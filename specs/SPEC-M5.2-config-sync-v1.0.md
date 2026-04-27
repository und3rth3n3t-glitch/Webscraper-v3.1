# SPEC-M5.2 — Config Sync (Theme 2)
**Version**: 1.0  
**Status**: Ready for implementation  
**Prerequisite**: SPEC-M5.1 complete (AutoMapper 13, bb_api_token shim already merged)

---

## Context

The extension currently has no way to share configs with the backend.  
- Shared configs let the backend push config changes to all connected extensions automatically.  
- The extension can also push configs to the backend for the first time (share them), then edit them in either place.  
- Conflict detection uses `If-Match` on `updatedAt` timestamps; last-write wins after the user picks a side.

---

## Commit order (6 PRs — independent within pairs)

| PR | Scope |
|---|---|
| PR 1 | DB migration (`M5ConfigSync`) + entities + DbContext |
| PR 2 | Service layer (ScraperConfigService + IWorkerService) |
| PR 3 | Controller changes + RunBatchService |
| PR 4 | Backend frontend (api/types.ts + Configs.tsx + ConfigEditor.tsx) |
| PR 5 | Extension types + storage v4 + syncClient + syncStore |
| PR 6 | Extension UI (ConfigSyncStatus, ConfigConflictDiffModal, ConfigListItem, App.tsx) |

PRs 1–4 are backend; 5–6 are extension. PRs 3 and 4 can run in parallel after PR 2. PRs 5 and 6 can run in parallel after no backend dep.

---

## Section 1 — DB Migration M5ConfigSync

### 1a. New entity — `ScraperConfigSubscription.cs`

**New file**: `backend/src/WebScrape.Data/Entities/ScraperConfigSubscription.cs`

```csharp
namespace WebScrape.Data.Entities;

public class ScraperConfigSubscription
{
    public Guid ScraperConfigId { get; set; }
    public Guid WorkerId { get; set; }
    public DateTimeOffset LastPulledAt { get; set; }

    public ScraperConfigEntity? Config { get; set; }
    public WorkerConnection? Worker { get; set; }
}
```

### 1b. Extend `ScraperConfigEntity.cs`

**File**: `backend/src/WebScrape.Data/Entities/ScraperConfigEntity.cs`  
Replace the entire file (16 lines → 22 lines):

```csharp
using System.Text.Json;

namespace WebScrape.Data.Entities;

public class ScraperConfigEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonDocument ConfigJson { get; set; } = JsonDocument.Parse("{}");
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public bool Shared { get; set; } = false;
    public DateTimeOffset? LastSyncedAt { get; set; }
    public string? OriginClientId { get; set; }
    public User? User { get; set; }
    public ICollection<ScraperConfigSubscription> Subscriptions { get; set; } = new List<ScraperConfigSubscription>();
}
```

### 1c. Update `WebScrapeDbContext.cs`

**File**: `backend/src/WebScrape.Data/WebScrapeDbContext.cs`

Add after line 22 (after `RunBatches` DbSet):
```csharp
    public DbSet<ScraperConfigSubscription> ScraperConfigSubscriptions => Set<ScraperConfigSubscription>();
```

Update the `ScraperConfigEntity` model builder block (lines 47–55) to add the new columns and the `Subscriptions` navigation:
```csharp
        builder.Entity<ScraperConfigEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
            e.Property(x => x.Domain).IsRequired();
            e.Property(x => x.ConfigJson).HasColumnType("jsonb").HasConversion(jsonConverter).IsRequired();
            e.Property(x => x.SchemaVersion).HasDefaultValue(3);
            e.Property(x => x.Shared).HasDefaultValue(false);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Subscriptions).WithOne(x => x.Config!).HasForeignKey(x => x.ScraperConfigId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.UserId, x.Shared }).HasDatabaseName("ix_scraper_configs_user_id_shared");
        });
```

Add after the `RunItem` entity block (before the closing `}`):
```csharp
        builder.Entity<ScraperConfigSubscription>(e =>
        {
            e.HasKey(x => new { x.ScraperConfigId, x.WorkerId });
            e.HasOne(x => x.Config).WithMany(x => x.Subscriptions).HasForeignKey(x => x.ScraperConfigId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Worker).WithMany().HasForeignKey(x => x.WorkerId).OnDelete(DeleteBehavior.Cascade);
        });
```

### 1d. Generate migration

After making entity and DbContext changes, run:

```bash
cd backend
dotnet ef migrations add M5ConfigSync --project src/WebScrape.Data --startup-project src/WebScrape.Server
```

Verify the generated migration file contains:
- `AddColumn<bool>` for `shared` on `scraper_configs` (defaultValue: false)
- `AddColumn<DateTimeOffset?>` for `last_synced_at` on `scraper_configs`
- `AddColumn<string?>` for `origin_client_id` on `scraper_configs`
- `CreateIndex` for `ix_scraper_configs_user_id_shared`
- `CreateTable` for `scraper_config_subscriptions` with composite PK + two FKs

**Smoke check**: `dotnet ef database update --project src/WebScrape.Data --startup-project src/WebScrape.Server`

---

## Section 2 — DTOs

### 2a. `ScraperConfigDto.cs`

**File**: `backend/src/WebScrape.Data/Dto/ScraperConfigDto.cs`  
Replace entire file:

```csharp
using System.Text.Json;

namespace WebScrape.Data.Dto;

public class ScraperConfigDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonElement ConfigJson { get; set; }
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public bool Shared { get; set; }
    public DateTimeOffset? LastSyncedAt { get; set; }
    public string? OriginClientId { get; set; }
    public string? OriginWorkerName { get; set; }
}

public class CreateScraperConfigDto
{
    public Guid? SuggestedId { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonElement ConfigJson { get; set; }
    public int SchemaVersion { get; set; } = 3;
    public bool Shared { get; set; } = false;
}

public class ScraperConfigSubscriberDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public bool Online { get; set; }
    public DateTimeOffset LastPulledAt { get; set; }
}
```

**Note**: `SuggestedId` in `CreateScraperConfigDto` lets the extension preserve its local UUID on first-share, avoiding an ID swap. The backend uses it if the UUID isn't already taken; otherwise falls back to `Guid.NewGuid()`. Cookie auth (backend editor) never sends `SuggestedId`.

### 2b. Update AutoMapper profile

**File**: `backend/src/WebScrape.Services/Profiles/AutoMapperProfile.cs` (or wherever the profile lives — run `grep -r "AutoMapperProfile" backend/src` to find it)

The new fields `Shared`, `LastSyncedAt`, `OriginClientId` on `ScraperConfigEntity` map by convention to `ScraperConfigDto` via AutoMapper's property-name matching. No explicit mapping needed if the profile uses `CreateMap<ScraperConfigEntity, ScraperConfigDto>()`.

