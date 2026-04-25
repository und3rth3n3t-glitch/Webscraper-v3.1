# SPEC-M2.2 — Task tree authoring + RunItemStatus enum refactor (v1.0)

**Author**: Opus (planning) → Sonnet (implementation)
**Milestone**: M2.2 (second sub-stage of M2 — Task authoring)
**Roadmap source**: [c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md), "Implementation sub-stages" → row M2.2
**Created against codebase state**: 2026-04-25 with M2.1 changes applied (build clean, 34 tests pass, migration `20260425163128_M2TaskBlocks` applied to local Postgres)

---

## 1. Context

M2.1 introduced the schema and entities for `task_blocks` + `run_batches`, backfilled the demo task as a 1-loop-1-scrape tree, and left `RunService.CreateAndDispatchAsync` reading from the new tree via the `ResolveLegacyDispatchShape` legacy path. There is still no API surface to **author** trees — POST `/api/tasks` takes a flat `CreateTaskDto` (ignored search terms, single scraper-config FK on the entity).

**M2.2 ships**:

1. **Wire DTOs** for the tree (`TaskBlockTreeDto`, `LoopBlockConfigDto`, `ScrapeBlockConfigDto`, `StepBindingDto`, `SaveTaskDto`, `ValidationErrorDto`).
2. **`TaskValidator`** — single-pass validator returning a typed error list (11 distinct codes).
3. **`TaskService.SaveAsync` / `DeleteAsync`** — replace-tree create/update + cascade delete (FK already cascades).
4. **`TasksController`** PUT / DELETE / refactored POST.
5. **AutoMapper** — `TaskEntity → TaskDto` now projects the full tree (`Blocks`).
6. **`Program.cs`** — global `JsonStringEnumConverter(JsonNamingPolicy.CamelCase)` for both controllers and SignalR. First sub-stage that puts enums on the wire.
7. **`RunItemStatus` enum refactor** — replace the M1 `static class RunItemStatus { public const string Pending = "pending"; ... }` with a real enum. Migration updates existing rows from lowercase to PascalCase. Wire format stays `"pending"` etc. via the new `JsonStringEnumConverter`.
8. **Frontend `types.ts`** mirror — adds `BlockType`, `BindingKind`, the new tree DTOs, and fixes the existing `scraperConfigId: string` → `string | null` (M2.1 broke nullability without updating the mirror).

**M2.2 does NOT ship**:

- Queue expansion service (M2.3)
- `POST /api/tasks/{id}/populate`, `POST /api/runs/batch`, `GET /api/run-batches/{id}` (M2.3)
- Extension `SetInputOptions.literalValue` (M2.4)
- Any frontend pages (M2.5+)

**Cascading impact** (call out for the user):

- M1's `POST /api/tasks` body shape changes from `CreateTaskDto { name, scraperConfigId, searchTerms[] }` to `SaveTaskDto { name, blocks: TaskBlockTreeDto[] }`. **No UI consumer exists** (frontend `Tasks.tsx` only reads — never POSTs tasks), so no break.
- AutoMapper map `TaskEntity → TaskDto` now emits a non-null `Blocks` array. Frontend `Tasks.tsx` (which only reads `searchTerms.length`) is unaffected — `searchTerms` derivation kept.
- `RunItem.Status` becomes `RunItemStatus` enum — all consumers (`RunService`, `WorkerService`, tests) compile unchanged because identifiers like `RunItemStatus.Pending` resolve the same way (static-class const → enum member).

---

## 2. Files added / modified / deleted

### New files

| Path | Purpose |
|---|---|
| `backend/src/WebScrape.Data/Enums/RunItemStatus.cs` | `enum RunItemStatus { Pending, Sent, Running, Paused, Completed, Failed, Cancelled }` |
| `backend/src/WebScrape.Data/Dto/TaskBlockDto.cs` | `TaskBlockTreeDto`, `LoopBlockConfigDto`, `ScrapeBlockConfigDto`, `StepBindingDto`, `SaveTaskDto` |
| `backend/src/WebScrape.Data/Dto/ValidationErrorDto.cs` | `ValidationErrorDto` (error code + optional context fields) |
| `backend/src/WebScrape.Services/Interfaces/ITaskValidator.cs` | `ITaskValidator` interface + `ValidationError` record |
| `backend/src/WebScrape.Services/Implementations/TaskValidator.cs` | The 11-code validator |
| `backend/src/WebScrape.Data/Migrations/<timestamp>_M2RunItemStatusEnum.cs` | One-shot SQL UPDATE to PascalCase existing `run_items.status` rows |
| `backend/tests/WebScrape.Tests/Services/TaskValidatorTests.cs` | One positive case per validation code + a happy nested-tree case |
| `backend/tests/WebScrape.Tests/Services/TaskServiceSaveTests.cs` | `SaveAsync` round-trip, replace-tree, cross-user, validation-fail-no-write, `DeleteAsync` cascade |

### Modified files

