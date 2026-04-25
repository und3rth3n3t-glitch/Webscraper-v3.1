# SPEC-M2.3 — Queue expansion + batch dispatch (v1.0)

**Author**: Opus (planning) → Sonnet (implementation)
**Milestone**: M2.3 (third sub-stage of M2 — Task authoring)
**Roadmap source**: [c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md), "Implementation sub-stages" → row M2.3
**Depends on**: SPEC-M2.2 (must be merged and applied first)

---

## 1. Context

M2.2 makes task-tree authoring REST-callable but tasks still run **only** via M1's legacy single-run path (`POST /api/runs` → `RunService.CreateAndDispatchAsync`), which dispatches one `QueueTaskDto` with the loop block's values flattened into `searchTerms[]`. Multi-loop trees, multi-scrape trees, and per-step bindings are **invisible** to the runtime.

**M2.3 ships**:

1. **Visitor-pattern expansion** — `IBlockExpander` interface + `LoopBlockExpander` + `ScrapeBlockExpander`, registered in DI per the roadmap's dispatcher pattern (`lets-plan-m2-splendid-flurry.md:124–134`).
2. **`QueueExpansionService`** — walks a task tree, computes the cartesian product over ancestor loops per scrape leaf, builds per-iteration `iterationLabel` and `iterationAssignments`, and produces patched `inlineConfig` objects with `step.options.literalValue` baked per setInput step.
3. **Hard cap = 1000 expansions** per task; reject populate/batch with 422 `BATCH_TOO_LARGE`.
4. **`POST /api/tasks/{id}/populate`** — preview-only endpoint. Returns the full expansion list + warnings without writing or dispatching.
5. **`RunBatchService` + `POST /api/runs/batch`** — expands, snapshots, creates `run_batches` row, creates N `run_items` linked to the batch, dispatches each via SignalR. Per-item dispatch failures don't abort siblings.
6. **`GET /api/run-batches/{id}`** — returns batch metadata + child run_items list (status grid for M2.7 frontend).
7. **`QueueTaskDto`** gets two additive fields: `iterationLabel` and `iterationAssignments`. Backwards-compatible with M1 extensions (they ignore unknown fields).
8. **Snapshot at populate time** — `run_batches.populate_snapshot` JSONB freezes the task tree + each referenced config's full `configJson` so live edits to the task or config after batch creation never affect dispatched runs.
9. **`RunService.CreateAndDispatchAsync` (M1 path)** — left **untouched**. M1 RunDetail page (`/runs/{id}`) keeps working unmodified.

**M2.3 does NOT ship**:

- Extension `SetInputOptions.literalValue` patch → M2.4 (without that patch, multi-loop runs against an extension that ignores `literalValue` will type empty strings; M2.4 lands together with M2.3 to make the e2e demo work — see SPEC-M2.4).
- Any frontend pages → M2.5–M2.7.

---

## 2. Files added / modified / deleted

### New files

| Path | Purpose |
|---|---|
| `backend/src/WebScrape.Services/Expansion/IBlockExpander.cs` | Visitor interface + `ExpansionFrame` + `ExpansionContext` records |
| `backend/src/WebScrape.Services/Expansion/LoopBlockExpander.cs` | Loop expander |
| `backend/src/WebScrape.Services/Expansion/ScrapeBlockExpander.cs` | Scrape expander (terminal) |
| `backend/src/WebScrape.Services/Implementations/QueueExpansionService.cs` | Public expansion entry point |
| `backend/src/WebScrape.Services/Interfaces/IQueueExpansionService.cs` | Interface for the above |
| `backend/src/WebScrape.Services/Implementations/RunBatchService.cs` | Batch creation + dispatch |
| `backend/src/WebScrape.Services/Interfaces/IRunBatchService.cs` | Interface for the above |
| `backend/src/WebScrape.Server/Controllers/RunBatchesController.cs` | `GET /api/run-batches/{id}` |
| `backend/src/WebScrape.Data/Dto/ExpansionDtos.cs` | `ExpansionPreviewDto`, `ExpandedItemDto`, `ExpansionWarningDto`, `RunBatchDetailDto`, `CreateBatchDto`, `BatchDispatchResultDto` |
| `backend/tests/WebScrape.Tests/Services/QueueExpansionServiceTests.cs` | Cartesian / cap / warnings cases |
| `backend/tests/WebScrape.Tests/Services/RunBatchServiceTests.cs` | Snapshot / dispatch / partial-failure cases |

### Modified files

| Path | Change |
|---|---|
| `backend/src/WebScrape.Data/Dto/QueueTaskDto.cs` | Add `IterationLabel: string?` and `IterationAssignments: Dictionary<string, string>?` |
| `backend/src/WebScrape.Server/Controllers/TasksController.cs` | Add `[HttpPost("{id:guid}/populate")]` action delegating to `IQueueExpansionService` |
| `backend/src/WebScrape.Server/Controllers/RunsController.cs` | Add `[HttpPost("batch")]` action delegating to `IRunBatchService` |
| `backend/src/WebScrape.Server/Program.cs` | DI registrations: `IBlockExpander` (Loop + Scrape), `IQueueExpansionService`, `IRunBatchService` |
| `backend/src/WebScrape.Client/src/api/types.ts` | Add expansion / batch DTOs |
| `backend/src/WebScrape.Client/src/api/queries.ts` | Add `useTaskExpansion(taskId)` and `useRunBatch(batchId)` queries |
| `backend/src/WebScrape.Client/src/api/mutations.ts` | Add `usePopulateTask()` and `useCreateBatch()` mutations |

### Deleted code

Nothing deleted. M1 single-run path stays intact.

---

## 3. Complete code

### 3.1 New: `backend/src/WebScrape.Services/Expansion/IBlockExpander.cs`

