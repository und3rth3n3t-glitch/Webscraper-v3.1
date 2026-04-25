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
        return _mapper.Map<List<ScraperConfigDto>>(rows);
    }

    public async Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.ScraperConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        return row is null ? null : _mapper.Map<ScraperConfigDto>(row);
    }

    public async Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var entity = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            Domain = dto.Domain,
            ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText()),
            SchemaVersion = dto.SchemaVersion <= 0 ? 3 : dto.SchemaVersion,
            CreatedAt = now,
            UpdatedAt = now,
        };
        _db.ScraperConfigs.Add(entity);
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }

    public async Task<ScraperConfigDto?> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (entity is null) return null;

        entity.Name = dto.Name;
        entity.Domain = dto.Domain;
        entity.ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText());
        if (dto.SchemaVersion > 0) entity.SchemaVersion = dto.SchemaVersion;
        entity.UpdatedAt = DateTimeOffset.UtcNow;

        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }

    public async Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id, ct);
        if (entity is null)
            return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.NotFound, 0);
        if (entity.UserId != userId)
            return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Forbidden, 0);

        // Reference check: JSONB scraperConfigId inside scrape blocks.
        // JSONB column has a HasConversion to string which the InMemory provider can't coerce
        // in a server-side LIKE. Materialise scrape blocks and filter in memory; the GUID is
        // a unique token so a substring match is safe, and block counts are small per user.
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
}