| Path | Change |
|---|---|
| `backend/src/WebScrape.Data/Entities/RunItem.cs` | Drop `static class RunItemStatus`; type `Status` as `RunItemStatus` enum; default `RunItemStatus.Pending` |
| `backend/src/WebScrape.Data/WebScrapeDbContext.cs` | `e.Property(x => x.Status).HasConversion<string>().IsRequired()` for the enum on `RunItem` |
| `backend/src/WebScrape.Data/Dto/TaskDto.cs` | Add `Blocks: List<TaskBlockTreeDto>`; remove `CreateTaskDto` (replaced by `SaveTaskDto` in `TaskBlockDto.cs`) |
| `backend/src/WebScrape.Data/Mapping/AutoMapperProfile.cs` | Add `TaskBlock → TaskBlockTreeDto`; add `.ForMember(d => d.Blocks, ...)` projection on `TaskEntity → TaskDto` |
| `backend/src/WebScrape.Services/Interfaces/ITaskService.cs` | Replace `CreateAsync(CreateTaskDto)` with `SaveAsync(Guid? taskId, SaveTaskDto)`, add `DeleteAsync(Guid taskId)` |
| `backend/src/WebScrape.Services/Implementations/TaskService.cs` | Implement `SaveAsync` + `DeleteAsync`; remove old `CreateAsync` |
| `backend/src/WebScrape.Server/Controllers/TasksController.cs` | Refactored POST + new PUT + new DELETE; consumes `SaveTaskDto`; returns `ValidationErrorDto[]` on 400 |
| `backend/src/WebScrape.Server/Program.cs` | Register `JsonStringEnumConverter(JsonNamingPolicy.CamelCase)` on both `AddControllers().AddJsonOptions(...)` and `AddSignalR().AddJsonProtocol(...)` |
| `backend/src/WebScrape.Server/Seed/InitialSeed.cs` | Tiny: change `RunItemStatus.Pending` references if any (none today — keep file untouched if the change isn't surfaced) |
| `backend/src/WebScrape.Data/Migrations/WebScrapeDbContextModelSnapshot.cs` | Auto-regenerated by `dotnet ef migrations add M2RunItemStatusEnum`; do not hand-edit |
| `backend/tests/WebScrape.Tests/Services/RunServiceTests.cs` | No code change needed — `RunItemStatus.Sent` etc. still resolve. Verify still green. |
| `backend/tests/WebScrape.Tests/Services/WorkerServiceTests.cs` | Same — verify still green. |

### Deleted code (inside files, not whole files)

- `RunItem.cs` lines 4–13 (the `static class RunItemStatus { const string ... }` block) — replaced by the new enum file.
- `TaskDto.cs` lines 18–25 (the `CreateTaskDto` class) — replaced by `SaveTaskDto`.
- `TaskService.cs` lines 43–63 (`CreateAsync` body and method) — replaced by `SaveAsync`.
- `TasksController.cs` lines 38–46 (the old `Create` action) — replaced by new POST that calls `SaveAsync`.

---

## 3. Complete code

### 3.1 New: `backend/src/WebScrape.Data/Enums/RunItemStatus.cs`

```csharp
namespace WebScrape.Data.Enums;

public enum RunItemStatus
{
    Pending,
    Sent,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}
```

### 3.2 Modified: `backend/src/WebScrape.Data/Entities/RunItem.cs` (full file after change)

```csharp
using System.Text.Json;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Entities;

public class RunItem
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public Guid? BatchId { get; set; }
    public RunItemStatus Status { get; set; } = RunItemStatus.Pending;
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonDocument? ResultJsonb { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PauseReason { get; set; }
    public int? ProgressPercent { get; set; }
    public string? CurrentTerm { get; set; }
    public string? CurrentStep { get; set; }
    public string? Phase { get; set; }
    public string? IterationLabel { get; set; }
    public JsonDocument? IterationAssignments { get; set; }
    public TaskEntity? Task { get; set; }
    public WorkerConnection? Worker { get; set; }
    public RunBatch? Batch { get; set; }
}
```

### 3.3 Modified: `backend/src/WebScrape.Data/WebScrapeDbContext.cs` — `RunItem` config block only

Replace **lines 96–108** with:

```csharp
        builder.Entity<RunItem>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Status).HasConversion<string>().IsRequired();
            e.Property(x => x.ResultJsonb).HasColumnType("jsonb").HasConversion(nullableJsonConverter);
            e.Property(x => x.IterationAssignments).HasColumnType("jsonb").HasConversion(nullableJsonConverter);
            e.HasOne(x => x.Task).WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Worker).WithMany().HasForeignKey(x => x.WorkerId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Batch).WithMany().HasForeignKey(x => x.BatchId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => new { x.TaskId, x.RequestedAt });
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.BatchId);
        });
```

(The only change is `.HasConversion<string>()` added to the `Status` property.)

### 3.4 New: EF migration `M2RunItemStatusEnum`

Generate with:

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet ef migrations add M2RunItemStatusEnum --project src/WebScrape.Data --startup-project src/WebScrape.Server
```

EF will autogenerate an empty migration (since `Status` is still a `text` column — only the converter changed, no schema diff). **Hand-edit the `Up` method body** to perform the data backfill:

```csharp
protected override void Up(MigrationBuilder migrationBuilder)
{
    // Translate existing lowercase status values to the PascalCase form that
    // EF's HasConversion<string>() now writes (matches the C# enum names).
    migrationBuilder.Sql("""
        UPDATE run_items SET status = CASE status
            WHEN 'pending'   THEN 'Pending'
            WHEN 'sent'      THEN 'Sent'
            WHEN 'running'   THEN 'Running'
            WHEN 'paused'    THEN 'Paused'
            WHEN 'completed' THEN 'Completed'
            WHEN 'failed'    THEN 'Failed'
            WHEN 'cancelled' THEN 'Cancelled'
            ELSE status
        END;
    """);
}

protected override void Down(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("""
        UPDATE run_items SET status = CASE status
            WHEN 'Pending'   THEN 'pending'
            WHEN 'Sent'      THEN 'sent'
            WHEN 'Running'   THEN 'running'
            WHEN 'Paused'    THEN 'paused'
            WHEN 'Completed' THEN 'completed'
            WHEN 'Failed'    THEN 'failed'
            WHEN 'Cancelled' THEN 'cancelled'
            ELSE status
        END;
    """);
}
```

If EF refuses to generate an empty migration ("No changes detected"), force-create it with `dotnet ef migrations add M2RunItemStatusEnum --force` — actually, the cleanest workaround is to add an `EmptyMigration` helper:

```bash
dotnet ef migrations add M2RunItemStatusEnum --project src/WebScrape.Data --startup-project src/WebScrape.Server -- --no-changes
```

If still empty, write the migration file by hand at `backend/src/WebScrape.Data/Migrations/<utc-timestamp>_M2RunItemStatusEnum.cs` using the body above; also create the matching `.Designer.cs` by copying from the M2.1 migration's Designer (only the timestamp + class name differ — the model snapshot is unchanged).

### 3.5 New: `backend/src/WebScrape.Data/Dto/ValidationErrorDto.cs`

```csharp
namespace WebScrape.Data.Dto;

public class ValidationErrorDto
{
    public string Code { get; set; } = "";
    public Guid? BlockId { get; set; }
    public Guid? LoopBlockId { get; set; }
    public Guid? ScraperConfigId { get; set; }
    public string? StepId { get; set; }
    public string? Message { get; set; }
}
```

### 3.6 New: `backend/src/WebScrape.Data/Dto/TaskBlockDto.cs`

```csharp
using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class TaskBlockTreeDto
{
    public Guid Id { get; set; }
    public Guid? ParentBlockId { get; set; }
    public BlockType BlockType { get; set; }
    public int OrderIndex { get; set; }
    // Exactly one of (Loop, Scrape) is non-null based on BlockType.
    // Validator enforces this; AutoMapper populates it on read.
    public LoopBlockConfigDto? Loop { get; set; }
    public ScrapeBlockConfigDto? Scrape { get; set; }
}

public class LoopBlockConfigDto
{
    public string Name { get; set; } = "";
    public List<string> Values { get; set; } = new();
}

public class ScrapeBlockConfigDto
{
    public Guid ScraperConfigId { get; set; }
    public Dictionary<string, StepBindingDto> StepBindings { get; set; } = new();
}

public class StepBindingDto
{
    public BindingKind Kind { get; set; }
    public string? Value { get; set; }            // when Kind == Literal
    public Guid? LoopBlockId { get; set; }        // when Kind == LoopRef
}

public class SaveTaskDto
{
    public string Name { get; set; } = "";
    public List<TaskBlockTreeDto> Blocks { get; set; } = new();
}
```

### 3.7 Modified: `backend/src/WebScrape.Data/Dto/TaskDto.cs` (full file after change)

```csharp
namespace WebScrape.Data.Dto;

public class TaskDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    // Deprecated since M2.1 — configs now live on scrape blocks.
    public Guid? ScraperConfigId { get; set; }
    public string ScraperConfigName { get; set; } = "";
    // Derived in AutoMapper from the root loop block's values when there is exactly one
    // root loop block (legacy 1-loop shape). Empty array otherwise. Kept on the wire so
    // the M1 Tasks.tsx page (which reads `t.searchTerms.length`) continues to render.
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public List<TaskBlockTreeDto> Blocks { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; }
}
```

(`CreateTaskDto` is removed — replaced by `SaveTaskDto` in `TaskBlockDto.cs`.)

### 3.8 New: `backend/src/WebScrape.Services/Interfaces/ITaskValidator.cs`

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public static class ValidationCodes
{
    public const string MissingTaskName            = "MISSING_TASK_NAME";
    public const string DuplicateBlockId           = "DUPLICATE_BLOCK_ID";
    public const string InvalidParentReference     = "INVALID_PARENT_REFERENCE";
    public const string TreeCycle                  = "TREE_CYCLE";
    public const string InvalidBlockConfig         = "INVALID_BLOCK_CONFIG";
    public const string MissingLoopName            = "MISSING_LOOP_NAME";
    public const string LoopRefNonAncestor         = "LOOP_REF_NON_ANCESTOR";
    public const string LoopRefMissing             = "LOOP_REF_MISSING";
    public const string LoopRefNotLoop             = "LOOP_REF_NOT_LOOP";
    public const string BindingLiteralMissingValue = "BINDING_LITERAL_MISSING_VALUE";
    public const string ConfigNotOwned             = "CONFIG_NOT_OWNED";
}

public interface ITaskValidator
{
    Task<List<ValidationErrorDto>> ValidateAsync(Guid userId, SaveTaskDto dto, CancellationToken ct = default);
}
```