```csharp
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

// One expansion frame represents the assignments active at a given depth
// during the cartesian walk. `LoopAssignments` keys are loop block ids
// (NOT names — names can be renamed; ids are immutable across saves).
public record ExpansionFrame(IReadOnlyDictionary<Guid, string> LoopAssignments);

// Context passed top-down so expanders can reach siblings/children of the
// current block + look up loop names for label rendering.
public class ExpansionContext
{
    public required IReadOnlyList<TaskBlock> AllBlocks { get; init; }
    public required IReadOnlyDictionary<Guid, TaskBlock> BlocksById { get; init; }
    // loopBlockId -> human name from LoopBlockConfig.Name, captured at expansion time.
    public required IReadOnlyDictionary<Guid, string> LoopNamesById { get; init; }
    // Maps scraperConfigId -> the cloned configJson (already deep-copied per leaf).
    public required IReadOnlyDictionary<Guid, ScraperConfigEntity> ConfigsById { get; init; }
    public List<ExpansionWarning> Warnings { get; } = new();
}

public record ExpansionWarning(string Code, Guid? BlockId = null, Guid? ScraperConfigId = null, string? StepId = null);

public static class ExpansionWarningCodes
{
    public const string BindingUnbound          = "BINDING_UNBOUND";              // step has no binding entry; resolved to ""
    public const string StepNoLongerExists      = "STEP_NO_LONGER_EXISTS";        // bound step id missing from live config
    public const string NewStepUnbound          = "NEW_STEP_UNBOUND";             // setInput step in config has no binding
    public const string ConfigNotFoundAtPopulate = "CONFIG_NOT_FOUND_AT_POPULATE"; // referenced config was deleted
}

// Result emitted by the visitor — one per scrape leaf × cartesian tuple.
public record ExpansionResult(
    Guid ScrapeBlockId,
    Guid ScraperConfigId,
    string ConfigName,
    Dictionary<Guid, string> Assignments,        // loopBlockId -> value
    string IterationLabel,                       // "loop1=alpha, loop2=widget" — display only
    System.Text.Json.JsonElement PatchedConfigJson); // cloned configJson with literalValue baked

public interface IBlockExpander
{
    BlockType Handles { get; }
    IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame);
}
```

### 3.2 New: `backend/src/WebScrape.Services/Expansion/LoopBlockExpander.cs`

```csharp
using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class LoopBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Loop;

    private readonly IReadOnlyDictionary<BlockType, IBlockExpander> _byType;

    public LoopBlockExpander(IEnumerable<IBlockExpander> all)
    {
        // We intentionally take ALL expanders so the loop can dispatch to children
        // of any future block type without the recursion knowing about it.
        _byType = all.ToDictionary(e => e.Handles);
    }

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var values = ReadLoopValues(block);
        var children = ctx.AllBlocks
            .Where(b => b.ParentBlockId == block.Id)
            .OrderBy(b => b.OrderIndex)
            .ToList();

        // Edge case: empty values means this loop contributes a single frame with
        // empty assignment for this loop's id. Matches M2.1 dispatch behaviour and
        // avoids silently dropping branches the user can't see.
        var iterationValues = values.Count == 0 ? new List<string> { "" } : values;

        foreach (var value in iterationValues)
        {
            var nextAssignments = new Dictionary<Guid, string>(frame.LoopAssignments) { [block.Id] = value };
            var nextFrame = new ExpansionFrame(nextAssignments);

            foreach (var child in children)
            {
                if (!_byType.TryGetValue(child.BlockType, out var expander)) continue;
                foreach (var result in expander.Expand(child, ctx, nextFrame))
                    yield return result;
            }
        }
    }

    private static List<string> ReadLoopValues(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;
        if (!root.TryGetProperty("values", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return new();
        var list = new List<string>(arr.GetArrayLength());
        foreach (var v in arr.EnumerateArray())
            if (v.ValueKind == JsonValueKind.String) list.Add(v.GetString() ?? "");
        return list;
    }
}
```

### 3.3 New: `backend/src/WebScrape.Services/Expansion/ScrapeBlockExpander.cs`

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class ScrapeBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Scrape;

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var (scraperConfigId, stepBindings) = ReadScrapeConfig(block);
        if (!ctx.ConfigsById.TryGetValue(scraperConfigId, out var config))
        {
            ctx.Warnings.Add(new ExpansionWarning(
                ExpansionWarningCodes.ConfigNotFoundAtPopulate,
                BlockId: block.Id,
                ScraperConfigId: scraperConfigId));
            yield break;
        }

        var node = JsonNode.Parse(config.ConfigJson.RootElement.GetRawText())!.AsObject();
        node["id"] = config.Id.ToString();

        var liveSetInputStepIds = new HashSet<string>();
        if (node["steps"] is JsonArray stepsArr)
        {
            foreach (var stepNode in stepsArr.OfType<JsonObject>())
            {
                if (stepNode["type"]?.GetValue<string>() != "setInput") continue;
                var stepId = stepNode["id"]?.GetValue<string>();
                if (string.IsNullOrEmpty(stepId)) continue;
                liveSetInputStepIds.Add(stepId);

                var (resolved, warning) = ResolveBinding(stepId, stepBindings, frame);
                if (warning is not null)
                    ctx.Warnings.Add(warning with { BlockId = block.Id, ScraperConfigId = config.Id, StepId = stepId });

                if (stepNode["options"] is not JsonObject options)
                {
                    options = new JsonObject();
                    stepNode["options"] = options;
                }
                options["literalValue"] = resolved;
            }
        }

        // Warn for bindings that reference steps no longer in the live config.
        foreach (var stepId in stepBindings.Keys)
        {
            if (!liveSetInputStepIds.Contains(stepId))
                ctx.Warnings.Add(new ExpansionWarning(
                    ExpansionWarningCodes.StepNoLongerExists,
                    BlockId: block.Id,
                    ScraperConfigId: config.Id,
                    StepId: stepId));
        }

        var patched = JsonSerializer.SerializeToElement(node);
        var label = BuildIterationLabel(frame.LoopAssignments, ctx.LoopNamesById);

        yield return new ExpansionResult(
            ScrapeBlockId: block.Id,
            ScraperConfigId: config.Id,
            ConfigName: config.Name,
            Assignments: new Dictionary<Guid, string>(frame.LoopAssignments),
            IterationLabel: label,
            PatchedConfigJson: patched);
    }

    private static (string scraperConfigId, Dictionary<string, BindingPayload> bindings) ReadScrapeConfig(TaskBlock block)
    {
        // (named tuple chosen for clarity; using local record below)
        var root = block.ConfigJsonb.RootElement;
        var configIdStr = root.TryGetProperty("scraperConfigId", out var cid) && cid.ValueKind == JsonValueKind.String
            ? cid.GetString() ?? "" : "";
        if (!Guid.TryParse(configIdStr, out var configId))
            return (configIdStr, new());

        var bindings = new Dictionary<string, BindingPayload>();
        if (root.TryGetProperty("stepBindings", out var b) && b.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in b.EnumerateObject())
            {
                var kindStr = prop.Value.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String
                    ? k.GetString() : null;
                if (kindStr is null) continue;

                var payload = new BindingPayload(kindStr,
                    prop.Value.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null,
                    prop.Value.TryGetProperty("loopBlockId", out var l) && l.ValueKind == JsonValueKind.String && Guid.TryParse(l.GetString(), out var lg) ? lg : null);
                bindings[prop.Name] = payload;
            }
        }
        return (configId.ToString(), bindings);
    }

    private record BindingPayload(string Kind, string? Value, Guid? LoopBlockId);

    private static (string resolved, ExpansionWarning? warning) ResolveBinding(string stepId, Dictionary<string, BindingPayload> bindings, ExpansionFrame frame)
    {
        if (!bindings.TryGetValue(stepId, out var binding))
            return ("", new ExpansionWarning(ExpansionWarningCodes.NewStepUnbound));

        switch (binding.Kind)
        {
            case "literal":
                return (binding.Value ?? "", null);
            case "loopRef":
                if (binding.LoopBlockId.HasValue && frame.LoopAssignments.TryGetValue(binding.LoopBlockId.Value, out var v))
                    return (v, null);
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
            case "unbound":
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
            default:
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
        }
    }

    private static string BuildIterationLabel(IReadOnlyDictionary<Guid, string> assignments, IReadOnlyDictionary<Guid, string> loopNames)
    {
        if (assignments.Count == 0) return "";
        return string.Join(", ", assignments.Select(kv => $"{(loopNames.TryGetValue(kv.Key, out var n) ? n : kv.Key.ToString())}={kv.Value}"));
    }
}
```

### 3.4 New: `backend/src/WebScrape.Services/Interfaces/IQueueExpansionService.cs`

```csharp
using WebScrape.Data.Dto;
using WebScrape.Services.Expansion;