`OriginWorkerName` has no backing column — it's populated manually in the service layer (see Section 3). Ensure AutoMapper doesn't fail on unmapped destination properties by adding `.ForMember(d => d.OriginWorkerName, opt => opt.Ignore())` if needed. Check by running `dotnet build` — AutoMapper v13 will warn on unmapped members.

---

## Section 3 — Service interface and implementation

### 3a. `IScraperConfigService.cs`

**File**: `backend/src/WebScrape.Services/Interfaces/IScraperConfigService.cs`  
Replace entire file:

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum DeleteScraperConfigOutcome
{
    Deleted,
    NotFound,
    Forbidden,
    Referenced,
}

public record DeleteScraperConfigResult(DeleteScraperConfigOutcome Outcome, int ReferencingTaskCount);

public enum UpdateScraperConfigOutcome
{
    Updated,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
}

public record UpdateScraperConfigResult(
    UpdateScraperConfigOutcome Outcome,
    ScraperConfigDto? Dto,
    ScraperConfigDto? Current);

public interface IScraperConfigService
{
    Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<List<ScraperConfigDto>> ListSharedAsync(Guid userId, CancellationToken ct = default);
    Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default);
    Task<UpdateScraperConfigResult> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, string? ifMatch = null, Guid? workerId = null, CancellationToken ct = default);
    Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<List<ScraperConfigSubscriberDto>?> GetSubscribersAsync(Guid userId, Guid configId, CancellationToken ct = default);
    Task RecordSubscriptionAsync(Guid configId, Guid workerId, CancellationToken ct = default);
}
```

### 3b. `ScraperConfigService.cs`

**File**: `backend/src/WebScrape.Services/Implementations/ScraperConfigService.cs`  
Replace entire file:

```csharp
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

    public async Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;

        // Honour the client-suggested ID if valid and not already taken (extension first-share flow).
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
        return await MapWithWorkerName(entity, ct);
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
        if (ifMatch is not null)
        {
            var etag = entity.UpdatedAt.ToUniversalTime().ToString("o");
            if (etag != ifMatch)
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

    // ── Helpers ───────────────────────────────��──────────────────────────────

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
```

### 3c. `IWorkerService.cs` — add `GetWorkerByApiKeyAsync`

**File**: `backend/src/WebScrape.Services/Interfaces/IWorkerService.cs`  
Add one line after line 11 (after `BumpLastSeenAsync`):

```csharp
    Task<WorkerConnection?> GetWorkerByApiKeyAsync(Guid userId, Guid apiKeyId, CancellationToken ct = default);
```

### 3d. `WorkerService.cs` — implement `GetWorkerByApiKeyAsync`

**File**: `backend/src/WebScrape.Services/Implementations/WorkerService.cs`  
Add after the `BumpLastSeenAsync` method (after line 105, before the closing `}`):

```csharp
    public async Task<WorkerConnection?> GetWorkerByApiKeyAsync(Guid userId, Guid apiKeyId, CancellationToken ct = default)
    {
        return await _db.WorkerConnections
            .AsNoTracking()
            .FirstOrDefaultAsync(w => w.UserId == userId && w.ApiKeyId == apiKeyId, ct);
    }
```

---

## Section 4 — Controller changes

### 4a. `ScraperConfigsController.cs`

**File**: `backend/src/WebScrape.Server/Controllers/ScraperConfigsController.cs`  
Replace entire file:

```csharp
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/scraper-configs")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.CookieAndPat)]
public class ScraperConfigsController : ControllerBase
{
    private readonly IScraperConfigService _configs;
    private readonly IWorkerService _workers;