### 3.9 New: `backend/src/WebScrape.Services/Implementations/TaskValidator.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class TaskValidator : ITaskValidator
{
    private readonly WebScrapeDbContext _db;

    public TaskValidator(WebScrapeDbContext db)
    {
        _db = db;
    }

    public async Task<List<ValidationErrorDto>> ValidateAsync(Guid userId, SaveTaskDto dto, CancellationToken ct = default)
    {
        var errors = new List<ValidationErrorDto>();

        if (string.IsNullOrWhiteSpace(dto.Name))
            errors.Add(new ValidationErrorDto { Code = ValidationCodes.MissingTaskName });

        // Pass 1: id uniqueness, parent-ref existence, type/payload shape.
        var byId = new Dictionary<Guid, TaskBlockTreeDto>();
        foreach (var block in dto.Blocks)
        {
            if (!byId.TryAdd(block.Id, block))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.DuplicateBlockId, BlockId = block.Id });
        }

        foreach (var block in dto.Blocks)
        {
            if (block.ParentBlockId.HasValue && !byId.ContainsKey(block.ParentBlockId.Value))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidParentReference, BlockId = block.Id });

            switch (block.BlockType)
            {
                case BlockType.Loop:
                    if (block.Loop is null)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Loop block missing 'loop' payload" });
                    else if (string.IsNullOrWhiteSpace(block.Loop.Name))
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.MissingLoopName, BlockId = block.Id });
                    break;
                case BlockType.Scrape:
                    if (block.Scrape is null)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Scrape block missing 'scrape' payload" });
                    else if (block.Scrape.ScraperConfigId == Guid.Empty)
                        errors.Add(new ValidationErrorDto { Code = ValidationCodes.InvalidBlockConfig, BlockId = block.Id, Message = "Scrape block missing scraperConfigId" });
                    break;
            }
        }

        // Pass 2: cycle detection. Walk parent chain from each block; detect re-visit.
        foreach (var block in dto.Blocks)
        {
            var seen = new HashSet<Guid> { block.Id };
            var cursor = block.ParentBlockId;
            while (cursor.HasValue)
            {
                if (!seen.Add(cursor.Value))
                {
                    errors.Add(new ValidationErrorDto { Code = ValidationCodes.TreeCycle, BlockId = block.Id });
                    break;
                }
                if (!byId.TryGetValue(cursor.Value, out var parent)) break;
                cursor = parent.ParentBlockId;
            }
        }

        // Pass 3: scrape blocks — bindings + config ownership.
        var configIds = dto.Blocks
            .Where(b => b.BlockType == BlockType.Scrape && b.Scrape is not null && b.Scrape.ScraperConfigId != Guid.Empty)
            .Select(b => b.Scrape!.ScraperConfigId)
            .Distinct()
            .ToList();

        var ownedConfigIds = configIds.Count == 0
            ? new HashSet<Guid>()
            : (await _db.ScraperConfigs
                .Where(c => c.UserId == userId && configIds.Contains(c.Id))
                .Select(c => c.Id)
                .ToListAsync(ct)).ToHashSet();

        foreach (var block in dto.Blocks.Where(b => b.BlockType == BlockType.Scrape && b.Scrape is not null))
        {
            var scrape = block.Scrape!;
            if (scrape.ScraperConfigId != Guid.Empty && !ownedConfigIds.Contains(scrape.ScraperConfigId))
                errors.Add(new ValidationErrorDto { Code = ValidationCodes.ConfigNotOwned, BlockId = block.Id, ScraperConfigId = scrape.ScraperConfigId });

            // Compute ancestor loop ids for this scrape block.
            var ancestors = new HashSet<Guid>();
            var cursor = block.ParentBlockId;
            while (cursor.HasValue && byId.TryGetValue(cursor.Value, out var parent))
            {
                ancestors.Add(parent.Id);
                cursor = parent.ParentBlockId;
            }

            foreach (var (stepId, binding) in scrape.StepBindings)
            {
                switch (binding.Kind)
                {
                    case BindingKind.Literal:
                        if (binding.Value is null)
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.BindingLiteralMissingValue, BlockId = block.Id, StepId = stepId });
                        break;
                    case BindingKind.LoopRef:
                        if (!binding.LoopBlockId.HasValue || !byId.ContainsKey(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefMissing, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (byId[binding.LoopBlockId.Value].BlockType != BlockType.Loop)
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNotLoop, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (!ancestors.Contains(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNonAncestor, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        break;
                    case BindingKind.Unbound:
                        // No further validation.
                        break;
                }
            }
        }

        return errors;
    }
}
```

### 3.10 Modified: `backend/src/WebScrape.Services/Interfaces/ITaskService.cs` (full file after change)

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum SaveTaskOutcome
{
    Created,
    Updated,
    NotFound,
    Forbidden,
    ValidationFailed,
}

public record SaveTaskResult(SaveTaskOutcome Outcome, TaskDto? Task, List<ValidationErrorDto> Errors);

public enum DeleteTaskOutcome
{
    Deleted,
    NotFound,
    Forbidden,
}

public interface ITaskService
{
    Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<SaveTaskResult> SaveAsync(Guid userId, Guid? taskId, SaveTaskDto dto, CancellationToken ct = default);
    Task<DeleteTaskOutcome> DeleteAsync(Guid userId, Guid taskId, CancellationToken ct = default);
}
```