namespace WebScrape.Services.Interfaces;

public enum ExpansionOutcome
{
    Ok,
    NotFound,
    Forbidden,
    BatchEmpty,
    BatchTooLarge,
}

public record ExpansionPreview(
    ExpansionOutcome Outcome,
    int Count,
    List<ExpansionResult> Results,
    List<ExpansionWarning> Warnings,
    string? Error = null);

public interface IQueueExpansionService
{
    public const int BatchCap = 1000;

    Task<ExpansionPreview> ExpandAsync(Guid userId, Guid taskId, CancellationToken ct = default);
}
```

### 3.5 New: `backend/src/WebScrape.Services/Implementations/QueueExpansionService.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Expansion;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class QueueExpansionService : IQueueExpansionService
{
    private readonly WebScrapeDbContext _db;
    private readonly IReadOnlyDictionary<BlockType, IBlockExpander> _expandersByType;

    public QueueExpansionService(WebScrapeDbContext db, IEnumerable<IBlockExpander> expanders)
    {
        _db = db;
        _expandersByType = expanders.ToDictionary(e => e.Handles);
    }

    public async Task<ExpansionPreview> ExpandAsync(Guid userId, Guid taskId, CancellationToken ct = default)
    {
        var task = await _db.Tasks
            .Include(t => t.Blocks)
            .FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null)
            return new ExpansionPreview(ExpansionOutcome.NotFound, 0, new(), new(), "Task not found");
        if (task.UserId != userId)
            return new ExpansionPreview(ExpansionOutcome.Forbidden, 0, new(), new(), "Task does not belong to user");

        var blocks = task.Blocks.ToList();
        var roots = blocks.Where(b => b.ParentBlockId is null).OrderBy(b => b.OrderIndex).ToList();

        // Pre-load the configs referenced by any scrape block so the expanders can patch.
        var configIds = new HashSet<Guid>();
        foreach (var b in blocks.Where(b => b.BlockType == BlockType.Scrape))
        {
            if (b.ConfigJsonb.RootElement.TryGetProperty("scraperConfigId", out var idEl)
                && idEl.ValueKind == System.Text.Json.JsonValueKind.String
                && Guid.TryParse(idEl.GetString(), out var id))
                configIds.Add(id);
        }
        var configs = await _db.ScraperConfigs
            .Where(c => configIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, ct);

        var loopNames = new Dictionary<Guid, string>();
        foreach (var b in blocks.Where(b => b.BlockType == BlockType.Loop))
        {
            var name = b.ConfigJsonb.RootElement.TryGetProperty("name", out var n) && n.ValueKind == System.Text.Json.JsonValueKind.String
                ? n.GetString() ?? "" : "";
            loopNames[b.Id] = name;
        }

        var ctx = new ExpansionContext
        {
            AllBlocks = blocks,
            BlocksById = blocks.ToDictionary(b => b.Id),
            LoopNamesById = loopNames,
            ConfigsById = configs,
        };

        var emptyFrame = new ExpansionFrame(new Dictionary<Guid, string>());
        var results = new List<ExpansionResult>();
        foreach (var root in roots)
        {
            if (!_expandersByType.TryGetValue(root.BlockType, out var expander)) continue;
            foreach (var r in expander.Expand(root, ctx, emptyFrame))
            {
                results.Add(r);
                if (results.Count > IQueueExpansionService.BatchCap)
                {
                    return new ExpansionPreview(
                        ExpansionOutcome.BatchTooLarge,
                        results.Count,
                        new(),
                        ctx.Warnings,
                        $"Expansion exceeds cap of {IQueueExpansionService.BatchCap}");
                }
            }
        }

        if (results.Count == 0)
            return new ExpansionPreview(ExpansionOutcome.BatchEmpty, 0, new(), ctx.Warnings, "Task produces no expanded items (no scrape blocks or all paths skipped).");

        return new ExpansionPreview(ExpansionOutcome.Ok, results.Count, results, ctx.Warnings);
    }
}
```

### 3.6 Modified: `backend/src/WebScrape.Data/Dto/QueueTaskDto.cs` (full file after change)

```csharp
using System.Text.Json;

namespace WebScrape.Data.Dto;