    public ScraperConfigsController(IScraperConfigService configs, IWorkerService workers)
    {
        _configs = configs;
        _workers = workers;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool? shared, CancellationToken ct)
    {
        if (shared == true)
            return Ok(await _configs.ListSharedAsync(User.GetUserId(), ct));
        return Ok(await _configs.ListAsync(User.GetUserId(), ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _configs.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);
        var created = await _configs.CreateAsync(User.GetUserId(), dto, workerId, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(
        Guid id,
        [FromBody] CreateScraperConfigDto dto,
        [FromHeader(Name = "If-Match")] string? ifMatch,
        CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);

        // Cookie auth bypasses If-Match (canonical backend edit).
        // PAT auth passes If-Match through — service enforces presence for shared configs.
        var effectiveIfMatch = workerId.HasValue ? ifMatch : null;

        var result = await _configs.UpdateAsync(User.GetUserId(), id, dto, effectiveIfMatch, workerId, ct);

        return result.Outcome switch
        {
            UpdateScraperConfigOutcome.Updated => Ok(result.Dto),
            UpdateScraperConfigOutcome.NotFound => NotFound(),
            UpdateScraperConfigOutcome.PreconditionFailed => StatusCode(StatusCodes.Status412PreconditionFailed, result.Current),
            UpdateScraperConfigOutcome.PreconditionRequired => StatusCode(428, new { error = "Shared config requires If-Match header on PAT requests" }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var result = await _configs.DeleteAsync(User.GetUserId(), id, ct);
        return result.Outcome switch
        {
            DeleteScraperConfigOutcome.Deleted   => NoContent(),
            DeleteScraperConfigOutcome.NotFound  => NotFound(),
            DeleteScraperConfigOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            DeleteScraperConfigOutcome.Referenced => Conflict(new
            {
                code = "CONFIG_REFERENCED",
                referencingTaskCount = result.ReferencingTaskCount,
                error = $"This config is used by {result.ReferencingTaskCount} task{(result.ReferencingTaskCount == 1 ? "" : "s")}. Delete or update those tasks first.",
            }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpGet("{id:guid}/subscribers")]
    public async Task<IActionResult> GetSubscribers(Guid id, CancellationToken ct)
    {
        var subs = await _configs.GetSubscribersAsync(User.GetUserId(), id, ct);
        if (subs is null) return NotFound();
        return Ok(subs);
    }

    [HttpPost("{id:guid}/subscribe")]
    [CookieCsrf]
    public async Task<IActionResult> Subscribe(Guid id, CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);
        if (!workerId.HasValue) return Forbid();

        var config = await _configs.GetAsync(User.GetUserId(), id, ct);
        if (config is null) return NotFound();

        await _configs.RecordSubscriptionAsync(id, workerId.Value, ct);
        return Ok();
    }

    // ── Helpers ──────────────────────────────��───────────────────────────────

    private async Task<Guid?> ResolveWorkerIdAsync(CancellationToken ct)
    {
        var apiKeyId = User.TryGetApiKeyId();
        if (!apiKeyId.HasValue) return null;
        var worker = await _workers.GetWorkerByApiKeyAsync(User.GetUserId(), apiKeyId.Value, ct);
        return worker?.Id;
    }
}
```

---

## Section 5 — RunBatchService: conditional InlineConfig

### 5a. Skip InlineConfig for shared configs

**File**: `backend/src/WebScrape.Services/Implementations/RunBatchService.cs`  
In `CreateAndDispatchAsync`, lines 57–58 currently fetch configs:

```csharp
        var configIds = preview.Results.Select(r => r.ScraperConfigId).Distinct().ToList();
        var configs = await _db.ScraperConfigs.Where(c => configIds.Contains(c.Id)).ToListAsync(ct);
```

Build a lookup dictionary for shared flags immediately after:

```csharp
        var sharedIds = configs.Where(c => c.Shared).Select(c => c.Id).ToHashSet();
```

Then in the dispatch loop (line 118–129), change the `InlineConfig` assignment:

```csharp
            var queueDto = new QueueTaskDto
            {
                Id = run.Id.ToString(),
                ConfigId = r.ScraperConfigId.ToString(),
                ConfigName = r.ConfigName,
                SearchTerms = new(),
                Priority = 0,
                CreatedAt = run.RequestedAt,
                InlineConfig = sharedIds.Contains(r.ScraperConfigId) ? null : r.PatchedConfigJson,
                IterationLabel = r.IterationLabel,
                IterationAssignments = r.Assignments.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
            };
```

**Why**: When a config is shared, the extension already has it cached locally (via sync). Sending `InlineConfig` wastes bandwidth. The extension's `background.ts` handles the `inlineConfig = null` case by looking up by `configId` from local storage.

---

## Section 6 — Backend frontend

### 6a. `backend/src/WebScrape.Client/src/api/types.ts`

Extend `ScraperConfigDto` type (lines 35–43) to add sync fields:

```typescript
export type ScraperConfigDto = {
  id: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  shared: boolean;
  lastSyncedAt: string | null;
  originClientId: string | null;
  originWorkerName: string | null;
};
```

Add new type after `DeleteConfigConflictDto` (after line 56):

```typescript
export type ScraperConfigSubscriberDto = {
  id: string;
  name: string;
  online: boolean;
  lastPulledAt: string;
};
```

Extend `CreateScraperConfigDto` (lines 45–50):

```typescript
export type CreateScraperConfigDto = {
  suggestedId?: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  shared?: boolean;
};
```

### 6b. `backend/src/WebScrape.Client/src/api/queries.ts`

Add after the `useScraperConfig` query (find it in the file):

```typescript
export function useScraperConfigSubscribers(id: string | undefined) {
  return useQuery({
    queryKey: ['scraper-config-subscribers', id],
    enabled: !!id,
    queryFn: async () => (await api.get<ScraperConfigSubscriberDto[]>(`/api/scraper-configs/${id}/subscribers`)).data,
  });
}
```

Add `ScraperConfigSubscriberDto` to the import line at the top of the file.

### 6c. `backend/src/WebScrape.Client/src/pages/Configs.tsx`

Add a "Shared" column to the table. Current table headers (lines 57–64):
```tsx
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Schema</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
```

Replace with:
```tsx
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Schema</th>
              <th>Updated</th>
              <th>Sync</th>
              <th />
            </tr>
          </thead>
```

Current data rows (lines 66–80):
```tsx
            {configs.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><span className="domain-badge">{c.domain}</span></td>
                <td>{c.schemaVersion}</td>
                <td>{fmtDate(c.updatedAt)}</td>
                <td style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end' }}>
                  <Link to={`/configs/${c.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirmDelete(c); setDeleteError(null); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
```

Replace with:
```tsx
            {configs.map((c) => (
              <tr key={c.id}>
                <td>
                  <div>{c.name}</div>
                  {c.originWorkerName && (
                    <div className="form-hint" style={{ marginTop: 2 }}>
                      Imported from {c.originWorkerName}
                    </div>
                  )}
                </td>
                <td><span className="domain-badge">{c.domain}</span></td>
                <td>{c.schemaVersion}</td>
                <td>{fmtDate(c.updatedAt)}</td>
                <td>
                  {c.shared && <span className="meta-badge">Synced</span>}
                </td>
                <td style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end' }}>
                  <Link to={`/configs/${c.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirmDelete(c); setDeleteError(null); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
```

### 6d. `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx`

Add subscriber warning banner. Add two new imports at the top of the file (after line 10):

```typescript
import { useScraperConfigSubscribers } from '../api/queries';
import type { ScraperConfigSubscriberDto } from '../api/types';
```

Add after the `const { id } = useParams` line (line 39):

```typescript
  const { data: subscribers } = useScraperConfigSubscribers(id);
  const onlineSubscribers = (subscribers ?? []).filter((s: ScraperConfigSubscriberDto) => s.online);
```

Add after the `saveError &&` banner (after line 132):

```typescript
      {onlineSubscribers.length > 0 && (
        <div className="run-banner-warning">
          This config is being synced to {onlineSubscribers.length} online extension{onlineSubscribers.length === 1 ? '' : 's'}{' '}
          ({onlineSubscribers.map((s: ScraperConfigSubscriberDto) => s.name).join(', ')}). Saving here updates everyone.
        </div>
      )}
```

**Note**: `run-banner-warning` is an existing CSS class (check `backend/src/WebScrape.Client/src/index.css` for the selector). If it doesn't exist, use `danger-banner` instead and add it later.

---

## Section 7 — Extension: types + storage

### 7a. `src/types/config.ts`

Extend `ScraperConfig` interface (line 177–189). Add sync fields after `updatedAt`:

```typescript
export interface ScraperConfig {
  id: string;
  name: string;
  description?: string;
  domain: string;
  domainLocked: boolean;
  url: string;
  steps: Step[];
  dataMapping?: DataMapping;
  schemaVersion: 3 | 4;
  createdAt: number;
  updatedAt: number;
  shared?: boolean;
  lastSyncedAt?: string | null;
  dirty?: boolean;
}
```

**Note**: `schemaVersion` now accepts `3 | 4`. The migration in storage.ts bumps to 4.

### 7b. `src/sidepanel/utils/storage.ts`

**File**: `src/sidepanel/utils/storage.ts`

**Change 1** (line 6): Bump schema version:
```typescript
export const CURRENT_SCHEMA_VERSION = 4;
```

**Change 2**: In `migrateConfig` function, extend the migration block to handle v3→v4. After the existing `// v2 → v3` comment block and before `migrated.schemaVersion = CURRENT_SCHEMA_VERSION`:

Current code around line 62:
```typescript
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return migrated as unknown as ScraperConfig;
```

Replace with:
```typescript
  // v3 → v4: add sync metadata fields with safe defaults.
  migrated.shared = (migrated.shared as boolean | undefined) ?? false;
  migrated.lastSyncedAt = (migrated.lastSyncedAt as string | null | undefined) ?? null;
  migrated.dirty = (migrated.dirty as boolean | undefined) ?? false;

  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return migrated as unknown as ScraperConfig;
```

**Change 3**: Add `saveSharedConfig` helper after `deleteConfig` (after line 94):

```typescript
export async function saveSharedConfig(config: ScraperConfig): Promise<ScraperConfig[]> {
  return saveConfig(config);
}
```

(This is an alias for future differentiation without changing callers.)

---

## Section 8 — New file: `src/sidepanel/utils/syncClient.ts`

**New file**: `src/sidepanel/utils/syncClient.ts`

```typescript
import type { ScraperConfig } from '../../types/config';

export interface ServerScraperConfig {
  id: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  updatedAt: string;
  shared: boolean;
  lastSyncedAt: string | null;
  originClientId: string | null;
  originWorkerName: string | null;
}

export type PushResult =
  | { outcome: 'created'; config: ServerScraperConfig }
  | { outcome: 'updated'; config: ServerScraperConfig }
  | { outcome: 'conflict'; current: ServerScraperConfig }
  | { outcome: 'error'; error: string };

export async function pullSharedConfigs(
  serverUrl: string,
  token: string,
): Promise<ServerScraperConfig[]> {
  const resp = await fetch(`${serverUrl}/api/scraper-configs?shared=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Pull failed: HTTP ${resp.status}`);
  return resp.json() as Promise<ServerScraperConfig[]>;
}

export async function pushConfig(
  serverUrl: string,
  token: string,
  config: ScraperConfig,
): Promise<PushResult> {
  // Strip extension-only storage metadata from the blob stored on the server.
  const { shared: _s, lastSyncedAt: _ls, dirty: _d, ...configPayload } = config;
  const body = {
    suggestedId: config.id,
    name: config.name,
    domain: config.domain,
    configJson: configPayload,
    schemaVersion: config.schemaVersion,
    shared: true,
  };

  if (!config.lastSyncedAt) {
    // First share: POST to create
    const resp = await fetch(`${serverUrl}/api/scraper-configs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { outcome: 'error', error: `HTTP ${resp.status}` };
    return { outcome: 'created', config: await resp.json() as ServerScraperConfig };
  }

  // Subsequent push: PUT with If-Match
  const resp = await fetch(`${serverUrl}/api/scraper-configs/${config.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'If-Match': config.lastSyncedAt,
    },
    body: JSON.stringify({ ...body, suggestedId: undefined }),
  });

  if (resp.status === 412) {
    const current = await resp.json() as ServerScraperConfig;
    return { outcome: 'conflict', current };
  }
  if (!resp.ok) return { outcome: 'error', error: `HTTP ${resp.status}` };
  return { outcome: 'updated', config: await resp.json() as ServerScraperConfig };
}

export async function recordSubscription(
  serverUrl: string,
  token: string,
  configId: string,
): Promise<void> {
  // Best-effort: ignore failures
  fetch(`${serverUrl}/api/scraper-configs/${configId}/subscribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}
```

---

## Section 9 — New file: `src/sidepanel/stores/syncStore.ts`

**New file**: `src/sidepanel/stores/syncStore.ts`

```typescript
import { create } from 'zustand';
import { getAllConfigs, saveConfig } from '../utils/storage';
import {
  pullSharedConfigs,
  pushConfig,
  recordSubscription,
  type ServerScraperConfig,
} from '../utils/syncClient';
import type { ScraperConfig } from '../../types/config';
import { migrateConfig } from '../utils/storage';

export interface ConflictState {
  localConfig: ScraperConfig;
  serverConfig: ServerScraperConfig;
}

interface SyncState {
  syncing: boolean;
  lastSyncError: string | null;
  conflicts: Record<string, ConflictState>;

  pullSharedConfigs: (serverUrl: string, token: string) => Promise<void>;
  pushIfDirty: (serverUrl: string, token: string, configId: string) => Promise<void>;
  resolveConflict: (choice: 'mine' | 'theirs', serverUrl: string, token: string, configId: string) => Promise<void>;
  dismissConflict: (configId: string) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncing: false,
  lastSyncError: null,
  conflicts: {},

  pullSharedConfigs: async (serverUrl, token) => {
    set({ syncing: true, lastSyncError: null });
    try {
      const serverConfigs = await pullSharedConfigs(serverUrl, token);
      const localConfigs = await getAllConfigs();
      const localById = new Map(localConfigs.map((c) => [c.id, c]));

      for (const sc of serverConfigs) {
        const local = localById.get(sc.id);
        const serverUpdatedMs = new Date(sc.updatedAt).getTime();
        const localSyncedMs = local?.lastSyncedAt ? new Date(local.lastSyncedAt).getTime() : 0;
        const serverIsNewer = serverUpdatedMs > localSyncedMs;

        if (!local) {
          // New shared config: import silently
          const imported = serverToLocal(sc);
          await saveConfig(imported);
          recordSubscription(serverUrl, token, sc.id);
        } else if (serverIsNewer && !local.dirty) {
          // Server update: overwrite silently
          const updated = serverToLocal(sc, local);
          await saveConfig(updated);
          recordSubscription(serverUrl, token, sc.id);
        } else if (serverIsNewer && local.dirty) {
          // Conflict: both sides changed
          set((s) => ({
            conflicts: { ...s.conflicts, [sc.id]: { localConfig: local, serverConfig: sc } },
          }));
        }
        // If !serverIsNewer: local is up-to-date or ahead — leave it, push will handle it
      }

      // Push any dirty shared configs that are not in conflict
      const { conflicts } = get();
      const updatedLocal = await getAllConfigs();
      for (const c of updatedLocal) {
        if (c.shared && c.dirty && !conflicts[c.id]) {
          await get().pushIfDirty(serverUrl, token, c.id);
        }
      }
    } catch (err) {
      set({ lastSyncError: (err as Error).message });
    } finally {
      set({ syncing: false });
    }
  },

  pushIfDirty: async (serverUrl, token, configId) => {
    const configs = await getAllConfigs();
    const config = configs.find((c) => c.id === configId);
    if (!config || !config.dirty) return;

    const result = await pushConfig(serverUrl, token, config);

    if (result.outcome === 'created' || result.outcome === 'updated') {
      const synced: ScraperConfig = {
        ...config,
        id: result.config.id, // server may have assigned a different ID (collision edge case)
        lastSyncedAt: result.config.updatedAt,
        dirty: false,
        shared: true,
      };
      // If server assigned a different ID, remove old entry
      if (result.config.id !== config.id) {
        const { deleteConfig } = await import('../utils/storage');
        await deleteConfig(config.id);
      }
      await saveConfig(synced);
      recordSubscription(serverUrl, token, result.config.id);
    } else if (result.outcome === 'conflict') {
      set((s) => ({
        conflicts: { ...s.conflicts, [configId]: { localConfig: config, serverConfig: result.current } },
      }));
    }
    // 'error' outcome: leave dirty=true, will retry on next sync
  },

  resolveConflict: async (choice, serverUrl, token, configId) => {
    const cs = get().conflicts[configId];
    if (!cs) return;

    if (choice === 'theirs') {
      const imported = serverToLocal(cs.serverConfig, cs.localConfig);
      await saveConfig(imported);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
      return;
    }

    // 'mine': push local version using server's updatedAt as the If-Match etag.
    const localWithServerEtag: ScraperConfig = {
      ...cs.localConfig,
      lastSyncedAt: cs.serverConfig.updatedAt,
    };
    const result = await pushConfig(serverUrl, token, localWithServerEtag);

    if (result.outcome === 'updated') {
      const synced: ScraperConfig = {
        ...cs.localConfig,
        lastSyncedAt: result.config.updatedAt,
        dirty: false,
      };
      await saveConfig(synced);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
    } else if (result.outcome === 'conflict') {
      // Another race — update conflict state with new server version
      set((s) => ({
        conflicts: { ...s.conflicts, [configId]: { localConfig: cs.localConfig, serverConfig: result.current } },
      }));
    }
    // 'error': leave conflict open so user sees it
  },

  dismissConflict: (configId) => {
    set((s) => {
      const { [configId]: _, ...rest } = s.conflicts;
      return { conflicts: rest };
    });
  },
}));

// ── Helpers ────────────────────────────���───────────────────��──────────────────

function serverToLocal(sc: ServerScraperConfig, existing?: ScraperConfig): ScraperConfig {
  const blob = migrateConfig(sc.configJson as Record<string, unknown>);
  const base = blob ?? {} as ScraperConfig;
  return {
    ...base,
    id: sc.id,
    name: sc.name,
    domain: sc.domain,
    shared: true,
    lastSyncedAt: sc.updatedAt,
    dirty: false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: new Date(sc.updatedAt).getTime(),
  } as ScraperConfig;
}
```

---

## Section 10 — New file: `src/sidepanel/components/ConfigSyncStatus.tsx`

**New file**: `src/sidepanel/components/ConfigSyncStatus.tsx`

```tsx
import { useSyncStore } from '../stores/syncStore';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
}

export default function ConfigSyncStatus({ config }: Props) {
  const { syncing, conflicts } = useSyncStore();

  if (!config.shared) return null;

  const inConflict = !!conflicts[config.id];
  const isPending = config.dirty && !inConflict;
  const isSyncing = syncing && isPending;

  let dot: string;
  let label: string;

  if (inConflict) {
    dot = 'error';
    label = 'Server has newer changes — click to resolve';
  } else if (isSyncing) {
    dot = 'running';
    label = 'Syncing…';
  } else if (isPending) {
    dot = 'pending';
    label = 'Pending sync';
  } else {
    dot = 'success';
    label = 'Synced with backend';
  }

  return (
    <span
      className="meta-badge"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={label}
    >
      <span className={`status-dot ${dot}`} />
      {inConflict ? 'Conflict' : isPending ? 'Pending' : 'Synced'}
    </span>
  );
}
```

---

## Section 11 — New file: `src/sidepanel/components/ConfigConflictDiffModal.tsx`

**New file**: `src/sidepanel/components/ConfigConflictDiffModal.tsx`

No external diff library — shows two formatted JSON panes side by side.

```tsx
import { X } from 'lucide-react';
import { useSyncStore } from '../stores/syncStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ScraperConfig } from '../../types/config';

interface Props {
  configId: string;
  onClose: () => void;
}

export default function ConfigConflictDiffModal({ configId, onClose }: Props) {
  const { conflicts, resolveConflict, syncing } = useSyncStore();
  const { serverUrl, jwtToken } = useSettingsStore();

  const cs = conflicts[configId];
  if (!cs) return null;

  const local = JSON.stringify(cs.localConfig, null, 2);
  const server = JSON.stringify(cs.serverConfig.configJson, null, 2);

  const handlePick = async (choice: 'mine' | 'theirs') => {
    await resolveConflict(choice, serverUrl, jwtToken, configId);
    onClose();
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-box" style={{ maxWidth: 720, width: '100%' }}>
        <div className="modal-box-header">
          <span className="modal-title">Config has changed on the backend</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="modal-body">
          You and the backend both edited <strong>{cs.localConfig.name}</strong>. Pick which version to keep.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
          <div>
            <div className="form-label" style={{ marginBottom: 4 }}>Your version</div>
            <pre
              style={{
                background: 'var(--bg-light)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--spacing-sm)',
                fontSize: 11,
                overflowY: 'auto',
                maxHeight: 320,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {local}
            </pre>
          </div>
          <div>
            <div className="form-label" style={{ marginBottom: 4 }}>Backend version</div>
            <pre
              style={{
                background: 'var(--bg-light)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--spacing-sm)',
                fontSize: 11,
                overflowY: 'auto',
                maxHeight: 320,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {server}
            </pre>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={syncing}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => handlePick('theirs')}
            disabled={syncing}
          >
            Keep backend version
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handlePick('mine')}
            disabled={syncing}
          >
            {syncing ? 'Saving…' : 'Keep my version'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Section 12 — Extension component + store updates

### 12a. `src/sidepanel/components/ConfigListItem.tsx`

Add share toggle and sync status badge to the config card.

**New imports** (add to existing imports at top):

```typescript
import { Wifi, WifiOff } from 'lucide-react';
import ConfigSyncStatus from './ConfigSyncStatus';
import ConfigConflictDiffModal from './ConfigConflictDiffModal';
import { useSyncStore } from '../stores/syncStore';
import { useSettingsStore } from '../stores/settingsStore';
import { saveConfig } from '../utils/storage';
```

**New state** (add inside the component function, after `const [confirming, setConfirming] = useState(false);`):

```typescript
  const [conflictOpen, setConflictOpen] = useState(false);
  const conflicts = useSyncStore((s) => s.conflicts);
  const { serverUrl, jwtToken, connectionStatus } = useSettingsStore();
  const pushIfDirty = useSyncStore((s) => s.pushIfDirty);
  const pullSharedConfigs = useSyncStore((s) => s.pullSharedConfigs);

  const inConflict = !!conflicts[config.id];
```

**Share toggle handler** (add after `handleDelete`):

```typescript
  const handleToggleShare = async () => {
    const nowShared = !config.shared;
    const updated = { ...config, shared: nowShared, dirty: nowShared ? true : false };
    await saveConfig(updated);
    if (nowShared && connectionStatus === 'connected') {
      await pushIfDirty(serverUrl, jwtToken, config.id);
    } else if (!nowShared) {
      // Un-share: leave backend copy in place, stop syncing locally
      showToast('Config will no longer sync. The backend keeps its copy.', 'success');
    }
  };
```

**Extend JSX** — in the `config-card-icons` div (after the Delete button), add a share icon button:

```tsx
            <button
              className={`btn btn-icon ${config.shared ? 'btn-icon-edit' : 'btn-icon-subtle'}`}
              onClick={inConflict ? () => setConflictOpen(true) : handleToggleShare}
              title={
                inConflict
                  ? 'Server has newer changes — click to resolve'
                  : config.shared
                  ? 'Stop syncing (your backend keeps a copy)'
                  : 'Sync this config with your backend'
              }
              aria-label={config.shared ? 'Stop syncing' : 'Sync config'}
            >
              {config.shared ? <Wifi size={14} /> : <WifiOff size={14} />}
            </button>
```

**Extend card body** — after the domain badge block, add:

```tsx
        {config.shared && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <ConfigSyncStatus config={config} />
          </div>
        )}
```

**Add conflict modal** — inside the fragment (`<>...</>`), after the `{confirming && <ConfirmDialog ...>}` block:

```tsx
      {conflictOpen && (
        <ConfigConflictDiffModal
          configId={config.id}
          onClose={() => setConflictOpen(false)}
        />
      )}
```

### 12b. `src/sidepanel/stores/configStore.ts`

In `saveCurrentConfig` (lines 197–214), after `set({ currentConfig: config, isDirty: false });`, mark shared configs as dirty:

```typescript
  saveCurrentConfig: async () => {
    const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked } = get();
    const config: ScraperConfig = {
      id: currentConfig?.id || generateId(),
      name: configName || 'Untitled Config',
      domain: domainLocked ? pageDomain : '',
      domainLocked,
      url: pageUrl,
      steps,
      dataMapping: currentConfig?.dataMapping,
      schemaVersion: CURRENT_SCHEMA_VERSION as 4,
      createdAt: currentConfig?.createdAt || Date.now(),
      updatedAt: Date.now(),
      // Preserve sync fields from current config
      shared: currentConfig?.shared ?? false,
      lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
    };

    // Mark dirty if this is a shared config (triggers push on next sync)
    if (config.shared) {
      (config as ScraperConfig).dirty = true;
    }

    await saveConfigToStorage(config);
    set({ currentConfig: config, isDirty: false });
    return config;
  },
```

Also update `loadConfig` to preserve sync fields when loading:

```typescript
  loadConfig: (config) => {
    const safe = migrateConfig(config as Record<string, unknown>) || config as ScraperConfig;
    set({
      currentConfig: safe,
      steps: safe.steps || [],
      configName: safe.name,
      domainLocked: safe.domainLocked ?? !!(safe.domain),
      isDirty: false,
      view: 'STEP_LIST',
      viewStack: [],
      draftStep: null,
      cameFromSaved: true,
    });
  },
```

(No change needed to `loadConfig` — sync fields are preserved through `safe` since `migrateConfig` passes unknown fields through.)

### 12c. `src/sidepanel/App.tsx`

Add pull trigger on connect. Add import at top (after existing imports):

```typescript
import { useSyncStore } from './stores/syncStore';
```

In the `CONNECTION_STATUS` effect (lines 26–38), after `useSettingsStore.getState().setConnectionStatus(payload.status, payload.error);`:

```typescript
      if (msg.type === 'CONNECTION_STATUS') {
        const payload = msg.payload as { status: ConnectionStatus; error?: string };
        useSettingsStore.getState().setConnectionStatus(payload.status, payload.error);
        if (payload.status === 'connected') {
          const { serverUrl, jwtToken } = useSettingsStore.getState();
          useSyncStore.getState().pullSharedConfigs(serverUrl, jwtToken);
        }
      }
```

**Note**: `jwtToken` in `settingsStore` is set when the user pastes a PAT and connects. It's the same token used for SignalR. After M5.1's `bb_api_token` shim, the token is in both `settingsStore.jwtToken` and `chrome.storage.local`. Here we use `settingsStore.jwtToken` directly (it's already in memory after connect).

---

## Section 13 — Tests

### 13a. Backend: `ScraperConfigServiceConflictTests.cs`

**New file**: `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceConflictTests.cs`

```csharp
using WebScrape.Data.Dto;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;

namespace WebScrape.Tests.Services;

public class ScraperConfigServiceConflictTests
{
    private async Task<(ScraperConfigService Svc, WebScrape.Data.WebScrapeDbContext Db, Guid UserId, Guid ConfigId, Guid WorkerId)> Build()
    {
        var db = TestDb.Create();
        var userId = Guid.NewGuid();
        var workerId = Guid.NewGuid();

        // Seed a user (or use existing seeder helper from other tests)
        var user = new WebScrape.Data.Entities.User { Id = userId, UserName = "test@test.com", Email = "test@test.com" };
        db.Users.Add(user);

        // Seed an ApiKey
        var key = new WebScrape.Data.Entities.ApiKey
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "test-key",
            Hash = "hash",
            Prefix = "pre",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.ApiKeys.Add(key);

        // Seed a worker
        var worker = new WebScrape.Data.Entities.WorkerConnection
        {
            Id = workerId,
            UserId = userId,
            Name = "Test Worker",
            ApiKeyId = key.Id,
        };
        db.WorkerConnections.Add(worker);

        // Seed a shared config
        var config = new WebScrape.Data.Entities.ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "Test Config",
            Domain = "example.com",
            ConfigJson = System.Text.Json.JsonDocument.Parse(@"{""steps"":[]}"),
            SchemaVersion = 4,
            Shared = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ScraperConfigs.Add(config);
        await db.SaveChangesAsync();

        var svc = new ScraperConfigService(db, TestDb.CreateMapper());
        return (svc, db, userId, config.Id, workerId);
    }

    [Fact]
    public async Task UpdateAsync_with_matching_ifMatch_succeeds()
    {
        var (svc, db, userId, configId, workerId) = await Build();
        var config = await db.ScraperConfigs.FindAsync(configId);
        var etag = config!.UpdatedAt.ToUniversalTime().ToString("o");
        var dto = new CreateScraperConfigDto { Name = "Updated", Domain = "example.com", ConfigJson = System.Text.Json.JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }), Shared = true };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: etag, workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.Updated, result.Outcome);
        Assert.NotNull(result.Dto);
        Assert.Equal("Updated", result.Dto!.Name);
        Assert.NotNull(result.Dto.LastSyncedAt);
    }

    [Fact]
    public async Task UpdateAsync_with_stale_ifMatch_returns_PreconditionFailed()
    {
        var (svc, _, userId, configId, workerId) = await Build();
        var dto = new CreateScraperConfigDto { Name = "Updated", Domain = "example.com", ConfigJson = System.Text.Json.JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }), Shared = true };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: "stale-etag", workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.PreconditionFailed, result.Outcome);
        Assert.NotNull(result.Current);
    }

    [Fact]
    public async Task UpdateAsync_without_ifMatch_on_shared_config_via_PAT_returns_PreconditionRequired()
    {
        var (svc, _, userId, configId, workerId) = await Build();
        var dto = new CreateScraperConfigDto { Name = "Updated", Domain = "example.com", ConfigJson = System.Text.Json.JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }), Shared = true };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: null, workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.PreconditionRequired, result.Outcome);
    }

    [Fact]
    public async Task UpdateAsync_without_ifMatch_via_cookie_auth_succeeds()
    {
        var (svc, db, userId, configId, _) = await Build();
        var dto = new CreateScraperConfigDto { Name = "Cookie edit", Domain = "example.com", ConfigJson = System.Text.Json.JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }), Shared = true };

        // workerId = null simulates cookie auth
        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: null, workerId: null);

        Assert.Equal(UpdateScraperConfigOutcome.Updated, result.Outcome);
        Assert.Equal("Cookie edit", result.Dto!.Name);
    }

    [Fact]
    public async Task CreateAsync_with_suggestedId_uses_provided_id()
    {
        var (svc, _, userId, _, workerId) = await Build();
        var suggestedId = Guid.NewGuid();
        var dto = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "New config",
            Domain = "test.com",
            ConfigJson = System.Text.Json.JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        var result = await svc.CreateAsync(userId, dto, workerId);

        Assert.Equal(suggestedId, result.Id);
    }
}
```

### 13b. Extension: `src/__tests__/syncStore.test.ts`

**New file**: `src/__tests__/syncStore.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage
vi.mock('../sidepanel/utils/storage', () => ({
  getAllConfigs: vi.fn(),
  saveConfig: vi.fn(),
  deleteConfig: vi.fn(),
  migrateConfig: (c: unknown) => c,
}));

// Mock syncClient
vi.mock('../sidepanel/utils/syncClient', () => ({
  pullSharedConfigs: vi.fn(),
  pushConfig: vi.fn(),
  recordSubscription: vi.fn(),
}));

import { useSyncStore } from '../sidepanel/stores/syncStore';
import * as storage from '../sidepanel/utils/storage';
import * as syncClient from '../sidepanel/utils/syncClient';

const SERVER_URL = 'http://localhost:5082';
const TOKEN = 'test-token';

const makeLocalConfig = (overrides = {}) => ({
  id: 'config-1',
  name: 'Test Config',
  domain: 'example.com',
  shared: true,
  dirty: false,
  lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
  updatedAt: new Date('2026-04-26T10:00:00Z').getTime(),
  createdAt: 0,
  schemaVersion: 4 as const,
  steps: [],
  url: '',
  domainLocked: false,
  ...overrides,
});

const makeServerConfig = (overrides = {}) => ({
  id: 'config-1',
  name: 'Test Config',
  domain: 'example.com',
  configJson: { steps: [], name: 'Test Config', domain: 'example.com', url: '', domainLocked: false, schemaVersion: 4 },
  schemaVersion: 4,
  updatedAt: '2026-04-26T10:00:00.0000000+00:00',
  shared: true,
  lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
  originClientId: null,
  originWorkerName: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.setState({ syncing: false, lastSyncError: null, conflicts: {} });
});

describe('pullSharedConfigs', () => {
  it('silently overwrites when server is newer and local is clean', async () => {
    const localConfig = makeLocalConfig({ lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00' });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00', name: 'Server Name' });

    vi.mocked(storage.getAllConfigs).mockResolvedValue([localConfig as never]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', dirty: false, lastSyncedAt: serverConfig.updatedAt }),
    );
    expect(useSyncStore.getState().conflicts).toEqual({});
  });

  it('sets conflict state when server is newer and local is dirty', async () => {
    const localConfig = makeLocalConfig({
      dirty: true,
      lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00',
    });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00' });

    vi.mocked(storage.getAllConfigs).mockResolvedValue([localConfig as never]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    // Second getAllConfigs call (for push-dirty pass) returns same dirty config still in conflict
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    const state = useSyncStore.getState();
    expect(state.conflicts['config-1']).toBeDefined();
    expect(storage.saveConfig).not.toHaveBeenCalled();
  });

  it('imports new server config when not present locally', async () => {
    const serverConfig = makeServerConfig();

    vi.mocked(storage.getAllConfigs).mockResolvedValue([]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', shared: true, dirty: false }),
    );
  });
});

describe('resolveConflict', () => {
  const setupConflict = () => {
    const localConfig = makeLocalConfig({ dirty: true, lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00', name: 'Local Name' });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00', name: 'Server Name' });
    useSyncStore.setState({ conflicts: { 'config-1': { localConfig: localConfig as never, serverConfig } } });
    return { localConfig, serverConfig };
  };

  it("resolveConflict('theirs') overwrites local with server version", async () => {
    setupConflict();
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().resolveConflict('theirs', SERVER_URL, TOKEN, 'config-1');

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', dirty: false, shared: true }),
    );
    expect(useSyncStore.getState().conflicts['config-1']).toBeUndefined();
  });

  it("resolveConflict('mine') pushes local with server etag as If-Match", async () => {
    const { serverConfig } = setupConflict();
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'updated',
      config: { ...serverConfig, updatedAt: '2026-04-26T11:00:00.0000000+00:00' },
    });
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().resolveConflict('mine', SERVER_URL, TOKEN, 'config-1');

    expect(syncClient.pushConfig).toHaveBeenCalledWith(
      SERVER_URL,
      TOKEN,
      expect.objectContaining({ lastSyncedAt: serverConfig.updatedAt }),
    );
    expect(useSyncStore.getState().conflicts['config-1']).toBeUndefined();
  });
});
```

### 13c. Extension: `src/__tests__/storageMigrateV4.test.ts`

**New file**: `src/__tests__/storageMigrateV4.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { migrateConfig } from '../sidepanel/utils/storage';

describe('migrateConfig v3→v4', () => {
  const v3Config = {
    id: 'abc',
    name: 'Test',
    domain: 'example.com',
    url: 'https://example.com',
    domainLocked: false,
    steps: [],
    schemaVersion: 3,
    createdAt: 1000,
    updatedAt: 2000,
  };

  it('migrates v3 config to v4 with safe defaults for sync fields', () => {
    const result = migrateConfig(v3Config);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(4);
    expect(result!.shared).toBe(false);
    expect(result!.lastSyncedAt).toBeNull();
    expect(result!.dirty).toBe(false);
  });

  it('preserves existing sync fields on re-migration', () => {
    const v4Config = {
      ...v3Config,
      schemaVersion: 4,
      shared: true,
      lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
      dirty: true,
    };
    const result = migrateConfig(v4Config as never);
    expect(result).not.toBeNull();
    expect(result!.shared).toBe(true);
    expect(result!.lastSyncedAt).toBe('2026-04-26T10:00:00.0000000+00:00');
    expect(result!.dirty).toBe(true);
  });

  it('preserves existing steps and data on migration', () => {
    const result = migrateConfig({ ...v3Config, steps: [{ id: 's1', type: 'click', label: 'Click', isSetup: false, selector: null, elementType: null, extra: null, options: { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } }] });
    expect(result!.steps).toHaveLength(1);
  });
});
```

---

## Section 14 — Verification

### Backend verification commands

```bash
cd c:/Users/und3r/blueberry-v3/backend

# Build
dotnet build

# Run migration (ensure Postgres is running first: pg_ctl -D "C:/Program Files/PostgreSQL/17/data" start)
dotnet ef database update --project src/WebScrape.Data --startup-project src/WebScrape.Server

# Run all tests
dotnet test

# Start server (port 5082)
cd src/WebScrape.Server && dotnet run
```

### Extension verification commands

```bash
cd c:/Users/und3r/blueberry-v3

# Type check
npm run typecheck

# Lint
npm run lint

# Unit tests
npm run test -- --reporter=verbose src/__tests__/syncStore.test.ts src/__tests__/storageMigrateV4.test.ts src/__tests__/apiTokenShim.test.ts

# Build
npm run build
```

### Manual end-to-end test script

**Test 1 — Config sync push (extension → backend):**
1. Open extension sidepanel, create a config called "Sync Test" with any steps.
2. In ConfigListItem, click the Wifi icon (Share). Badge should show "Synced" after a moment.
3. Open backend at `http://localhost:5082`. Navigate to Configs page.
4. Verify "Sync Test" appears with a "Synced" badge and "Imported from [worker name]" sub-row.

**Test 2 — Config sync pull (backend → extension):**
1. In backend ConfigEditor, create a new config and mark `shared = true` via the JSON editor (add `"shared": true` at top-level, or use PUT API directly). 
   - **Note**: In M5.2 the backend UI doesn't have a "Share" toggle button yet — that's in M5.3 scope. For now, test via the API directly:  
   `curl -X PUT http://localhost:5082/api/scraper-configs/{id} -H "Content-Type: application/json" -H "Cookie: ..." -d '{"name":"Backend Config","domain":"test.com","configJson":{...},"schemaVersion":4,"shared":true}'`
2. Disconnect and reconnect the extension (click Settings → Save in extension).
3. Verify the config appears in the extension's Saved tab with "Synced" badge.

**Test 3 — Conflict detection:**
1. With a shared config synced to the extension, edit it in the extension (don't save yet). 
2. Edit the same config in the backend ConfigEditor and save it.
3. Now save the extension edit.
4. On next connect/sync, conflict modal should appear showing both versions.
5. Pick "Keep my version" → extension version pushed to backend.
6. Verify backend shows extension's version.

**Test 4 — Conflict: keep backend version:**
1. Repeat Test 3 steps 1–4.
2. Pick "Keep backend version" → extension local copy updated to backend's version.
3. Verify extension config now matches what was on the backend.

**Test 5 — Subscriber warning:**
1. With a config synced to extension (from Test 1), open the config in backend ConfigEditor.
2. Verify the warning banner: "This config is being synced to 1 online extension (My Browser). Saving here updates everyone."
3. Disconnect extension. Refresh ConfigEditor. Warning banner should disappear.

**Test 6 — InlineConfig omitted for shared configs:**
1. Create a task using a shared config.
2. Dispatch the task from the backend.
3. In the extension console, verify the received `TASK_RECEIVED` message has `inlineConfig: null`.
4. Verify the task still executes correctly (extension looks up the config locally).

**Test 7 — Unshare:**
1. With a shared config, click the Wifi icon again to unshare.
2. Badge disappears.
3. Backend `/configs` page still shows the config.
4. Edit the config locally → no push to server.
5. Reconnect extension → no re-import from server.

---

## Known edge cases and decisions

| Case | Decision |
|---|---|
| Server assigns different ID (SuggestedId collision) | syncStore detects `result.config.id !== config.id`, deletes old, saves with new ID |
| Extension offline during push | `dirty=true` persists; push retried on next connect |
| Config deleted on backend while extension has local copy | Extension keeps local copy; on next pull, config not in server list; no action taken (per plan decision: no surprise deletes) |
| Backend-authored shared config with no `configJson.id` field | `serverToLocal` overrides with `sc.id` from server metadata |
| Concurrent conflict modal for multiple configs | Each config has its own conflict key in `conflicts` map; all can be open simultaneously |
| Shared config used in queue task; extension re-shares with different ID | Existing `queueStore` tasks reference old ID; they will fail to resolve. This is an edge case of ID collision (extremely rare with UUIDs). Acceptable for M5.2. |

---

## Files changed summary

**Backend** (PR 1–4):
- `NEW`: `backend/src/WebScrape.Data/Entities/ScraperConfigSubscription.cs`
- `NEW`: `backend/src/WebScrape.Data/Migrations/20260426XXXXXX_M5ConfigSync.cs` (generated)
- `EDIT`: `backend/src/WebScrape.Data/Entities/ScraperConfigEntity.cs` (3 new props)
- `EDIT`: `backend/src/WebScrape.Data/WebScrapeDbContext.cs` (new DbSet + entity config)
- `EDIT`: `backend/src/WebScrape.Data/Dto/ScraperConfigDto.cs` (sync fields + new DTOs)
- `EDIT`: `backend/src/WebScrape.Services/Interfaces/IScraperConfigService.cs` (outcome enum + new methods)
- `EDIT`: `backend/src/WebScrape.Services/Implementations/ScraperConfigService.cs` (full rewrite)
- `EDIT`: `backend/src/WebScrape.Services/Interfaces/IWorkerService.cs` (add GetWorkerByApiKeyAsync)
- `EDIT`: `backend/src/WebScrape.Services/Implementations/WorkerService.cs` (implement it)
- `EDIT`: `backend/src/WebScrape.Server/Controllers/ScraperConfigsController.cs` (full rewrite)
- `EDIT`: `backend/src/WebScrape.Services/Implementations/RunBatchService.cs` (conditional InlineConfig)
- `EDIT`: `backend/src/WebScrape.Client/src/api/types.ts` (sync fields)
- `EDIT`: `backend/src/WebScrape.Client/src/api/queries.ts` (add useScraperConfigSubscribers)
- `EDIT`: `backend/src/WebScrape.Client/src/pages/Configs.tsx` (shared badge + imported-from row)
- `EDIT`: `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx` (subscriber warning)
- `NEW`: `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceConflictTests.cs`

**Extension** (PR 5–6):
- `EDIT`: `src/types/config.ts` (sync fields on ScraperConfig)
- `EDIT`: `src/sidepanel/utils/storage.ts` (v4 migration, saveSharedConfig)
- `NEW`: `src/sidepanel/utils/syncClient.ts`
- `NEW`: `src/sidepanel/stores/syncStore.ts`
- `NEW`: `src/sidepanel/components/ConfigSyncStatus.tsx`
- `NEW`: `src/sidepanel/components/ConfigConflictDiffModal.tsx`
- `EDIT`: `src/sidepanel/components/ConfigListItem.tsx` (share toggle + status badge)
- `EDIT`: `src/sidepanel/stores/configStore.ts` (dirty flag on save)
- `EDIT`: `src/sidepanel/App.tsx` (trigger pull on connect)
- `NEW`: `src/__tests__/syncStore.test.ts`
- `NEW`: `src/__tests__/storageMigrateV4.test.ts`