### 3.11 Modified: `backend/src/WebScrape.Services/Implementations/TaskService.cs` (full file after change)

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

public class TaskService : ITaskService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly ITaskValidator _validator;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public TaskService(WebScrapeDbContext db, IMapper mapper, ITaskValidator validator)
    {
        _db = db;
        _mapper = mapper;
        _validator = validator;
    }

    public async Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .Include(t => t.Blocks)
            .Where(t => t.UserId == userId)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<TaskDto>>(rows);
    }

    public async Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .Include(t => t.Blocks)
            .FirstOrDefaultAsync(t => t.Id == id && t.UserId == userId, ct);
        return row is null ? null : _mapper.Map<TaskDto>(row);
    }

    public async Task<SaveTaskResult> SaveAsync(Guid userId, Guid? taskId, SaveTaskDto dto, CancellationToken ct = default)
    {
        var errors = await _validator.ValidateAsync(userId, dto, ct);
        if (errors.Count > 0)
            return new SaveTaskResult(SaveTaskOutcome.ValidationFailed, null, errors);

        TaskEntity task;
        bool isCreate;

        if (taskId.HasValue)
        {
            var existing = await _db.Tasks
                .Include(t => t.Blocks)
                .FirstOrDefaultAsync(t => t.Id == taskId.Value, ct);
            if (existing is null)
                return new SaveTaskResult(SaveTaskOutcome.NotFound, null, new());
            if (existing.UserId != userId)
                return new SaveTaskResult(SaveTaskOutcome.Forbidden, null, new());

            existing.Name = dto.Name;
            // Replace-tree: drop old blocks, re-insert from DTO.
            _db.TaskBlocks.RemoveRange(existing.Blocks);
            existing.Blocks.Clear();
            task = existing;
            isCreate = false;
        }
        else
        {
            task = new TaskEntity
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                Name = dto.Name,
                ScraperConfigId = null,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            _db.Tasks.Add(task);
            isCreate = true;
        }

        foreach (var blockDto in dto.Blocks)
        {
            var block = new TaskBlock
            {
                Id = blockDto.Id,
                TaskId = task.Id,
                ParentBlockId = blockDto.ParentBlockId,
                BlockType = blockDto.BlockType,
                OrderIndex = blockDto.OrderIndex,
                ConfigJsonb = SerializeBlockConfig(blockDto),
            };
            _db.TaskBlocks.Add(block);
        }

        await _db.SaveChangesAsync(ct);

        var saved = await GetAsync(userId, task.Id, ct);
        return new SaveTaskResult(isCreate ? SaveTaskOutcome.Created : SaveTaskOutcome.Updated, saved, new());
    }

    public async Task<DeleteTaskOutcome> DeleteAsync(Guid userId, Guid taskId, CancellationToken ct = default)
    {
        var task = await _db.Tasks.FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null) return DeleteTaskOutcome.NotFound;
        if (task.UserId != userId) return DeleteTaskOutcome.Forbidden;

        // FK on task_blocks (Cascade) and run_items (Cascade) does the rest.
        _db.Tasks.Remove(task);
        await _db.SaveChangesAsync(ct);
        return DeleteTaskOutcome.Deleted;
    }

    private static JsonDocument SerializeBlockConfig(TaskBlockTreeDto block)
    {
        return block.BlockType switch
        {
            BlockType.Loop   => JsonSerializer.SerializeToDocument(block.Loop ?? new LoopBlockConfigDto(), JsonOpts),
            BlockType.Scrape => JsonSerializer.SerializeToDocument(block.Scrape ?? new ScrapeBlockConfigDto(), JsonOpts),
            _ => JsonDocument.Parse("{}"),
        };
    }
}
```

### 3.12 Modified: `backend/src/WebScrape.Server/Controllers/TasksController.cs` (full file after change)

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/tasks")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class TasksController : ControllerBase
{
    private readonly ITaskService _tasks;

    public TasksController(ITaskService tasks)
    {
        _tasks = tasks;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        return Ok(await _tasks.ListAsync(GetUserId(), ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _tasks.GetAsync(GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] SaveTaskDto dto, CancellationToken ct)
    {
        var result = await _tasks.SaveAsync(GetUserId(), null, dto, ct);
        return Render(result, isCreate: true);
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveTaskDto dto, CancellationToken ct)
    {
        var result = await _tasks.SaveAsync(GetUserId(), id, dto, ct);
        return Render(result, isCreate: false);
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var outcome = await _tasks.DeleteAsync(GetUserId(), id, ct);
        return outcome switch
        {
            DeleteTaskOutcome.Deleted   => NoContent(),
            DeleteTaskOutcome.NotFound  => NotFound(),
            DeleteTaskOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    private IActionResult Render(SaveTaskResult result, bool isCreate)
    {
        return result.Outcome switch
        {
            SaveTaskOutcome.Created          => CreatedAtAction(nameof(Get), new { id = result.Task!.Id }, result.Task),
            SaveTaskOutcome.Updated          => Ok(result.Task),
            SaveTaskOutcome.ValidationFailed => BadRequest(new { errors = result.Errors }),
            SaveTaskOutcome.NotFound         => NotFound(),
            SaveTaskOutcome.Forbidden        => StatusCode(StatusCodes.Status403Forbidden),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    private Guid GetUserId() => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
}
```

