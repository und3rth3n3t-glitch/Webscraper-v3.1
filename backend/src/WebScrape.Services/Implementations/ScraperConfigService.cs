using System.Text.Json;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class ScraperConfigService : IScraperConfigService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;

    public ScraperConfigService(WebScrapeDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.ScraperConfigs
            .AsNoTracking()
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        return await MapWithWorkerNames(rows, ct);
    }

    public async Task<List<ScraperConfigDto>> ListSharedAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.ScraperConfigs
            .AsNoTracking()
            .Where(c => c.UserId == userId && c.Shared)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        return await MapWithWorkerNames(rows, ct);
    }

    public async Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.ScraperConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (row is null) return null;
        return await MapWithWorkerName(row, ct);
    }

    public async Task<CreateScraperConfigResult> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;

        // Idempotent first-share: if this user already owns a config at the suggested ID,
        // either return it (matching content → idempotent success) or reject (mismatched
        // content → caller must use PUT to overwrite). Scoping by userId also closes the
        // GUID-existence oracle that the previous fallback exposed.
        if (dto.SuggestedId.HasValue)
        {
            var existing = await _db.ScraperConfigs
                .FirstOrDefaultAsync(c => c.Id == dto.SuggestedId.Value && c.UserId == userId, ct);

            if (existing is not null)
            {
                var incomingJson = dto.ConfigJson.GetRawText();
                var storedJson = existing.ConfigJson.RootElement.GetRawText();
                var matches = existing.Name == dto.Name
                    && existing.Domain == dto.Domain
                    && incomingJson == storedJson;

                var outcome = matches ? CreateScraperConfigOutcome.Idempotent : CreateScraperConfigOutcome.Conflict;
                return new CreateScraperConfigResult(outcome, await MapWithWorkerName(existing, ct));
            }
        }

        // Fall back to a fresh GUID if another user already owns this suggested ID.
        var entityId = dto.SuggestedId.HasValue
            && !await _db.ScraperConfigs.AnyAsync(c => c.Id == dto.SuggestedId.Value, ct)
            ? dto.SuggestedId.Value
            : Guid.NewGuid();

        var entity = new ScraperConfigEntity
        {
            Id = entityId,
            UserId = userId,
            Name = dto.Name,
            Domain = dto.Domain,
            ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText()),
            SchemaVersion = dto.SchemaVersion <= 0 ? 3 : dto.SchemaVersion,
            Shared = dto.Shared,
            CreatedAt = now,
            UpdatedAt = now,
        };

        if (workerId.HasValue)
        {
            entity.LastSyncedAt = now;
            entity.OriginClientId = workerId.Value.ToString();
        }

        _db.ScraperConfigs.Add(entity);
        await _db.SaveChangesAsync(ct);
        return new CreateScraperConfigResult(CreateScraperConfigOutcome.Created, await MapWithWorkerName(entity, ct));
    }

    public async Task<UpdateScraperConfigResult> UpdateAsync(
        Guid userId, Guid id, CreateScraperConfigDto dto,
        string? ifMatch = null, Guid? workerId = null,
        CancellationToken ct = default)
    {
        var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (entity is null) return new(UpdateScraperConfigOutcome.NotFound, null, null);

        // PAT auth (workerId set) with a shared config must supply If-Match.
        if (workerId.HasValue && entity.Shared && ifMatch is null)
            return new(UpdateScraperConfigOutcome.PreconditionRequired, null, null);

        // If-Match check: compare client's etag to server's current UpdatedAt.
        // Parse both sides to UTC ticks to avoid string format differences (e.g. +00:00 vs +01:00 in BST).
        if (ifMatch is not null)
        {
            if (!DateTimeOffset.TryParse(ifMatch, out var clientDt)
                || entity.UpdatedAt.ToUnixTimeMilliseconds() != clientDt.ToUnixTimeMilliseconds())
                return new(UpdateScraperConfigOutcome.PreconditionFailed, null, await MapWithWorkerName(entity, ct));
        }

        entity.Name = dto.Name;
        entity.Domain = dto.Domain;
        entity.ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText());
        if (dto.SchemaVersion > 0) entity.SchemaVersion = dto.SchemaVersion;
        entity.Shared = dto.Shared;
        entity.UpdatedAt = DateTimeOffset.UtcNow;

        if (workerId.HasValue)
        {
            entity.LastSyncedAt = entity.UpdatedAt;
            if (entity.OriginClientId is null)
                entity.OriginClientId = workerId.Value.ToString();
        }

        await _db.SaveChangesAsync(ct);
        return new(UpdateScraperConfigOutcome.Updated, await MapWithWorkerName(entity, ct), null);
    }

    public async Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id, ct);
        if (entity is null)
            return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.NotFound, 0);
        if (entity.UserId != userId)
            return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Forbidden, 0);

        var idAsString = id.ToString();
        var scrapeBlockTaskIds = (await _db.TaskBlocks
            .Where(b => b.BlockType == BlockType.Scrape)
            .Select(b => new { b.TaskId, b.ConfigJsonb })
            .ToListAsync(ct))
            .Where(b => b.ConfigJsonb.RootElement.GetRawText().Contains(idAsString))
            .Select(b => b.TaskId)
            .Distinct()
            .ToList();

        var referencingTaskCount = scrapeBlockTaskIds.Count;
        if (referencingTaskCount > 0)
            return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Referenced, referencingTaskCount);

        _db.ScraperConfigs.Remove(entity);
        await _db.SaveChangesAsync(ct);
        return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Deleted, 0);
    }

    public async Task<List<ScraperConfigSubscriberDto>?> GetSubscribersAsync(Guid userId, Guid configId, CancellationToken ct = default)
    {
        var config = await _db.ScraperConfigs.AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == configId && c.UserId == userId, ct);
        if (config is null) return null;

        var subs = await _db.ScraperConfigSubscriptions
            .AsNoTracking()
            .Include(s => s.Worker)
            .Where(s => s.ScraperConfigId == configId)
            .ToListAsync(ct);

        return subs.Select(s => new ScraperConfigSubscriberDto
        {
            Id = s.WorkerId,
            Name = s.Worker!.Name,
            Online = s.Worker.CurrentConnection != null,
            LastPulledAt = s.LastPulledAt,
        }).ToList();
    }

    public async Task RecordSubscriptionAsync(Guid configId, Guid workerId, CancellationToken ct = default)
    {
        var sub = await _db.ScraperConfigSubscriptions
            .FirstOrDefaultAsync(s => s.ScraperConfigId == configId && s.WorkerId == workerId, ct);

        var now = DateTimeOffset.UtcNow;
        if (sub is null)
        {
            _db.ScraperConfigSubscriptions.Add(new ScraperConfigSubscription
            {
                ScraperConfigId = configId,
                WorkerId = workerId,
                LastPulledAt = now,
            });
        }
        else
        {
            sub.LastPulledAt = now;
        }
        await _db.SaveChangesAsync(ct);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task<ScraperConfigDto> MapWithWorkerName(ScraperConfigEntity entity, CancellationToken ct)
    {
        var dto = _mapper.Map<ScraperConfigDto>(entity);
        if (entity.OriginClientId is not null && Guid.TryParse(entity.OriginClientId, out var wId))
        {
            var worker = await _db.WorkerConnections.AsNoTracking()
                .FirstOrDefaultAsync(w => w.Id == wId, ct);
            dto.OriginWorkerName = worker?.Name;
        }
        return dto;
    }

    private async Task<List<ScraperConfigDto>> MapWithWorkerNames(List<ScraperConfigEntity> rows, CancellationToken ct)
    {
        var workerIds = rows
            .Where(r => r.OriginClientId is not null)
            .Select(r => Guid.TryParse(r.OriginClientId, out var g) ? (Guid?)g : null)
            .OfType<Guid>()
            .Distinct()
            .ToList();

        Dictionary<Guid, string> workerMap = new();
        if (workerIds.Count > 0)
        {
            var workers = await _db.WorkerConnections.AsNoTracking()
                .Where(w => workerIds.Contains(w.Id))
                .ToListAsync(ct);
            workerMap = workers.ToDictionary(w => w.Id, w => w.Name);
        }

        var dtos = _mapper.Map<List<ScraperConfigDto>>(rows);
        foreach (var dto in dtos)
        {
            if (dto.OriginClientId is not null && Guid.TryParse(dto.OriginClientId, out var wId) && workerMap.TryGetValue(wId, out var name))
                dto.OriginWorkerName = name;
        }
        return dtos;
    }
}