public class QueueTaskDto
{
    public string Id { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string ConfigName { get; set; } = "";
    public List<string> SearchTerms { get; set; } = new();
    public int Priority { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public string Status { get; set; } = "pending";
    public JsonElement? InlineConfig { get; set; }
    // ── M2.3 additions (additive — older extensions ignore unknown fields) ──
    // Display string built from loop assignments at populate time, e.g. "loop1=alpha, loop2=widget".
    public string? IterationLabel { get; set; }
    // Structured assignments keyed by loop block id (string-stringified Guid for JSON simplicity).
    public Dictionary<string, string>? IterationAssignments { get; set; }
}
```

### 3.7 New: `backend/src/WebScrape.Data/Dto/ExpansionDtos.cs`

```csharp
namespace WebScrape.Data.Dto;

public class ExpandedItemDto
{
    public Guid ScrapeBlockId { get; set; }
    public Guid ScraperConfigId { get; set; }
    public string ConfigName { get; set; } = "";
    // loopBlockId (string-stringified Guid) -> value
    public Dictionary<string, string> Assignments { get; set; } = new();
    public string IterationLabel { get; set; } = "";
}

public class ExpansionWarningDto
{
    public string Code { get; set; } = "";
    public Guid? BlockId { get; set; }
    public Guid? ScraperConfigId { get; set; }
    public string? StepId { get; set; }
}

public class ExpansionPreviewDto
{
    public int Count { get; set; }
    public List<ExpandedItemDto> Items { get; set; } = new();
    public List<ExpansionWarningDto> Warnings { get; set; } = new();
}

public class CreateBatchDto
{
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
}

public class BatchDispatchResultDto
{
    public Guid BatchId { get; set; }
    public int DispatchedCount { get; set; }
    public int FailedCount { get; set; }
}

public class RunBatchDetailDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public string TaskName { get; set; } = "";
    public Guid WorkerId { get; set; }
    public string WorkerName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public List<RunItemDto> RunItems { get; set; } = new();
}
```

### 3.8 New: `backend/src/WebScrape.Services/Interfaces/IRunBatchService.cs`

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum RunBatchOutcome
{
    Created,
    NotFound,
    Forbidden,
    WorkerOffline,
    BatchEmpty,
    BatchTooLarge,
}

public record RunBatchDispatchResult(
    RunBatchOutcome Outcome,
    Guid? BatchId,
    int DispatchedCount,
    int FailedCount,
    string? Error);

public interface IRunBatchService
{
    Task<RunBatchDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task<RunBatchDetailDto?> GetAsync(Guid userId, Guid batchId, CancellationToken ct = default);
}
```

### 3.9 New: `backend/src/WebScrape.Services/Implementations/RunBatchService.cs`

```csharp
using System.Text.Json;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Hubs;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class RunBatchService : IRunBatchService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IQueueExpansionService _expander;
    private readonly IWorkerNotifier _notifier;
    private readonly ILogger<RunBatchService> _log;

    public RunBatchService(
        WebScrapeDbContext db,
        IMapper mapper,
        IQueueExpansionService expander,
        IWorkerNotifier notifier,
        ILogger<RunBatchService> log)
    {
        _db = db;
        _mapper = mapper;
        _expander = expander;
        _notifier = notifier;
        _log = log;
    }

    public async Task<RunBatchDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.Id == workerId, ct);
        if (worker is null) return new(RunBatchOutcome.NotFound, null, 0, 0, "Worker not found");
        if (worker.UserId != userId) return new(RunBatchOutcome.Forbidden, null, 0, 0, "Worker does not belong to user");
        if (string.IsNullOrEmpty(worker.CurrentConnection)) return new(RunBatchOutcome.WorkerOffline, null, 0, 0, "Worker is offline");

        var preview = await _expander.ExpandAsync(userId, taskId, ct);
        switch (preview.Outcome)
        {
            case ExpansionOutcome.NotFound: return new(RunBatchOutcome.NotFound, null, 0, 0, preview.Error);
            case ExpansionOutcome.Forbidden: return new(RunBatchOutcome.Forbidden, null, 0, 0, preview.Error);
            case ExpansionOutcome.BatchEmpty: return new(RunBatchOutcome.BatchEmpty, null, 0, 0, preview.Error);
            case ExpansionOutcome.BatchTooLarge: return new(RunBatchOutcome.BatchTooLarge, null, 0, 0, preview.Error);
        }

        var task = await _db.Tasks.Include(t => t.Blocks).FirstAsync(t => t.Id == taskId, ct);
        var configIds = preview.Results.Select(r => r.ScraperConfigId).Distinct().ToList();
        var configs = await _db.ScraperConfigs.Where(c => configIds.Contains(c.Id)).ToListAsync(ct);

        // Snapshot the full task tree + per-config configJson so live edits don't affect the batch.
        var snapshot = JsonSerializer.SerializeToDocument(new
        {
            expandedAt = DateTimeOffset.UtcNow,
            treeSnapshot = task.Blocks.Select(b => new
            {
                id = b.Id,
                taskId = b.TaskId,
                parentBlockId = b.ParentBlockId,
                blockType = b.BlockType.ToString(),
                orderIndex = b.OrderIndex,
                config = b.ConfigJsonb.RootElement,
            }),
            configSnapshots = configs.ToDictionary(
                c => c.Id.ToString(),
                c => c.ConfigJson.RootElement),
        });

        var batchId = Guid.NewGuid();
        var batch = new RunBatch
        {
            Id = batchId,
            TaskId = task.Id,
            UserId = userId,
            WorkerId = worker.Id,
            PopulateSnapshot = snapshot,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.RunBatches.Add(batch);

        var runItems = new List<RunItem>(preview.Results.Count);
        foreach (var r in preview.Results)
        {
            var assignmentsJson = JsonSerializer.SerializeToDocument(
                r.Assignments.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value));
            var run = new RunItem
            {
                Id = Guid.NewGuid(),
                TaskId = task.Id,
                WorkerId = worker.Id,
                BatchId = batchId,
                Status = RunItemStatus.Pending,
                RequestedAt = DateTimeOffset.UtcNow,
                IterationLabel = r.IterationLabel,
                IterationAssignments = assignmentsJson,
            };
            _db.RunItems.Add(run);
            runItems.Add(run);
        }
        await _db.SaveChangesAsync(ct);

        var connectionId = worker.CurrentConnection!;
        int dispatched = 0, failed = 0;
        for (int i = 0; i < preview.Results.Count; i++)
        {
            var r = preview.Results[i];
            var run = runItems[i];

            var queueDto = new QueueTaskDto
            {
                Id = run.Id.ToString(),
                ConfigId = r.ScraperConfigId.ToString(),
                ConfigName = r.ConfigName,
                SearchTerms = new(),
                Priority = 0,
                CreatedAt = run.RequestedAt,
                Status = "pending",
                InlineConfig = r.PatchedConfigJson,
                IterationLabel = r.IterationLabel,
                IterationAssignments = r.Assignments.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
            };

            try
            {
                await _notifier.SendReceiveTaskAsync(connectionId, queueDto, ct);
                run.Status = RunItemStatus.Sent;
                run.SentAt = DateTimeOffset.UtcNow;
                dispatched++;
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Per-item dispatch failed for run {RunId} in batch {BatchId}", run.Id, batchId);
                run.Status = RunItemStatus.Failed;
                run.ErrorMessage = $"Worker disconnected before task could be sent: {ex.Message}";
                run.CompletedAt = DateTimeOffset.UtcNow;
                failed++;
            }
        }
        await _db.SaveChangesAsync(ct);

        return new RunBatchDispatchResult(RunBatchOutcome.Created, batchId, dispatched, failed, null);
    }

    public async Task<RunBatchDetailDto?> GetAsync(Guid userId, Guid batchId, CancellationToken ct = default)
    {
        var batch = await _db.RunBatches
            .AsNoTracking()
            .Include(b => b.Task)
            .Include(b => b.Worker)
            .FirstOrDefaultAsync(b => b.Id == batchId, ct);
        if (batch is null || batch.UserId != userId) return null;

        var runItems = await _db.RunItems
            .AsNoTracking()
            .Where(r => r.BatchId == batchId)
            .OrderBy(r => r.RequestedAt)
            .ToListAsync(ct);

        return new RunBatchDetailDto
        {
            Id = batch.Id,
            TaskId = batch.TaskId,
            TaskName = batch.Task?.Name ?? "",
            WorkerId = batch.WorkerId,
            WorkerName = batch.Worker?.Name ?? "",
            CreatedAt = batch.CreatedAt,
            RunItems = _mapper.Map<List<RunItemDto>>(runItems),
        };
    }
}
```

### 3.10 New: `backend/src/WebScrape.Server/Controllers/RunBatchesController.cs`

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/run-batches")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class RunBatchesController : ControllerBase
{
    private readonly IRunBatchService _batches;

    public RunBatchesController(IRunBatchService batches)
    {
        _batches = batches;
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _batches.GetAsync(GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    private Guid GetUserId() => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
}
```

### 3.11 Modified: `backend/src/WebScrape.Server/Controllers/TasksController.cs` — add populate action

Add the following action to the `TasksController` class (after the `Delete` action, before the `Render` private method):

```csharp
    [HttpPost("{id:guid}/populate")]
    [CookieCsrf]
    public async Task<IActionResult> Populate(Guid id, [FromServices] IQueueExpansionService expander, CancellationToken ct)
    {
        var preview = await expander.ExpandAsync(GetUserId(), id, ct);
        return preview.Outcome switch
        {
            ExpansionOutcome.Ok => Ok(new ExpansionPreviewDto
            {
                Count = preview.Count,
                Items = preview.Results.Select(r => new ExpandedItemDto
                {
                    ScrapeBlockId = r.ScrapeBlockId,
                    ScraperConfigId = r.ScraperConfigId,
                    ConfigName = r.ConfigName,
                    Assignments = r.Assignments.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
                    IterationLabel = r.IterationLabel,
                }).ToList(),
                Warnings = preview.Warnings.Select(w => new ExpansionWarningDto
                {
                    Code = w.Code, BlockId = w.BlockId, ScraperConfigId = w.ScraperConfigId, StepId = w.StepId,
                }).ToList(),
            }),
            ExpansionOutcome.NotFound => NotFound(new { error = preview.Error }),
            ExpansionOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = preview.Error }),
            ExpansionOutcome.BatchEmpty => UnprocessableEntity(new { code = "BATCH_EMPTY", error = preview.Error }),
            ExpansionOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", count = preview.Count, cap = IQueueExpansionService.BatchCap, error = preview.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
```

Add the matching `using` statements at the top of the file:

```csharp
using WebScrape.Services.Expansion;   // ExpansionOutcome (it's in WebScrape.Services.Interfaces — drop this if redundant)
using WebScrape.Services.Interfaces;  // already imported
```

(`ExpansionOutcome` is defined in `WebScrape.Services.Interfaces`. Only one `using` needed.)

### 3.12 Modified: `backend/src/WebScrape.Server/Controllers/RunsController.cs` — add batch action

Add the following action to the `RunsController` class (after the `Get` action):

```csharp
    [HttpPost("batch")]
    [CookieCsrf]
    public async Task<IActionResult> CreateBatch(
        [FromBody] WebScrape.Data.Dto.CreateBatchDto dto,
        [FromServices] IRunBatchService batches,
        CancellationToken ct)
    {
        var result = await batches.CreateAndDispatchAsync(GetUserId(), dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            RunBatchOutcome.Created => Ok(new WebScrape.Data.Dto.BatchDispatchResultDto
            {
                BatchId = result.BatchId!.Value,
                DispatchedCount = result.DispatchedCount,
                FailedCount = result.FailedCount,
            }),
            RunBatchOutcome.NotFound => NotFound(new { error = result.Error }),
            RunBatchOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            RunBatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            RunBatchOutcome.BatchEmpty => UnprocessableEntity(new { code = "BATCH_EMPTY", error = result.Error }),
            RunBatchOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", error = result.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
```

### 3.13 Modified: `backend/src/WebScrape.Server/Program.cs` — DI registrations

After `builder.Services.AddScoped<ITaskValidator, TaskValidator>();` (added in M2.2), append:

```csharp
builder.Services.AddScoped<WebScrape.Services.Expansion.IBlockExpander, WebScrape.Services.Expansion.LoopBlockExpander>();
builder.Services.AddScoped<WebScrape.Services.Expansion.IBlockExpander, WebScrape.Services.Expansion.ScrapeBlockExpander>();
builder.Services.AddScoped<IQueueExpansionService, QueueExpansionService>();
builder.Services.AddScoped<IRunBatchService, RunBatchService>();
```

### 3.14 New: `backend/tests/WebScrape.Tests/Services/QueueExpansionServiceTests.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Expansion;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class QueueExpansionServiceTests
{
    private static QueueExpansionService BuildService(WebScrapeDbContext db)
    {
        // Loop expander needs the full registry — mirror DI ordering.
        var scrape = new ScrapeBlockExpander();
        var expanders = new List<IBlockExpander> { scrape };
        var loop = new LoopBlockExpander(expanders.Concat(new IBlockExpander[] { /* placeholder */ }));
        // Re-assemble with both, since LoopBlockExpander captures the registry by ctor.
        var all = new IBlockExpander[] { loop, scrape };
        var loopFinal = new LoopBlockExpander(all);
        return new QueueExpansionService(db, new IBlockExpander[] { loopFinal, scrape });
    }

    private static (WebScrapeDbContext db, Guid userId, Guid configId, Guid taskId) Seed(
        Func<Guid, Guid, Guid, List<TaskBlock>> buildTree,
        string configJson = """{"steps":[{"id":"s1","type":"setInput","options":{}}]}""")
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        var taskId = Guid.NewGuid();

        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId, UserId = userId, Name = "demo", Domain = "example.com",
            ConfigJson = JsonDocument.Parse(configJson),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.Tasks.Add(new TaskEntity
        {
            Id = taskId, UserId = userId, Name = "T",
            ScraperConfigId = null, CreatedAt = DateTimeOffset.UtcNow,
        });
        foreach (var b in buildTree(taskId, configId, Guid.NewGuid())) db.TaskBlocks.Add(b);
        db.SaveChanges();
        return (db, userId, configId, taskId);
    }

    private static TaskBlock LoopBlock(Guid id, Guid taskId, Guid? parent, string name, string[] values, int order = 0) => new()
    {
        Id = id, TaskId = taskId, ParentBlockId = parent, BlockType = BlockType.Loop, OrderIndex = order,
        ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new { name, values })),
    };

    private static TaskBlock ScrapeBlock(Guid id, Guid taskId, Guid? parent, Guid configId, Dictionary<string, object>? bindings = null, int order = 0) => new()
    {
        Id = id, TaskId = taskId, ParentBlockId = parent, BlockType = BlockType.Scrape, OrderIndex = order,
        ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new {
            scraperConfigId = configId.ToString(),
            stepBindings = bindings ?? new(),
        })),
    };