### 3.13 Modified: `backend/src/WebScrape.Data/Mapping/AutoMapperProfile.cs` (full file after change)

```csharp
using System.Text.Json;
using AutoMapper;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Mapping;

public class AutoMapperProfile : Profile
{
    private static readonly JsonSerializerOptions DeserializeOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public AutoMapperProfile()
    {
        CreateMap<ApiKey, ApiKeyDto>();

        CreateMap<ScraperConfigEntity, ScraperConfigDto>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => s.ConfigJson.RootElement));

        CreateMap<CreateScraperConfigDto, ScraperConfigEntity>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => JsonDocument.Parse(s.ConfigJson.GetRawText(), default)));

        CreateMap<TaskBlock, TaskBlockTreeDto>()
            .ForMember(d => d.Loop,   o => o.MapFrom(s => s.BlockType == BlockType.Loop   ? DeserializeLoop(s.ConfigJsonb)   : null))
            .ForMember(d => d.Scrape, o => o.MapFrom(s => s.BlockType == BlockType.Scrape ? DeserializeScrape(s.ConfigJsonb) : null));

        CreateMap<TaskEntity, TaskDto>()
            .ForMember(d => d.ScraperConfigName, o => o.MapFrom(s => s.ScraperConfig != null ? s.ScraperConfig.Name : ""))
            .ForMember(d => d.SearchTerms, o => o.MapFrom(s => DeriveLegacySearchTerms(s)))
            .ForMember(d => d.Blocks, o => o.MapFrom(s => s.Blocks ?? new List<TaskBlock>()));

        CreateMap<WorkerConnection, WorkerDto>()
            .ForMember(d => d.Online, o => o.MapFrom(s => s.CurrentConnection != null));

        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));
    }

    private static LoopBlockConfigDto? DeserializeLoop(JsonDocument? doc)
    {
        if (doc is null) return null;
        try { return JsonSerializer.Deserialize<LoopBlockConfigDto>(doc.RootElement.GetRawText(), DeserializeOpts); }
        catch { return null; }
    }

    private static ScrapeBlockConfigDto? DeserializeScrape(JsonDocument? doc)
    {
        if (doc is null) return null;
        try { return JsonSerializer.Deserialize<ScrapeBlockConfigDto>(doc.RootElement.GetRawText(), DeserializeOpts); }
        catch { return null; }
    }

    private static string[] DeriveLegacySearchTerms(TaskEntity task)
    {
        var rootLoops = task.Blocks?.Where(b => b.ParentBlockId == null && b.BlockType == BlockType.Loop).ToList();
        if (rootLoops is null || rootLoops.Count != 1) return Array.Empty<string>();

        var configRoot = rootLoops[0].ConfigJsonb.RootElement;
        if (!configRoot.TryGetProperty("values", out var valuesElement) || valuesElement.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();

        var result = new List<string>(valuesElement.GetArrayLength());
        foreach (var v in valuesElement.EnumerateArray())
        {
            if (v.ValueKind == JsonValueKind.String) result.Add(v.GetString() ?? "");
        }
        return result.ToArray();
    }
}
```

### 3.14 Modified: `backend/src/WebScrape.Server/Program.cs` — JSON converter wiring only

Replace **lines 84–95** (the `AddSignalR` + `AddControllers` registrations) with:

```csharp
builder.Services.AddSignalR()
    .AddJsonProtocol(opts =>
    {
        opts.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        opts.PayloadSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

builder.Services.AddControllers()
    .AddJsonOptions(opts =>
    {
        opts.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        opts.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
        opts.JsonSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });
```

Also register `ITaskValidator`:

After **line 79** (`builder.Services.AddScoped<ITaskService, TaskService>();`), add:

```csharp
builder.Services.AddScoped<ITaskValidator, TaskValidator>();
```

### 3.15 Frontend: `backend/src/WebScrape.Client/src/api/types.ts` (full file after change)

```typescript
// Mirrors backend DTOs. Update in same PR as backend DTO changes.
// Source files:
//   backend/src/WebScrape.Data/Dto/AccountDtos.cs
//   backend/src/WebScrape.Data/Dto/ApiKeyDto.cs
//   backend/src/WebScrape.Data/Dto/TaskDto.cs
//   backend/src/WebScrape.Data/Dto/TaskBlockDto.cs
//   backend/src/WebScrape.Data/Dto/ValidationErrorDto.cs
//   backend/src/WebScrape.Data/Dto/WorkerDto.cs
//   backend/src/WebScrape.Data/Dto/RunItemDto.cs
//   backend/src/WebScrape.Data/Enums/BlockType.cs, BindingKind.cs, RunItemStatus.cs

export type AccountDto = {
  id: string;
  email: string;
  name: string | null;
};

export type ApiKeyDto = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreateApiKeyResponseDto = {
  id: string;
  name: string;
  prefix: string;
  token: string;
};

export const BlockType = {
  Loop: 'loop',
  Scrape: 'scrape',
} as const;
export type BlockType = (typeof BlockType)[keyof typeof BlockType];

export const BindingKind = {
  Literal: 'literal',
  LoopRef: 'loopRef',
  Unbound: 'unbound',
} as const;
export type BindingKind = (typeof BindingKind)[keyof typeof BindingKind];

export type LoopBlockConfigDto = {
  name: string;
  values: string[];
};

export type StepBindingDto =
  | { kind: 'literal'; value: string }
  | { kind: 'loopRef'; loopBlockId: string }
  | { kind: 'unbound' };

export type ScrapeBlockConfigDto = {
  scraperConfigId: string;
  stepBindings: Record<string, StepBindingDto>;
};

export type TaskBlockTreeDto = {
  id: string;
  parentBlockId: string | null;
  blockType: BlockType;
  orderIndex: number;
  loop?: LoopBlockConfigDto | null;
  scrape?: ScrapeBlockConfigDto | null;
};

export type SaveTaskDto = {
  name: string;
  blocks: TaskBlockTreeDto[];
};

export type ValidationErrorDto = {
  code: string;
  blockId?: string | null;
  loopBlockId?: string | null;
  scraperConfigId?: string | null;
  stepId?: string | null;
  message?: string | null;
};

export type TaskDto = {
  id: string;
  name: string;
  scraperConfigId: string | null;
  scraperConfigName: string;
  searchTerms: string[];
  blocks: TaskBlockTreeDto[];
  createdAt: string;
};

export type WorkerDto = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  extensionVersion: string | null;
};

export const RunItemStatus = {
  Pending: 'pending',
  Sent: 'sent',
  Running: 'running',
  Paused: 'paused',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type RunStatus = (typeof RunItemStatus)[keyof typeof RunItemStatus];

export type RunItemDto = {
  id: string;
  taskId: string;
  workerId: string;
  status: RunStatus;
  requestedAt: string;
  sentAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown | null;
  errorMessage: string | null;
  pauseReason: string | null;
  progressPercent: number | null;
  currentTerm: string | null;
  currentStep: string | null;
  phase: string | null;
};

export type CreateRunSuccess = { runItemId: string };

export const TERMINAL_STATUSES: RunStatus[] = [
  RunItemStatus.Completed,
  RunItemStatus.Failed,
  RunItemStatus.Cancelled,
];
```