    [Fact]
    public async Task Single_loop_three_values_one_scrape_yields_three_results()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a", "b", "c" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(ExpansionOutcome.Ok, preview.Outcome);
        Assert.Equal(3, preview.Count);
        Assert.Collection(preview.Results,
            r => Assert.Equal("loop1=a", r.IterationLabel),
            r => Assert.Equal("loop1=b", r.IterationLabel),
            r => Assert.Equal("loop1=c", r.IterationLabel));
    }

    [Fact]
    public async Task Two_nested_loops_one_scrape_yields_cartesian_product()
    {
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loop1, tid, null, "loop1", new[] { "a", "b" }),
            LoopBlock(loop2, tid, loop1, "loop2", new[] { "x", "y" }),
            ScrapeBlock(Guid.NewGuid(), tid, loop2, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(4, preview.Count);
        var labels = preview.Results.Select(r => r.IterationLabel).ToList();
        Assert.Contains("loop1=a, loop2=x", labels);
        Assert.Contains("loop1=a, loop2=y", labels);
        Assert.Contains("loop1=b, loop2=x", labels);
        Assert.Contains("loop1=b, loop2=y", labels);
    }

    [Fact]
    public async Task Loop_with_two_scrape_children_yields_2N_results()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a", "b", "c" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, order: 0),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, order: 1),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(6, preview.Count);
    }

    [Fact]
    public async Task Empty_tree_returns_BATCH_EMPTY()
    {
        var (db, userId, _, taskId) = Seed((tid, cid, _) => new List<TaskBlock>());
        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(ExpansionOutcome.BatchEmpty, preview.Outcome);
    }

    [Fact]
    public async Task Cap_exceeded_returns_BATCH_TOO_LARGE()
    {
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var loop3 = Guid.NewGuid();
        var loop4 = Guid.NewGuid();
        var values = Enumerable.Range(0, 7).Select(i => i.ToString()).ToArray(); // 7^4 = 2401 > 1000
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loop1, tid, null, "l1", values),
            LoopBlock(loop2, tid, loop1, "l2", values),
            LoopBlock(loop3, tid, loop2, "l3", values),
            LoopBlock(loop4, tid, loop3, "l4", values),
            ScrapeBlock(Guid.NewGuid(), tid, loop4, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(ExpansionOutcome.BatchTooLarge, preview.Outcome);
    }

    [Fact]
    public async Task LoopRef_binding_is_baked_into_literalValue()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "alpha", "beta" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new() {
                ["s1"] = new { kind = "loopRef", loopBlockId = loopId.ToString() },
            }),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(2, preview.Results.Count);
        var first = preview.Results[0].PatchedConfigJson;
        var step = first.GetProperty("steps")[0];
        Assert.Equal("alpha", step.GetProperty("options").GetProperty("literalValue").GetString());

        var second = preview.Results[1].PatchedConfigJson;
        Assert.Equal("beta", second.GetProperty("steps")[0].GetProperty("options").GetProperty("literalValue").GetString());
    }

    [Fact]
    public async Task Literal_binding_baked_directly()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new() {
                ["s1"] = new { kind = "literal", value = "constant" },
            }),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        var step = preview.Results[0].PatchedConfigJson.GetProperty("steps")[0];
        Assert.Equal("constant", step.GetProperty("options").GetProperty("literalValue").GetString());
    }

    [Fact]
    public async Task Unbound_setInput_emits_warning_and_resolves_to_empty()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid), // no bindings
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal("", preview.Results[0].PatchedConfigJson.GetProperty("steps")[0].GetProperty("options").GetProperty("literalValue").GetString());
        Assert.Contains(preview.Warnings, w => w.Code == ExpansionWarningCodes.NewStepUnbound);
    }

    [Fact]
    public async Task Bound_step_no_longer_in_config_emits_warning()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed(
            (tid, cid, _) => new List<TaskBlock>
            {
                LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
                ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new() {
                    ["ghost-step"] = new { kind = "literal", value = "x" },
                }),
            },
            configJson: """{"steps":[{"id":"s1","type":"setInput","options":{}}]}""");

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Contains(preview.Warnings, w => w.Code == ExpansionWarningCodes.StepNoLongerExists && w.StepId == "ghost-step");
    }

    [Fact]
    public async Task Cross_user_task_returns_Forbidden()
    {
        var loopId = Guid.NewGuid();
        var (db, _, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid),
        });
        var preview = await BuildService(db).ExpandAsync(Guid.NewGuid(), taskId);
        Assert.Equal(ExpansionOutcome.Forbidden, preview.Outcome);
    }
}
```

### 3.15 New: `backend/tests/WebScrape.Tests/Services/RunBatchServiceTests.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Expansion;
using WebScrape.Services.Hubs;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunBatchServiceTests
{
    private record Setup(
        RunBatchService Svc,
        WebScrapeDbContext Db,
        Mock<IWorkerNotifier> Notifier,
        Guid UserId,
        Guid TaskId,
        Guid WorkerId);

    private static async Task<Setup> Build(bool workerOnline = true, int loopValues = 3)
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);

        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        var taskId = Guid.NewGuid();
        var loopId = Guid.NewGuid();

        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId, UserId = userId, Name = "demo", Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[{"id":"s1","type":"setInput","options":{}}]}"""),
            SchemaVersion = 3, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.Tasks.Add(new TaskEntity
        {
            Id = taskId, UserId = userId, Name = "T", ScraperConfigId = null,
            CreatedAt = DateTimeOffset.UtcNow,
        });

        var values = Enumerable.Range(0, loopValues).Select(i => $"v{i}").ToArray();
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = loopId, TaskId = taskId, ParentBlockId = null, BlockType = BlockType.Loop, OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new { name = "loop1", values })),
        });
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = Guid.NewGuid(), TaskId = taskId, ParentBlockId = loopId, BlockType = BlockType.Scrape, OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new {
                scraperConfigId = configId.ToString(),
                stepBindings = new Dictionary<string, object> {
                    ["s1"] = new { kind = "loopRef", loopBlockId = loopId.ToString() },
                },
            })),
        });

        var workerId = Guid.NewGuid();
        db.WorkerConnections.Add(new WorkerConnection
        {
            Id = workerId, UserId = userId, Name = "w", ApiKeyId = Guid.NewGuid(),
            CurrentConnection = workerOnline ? "conn-1" : null,
        });

        await db.SaveChangesAsync();

        var scrape = new ScrapeBlockExpander();
        var loop = new LoopBlockExpander(new IBlockExpander[] { scrape });
        var loopFinal = new LoopBlockExpander(new IBlockExpander[] { loop, scrape });
        var expander = new QueueExpansionService(db, new IBlockExpander[] { loopFinal, scrape });
        var svc = new RunBatchService(db, TestDb.CreateMapper(), expander, notifier.Object, NullLogger<RunBatchService>.Instance);

        return new Setup(svc, db, notifier, userId, taskId, workerId);
    }

    [Fact]
    public async Task CreateBatch_dispatches_one_per_iteration_and_marks_sent()
    {
        var s = await Build(workerOnline: true, loopValues: 3);
        s.Notifier.Setup(n => n.SendReceiveTaskAsync("conn-1", It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);

        var result = await s.Svc.CreateAndDispatchAsync(s.UserId, s.TaskId, s.WorkerId);

        Assert.Equal(RunBatchOutcome.Created, result.Outcome);
        Assert.Equal(3, result.DispatchedCount);
        Assert.Equal(0, result.FailedCount);
        s.Notifier.Verify(n => n.SendReceiveTaskAsync("conn-1", It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>()), Times.Exactly(3));

        var runs = await s.Db.RunItems.ToListAsync();
        Assert.Equal(3, runs.Count);
        Assert.All(runs, r => Assert.Equal(RunItemStatus.Sent, r.Status));
        Assert.All(runs, r => Assert.NotNull(r.IterationLabel));
        Assert.All(runs, r => Assert.NotNull(r.IterationAssignments));
    }

    [Fact]
    public async Task CreateBatch_snapshots_tree_and_configs()
    {
        var s = await Build(loopValues: 2);
        s.Notifier.Setup(n => n.SendReceiveTaskAsync("conn-1", It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);

        var result = await s.Svc.CreateAndDispatchAsync(s.UserId, s.TaskId, s.WorkerId);

        var batch = await s.Db.RunBatches.SingleAsync(b => b.Id == result.BatchId);
        var snapshot = batch.PopulateSnapshot.RootElement;
        Assert.True(snapshot.TryGetProperty("treeSnapshot", out _));
        Assert.True(snapshot.TryGetProperty("configSnapshots", out _));
        Assert.True(snapshot.TryGetProperty("expandedAt", out _));
    }

    [Fact]
    public async Task CreateBatch_returns_offline_with_no_writes_when_worker_offline()
    {
        var s = await Build(workerOnline: false);
        var result = await s.Svc.CreateAndDispatchAsync(s.UserId, s.TaskId, s.WorkerId);

        Assert.Equal(RunBatchOutcome.WorkerOffline, result.Outcome);
        Assert.Equal(0, await s.Db.RunBatches.CountAsync());
        Assert.Equal(0, await s.Db.RunItems.CountAsync());
        s.Notifier.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CreateBatch_marks_only_failing_item_failed_when_one_dispatch_throws()
    {
        var s = await Build(loopValues: 3);
        var calls = 0;
        s.Notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                calls++;
                if (calls == 2) throw new InvalidOperationException("boom");
                return Task.CompletedTask;
            });

        var result = await s.Svc.CreateAndDispatchAsync(s.UserId, s.TaskId, s.WorkerId);

        Assert.Equal(2, result.DispatchedCount);
        Assert.Equal(1, result.FailedCount);

        var runs = await s.Db.RunItems.OrderBy(r => r.RequestedAt).ToListAsync();
        Assert.Equal(RunItemStatus.Sent,   runs[0].Status);
        Assert.Equal(RunItemStatus.Failed, runs[1].Status);
        Assert.Equal(RunItemStatus.Sent,   runs[2].Status);
    }

    [Fact]
    public async Task CreateBatch_returns_forbidden_for_other_users_worker()
    {
        var s = await Build();
        var result = await s.Svc.CreateAndDispatchAsync(Guid.NewGuid(), s.TaskId, s.WorkerId);
        Assert.Equal(RunBatchOutcome.Forbidden, result.Outcome);
        Assert.Equal(0, await s.Db.RunBatches.CountAsync());
    }

    [Fact]
    public async Task GetAsync_returns_batch_with_run_items()
    {
        var s = await Build(loopValues: 2);
        s.Notifier.Setup(n => n.SendReceiveTaskAsync("conn-1", It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var result = await s.Svc.CreateAndDispatchAsync(s.UserId, s.TaskId, s.WorkerId);

        var detail = await s.Svc.GetAsync(s.UserId, result.BatchId!.Value);
        Assert.NotNull(detail);
        Assert.Equal(2, detail!.RunItems.Count);

        var asOther = await s.Svc.GetAsync(Guid.NewGuid(), result.BatchId.Value);
        Assert.Null(asOther);
    }
}
```

### 3.16 Frontend: `backend/src/WebScrape.Client/src/api/types.ts` — additions

Append the following at the end of the file (after the existing M2.2 additions):

```typescript
// ── M2.3 expansion + batch ─────────────────────────────────────────────────

export type ExpandedItemDto = {
  scrapeBlockId: string;
  scraperConfigId: string;
  configName: string;
  assignments: Record<string, string>;     // loopBlockId -> value
  iterationLabel: string;
};

export type ExpansionWarningDto = {
  code: string;
  blockId?: string | null;
  scraperConfigId?: string | null;
  stepId?: string | null;
};

export type ExpansionPreviewDto = {
  count: number;
  items: ExpandedItemDto[];
  warnings: ExpansionWarningDto[];
};

export type CreateBatchDto = { taskId: string; workerId: string };

export type BatchDispatchResultDto = {
  batchId: string;
  dispatchedCount: number;
  failedCount: number;
};

export type RunBatchDetailDto = {
  id: string;
  taskId: string;
  taskName: string;
  workerId: string;
  workerName: string;
  createdAt: string;
  runItems: RunItemDto[];
};
```

### 3.17 Frontend: queries / mutations

**`backend/src/WebScrape.Client/src/api/queries.ts`** — append:

```typescript
// (alongside existing useTasks, useTask, useWorkers etc. — match existing patterns)

import { useQuery } from '@tanstack/react-query';
import type { RunBatchDetailDto } from './types';
import { client } from './client';

export function useRunBatch(batchId: string | null | undefined) {
  return useQuery<RunBatchDetailDto>({
    queryKey: ['run-batches', batchId],
    enabled: !!batchId,
    queryFn: async () => (await client.get(`/api/run-batches/${batchId}`)).data,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 1000;
      const allTerminal = data.runItems.every(r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled');
      return allTerminal ? false : 1000;
    },
  });
}
```

**`backend/src/WebScrape.Client/src/api/mutations.ts`** — append:

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExpansionPreviewDto, BatchDispatchResultDto, CreateBatchDto } from './types';
import { client } from './client';

export function usePopulateTask() {
  return useMutation({
    mutationFn: async (taskId: string): Promise<ExpansionPreviewDto> =>
      (await client.post(`/api/tasks/${taskId}/populate`)).data,
  });
}

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateBatchDto): Promise<BatchDispatchResultDto> =>
      (await client.post(`/api/runs/batch`, body)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['workers'] }); },
  });
}
```

(If `queries.ts` / `mutations.ts` already define `client` differently — re-use the existing import path; the snippets above assume the M1 conventions from the surrounding files.)

---

## 4. Function order / file structure after changes

### `WebScrape.Services` project tree (new + modified items in **bold**)

```
WebScrape.Services/
├── Expansion/                                 ← NEW directory
│   ├── **IBlockExpander.cs**
│   ├── **LoopBlockExpander.cs**
│   └── **ScrapeBlockExpander.cs**
├── Implementations/
│   ├── ...
│   ├── **QueueExpansionService.cs**           ← NEW
│   ├── **RunBatchService.cs**                 ← NEW
│   └── RunService.cs                          ← unchanged (M1 single-run path stays)
└── Interfaces/
    ├── ...
    ├── **IQueueExpansionService.cs**          ← NEW
    └── **IRunBatchService.cs**                ← NEW
```

### `WebScrape.Server` controllers

```
Controllers/
├── ...
├── **RunBatchesController.cs**                ← NEW
├── RunsController.cs                          ← modified (add CreateBatch action)
└── TasksController.cs                         ← modified (add Populate action)
```

---

## 5. Verification

### Build + tests

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests
```

Expected: 54 (from M2.2) + 11 (QueueExpansionService) + 6 (RunBatchService) = **71 tests passing**.

### Manual smoke (run AFTER M2.4 lands — see SPEC-M2.4)

1. Backend running, frontend at `http://localhost:5173`, extension built with M2.4 patch and connected as worker.
2. POST `/api/tasks` with a 2-loop tree: outer `loop1.values=[a,b]`, inner `loop2.values=[x,y]` (child of loop1), one scrape under loop2 binding `step-1` to `loop1` and `step-2` to `loop2` (literal).
3. POST `/api/tasks/{id}/populate` → 200 with `count=4`, items `[loop1=a, loop2=x]`..`[loop1=b, loop2=y]`. No warnings.
4. POST `/api/runs/batch` with `{ taskId, workerId }` → 200 `{ batchId, dispatchedCount: 4, failedCount: 0 }`.
5. GET `/api/run-batches/{batchId}` polled at 1Hz: 4 run_items go `pending` → `sent` → `running` → `completed` (with empty steps array, completes immediately on the demo config).
6. Negative — disconnect extension, POST `/api/runs/batch` → 409 `worker offline`. No run_batches row created.
7. Negative — author 4-deep tree of values [1..10] each (10000 expansions). POST populate → 422 `BATCH_TOO_LARGE`.

### Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Loop with empty `values=[]` | **Cover** — produces 1 frame with empty assignment for that loop (consistent with M2.1 dispatch). |
| Scrape block at root (no parent loop) | **Cover** — 1 expansion with empty assignments + `iterationLabel=""`. |
| Two scrape blocks under different loop chains | **Cover** — sums per-leaf cartesian counts. |
| Bound step `loopRef.loopBlockId` outside ancestor chain | Already rejected at SAVE time (M2.2 validation). Defense-in-depth: expander emits `BindingUnbound` warning if `frame.LoopAssignments` doesn't contain it. |
| Live config edited mid-batch | **Cover** via `populate_snapshot` — runs use the snapshotted config; live edits don't affect in-flight batches. |
| Worker disconnects mid-batch dispatch loop | **Cover** — `WorkerService.HandleDisconnectAsync` (existing) fails any `Sent`/`Running`/`Paused` run_items including batch-linked ones. Per-item try/catch in `RunBatchService` handles per-call SignalR throws. |
| Per-item run_item.id collision with M1 single-run path | Impossible — both use `Guid.NewGuid()`. |
| `IterationAssignments` JSONB stored as `Dictionary<string, string>` (loop block id stringified) instead of typed Guid keys | **Cover** — JSON object keys must be strings. Reverse parse in M3 result viewer if needed. |
| Frontend M2 doesn't yet exist (M2.7 territory) | **Out of scope** — M2.3 verified via direct REST calls + the existing Tasks page. |

---

## 6. Out-of-scope notes (NOT for M2.3)

- Extension `SetInputOptions.literalValue` patch → SPEC-M2.4 (sister doc — bundle in same Sonnet sitting).
- Frontend `/run-batches/{id}` page → M2.7.
- Aggregate batch status (`Pending`/`Running`/`Completed`/`PartiallyFailed`) on the `RunBatch` entity — computed client-side from child `RunItem.Status` values.
- `POST /api/runs/{id}/resume` for paused batches → M4.

---

## 7. Definition of done (M2.3)

- [ ] `dotnet build WebScrape.sln` clean.
- [ ] 71 tests passing.
- [ ] `POST /api/tasks/{id}/populate` returns expansion preview with correct counts and labels for the 2×2 case.
- [ ] `POST /api/runs/batch` creates a `RunBatch` row + N `RunItem` rows; SignalR notifier called N times; result shape correct.
- [ ] `GET /api/run-batches/{id}` returns batch + run_items list, scoped to the user.
- [ ] Cap test: 7^4 tree returns 422 `BATCH_TOO_LARGE`.
- [ ] M1 single-run regression — `POST /api/runs` with seeded demo task still works end-to-end.
- [ ] Per-item dispatch failure scenario: 1 throw out of 3 → `dispatchedCount=2, failedCount=1`, only the right run_item is `Failed`.
- [ ] No frontend pages added (only `types.ts` / `queries.ts` / `mutations.ts` shims).