### 3.16 New: `backend/tests/WebScrape.Tests/Services/TaskValidatorTests.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class TaskValidatorTests
{
    private static (TaskValidator validator, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId,
            UserId = userId,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = System.Text.Json.JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.SaveChanges();
        return (new TaskValidator(db), db, userId, configId);
    }

    [Fact]
    public async Task Happy_path_two_loops_one_scrape_returns_no_errors()
    {
        var (v, _, userId, configId) = Build();
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loop1,  BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "outer", Values = new() { "a", "b" } } },
                new TaskBlockTreeDto { Id = loop2,  ParentBlockId = loop1, BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "inner", Values = new() { "x", "y" } } },
                new TaskBlockTreeDto { Id = scrape, ParentBlockId = loop2, BlockType = BlockType.Scrape, OrderIndex = 0, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["step-1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop1 },
                    ["step-2"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop2 },
                    ["step-3"] = new StepBindingDto { Kind = BindingKind.Literal, Value = "hello" },
                    ["step-4"] = new StepBindingDto { Kind = BindingKind.Unbound },
                }}},
            },
        };

        var errors = await v.ValidateAsync(userId, dto);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Missing_task_name_returns_MISSING_TASK_NAME()
    {
        var (v, _, userId, _) = Build();
        var errors = await v.ValidateAsync(userId, new SaveTaskDto { Name = "  " });
        Assert.Contains(errors, e => e.Code == ValidationCodes.MissingTaskName);
    }

    [Fact]
    public async Task Duplicate_block_id_is_caught()
    {
        var (v, _, userId, _) = Build();
        var dup = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = dup, BlockType = BlockType.Loop, Loop = new() { Name = "a" } },
                new TaskBlockTreeDto { Id = dup, BlockType = BlockType.Loop, Loop = new() { Name = "b" } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.DuplicateBlockId && e.BlockId == dup);
    }

    [Fact]
    public async Task Invalid_parent_reference_is_caught()
    {
        var (v, _, userId, _) = Build();
        var orphan = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new() { new TaskBlockTreeDto { Id = orphan, ParentBlockId = Guid.NewGuid(), BlockType = BlockType.Loop, Loop = new() { Name = "a" } } },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.InvalidParentReference && e.BlockId == orphan);
    }

    [Fact]
    public async Task Tree_cycle_is_caught()
    {
        var (v, _, userId, _) = Build();
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = a, ParentBlockId = b, BlockType = BlockType.Loop, Loop = new() { Name = "a" } },
                new TaskBlockTreeDto { Id = b, ParentBlockId = a, BlockType = BlockType.Loop, Loop = new() { Name = "b" } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.TreeCycle);
    }

    [Fact]
    public async Task Loop_block_missing_payload_returns_INVALID_BLOCK_CONFIG()
    {
        var (v, _, userId, _) = Build();
        var id = Guid.NewGuid();
        var dto = new SaveTaskDto { Name = "T", Blocks = new() { new TaskBlockTreeDto { Id = id, BlockType = BlockType.Loop, Loop = null } } };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.InvalidBlockConfig && e.BlockId == id);
    }

    [Fact]
    public async Task Missing_loop_name_is_caught()
    {
        var (v, _, userId, _) = Build();
        var id = Guid.NewGuid();
        var dto = new SaveTaskDto { Name = "T", Blocks = new() { new TaskBlockTreeDto { Id = id, BlockType = BlockType.Loop, Loop = new() { Name = "" } } } };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.MissingLoopName && e.BlockId == id);
    }

    [Fact]
    public async Task Loop_ref_to_non_ancestor_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            // loop1 and loop2 are siblings; scrape is under loop1 only — referencing loop2 must fail.
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loop1, BlockType = BlockType.Loop, Loop = new() { Name = "l1" } },
                new TaskBlockTreeDto { Id = loop2, BlockType = BlockType.Loop, Loop = new() { Name = "l2" } },
                new TaskBlockTreeDto { Id = scrape, ParentBlockId = loop1, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop2 },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefNonAncestor && e.LoopBlockId == loop2);
    }

    [Fact]
    public async Task Loop_ref_missing_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var scrape = Guid.NewGuid();
        var phantom = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = phantom },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefMissing && e.LoopBlockId == phantom);
    }

    [Fact]
    public async Task Loop_ref_to_non_loop_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var notALoop = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = notALoop, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId } },
                new TaskBlockTreeDto { Id = scrape,   ParentBlockId = notALoop, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = notALoop },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefNotLoop && e.LoopBlockId == notALoop);
    }

    [Fact]
    public async Task Literal_binding_missing_value_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.Literal, Value = null },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.BindingLiteralMissingValue && e.StepId == "s1");
    }

    [Fact]
    public async Task Config_not_owned_is_caught()
    {
        var (v, _, userId, _) = Build();
        var foreignConfig = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = foreignConfig } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.ConfigNotOwned && e.ScraperConfigId == foreignConfig);
    }
}
```

### 3.17 New: `backend/tests/WebScrape.Tests/Services/TaskServiceSaveTests.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class TaskServiceSaveTests
{
    private static (TaskService svc, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId,
            UserId = userId,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.SaveChanges();
        var svc = new TaskService(db, TestDb.CreateMapper(), new TaskValidator(db));
        return (svc, db, userId, configId);
    }

    private static SaveTaskDto MakeTree(Guid configId, params string[] values)
    {
        var loopId = Guid.NewGuid();
        var scrapeId = Guid.NewGuid();
        return new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loopId,   BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "loop1", Values = values.ToList() } },
                new TaskBlockTreeDto { Id = scrapeId, ParentBlockId = loopId, BlockType = BlockType.Scrape, OrderIndex = 0, Scrape = new() { ScraperConfigId = configId, StepBindings = new() } },
            },
        };
    }

    [Fact]
    public async Task SaveAsync_create_writes_blocks_and_returns_dto()
    {
        var (svc, db, userId, configId) = Build();
        var dto = MakeTree(configId, "alpha", "beta");

        var result = await svc.SaveAsync(userId, null, dto);

        Assert.Equal(SaveTaskOutcome.Created, result.Outcome);
        Assert.NotNull(result.Task);
        Assert.Equal(2, result.Task!.Blocks.Count);
        Assert.Equal(new[] { "alpha", "beta" }, result.Task.SearchTerms);
        Assert.Equal(2, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task SaveAsync_update_replaces_tree()
    {
        var (svc, db, userId, configId) = Build();
        var first = await svc.SaveAsync(userId, null, MakeTree(configId, "a", "b"));
        var taskId = first.Task!.Id;

        var second = await svc.SaveAsync(userId, taskId, MakeTree(configId, "x"));

        Assert.Equal(SaveTaskOutcome.Updated, second.Outcome);
        Assert.Equal(2, await db.TaskBlocks.CountAsync()); // 1 loop + 1 scrape under the updated task
        Assert.Equal(new[] { "x" }, second.Task!.SearchTerms);
    }

    [Fact]
    public async Task SaveAsync_returns_forbidden_for_other_users_task()
    {
        var (svc, _, userId, configId) = Build();
        var first = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var taskId = first.Task!.Id;

        var asOther = await svc.SaveAsync(Guid.NewGuid(), taskId, MakeTree(configId, "b"));
        Assert.Equal(SaveTaskOutcome.Forbidden, asOther.Outcome);
    }

    [Fact]
    public async Task SaveAsync_returns_validation_failed_without_writing()
    {
        var (svc, db, userId, _) = Build();
        var phantomConfig = Guid.NewGuid();
        var bad = MakeTree(phantomConfig, "a"); // CONFIG_NOT_OWNED

        var result = await svc.SaveAsync(userId, null, bad);

        Assert.Equal(SaveTaskOutcome.ValidationFailed, result.Outcome);
        Assert.NotEmpty(result.Errors);
        Assert.Equal(0, await db.Tasks.CountAsync());
        Assert.Equal(0, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task SaveAsync_returns_not_found_for_unknown_taskId()
    {
        var (svc, _, userId, configId) = Build();
        var result = await svc.SaveAsync(userId, Guid.NewGuid(), MakeTree(configId, "a"));
        Assert.Equal(SaveTaskOutcome.NotFound, result.Outcome);
    }

    [Fact]
    public async Task DeleteAsync_removes_task_and_cascades_blocks()
    {
        var (svc, db, userId, configId) = Build();
        var created = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var outcome = await svc.DeleteAsync(userId, created.Task!.Id);

        Assert.Equal(DeleteTaskOutcome.Deleted, outcome);
        Assert.Equal(0, await db.Tasks.CountAsync());
        Assert.Equal(0, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_returns_forbidden_for_other_users_task()
    {
        var (svc, _, userId, configId) = Build();
        var created = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var outcome = await svc.DeleteAsync(Guid.NewGuid(), created.Task!.Id);
        Assert.Equal(DeleteTaskOutcome.Forbidden, outcome);
    }

    [Fact]
    public async Task DeleteAsync_returns_not_found_for_missing_task()
    {
        var (svc, _, userId, _) = Build();
        var outcome = await svc.DeleteAsync(userId, Guid.NewGuid());
        Assert.Equal(DeleteTaskOutcome.NotFound, outcome);
    }
}
```

---

## 4. Function order / file structure after changes

### `WebScrape.Data` project tree (new + modified items in **bold**)

```
WebScrape.Data/
├── Dto/
│   ├── ...
│   ├── TaskDto.cs                    ← modified (add Blocks, remove CreateTaskDto)
│   ├── **TaskBlockDto.cs**           ← NEW (TaskBlockTreeDto, LoopBlockConfigDto, ScrapeBlockConfigDto, StepBindingDto, SaveTaskDto)
│   └── **ValidationErrorDto.cs**     ← NEW
├── Enums/
│   ├── BindingKind.cs
│   ├── BlockType.cs
│   └── **RunItemStatus.cs**          ← NEW
├── Entities/
│   ├── ...
│   └── RunItem.cs                    ← modified (drop static class, type Status as enum)
├── Mapping/
│   └── AutoMapperProfile.cs          ← modified (TaskBlock map + TaskEntity.Blocks projection)
├── Migrations/
│   ├── 20260425122515_Initial.cs
│   ├── 20260425163128_M2TaskBlocks.cs
│   ├── **<new-timestamp>_M2RunItemStatusEnum.cs**  ← NEW (one-shot SQL UPDATE)
│   └── WebScrapeDbContextModelSnapshot.cs          ← auto-regenerated
└── WebScrapeDbContext.cs             ← modified (HasConversion<string>() on RunItem.Status)
```

### `WebScrape.Services` project tree

```
WebScrape.Services/
├── Implementations/
│   ├── ...
│   ├── TaskService.cs                ← modified (rewrite SaveAsync + DeleteAsync)
│   └── **TaskValidator.cs**          ← NEW
└── Interfaces/
    ├── ...
    ├── ITaskService.cs               ← modified (Save + Delete)
    └── **ITaskValidator.cs**         ← NEW
```

### `TaskService.cs` function order after change

1. Constructor
2. `ListAsync`
3. `GetAsync`
4. `SaveAsync`
5. `DeleteAsync`
6. `SerializeBlockConfig` (private static helper)

---

## 5. Verification

### Build + migration

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet build WebScrape.sln

# Generate the migration
dotnet ef migrations add M2RunItemStatusEnum --project src/WebScrape.Data --startup-project src/WebScrape.Server
# Hand-edit Up()/Down() per Section 3.4 if EF generated empty bodies.

# Apply (stop the running backend first if it has the DB locked)
dotnet ef database update --project src/WebScrape.Data --startup-project src/WebScrape.Server
```

### Unit tests

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet test tests/WebScrape.Tests
```

Expected: 34 (M2.1) + 12 (TaskValidator) + 8 (TaskServiceSave) = **54 tests passing**.

### Manual smoke

1. Restart the backend (`dotnet run --project src/WebScrape.Server` from `backend/`).
2. In psql, verify `SELECT id, status FROM run_items LIMIT 5;` — values should be PascalCase (`Pending`, `Sent`, etc.) if any run rows exist. If the table is empty, the migration is a no-op (still safe).
3. Login at `http://localhost:5173` (frontend), navigate to `/tasks`. The seeded demo task should still render with `2 terms` (proves the legacy `searchTerms` derivation still works through the new AutoMapper map).
4. From the frontend (or curl with cookie + CSRF) — POST `/api/tasks` with a valid 2-loop tree → 201 returned, task appears in `/tasks`. Validation negative test: POST a tree with a non-ancestor `loopRef` → 400, body `{ errors: [{ code: "LOOP_REF_NON_ANCESTOR", ... }] }`.
5. **M1 single-run regression** — `/tasks` → "Run on…" → demo task → run completes (proves `RunItemStatus` refactor preserves the dispatch flow end-to-end).

### Edge cases — explicit decisions

| Case | Decision |
|---|---|
| `JsonStringEnumConverter` collides with existing camelCase property naming | No collision — `JsonNamingPolicy.CamelCase` applies to both property names AND enum value names independently. Verified at compile + runtime via tests. |
| Empty `loop.values` array | **Cover** (no validation error) — matches M2.1 dispatch behaviour. M2.3 expansion will treat as 1 iteration with empty assignment for that loop. |
| Empty `dto.Blocks` array | **Cover** (no validation error) — empty trees save fine; `RunService` legacy path returns `NotFound` because no scrape block exists. |
| Block id collision across users | Impossible — id is the primary key; conflict raises a DB exception. (Frontend should always generate fresh `crypto.randomUUID()` per block.) |
| Update with stale tree from another tab | **Ignore (M5)** — last-write-wins. No `UpdatedAt` concurrency check yet. |
| EF generates empty migration for M2RunItemStatusEnum | **Cover** — see Section 3.4 fallback (write the file by hand if `--no-changes` doesn't work). |
| Existing `RunService.cs` references `RunItemStatus.Pending` (now an enum member) | Compiles unchanged — same identifier resolves to the new enum value. |
| `RunItemStatus` enum on the wire breaks frontend `RunStatus` literal type | **Cover** — `JsonStringEnumConverter(camelCase)` outputs `"pending"` etc.; the new TS const map keeps the same string literals. |

---

## 6. Out-of-scope notes (NOT for M2.2)

These belong to later sub-stages — Sonnet must not touch them:
- `QueueExpansionService`, `RunBatchService`, `POST /api/tasks/{id}/populate`, `POST /api/runs/batch`, `GET /api/run-batches/{id}` → M2.3.
- Extension `SetInputOptions.literalValue` patch → M2.4.
- Frontend Configs page, Task editor, RunBatch detail → M2.5–M2.7.
- WebApplicationFactory-based controller integration tests — current pattern is service-layer only; defer.
- `UpdatedAt` / row-version concurrency control on tasks → M5.

---

## 7. Definition of done (M2.2)

- [ ] `dotnet build WebScrape.sln` succeeds with no new warnings.
- [ ] `M2RunItemStatusEnum` migration applies cleanly to local PG17 DB (no-op on empty `run_items`, transforms rows otherwise).
- [ ] `dotnet test tests/WebScrape.Tests` — 54 tests passing.
- [ ] `POST /api/tasks` (valid tree) → 201, returns full `TaskDto.Blocks`.
- [ ] `PUT /api/tasks/{id}` (valid tree) → 200, returns full `TaskDto.Blocks`.
- [ ] `DELETE /api/tasks/{id}` → 204; cascade-deletes all `task_blocks`.
- [ ] `POST /api/tasks` with non-ancestor `loopRef` → 400 with typed error array.
- [ ] M1 single-run dispatch end-to-end: extension worker receives task and `/runs/{id}` shows `Completed`.
- [ ] Frontend `/tasks` list still shows "2 terms" for the seeded demo task (legacy derivation intact).
- [ ] No code added for M2.3+ scope items.
