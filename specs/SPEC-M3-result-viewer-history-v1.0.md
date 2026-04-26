# SPEC-M3 — Result viewer + history (v1.0)

**Status**: ready for Sonnet to implement.
**Plan**: [C:\Users\und3r\.claude\plans\ok-so-next-robust-pascal.md](C:\Users\und3r\.claude\plans\ok-so-next-robust-pascal.md)
**Date**: 2026-04-26

---

## AMENDMENTS

> **READ THIS BEFORE CONTINUING.** Sections below were written against an outdated assumption about the schema. The amendments here override the original spec.

### 2026-04-26 — A1: §3.5 PopulateSnapshotReader + new RunItem column

**Why:** The original §3.5 assumed `TaskEntity.ScraperConfigId` existed (the spec author's footnote at line 233 anticipated only the nullable/non-nullable split). Reality: M2.7 (`20260425200000_M2_7DropLegacyScraperConfigId.cs`) **deleted** that column. `ScraperConfigId` now lives only on each Scrape block ([TaskBlockDto.cs:23](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Dto\TaskBlockDto.cs#L23)); a single task may contain multiple Scrape blocks pointing at different configs ([RunBatchService.cs:53](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\RunBatchService.cs#L53)). An iterate-all-snapshots fallback is non-deterministic for multi-config tasks and silently corrupts CSV exports.

**Decision overrides:**
- **L6 ("No new entity columns. No EF migration.") is overridden.** We add one nullable column to `run_items` and one EF migration. L6's premise — that snapshot lookup was sufficient — was based on the now-disproven schema assumption.

**New work items (do these in addition to the original §3.5):**

1. **Add column to [RunItem.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Entities\RunItem.cs):**
   ```csharp
   public Guid? ScraperConfigId { get; set; }
   ```
   Nullable for forward-compat with any pre-M3 rows. No FK — configs may be deleted independently of run history (the snapshot remains the source of truth for column resolution).

2. **Configure the column** in the `RunItem` model builder in [WebScrapeDbContext.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\WebScrapeDbContext.cs). No new index (config-id isn't a query path).

3. **Create EF migration** `M3_AddRunItemScraperConfigId`:
   ```
   dotnet ef migrations add M3_AddRunItemScraperConfigId \
     --project backend/src/WebScrape.Data \
     --startup-project backend/src/WebScrape.Server
   ```

4. **Persist on insert** in [RunBatchService.cs:90-100](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\RunBatchService.cs#L90) — when constructing each `RunItem`, set:
   ```csharp
   ScraperConfigId = r.ScraperConfigId,
   ```

5. **Replace §3.5 `PopulateSnapshotReader.GetDataMappingForRun`** with the corrected body below. The `### 3.5 — Create ... PopulateSnapshotReader.cs` block further down in this spec is **superseded** — implement this version instead:
   ```csharp
   using System.Text.Json;
   using WebScrape.Data.Entities;

   namespace WebScrape.Services.Implementations;

   internal static class PopulateSnapshotReader
   {
       /// <summary>
       /// Returns the dataMapping element for the run's specific scraper config from the batch's
       /// frozen populate_snapshot, or null if absent. Looks up the snapshot by RunItem.ScraperConfigId
       /// (each RunItem corresponds to one specific config at dispatch time).
       /// </summary>
       public static JsonElement? GetDataMappingForRun(RunBatch? batch, RunItem? run)
       {
           if (batch is null || run is null || !run.ScraperConfigId.HasValue) return null;
           var root = batch.PopulateSnapshot.RootElement;
           if (root.ValueKind != JsonValueKind.Object) return null;
           if (!root.TryGetProperty("configSnapshots", out var snaps) || snaps.ValueKind != JsonValueKind.Object) return null;
           var key = run.ScraperConfigId.Value.ToString();
           if (!snaps.TryGetProperty(key, out var snap)) return null;
           return GetDataMapping(snap);
       }

       /// <summary>
       /// Reads dataMapping out of a stored config JSON root element. Tolerates the two shapes we
       /// observe in the wild: top-level dataMapping, or nested under configJson.dataMapping.
       /// </summary>
       public static JsonElement? GetDataMapping(JsonElement configElement)
       {
           if (configElement.ValueKind != JsonValueKind.Object) return null;
           if (configElement.TryGetProperty("dataMapping", out var dm) && dm.ValueKind == JsonValueKind.Object) return dm;
           if (configElement.TryGetProperty("configJson", out var cj) && cj.ValueKind == JsonValueKind.Object
               && cj.TryGetProperty("dataMapping", out var dm2) && dm2.ValueKind == JsonValueKind.Object) return dm2;
           return null;
       }
   }
   ```

6. **No DTO change required.** `RunItemDto` doesn't need to expose `ScraperConfigId` for M3 scope.

7. **Footnote at original §3.5 line 233 is obsolete** — ignore the "TaskEntity.ScraperConfigId is nullable per memory" advice. The column doesn't exist.

**Additional verification (in addition to the original spec's verification section):**
- Add a `RunBatchService` test: build a task with two Scrape blocks pointing at distinct configs, dispatch a batch, assert each persisted `RunItem.ScraperConfigId` equals the corresponding `preview.Results[i].ScraperConfigId`.
- Add a `PopulateSnapshotReader` test: build a `RunBatch` whose snapshot contains two configs (only one with `dataMapping`); assert the lookup returns the correct snapshot based on `RunItem.ScraperConfigId`.
- Manual: dispatch a batch from the extension with two distinct configs in the same task; export CSVs for one run from each config; confirm column headers and row values match the run's actual config (not whichever enumerates first).

---

## 1. Context

WebScrape is shipped through M2: extension can register, configs and tasks can be authored with block trees, batches dispatch and stream progress. What's missing is **history** (no way to browse runs across tasks, no filtering, no export) and the **result viewer** is still the M1 stub (`<pre>{JSON.stringify(result)}</pre>`).

M3 closes both gaps so the user can queue a batch, walk away, come back, and read structured results.

**Out of scope**: extension changes (chart/page-block extractors already produce the shapes we render), auth/PAT changes, Docker.

---

## 2. Locked decisions (from staged planning)

| # | Decision | Rationale |
|---|---|---|
| L1 | Full chart + table + PageBlock + raw-JSON-fallback cards | User-confirmed scope |
| L2 | Top-level `/runs` page with filters + per-task "Recent runs" panel | User-confirmed scope |
| L3 | Three exports: per-run JSON, per-run CSV, bulk batch JSON/CSV | User-confirmed scope |
| L4 | CSV declines wholepage iterations with HTTP 422 + `ITERATION_NOT_TABULAR` | Wholepage data isn't row-shaped |
| L5 | Column resolution prefers `populate_snapshot.configSnapshots[configId].dataMapping` over live config | Run-time reproducibility |
| L6 | No new entity columns. No EF migration. | Existing indexes cover all filters |
| L7 | Recharts pinned to `^2.13.0` | 3.x peer is React 19; we're on React 18 |
| L8 | No Tailwind. Use existing CSS tokens in [index.css](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\index.css) | Project's design system |
| L9 | `safeHref()` scheme allowlist for any rendered link from scraped data | XSS defence |
| L10 | CSV cell values starting with `= + - @ \t \r` get `'` prefix | Excel/Sheets formula-injection defence |
| L11 | `IterationAssignments` stays internal; not surfaced in DTOs | `IterationLabel` is sufficient for display |

---

## 3. Backend changes

All paths under `c:\Users\und3r\blueberry-v3\backend\src\`.

### 3.1 — No migrations

Existing indexes on `run_items`: `(task_id, requested_at)`, `status`, `batch_id` ([WebScrapeDbContext.cs:102-104](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\WebScrapeDbContext.cs)). Cover every M3 filter path.

### 3.2 — New DTOs

**Create `WebScrape.Data/Dto/PagedResultDto.cs`:**

```csharp
namespace WebScrape.Data.Dto;

public class PagedResultDto<T>
{
    public List<T> Items { get; set; } = new();
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}
```

**Create `WebScrape.Data/Dto/RunListItemDto.cs`:**

```csharp
using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class RunListItemDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public string TaskName { get; set; } = "";
    public Guid WorkerId { get; set; }
    public string WorkerName { get; set; } = "";
    public Guid? BatchId { get; set; }
    public RunItemStatus Status { get; set; }
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public string? IterationLabel { get; set; }
    public int? ProgressPercent { get; set; }
}
```

**Create `WebScrape.Data/Dto/RunListQueryDto.cs`:**

```csharp
using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class RunListQueryDto
{
    public Guid? TaskId { get; set; }
    public Guid? WorkerId { get; set; }
    public Guid? BatchId { get; set; }
    public RunItemStatus? Status { get; set; }
    public DateTimeOffset? From { get; set; }
    public DateTimeOffset? To { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 25;
}
```

**Create `WebScrape.Data/Dto/RunBatchListItemDto.cs`:**

```csharp
namespace WebScrape.Data.Dto;

public class RunBatchListItemDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public string TaskName { get; set; } = "";
    public Guid WorkerId { get; set; }
    public string WorkerName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public int TotalItems { get; set; }
    public int CompletedCount { get; set; }
    public int FailedCount { get; set; }
    public int PendingCount { get; set; }
}
```

**Create `WebScrape.Data/Dto/RunBatchListQueryDto.cs`:**

```csharp
namespace WebScrape.Data.Dto;

public class RunBatchListQueryDto
{
    public Guid? TaskId { get; set; }
    public DateTimeOffset? From { get; set; }
    public DateTimeOffset? To { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 25;
}
```

### 3.3 — Edit `WebScrape.Data/Dto/RunItemDto.cs`

Add `BatchId` field. Replace the entire file body:

```csharp
using System.Text.Json;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class RunItemDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public Guid? BatchId { get; set; }
    public RunItemStatus Status { get; set; }
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonElement? Result { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PauseReason { get; set; }
    public int? ProgressPercent { get; set; }
    public string? CurrentTerm { get; set; }
    public string? CurrentStep { get; set; }
    public string? Phase { get; set; }
    public string? IterationLabel { get; set; }
}
```

### 3.4 — Edit `WebScrape.Data/Mapping/AutoMapperProfile.cs`

Add the `RunItem → RunListItemDto` map at the end of `AutoMapperProfile()` ctor (after the existing `RunItem → RunItemDto` map at line 38–39):

**BEFORE:**
```csharp
        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));
    }
```

**AFTER:**
```csharp
        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));

        CreateMap<RunItem, RunListItemDto>()
            .ForMember(d => d.TaskName,   o => o.MapFrom(s => s.Task != null ? s.Task.Name : ""))
            .ForMember(d => d.WorkerName, o => o.MapFrom(s => s.Worker != null ? s.Worker.Name : ""));
    }
```

### 3.5 — Create `WebScrape.Services/Implementations/PopulateSnapshotReader.cs`

> ⚠️ **SUPERSEDED by AMENDMENT A1 (top of file).** The code block below assumes `TaskEntity.ScraperConfigId` exists; it does not (M2.7 dropped the column). Do not implement the body shown here — implement the corrected version in AMENDMENT A1 above, which looks up the snapshot via `RunItem.ScraperConfigId` (a new column added by amendment A1). The original snippet is left in place only for context on what was originally proposed.

```csharp
using System.Text.Json;
using WebScrape.Data.Entities;

namespace WebScrape.Services.Implementations;

internal static class PopulateSnapshotReader
{
    /// <summary>
    /// Returns the dataMapping element for the run's primary scraper config from the batch's frozen
    /// populate_snapshot, or null if the snapshot doesn't carry one.
    /// </summary>
    public static JsonElement? GetDataMappingForRun(RunBatch? batch, RunItem? run)
    {
        if (batch is null || run?.Task is null || !run.Task.ScraperConfigId.HasValue) return null;
        var root = batch.PopulateSnapshot.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("configSnapshots", out var snaps) || snaps.ValueKind != JsonValueKind.Object) return null;
        var key = run.Task.ScraperConfigId.Value.ToString();
        if (!snaps.TryGetProperty(key, out var snap)) return null;
        return GetDataMapping(snap);
    }

    /// <summary>
    /// Reads dataMapping out of a stored config JSON root element. Tolerates the two shapes we
    /// observe in the wild: top-level dataMapping, or nested under configJson.dataMapping.
    /// </summary>
    public static JsonElement? GetDataMapping(JsonElement configElement)
    {
        if (configElement.ValueKind != JsonValueKind.Object) return null;
        if (configElement.TryGetProperty("dataMapping", out var dm) && dm.ValueKind == JsonValueKind.Object) return dm;
        if (configElement.TryGetProperty("configJson", out var cj) && cj.ValueKind == JsonValueKind.Object
            && cj.TryGetProperty("dataMapping", out var dm2) && dm2.ValueKind == JsonValueKind.Object) return dm2;
        return null;
    }
}
```

> **Note for Sonnet**: `TaskEntity.ScraperConfigId` is nullable (per memory; M2.1 made it nullable). Confirm by reading [TaskEntity.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Entities\TaskEntity.cs). If it isn't nullable (memory wrong), drop the `.HasValue` guard and use `.ToString()` directly.

### 3.6 — Create `WebScrape.Services/Interfaces/IRunCsvExporter.cs`

```csharp
using WebScrape.Data.Entities;

namespace WebScrape.Services.Interfaces;

public interface IRunCsvExporter
{
    bool IsTabular(RunItem run);
    byte[] ExportRun(RunItem run, ScraperConfigEntity? liveConfig, RunBatch? batch);
    byte[] ExportBatch(RunBatch batch, IReadOnlyList<RunItem> items, ScraperConfigEntity? liveConfig);
}
```

### 3.7 — Create `WebScrape.Services/Implementations/RunCsvExporter.cs`

```csharp
using System.Globalization;
using System.Text;
using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class RunCsvExporter : IRunCsvExporter
{
    private static readonly char[] FormulaTriggers = { '=', '+', '-', '@', '\t', '\r' };

    public bool IsTabular(RunItem run)
    {
        if (run.ResultJsonb is null) return false;
        var root = run.ResultJsonb.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return false;
        if (!root.TryGetProperty("iterations", out var iters) || iters.ValueKind != JsonValueKind.Array) return false;
        foreach (var iter in iters.EnumerateArray())
        {
            if (iter.ValueKind != JsonValueKind.Object) continue;
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                if (row.TryGetProperty("blocks", out _) && row.TryGetProperty("tables", out _) && row.TryGetProperty("charts", out _))
                    return false; // wholepage-flattened iteration is not CSV-friendly
            }
        }
        return true;
    }

    public byte[] ExportRun(RunItem run, ScraperConfigEntity? liveConfig, RunBatch? batch)
    {
        var columns = ResolveColumns(run, liveConfig, batch);
        var sb = new StringBuilder();
        WriteHeader(sb, columns, includeRunId: false);
        WriteRunRows(sb, run, columns, includeRunId: false);
        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    public byte[] ExportBatch(RunBatch batch, IReadOnlyList<RunItem> items, ScraperConfigEntity? liveConfig)
    {
        var firstRun = items.FirstOrDefault(r => r.ResultJsonb is not null);
        var columns = ResolveColumns(firstRun, liveConfig, batch);
        var sb = new StringBuilder();
        WriteHeader(sb, columns, includeRunId: true);
        foreach (var run in items) WriteRunRows(sb, run, columns, includeRunId: true);
        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static IReadOnlyList<ResolvedColumn> ResolveColumns(RunItem? run, ScraperConfigEntity? liveConfig, RunBatch? batch)
    {
        var snapshotMapping = PopulateSnapshotReader.GetDataMappingForRun(batch, run);
        if (snapshotMapping is JsonElement m1) { var cols = ColumnsFromMapping(m1); if (cols.Count > 0) return cols; }

        if (liveConfig is not null)
        {
            var liveMapping = PopulateSnapshotReader.GetDataMapping(liveConfig.ConfigJson.RootElement);
            if (liveMapping is JsonElement m2) { var cols = ColumnsFromMapping(m2); if (cols.Count > 0) return cols; }
        }

        return UnionOfKeys(run);
    }

    private static IReadOnlyList<ResolvedColumn> ColumnsFromMapping(JsonElement mapping)
    {
        if (!mapping.TryGetProperty("columns", out var cols) || cols.ValueKind != JsonValueKind.Array) return Array.Empty<ResolvedColumn>();
        return cols.EnumerateArray()
            .Where(c => c.ValueKind == JsonValueKind.Object)
            .Where(c => !c.TryGetProperty("enabled", out var e) || e.ValueKind != JsonValueKind.False)
            .OrderBy(c => c.TryGetProperty("position", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0)
            .Select(c => new ResolvedColumn(
                OriginalName: c.TryGetProperty("originalName", out var on) && on.ValueKind == JsonValueKind.String ? on.GetString() ?? "" : "",
                DisplayName:  c.TryGetProperty("displayName",  out var dn) && dn.ValueKind == JsonValueKind.String ? dn.GetString() ?? "" : ""))
            .Where(c => !string.IsNullOrEmpty(c.OriginalName))
            .ToList();
    }

    private static IReadOnlyList<ResolvedColumn> UnionOfKeys(RunItem? run)
    {
        if (run?.ResultJsonb is null) return Array.Empty<ResolvedColumn>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();
        if (!run.ResultJsonb.RootElement.TryGetProperty("iterations", out var iters)) return Array.Empty<ResolvedColumn>();
        foreach (var iter in iters.EnumerateArray())
        {
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                foreach (var prop in row.EnumerateObject())
                    if (seen.Add(prop.Name)) ordered.Add(prop.Name);
            }
        }
        return ordered.Select(k => new ResolvedColumn(k, k)).ToList();
    }

    private static void WriteHeader(StringBuilder sb, IReadOnlyList<ResolvedColumn> columns, bool includeRunId)
    {
        if (includeRunId) { sb.Append(EscapeCell("run_id")); sb.Append(','); }
        sb.Append(EscapeCell("iteration_label")); sb.Append(',');
        sb.Append(EscapeCell("iteration_status"));
        foreach (var c in columns) { sb.Append(','); sb.Append(EscapeCell(string.IsNullOrEmpty(c.DisplayName) ? c.OriginalName : c.DisplayName)); }
        sb.Append("\r\n");
    }

    private static void WriteRunRows(StringBuilder sb, RunItem run, IReadOnlyList<ResolvedColumn> columns, bool includeRunId)
    {
        if (run.ResultJsonb is null) return;
        if (!run.ResultJsonb.RootElement.TryGetProperty("iterations", out var iters) || iters.ValueKind != JsonValueKind.Array) return;
        foreach (var iter in iters.EnumerateArray())
        {
            if (iter.ValueKind != JsonValueKind.Object) continue;
            var iterStatus = iter.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "" : "";
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (includeRunId) { sb.Append(EscapeCell(run.Id.ToString())); sb.Append(','); }
                sb.Append(EscapeCell(run.IterationLabel ?? "")); sb.Append(',');
                sb.Append(EscapeCell(iterStatus));
                foreach (var col in columns)
                {
                    sb.Append(',');
                    sb.Append(EscapeCell(ExtractCell(row, col.OriginalName)));
                }
                sb.Append("\r\n");
            }
        }
    }

    private static string ExtractCell(JsonElement row, string key)
    {
        if (row.ValueKind != JsonValueKind.Object) return "";
        if (!row.TryGetProperty(key, out var v)) return "";
        return v.ValueKind switch
        {
            JsonValueKind.String                       => v.GetString() ?? "",
            JsonValueKind.Number                       => v.GetRawText(),
            JsonValueKind.True or JsonValueKind.False  => v.GetBoolean().ToString(CultureInfo.InvariantCulture).ToLowerInvariant(),
            JsonValueKind.Null or JsonValueKind.Undefined => "",
            _                                          => v.GetRawText(),
        };
    }

    private static string EscapeCell(string raw)
    {
        if (raw.Length > 0 && Array.IndexOf(FormulaTriggers, raw[0]) >= 0) raw = "'" + raw;
        if (raw.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0) return raw;
        return "\"" + raw.Replace("\"", "\"\"") + "\"";
    }

    private record ResolvedColumn(string OriginalName, string DisplayName);
}
```

### 3.8 — Edit `WebScrape.Services/Interfaces/IRunService.cs`

Replace the full file:

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum RunExportOutcome { Ok, NotFound, Forbidden, NotTabular, BadFormat, NotReady }

public record RunExportResult(
    RunExportOutcome Outcome,
    byte[]? Bytes,
    string? Filename,
    string? ContentType);

public interface IRunService
{
    Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default);
    Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default);
    Task FailAsync(TaskErrorDto payload, CancellationToken ct = default);
    Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default);
    Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<PagedResultDto<RunListItemDto>> ListAsync(Guid userId, RunListQueryDto query, CancellationToken ct = default);
    Task<RunExportResult> ExportAsync(Guid userId, Guid runId, string format, CancellationToken ct = default);
}
```

### 3.9 — Edit `WebScrape.Services/Implementations/RunService.cs`

Add fields, ctor injection, and the two new methods. Replace `private readonly IWorkerNotifier _notifier;` line and the ctor; add the methods at the bottom of the class (before the `Truncate` helper).

**BEFORE** (lines 13–26):
```csharp
public class RunService : IRunService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IWorkerNotifier _notifier;
    private readonly ILogger<RunService> _log;

    public RunService(WebScrapeDbContext db, IMapper mapper, IWorkerNotifier notifier, ILogger<RunService> log)
    {
        _db = db;
        _mapper = mapper;
        _notifier = notifier;
        _log = log;
    }
```

**AFTER:**
```csharp
public class RunService : IRunService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IWorkerNotifier _notifier;
    private readonly IRunCsvExporter _csv;
    private readonly ILogger<RunService> _log;

    public RunService(
        WebScrapeDbContext db,
        IMapper mapper,
        IWorkerNotifier notifier,
        IRunCsvExporter csv,
        ILogger<RunService> log)
    {
        _db = db;
        _mapper = mapper;
        _notifier = notifier;
        _csv = csv;
        _log = log;
    }
```

Then add these two methods immediately before the `private static string Truncate(string? s)` line at the bottom of the class:

```csharp
    public async Task<PagedResultDto<RunListItemDto>> ListAsync(Guid userId, RunListQueryDto query, CancellationToken ct = default)
    {
        var page = query.Page < 1 ? 1 : query.Page;
        var pageSize = query.PageSize switch { < 1 => 1, > 100 => 100, var n => n };

        var q = _db.RunItems
            .AsNoTracking()
            .Include(r => r.Task)
            .Include(r => r.Worker)
            .Where(r => r.Task != null && r.Task.UserId == userId);

        if (query.TaskId.HasValue)   q = q.Where(r => r.TaskId == query.TaskId.Value);
        if (query.WorkerId.HasValue) q = q.Where(r => r.WorkerId == query.WorkerId.Value);
        if (query.BatchId.HasValue)  q = q.Where(r => r.BatchId == query.BatchId.Value);
        if (query.Status.HasValue)   q = q.Where(r => r.Status == query.Status.Value);
        if (query.From.HasValue)     q = q.Where(r => r.RequestedAt >= query.From.Value);
        if (query.To.HasValue)       q = q.Where(r => r.RequestedAt <= query.To.Value);

        var total = await q.CountAsync(ct);
        var rows = await q
            .OrderByDescending(r => r.RequestedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        return new PagedResultDto<RunListItemDto>
        {
            Items = _mapper.Map<List<RunListItemDto>>(rows),
            Total = total,
            Page = page,
            PageSize = pageSize,
        };
    }

    public async Task<RunExportResult> ExportAsync(Guid userId, Guid runId, string format, CancellationToken ct = default)
    {
        var fmt = (format ?? "").ToLowerInvariant();
        if (fmt != "json" && fmt != "csv")
            return new RunExportResult(RunExportOutcome.BadFormat, null, null, null);

        var run = await _db.RunItems
            .AsNoTracking()
            .Include(r => r.Task)
            .Include(r => r.Batch)
            .FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return new RunExportResult(RunExportOutcome.NotFound, null, null, null);
        if (run.Task is null || run.Task.UserId != userId)
            return new RunExportResult(RunExportOutcome.Forbidden, null, null, null);
        if (run.ResultJsonb is null)
            return new RunExportResult(RunExportOutcome.NotReady, null, null, null);

        if (fmt == "json")
        {
            var bytes = System.Text.Encoding.UTF8.GetBytes(run.ResultJsonb.RootElement.GetRawText());
            return new RunExportResult(RunExportOutcome.Ok, bytes, $"run-{run.Id}.json", "application/json");
        }

        if (!_csv.IsTabular(run))
            return new RunExportResult(RunExportOutcome.NotTabular, null, null, null);

        ScraperConfigEntity? liveConfig = null;
        if (run.Task.ScraperConfigId.HasValue)
        {
            liveConfig = await _db.ScraperConfigs
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == run.Task.ScraperConfigId.Value, ct);
        }

        var csvBytes = _csv.ExportRun(run, liveConfig, run.Batch);
        return new RunExportResult(RunExportOutcome.Ok, csvBytes, $"run-{run.Id}.csv", "text/csv");
    }
```

> Add `using WebScrape.Data.Entities;` to the file's `using` block if not present.

### 3.10 — Edit `WebScrape.Services/Interfaces/IRunBatchService.cs`

Replace the full file:

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

public enum RunBatchExportOutcome { Ok, NotFound, Forbidden, BadFormat }

public record RunBatchExportResult(
    RunBatchExportOutcome Outcome,
    byte[]? Bytes,
    string? Filename,
    string? ContentType);

public interface IRunBatchService
{
    Task<RunBatchDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task<RunBatchDetailDto?> GetAsync(Guid userId, Guid batchId, CancellationToken ct = default);
    Task<PagedResultDto<RunBatchListItemDto>> ListAsync(Guid userId, RunBatchListQueryDto query, CancellationToken ct = default);
    Task<RunBatchExportResult> ExportAsync(Guid userId, Guid batchId, string format, CancellationToken ct = default);
}
```

### 3.11 — Edit `WebScrape.Services/Implementations/RunBatchService.cs`

Add `IRunCsvExporter` injection. Replace ctor:

**BEFORE:**
```csharp
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
```

**AFTER:**
```csharp
public class RunBatchService : IRunBatchService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IQueueExpansionService _expander;
    private readonly IWorkerNotifier _notifier;
    private readonly IRunCsvExporter _csv;
    private readonly ILogger<RunBatchService> _log;

    public RunBatchService(
        WebScrapeDbContext db,
        IMapper mapper,
        IQueueExpansionService expander,
        IWorkerNotifier notifier,
        IRunCsvExporter csv,
        ILogger<RunBatchService> log)
    {
        _db = db;
        _mapper = mapper;
        _expander = expander;
        _notifier = notifier;
        _csv = csv;
        _log = log;
    }
```

Add these two methods at the bottom of the class (after `GetAsync`):

```csharp
    public async Task<PagedResultDto<RunBatchListItemDto>> ListAsync(Guid userId, RunBatchListQueryDto query, CancellationToken ct = default)
    {
        var page = query.Page < 1 ? 1 : query.Page;
        var pageSize = query.PageSize switch { < 1 => 1, > 100 => 100, var n => n };

        var q = _db.RunBatches
            .AsNoTracking()
            .Include(b => b.Task)
            .Include(b => b.Worker)
            .Where(b => b.UserId == userId);

        if (query.TaskId.HasValue) q = q.Where(b => b.TaskId == query.TaskId.Value);
        if (query.From.HasValue)   q = q.Where(b => b.CreatedAt >= query.From.Value);
        if (query.To.HasValue)     q = q.Where(b => b.CreatedAt <= query.To.Value);

        var total = await q.CountAsync(ct);
        var batches = await q
            .OrderByDescending(b => b.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        var batchIds = batches.Select(b => b.Id).ToList();
        var aggregates = await _db.RunItems
            .AsNoTracking()
            .Where(r => r.BatchId != null && batchIds.Contains(r.BatchId!.Value))
            .GroupBy(r => r.BatchId!.Value)
            .Select(g => new
            {
                BatchId = g.Key,
                Total = g.Count(),
                Completed = g.Count(r => r.Status == RunItemStatus.Completed),
                Failed    = g.Count(r => r.Status == RunItemStatus.Failed || r.Status == RunItemStatus.Cancelled),
                Pending   = g.Count(r => r.Status == RunItemStatus.Pending || r.Status == RunItemStatus.Sent
                                      || r.Status == RunItemStatus.Running || r.Status == RunItemStatus.Paused),
            })
            .ToListAsync(ct);
        var aggMap = aggregates.ToDictionary(a => a.BatchId);

        var items = batches.Select(b =>
        {
            aggMap.TryGetValue(b.Id, out var a);
            return new RunBatchListItemDto
            {
                Id = b.Id,
                TaskId = b.TaskId,
                TaskName = b.Task?.Name ?? "",
                WorkerId = b.WorkerId,
                WorkerName = b.Worker?.Name ?? "",
                CreatedAt = b.CreatedAt,
                TotalItems = a?.Total ?? 0,
                CompletedCount = a?.Completed ?? 0,
                FailedCount = a?.Failed ?? 0,
                PendingCount = a?.Pending ?? 0,
            };
        }).ToList();

        return new PagedResultDto<RunBatchListItemDto>
        {
            Items = items, Total = total, Page = page, PageSize = pageSize,
        };
    }

    public async Task<RunBatchExportResult> ExportAsync(Guid userId, Guid batchId, string format, CancellationToken ct = default)
    {
        var fmt = (format ?? "").ToLowerInvariant();
        if (fmt != "json" && fmt != "csv")
            return new RunBatchExportResult(RunBatchExportOutcome.BadFormat, null, null, null);

        var batch = await _db.RunBatches
            .AsNoTracking()
            .Include(b => b.Task)
            .FirstOrDefaultAsync(b => b.Id == batchId, ct);
        if (batch is null) return new RunBatchExportResult(RunBatchExportOutcome.NotFound, null, null, null);
        if (batch.UserId != userId) return new RunBatchExportResult(RunBatchExportOutcome.Forbidden, null, null, null);

        var items = await _db.RunItems
            .AsNoTracking()
            .Where(r => r.BatchId == batchId)
            .OrderBy(r => r.RequestedAt)
            .ToListAsync(ct);

        if (fmt == "json")
        {
            var envelope = new StringBuilder();
            envelope.Append("{\"batchId\":\"").Append(batch.Id).Append("\",\"items\":[");
            var first = true;
            foreach (var run in items)
            {
                if (!first) envelope.Append(',');
                first = false;
                envelope.Append("{\"runId\":\"").Append(run.Id).Append("\",\"iterationLabel\":");
                envelope.Append(JsonSerializer.Serialize(run.IterationLabel));
                envelope.Append(",\"status\":");
                envelope.Append(JsonSerializer.Serialize(run.Status.ToString().ToLowerInvariant()));
                envelope.Append(",\"result\":");
                envelope.Append(run.ResultJsonb is null ? "null" : run.ResultJsonb.RootElement.GetRawText());
                envelope.Append('}');
            }
            envelope.Append("]}");
            var jsonBytes = System.Text.Encoding.UTF8.GetBytes(envelope.ToString());
            return new RunBatchExportResult(RunBatchExportOutcome.Ok, jsonBytes, $"batch-{batch.Id}.json", "application/json");
        }

        ScraperConfigEntity? liveConfig = null;
        if (batch.Task is not null && batch.Task.ScraperConfigId.HasValue)
        {
            liveConfig = await _db.ScraperConfigs
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == batch.Task.ScraperConfigId.Value, ct);
        }

        var csvBytes = _csv.ExportBatch(batch, items, liveConfig);
        return new RunBatchExportResult(RunBatchExportOutcome.Ok, csvBytes, $"batch-{batch.Id}.csv", "text/csv");
    }
```

> Add `using System.Text;` and `using WebScrape.Data.Enums;` to the file's `using` block if not present.

### 3.12 — Edit `WebScrape.Server/Controllers/RunsController.cs`

Replace the full file:

```csharp
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/runs")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class RunsController : ControllerBase
{
    private readonly IRunService _runs;

    public RunsController(IRunService runs)
    {
        _runs = runs;
    }

    [HttpGet("")]
    public async Task<IActionResult> List([FromQuery] RunListQueryDto query, CancellationToken ct)
    {
        var page = await _runs.ListAsync(User.GetUserId(), query, ct);
        return Ok(page);
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _runs.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpGet("{id:guid}/export")]
    public async Task<IActionResult> Export(Guid id, [FromQuery] string format, CancellationToken ct)
    {
        var result = await _runs.ExportAsync(User.GetUserId(), id, format, ct);
        return result.Outcome switch
        {
            RunExportOutcome.Ok          => File(result.Bytes!, result.ContentType!, result.Filename),
            RunExportOutcome.BadFormat   => BadRequest(new { error = "format must be 'json' or 'csv'" }),
            RunExportOutcome.NotFound    => NotFound(),
            RunExportOutcome.NotReady    => NotFound(new { error = "Run is not yet complete" }),
            RunExportOutcome.Forbidden   => StatusCode(StatusCodes.Status403Forbidden),
            RunExportOutcome.NotTabular  => UnprocessableEntity(new { code = "ITERATION_NOT_TABULAR", error = "CSV isn't available for full-page results — use JSON export" }),
            _                            => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpPost("batch")]
    [CookieCsrf]
    public async Task<IActionResult> CreateBatch(
        [FromBody] CreateBatchDto dto,
        [FromServices] IRunBatchService batches,
        CancellationToken ct)
    {
        var result = await batches.CreateAndDispatchAsync(User.GetUserId(), dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            RunBatchOutcome.Created => Ok(new BatchDispatchResultDto
            {
                BatchId = result.BatchId!.Value,
                DispatchedCount = result.DispatchedCount,
                FailedCount = result.FailedCount,
            }),
            RunBatchOutcome.NotFound      => NotFound(new { error = result.Error }),
            RunBatchOutcome.Forbidden     => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            RunBatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            RunBatchOutcome.BatchEmpty    => UnprocessableEntity(new { code = "BATCH_EMPTY", error = result.Error }),
            RunBatchOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", error = result.Error }),
            _                              => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
}
```

### 3.13 — Edit `WebScrape.Server/Controllers/RunBatchesController.cs`

Replace the full file:

```csharp
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
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

    [HttpGet("")]
    public async Task<IActionResult> List([FromQuery] RunBatchListQueryDto query, CancellationToken ct)
    {
        var page = await _batches.ListAsync(User.GetUserId(), query, ct);
        return Ok(page);
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _batches.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpGet("{id:guid}/export")]
    public async Task<IActionResult> Export(Guid id, [FromQuery] string format, CancellationToken ct)
    {
        var result = await _batches.ExportAsync(User.GetUserId(), id, format, ct);
        return result.Outcome switch
        {
            RunBatchExportOutcome.Ok        => File(result.Bytes!, result.ContentType!, result.Filename),
            RunBatchExportOutcome.BadFormat => BadRequest(new { error = "format must be 'json' or 'csv'" }),
            RunBatchExportOutcome.NotFound  => NotFound(),
            RunBatchExportOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            _                                => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
}
```

### 3.14 — Edit `WebScrape.Server/Program.cs`

Register the new exporter as a singleton (it's stateless). Add this line after the existing `AddSingleton<IApiKeyTokenGenerator, ApiKeyTokenGenerator>();` at line 73:

**BEFORE:**
```csharp
builder.Services.AddSingleton<IApiKeyHasher, Argon2idApiKeyHasher>();
builder.Services.AddSingleton<IApiKeyTokenGenerator, ApiKeyTokenGenerator>();

builder.Services.AddScoped<IApiKeyService, ApiKeyService>();
```

**AFTER:**
```csharp
builder.Services.AddSingleton<IApiKeyHasher, Argon2idApiKeyHasher>();
builder.Services.AddSingleton<IApiKeyTokenGenerator, ApiKeyTokenGenerator>();
builder.Services.AddSingleton<IRunCsvExporter, RunCsvExporter>();

builder.Services.AddScoped<IApiKeyService, ApiKeyService>();
```

---

## 4. Frontend changes

All paths under `c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\`.

### 4.1 — Dependency

```bash
cd c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client
npm install recharts@^2.13.0
```

### 4.2 — Edit `api/types.ts`

Add `batchId?: string` to existing `RunItemDto` (at line 136). Replace:

**BEFORE:**
```typescript
export type RunItemDto = {
  id: string;
  taskId: string;
  workerId: string;
  status: RunStatus;
```

**AFTER:**
```typescript
export type RunItemDto = {
  id: string;
  taskId: string;
  workerId: string;
  batchId: string | null;
  status: RunStatus;
```

Append at the end of the file:

```typescript
// ── M3 list + export ──────────────────────────────────────────────────────

export type PagedResultDto<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type RunListItemDto = {
  id: string;
  taskId: string;
  taskName: string;
  workerId: string;
  workerName: string;
  batchId: string | null;
  status: RunStatus;
  requestedAt: string;
  completedAt: string | null;
  iterationLabel: string | null;
  progressPercent: number | null;
};

export type RunListQuery = {
  taskId?: string;
  workerId?: string;
  batchId?: string;
  status?: RunStatus;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export type RunBatchListItemDto = {
  id: string;
  taskId: string;
  taskName: string;
  workerId: string;
  workerName: string;
  createdAt: string;
  totalItems: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
};

export type RunBatchListQuery = {
  taskId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};
```

### 4.3 — Create `types/extraction.ts` (frozen contract from extension)

```typescript
// Frozen contract — mirrored from c:\Users\und3r\blueberry-v3\src\content\extraction\pageBlockExtractor.ts
// and c:\Users\und3r\blueberry-v3\src\content\extraction\chartExtractor.ts.
// Update only when extension's wire shape changes; cardDiscrimination tests catch drift.

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; listType: 'ul' | 'ol'; items: string[] }
  | { type: 'link'; text: string; href: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language: string | null }
  | { type: 'table'; ref: string; label: string }
  | { type: 'chart'; ref: string; label: string };

export interface TableEntry {
  id: string;
  label: string;
  rows: Record<string, unknown>[];
}

export interface ChartEntry {
  id: string;
  label: string;
  title: string | null;
  data: unknown;
  method: string | null;
  canExtract: boolean;
  _extractionNote?: string;
}

export interface PageContent {
  pageTitle: string;
  blocks: Block[];
  tables: TableEntry[];
  charts: ChartEntry[];
}

export interface IterationResult {
  searchTerm: string | null;
  data: Record<string, unknown>[];
  status: 'success' | 'error' | 'skipped';
  error?: string;
  pageUrls?: string[];
}

export interface ChartResult {
  data: unknown;
  title: string | null;
  method: string | null;
  canExtract: boolean;
  message?: string;
  _extractionNote?: string;
}

// dataMapping is part of the scrape config, not extraction output — but the result viewer reads it.
export interface MappingColumn {
  id: string;
  originalName: string;
  displayName: string;
  enabled: boolean;
  position: number;
  sourceType: 'scrapeElement' | 'apiCall' | 'computed';
  apiCallId?: string;
}

export interface DataMapping {
  version: 1;
  columns: MappingColumn[];
}
```

### 4.4 — Create `utils/safeHref.ts`

```typescript
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns a safe href to use in <a href={...}>, or null if the input is missing,
 * malformed, or uses a non-allowlisted scheme. Defends against javascript:/data: XSS
 * when rendering scraped link blocks.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
```

### 4.5 — Create `utils/safeHref.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { safeHref } from './safeHref';

describe('safeHref', () => {
  it('passes http URLs', () => { expect(safeHref('http://example.com/a')).toBe('http://example.com/a'); });
  it('passes https URLs', () => { expect(safeHref('https://example.com/')).toBe('https://example.com/'); });
  it('passes mailto', () => { expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c'); });
  it('blocks javascript:', () => { expect(safeHref('javascript:alert(1)')).toBeNull(); });
  it('blocks JavaScript: case-insensitive', () => { expect(safeHref('JavaScript:alert(1)')).toBeNull(); });
  it('blocks data: URLs', () => { expect(safeHref('data:text/html,<script>1</script>')).toBeNull(); });
  it('blocks file:', () => { expect(safeHref('file:///etc/passwd')).toBeNull(); });
  it('rejects relative paths', () => { expect(safeHref('/foo')).toBeNull(); });
  it('rejects empty', () => { expect(safeHref('')).toBeNull(); });
  it('rejects whitespace-only', () => { expect(safeHref('   ')).toBeNull(); });
  it('rejects non-strings', () => { expect(safeHref(null)).toBeNull(); expect(safeHref(undefined)).toBeNull(); expect(safeHref(42)).toBeNull(); });
});
```

### 4.6 — Create `utils/cardDiscrimination.ts`

```typescript
import type { DataMapping, IterationResult, PageContent, ChartResult } from '../types/extraction';

export type CardKind =
  | { kind: 'empty' }
  | { kind: 'table-iteration'; rows: Record<string, unknown>[]; mapping: DataMapping }
  | { kind: 'mixed'; perRow: FieldCard[][] };

export type FieldCard =
  | { kind: 'chart'; fieldName: string | null; value: ChartResult }
  | { kind: 'table-field'; fieldName: string; rows: Record<string, unknown>[] }
  | { kind: 'pageblocks'; fieldName: string | null; value: PageContent }
  | { kind: 'text'; fields: Record<string, string | number | boolean | null> }
  | { kind: 'raw'; fieldName: string | null; value: unknown };

export function discriminateIteration(iter: IterationResult, mapping?: DataMapping): CardKind {
  const rows = Array.isArray(iter.data) ? iter.data : [];
  if (rows.length === 0) return { kind: 'empty' };

  // Fast path: every row is all-scalars, every key is a known mapping originalName.
  if (mapping?.columns?.length) {
    const allowed = new Set(mapping.columns.map((c) => c.originalName));
    const allTabular = rows.every(
      (r) =>
        r != null &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Object.entries(r as Record<string, unknown>).every(
          ([k, v]) =>
            allowed.has(k) &&
            (v === null || ['string', 'number', 'boolean'].includes(typeof v)),
        ),
    );
    if (allTabular) return { kind: 'table-iteration', rows, mapping };
  }

  const perRow: FieldCard[][] = rows.map((row) => discriminateRow(row));
  return { kind: 'mixed', perRow };
}

function discriminateRow(row: unknown): FieldCard[] {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return [{ kind: 'raw', fieldName: null, value: row }];
  }
  // Whole-row PageContent (wholepage-flattened): the row itself IS the PageContent.
  if (isPageContent(row)) {
    return [{ kind: 'pageblocks', fieldName: null, value: row as unknown as PageContent }];
  }
  const cards: FieldCard[] = [];
  const scalars: Record<string, string | number | boolean | null> = {};
  for (const [fieldName, value] of Object.entries(row as Record<string, unknown>)) {
    if (isChart(value)) {
      cards.push({ kind: 'chart', fieldName, value: value as ChartResult });
    } else if (isPageContent(value)) {
      cards.push({ kind: 'pageblocks', fieldName, value: value as PageContent });
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => v != null && typeof v === 'object' && !Array.isArray(v))
    ) {
      cards.push({ kind: 'table-field', fieldName, rows: value as Record<string, unknown>[] });
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      scalars[fieldName] = value as string | number | boolean | null;
    } else {
      cards.push({ kind: 'raw', fieldName, value });
    }
  }
  if (Object.keys(scalars).length > 0) cards.push({ kind: 'text', fields: scalars });
  return cards;
}

function isChart(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.canExtract === 'boolean' && 'method' in o) return true;
  if (o._canExtract === false || '_warning' in o) return true;
  return false;
}

function isPageContent(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.blocks) && Array.isArray(o.tables) && Array.isArray(o.charts);
}
```

### 4.7 — Create `utils/cardDiscrimination.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { discriminateIteration } from './cardDiscrimination';
import type { DataMapping, IterationResult } from '../types/extraction';

const mappingFor = (...names: string[]): DataMapping => ({
  version: 1,
  columns: names.map((n, i) => ({
    id: `c${i}`, originalName: n, displayName: n, enabled: true, position: i, sourceType: 'scrapeElement',
  })),
});
const iter = (data: Record<string, unknown>[]): IterationResult => ({
  searchTerm: 't', data, status: 'success',
});

describe('discriminateIteration', () => {
  it('empty data → empty', () => {
    expect(discriminateIteration(iter([])).kind).toBe('empty');
  });

  it('flat scalar rows + matching mapping → table-iteration', () => {
    const r = discriminateIteration(iter([{ name: 'a', price: 1 }, { name: 'b', price: 2 }]), mappingFor('name', 'price'));
    expect(r.kind).toBe('table-iteration');
  });

  it('flat rows but no mapping → mixed (per-field text card)', () => {
    const r = discriminateIteration(iter([{ name: 'a', price: 1 }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('text');
  });

  it('chart record under a key → chart card', () => {
    const r = discriminateIteration(iter([{
      myChart: { data: [], title: 't', method: 'js_library', canExtract: true },
    }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('chart');
  });

  it('chart fallback shape (_canExtract:false) → chart card', () => {
    const r = discriminateIteration(iter([{ chart2: { _canExtract: false, _warning: 'no data' } }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('chart');
  });

  it('Array<Record> under a key → table-field card', () => {
    const r = discriminateIteration(iter([{ rows: [{ a: 1 }, { a: 2 }] }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('table-field');
  });

  it('PageContent shape under a key → pageblocks card', () => {
    const r = discriminateIteration(iter([{ wholePage: { pageTitle: 't', blocks: [], tables: [], charts: [] } }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('pageblocks');
  });

  it('row is itself PageContent (wholepage-flattened) → pageblocks card', () => {
    const r = discriminateIteration(iter([{ pageTitle: 't', blocks: [], tables: [], charts: [] }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('pageblocks');
    expect((r.perRow[0][0] as { kind: string; fieldName: string | null }).fieldName).toBeNull();
  });

  it('mixed row → per-field dispatch', () => {
    const r = discriminateIteration(iter([{
      name: 'A',
      chart: { data: [], method: 'aria', canExtract: true },
      rows: [{ x: 1 }],
    }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    const kinds = r.perRow[0].map((c) => c.kind).sort();
    expect(kinds).toEqual(['chart', 'table-field', 'text']);
  });

  it('all scalars → grouped text card (one per row)', () => {
    const r = discriminateIteration(iter([{ a: 1, b: 'x', c: true }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0]).toHaveLength(1);
    expect(r.perRow[0][0].kind).toBe('text');
  });

  it('null row → raw card', () => {
    const r = discriminateIteration(iter([null as unknown as Record<string, unknown>]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('raw');
  });

  it('unknown shape → raw card', () => {
    const r = discriminateIteration(iter([{ thing: () => 1 } as unknown as Record<string, unknown>]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('raw');
  });
});
```

### 4.8 — Create `utils/exportLinks.ts`

```typescript
export function runExportUrl(runId: string, format: 'json' | 'csv'): string {
  return `/api/runs/${encodeURIComponent(runId)}/export?format=${format}`;
}

export function batchExportUrl(batchId: string, format: 'json' | 'csv'): string {
  return `/api/run-batches/${encodeURIComponent(batchId)}/export?format=${format}`;
}
```

### 4.9 — Create `utils/chartPalette.ts`

```typescript
// CSS-variable strings (resolved by the browser at render time).
// Never inline hex/rgb in JSX or chart props — go through this helper.
export const chartPalette = {
  primary:    'var(--purple-primary)',
  secondary:  'var(--magenta-secondary)',
  light:      'var(--purple-light)',
  textDark:   'var(--text-dark)',
  textLight:  'var(--text-light)',
  border:     'var(--border)',
  success:    'var(--success)',
  warning:    'var(--warning)',
  danger:     'var(--danger)',
};

// Series colours, in order. Repeats from index 0 once exhausted.
export const seriesColours = [
  chartPalette.primary,
  chartPalette.secondary,
  chartPalette.light,
  chartPalette.warning,
  chartPalette.success,
];

export function colourFor(index: number): string {
  return seriesColours[index % seriesColours.length];
}
```

### 4.10 — Edit `api/queries.ts`

Append at the end of the file:

```typescript
import type {
  PagedResultDto,
  RunBatchListItemDto,
  RunBatchListQuery,
  RunListItemDto,
  RunListQuery,
} from './types';

function paramsOf(q: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  return sp;
}

export function useRunsList(query: RunListQuery) {
  return useQuery({
    queryKey: ['runs', query],
    queryFn: async (): Promise<PagedResultDto<RunListItemDto>> => {
      const sp = paramsOf(query as Record<string, unknown>);
      return (await api.get<PagedResultDto<RunListItemDto>>(`/api/runs?${sp.toString()}`)).data;
    },
    refetchInterval: shouldPollRunsList(query) ? RUN_POLL_MS : false,
  });
}

function shouldPollRunsList(q: RunListQuery): boolean {
  if (!q.status) return true; // no status filter → assume some runs may still be active
  return !['completed', 'failed', 'cancelled'].includes(q.status);
}

export function useRunBatchesList(query: RunBatchListQuery) {
  return useQuery({
    queryKey: ['run-batches-list', query],
    queryFn: async (): Promise<PagedResultDto<RunBatchListItemDto>> => {
      const sp = paramsOf(query as Record<string, unknown>);
      return (await api.get<PagedResultDto<RunBatchListItemDto>>(`/api/run-batches?${sp.toString()}`)).data;
    },
    refetchInterval: WORKER_POLL_MS,
  });
}

export function useRecentRunsForTask(taskId: string | undefined, limit: number = 5) {
  return useQuery({
    queryKey: ['recent-runs', taskId, limit],
    enabled: !!taskId,
    queryFn: async (): Promise<RunListItemDto[]> => {
      const sp = paramsOf({ taskId, page: 1, pageSize: limit });
      const data = (await api.get<PagedResultDto<RunListItemDto>>(`/api/runs?${sp.toString()}`)).data;
      return data.items;
    },
    staleTime: 10_000,
  });
}
```

### 4.11 — Create `components/result/ResultViewer.tsx`

```tsx
import { useState } from 'react';
import type { DataMapping, IterationResult } from '../../types/extraction';
import { discriminateIteration } from '../../utils/cardDiscrimination';
import IterationCards from './IterationCards';

type Props = {
  iterations: IterationResult[];
  dataMapping?: DataMapping;
};

const STATUS_DOT: Record<IterationResult['status'], string> = {
  success: 'success',
  error: 'error',
  skipped: 'pending',
};

export default function ResultViewer({ iterations, dataMapping }: Props) {
  if (!iterations || iterations.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No iterations yet</div>
        <div className="empty-state-desc">Result will appear when this run finishes.</div>
      </div>
    );
  }

  return (
    <div className="config-list">
      {iterations.map((iter, i) => (
        <IterationAccordion key={i} index={i} iter={iter} mapping={dataMapping} />
      ))}
    </div>
  );
}

function IterationAccordion({ index, iter, mapping }: { index: number; iter: IterationResult; mapping?: DataMapping }) {
  const [open, setOpen] = useState(iter.status !== 'success');
  const card = discriminateIteration(iter, mapping);
  return (
    <div className="card list-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-sm w-full"
        style={{ background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
      >
        <span className={`status-dot ${STATUS_DOT[iter.status]}`} />
        <span className="font-medium">
          {index + 1}. {iter.searchTerm ?? '—'}
        </span>
        <span className="text-sm text-light">({iter.status})</span>
        {iter.error && <span className="text-sm text-danger truncate" title={iter.error}>· {iter.error}</span>}
        <span className="sidebar-spacer" />
        <span className="text-light">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
          <IterationCards card={card} />
        </div>
      )}
    </div>
  );
}
```

### 4.12 — Create `components/result/IterationCards.tsx`

```tsx
import type { CardKind, FieldCard } from '../../utils/cardDiscrimination';
import TableCard from './TableCard';
import ChartCard from './ChartCard';
import PageBlocksCard from './PageBlocksCard';
import TextCard from './TextCard';
import RawJsonCard from './RawJsonCard';

export default function IterationCards({ card }: { card: CardKind }) {
  if (card.kind === 'empty') {
    return (
      <div className="empty-state" style={{ minHeight: 80 }}>
        <div className="empty-state-desc">No data extracted.</div>
      </div>
    );
  }
  if (card.kind === 'table-iteration') {
    return <TableCard rows={card.rows} mapping={card.mapping} />;
  }
  return (
    <div className="flex flex-col gap-sm">
      {card.perRow.map((cards, rowIdx) => (
        <div key={rowIdx} className="flex flex-col gap-sm">
          {cards.map((c, i) => <FieldCardRender key={i} card={c} />)}
        </div>
      ))}
    </div>
  );
}

function FieldCardRender({ card }: { card: FieldCard }) {
  switch (card.kind) {
    case 'chart':       return <ChartCard fieldName={card.fieldName} value={card.value} />;
    case 'table-field': return <TableCard rows={card.rows} fieldName={card.fieldName} />;
    case 'pageblocks':  return <PageBlocksCard fieldName={card.fieldName} value={card.value} />;
    case 'text':        return <TextCard fields={card.fields} />;
    case 'raw':         return <RawJsonCard fieldName={card.fieldName} value={card.value} />;
  }
}
```

### 4.13 — Create `components/result/TableCard.tsx`

```tsx
import { useState } from 'react';
import type { DataMapping } from '../../types/extraction';
import RawJsonCard from './RawJsonCard';

type Props = {
  rows: Record<string, unknown>[];
  mapping?: DataMapping;
  fieldName?: string;
};

export default function TableCard({ rows, mapping, fieldName }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const columns = mapping?.columns?.length
    ? mapping.columns.filter((c) => c.enabled).sort((a, b) => a.position - b.position)
    : unionKeys(rows).map((k, i) => ({ id: k, originalName: k, displayName: k, enabled: true, position: i, sourceType: 'scrapeElement' as const }));

  return (
    <section className="card">
      <div className="run-log-title">
        {fieldName ? `Table — ${fieldName}` : 'Table'} ({rows.length} row{rows.length === 1 ? '' : 's'})
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>{columns.map((c) => <th key={c.id}>{c.displayName || c.originalName}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.id} className="truncate" style={{ maxWidth: 320 }} title={cellTitle(r[c.originalName])}>
                    {renderCell(r[c.originalName])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName ?? null} value={rows} />}
    </section>
  );
}

function unionKeys(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!set.has(k)) { set.add(k); seen.push(k); }
  return seen;
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function cellTitle(v: unknown): string {
  return renderCell(v);
}
```

### 4.14 — Create `components/result/ChartCard.tsx`

```tsx
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartResult } from '../../types/extraction';
import { chartPalette, colourFor } from '../../utils/chartPalette';
import RawJsonCard from './RawJsonCard';

export default function ChartCard({ fieldName, value }: { fieldName: string | null; value: ChartResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const headerLabel = fieldName ? `Chart — ${fieldName}` : 'Chart';
  const titleLine = value.title ? <div className="text-sm text-light">{value.title}</div> : null;

  if (!value.canExtract) {
    return (
      <section className="card">
        <div className="run-log-title">{headerLabel}</div>
        {titleLine}
        <div className="run-banner run-banner-warning" style={{ marginTop: 'var(--spacing-sm)' }}>
          We could see this chart but couldn't read its data.
        </div>
        {value._extractionNote && <div className="text-sm text-light">{value._extractionNote}</div>}
        <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? 'Hide raw' : 'View raw'}
          </button>
        </div>
        {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
      </section>
    );
  }

  const series = pickSeries(value.data);
  if (!series) {
    // canExtract was true but data shape isn't plottable — fall back gracefully.
    return (
      <section className="card">
        <div className="run-log-title">{headerLabel}</div>
        {titleLine}
        <div className="text-sm text-light">Data extracted but couldn't be plotted.</div>
        <RawJsonCard fieldName={fieldName} value={value.data} />
      </section>
    );
  }

  const numericX = series.rows.length > 0 && typeof series.rows[0][series.xKey] === 'number';

  return (
    <section className="card">
      <div className="run-log-title">{headerLabel}</div>
      {titleLine}
      <div style={{ width: '100%', height: 280, marginTop: 'var(--spacing-sm)' }}>
        <ResponsiveContainer width="100%" height="100%">
          {numericX ? (
            <LineChart data={series.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartPalette.border} />
              <XAxis dataKey={series.xKey} stroke={chartPalette.textLight} />
              <YAxis stroke={chartPalette.textLight} />
              <Tooltip />
              <Legend />
              {series.yKeys.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k} stroke={colourFor(i)} dot={false} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={series.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartPalette.border} />
              <XAxis dataKey={series.xKey} stroke={chartPalette.textLight} />
              <YAxis stroke={chartPalette.textLight} />
              <Tooltip />
              <Legend />
              {series.yKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={colourFor(i)} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      <div className="flex gap-sm">
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
    </section>
  );
}

/**
 * Best-effort extraction of plottable rows from the various ChartResult shapes the extension
 * produces. Returns null if nothing recognisable.
 */
function pickSeries(data: unknown): { rows: Record<string, unknown>[]; xKey: string; yKeys: string[] } | null {
  if (data === null || typeof data !== 'object') return null;

  // Case 1: data is an array of row objects (accessible_table extractor returns this).
  if (Array.isArray(data)) return rowsFromArray(data);

  const obj = data as Record<string, unknown>;

  // Case 2: { rows: [...] }
  if (Array.isArray(obj.rows)) return rowsFromArray(obj.rows as unknown[]);

  // Case 3: { categories: [...], series: [{ name, data: [...] }] } — Highcharts/ApexCharts shape.
  if (Array.isArray(obj.categories) && Array.isArray(obj.series)) {
    const cats = obj.categories as unknown[];
    const seriesArr = obj.series as Array<{ name?: unknown; data?: unknown }>;
    const yKeys: string[] = [];
    const rows: Record<string, unknown>[] = cats.map((c, i) => {
      const row: Record<string, unknown> = { x: typeof c === 'string' || typeof c === 'number' ? c : String(c) };
      seriesArr.forEach((s, sIdx) => {
        const name = typeof s.name === 'string' && s.name ? s.name : `series${sIdx}`;
        if (i === 0) yKeys.push(name);
        if (Array.isArray(s.data) && s.data[i] != null && typeof s.data[i] !== 'object') {
          row[name] = s.data[i];
        }
      });
      return row;
    });
    return rows.length > 0 ? { rows, xKey: 'x', yKeys } : null;
  }

  return null;
}

function rowsFromArray(arr: unknown[]): { rows: Record<string, unknown>[]; xKey: string; yKeys: string[] } | null {
  const rows = arr.filter((r): r is Record<string, unknown> => r != null && typeof r === 'object' && !Array.isArray(r));
  if (rows.length === 0) return null;
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  if (keys.length < 2) return null;
  const xKey = keys[0];
  const yKeys = keys.slice(1).filter((k) => rows.some((r) => typeof r[k] === 'number'));
  if (yKeys.length === 0) return null;
  return { rows, xKey, yKeys };
}
```

### 4.15 — Create `components/result/PageBlocksCard.tsx`

```tsx
import { useState } from 'react';
import type { Block, ChartEntry, PageContent, TableEntry } from '../../types/extraction';
import { safeHref } from '../../utils/safeHref';
import TableCard from './TableCard';
import ChartCard from './ChartCard';
import RawJsonCard from './RawJsonCard';

export default function PageBlocksCard({ fieldName, value }: { fieldName: string | null; value: PageContent }) {
  const [showRaw, setShowRaw] = useState(false);
  const tablesById = new Map<string, TableEntry>(value.tables.map((t) => [t.id, t]));
  const chartsById = new Map<string, ChartEntry>(value.charts.map((c) => [c.id, c]));

  return (
    <section className="card">
      <div className="run-log-title">
        {fieldName ? `Page content — ${fieldName}` : 'Page content'}
      </div>
      {value.pageTitle && <h3 className="font-semibold" style={{ fontSize: 'var(--font-size-md)' }}>{value.pageTitle}</h3>}
      <div className="flex flex-col gap-sm">
        {value.blocks.map((b, i) => <BlockRender key={i} block={b} tables={tablesById} charts={chartsById} />)}
      </div>
      <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
    </section>
  );
}

function BlockRender({ block, tables, charts }: { block: Block; tables: Map<string, TableEntry>; charts: Map<string, ChartEntry> }) {
  switch (block.type) {
    case 'heading': {
      const level = block.level;
      const Tag = (`h${Math.min(Math.max(level + 1, 2), 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      return <Tag className="font-semibold">{block.text}</Tag>;
    }
    case 'paragraph': return <p className="text-sm">{block.text}</p>;
    case 'list': {
      const Tag = block.listType === 'ol' ? 'ol' : 'ul';
      return <Tag style={{ paddingLeft: 'var(--spacing-lg)' }}>{block.items.map((it, i) => <li key={i} className="text-sm">{it}</li>)}</Tag>;
    }
    case 'link': {
      const href = safeHref(block.href);
      if (!href) return <span className="text-sm">{block.text || block.href}</span>;
      return <a className="text-sm" href={href} target="_blank" rel="noopener noreferrer">{block.text || href}</a>;
    }
    case 'quote': return <blockquote className="text-sm text-light" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 'var(--spacing-sm)' }}>{block.text}</blockquote>;
    case 'code': return <pre className="json-preview">{block.text}</pre>;
    case 'table': {
      const t = tables.get(block.ref);
      if (!t) return <div className="text-sm text-light">Missing table {block.ref}</div>;
      return <TableCard rows={t.rows} fieldName={t.label} />;
    }
    case 'chart': {
      const c = charts.get(block.ref);
      if (!c) return <div className="text-sm text-light">Missing chart {block.ref}</div>;
      return <ChartCard fieldName={c.label} value={{
        data: c.data, title: c.title, method: c.method, canExtract: c.canExtract, _extractionNote: c._extractionNote,
      }} />;
    }
  }
}
```

### 4.16 — Create `components/result/TextCard.tsx`

```tsx
type Props = {
  fields: Record<string, string | number | boolean | null>;
};

export default function TextCard({ fields }: Props) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return (
    <section className="card">
      <div className="run-log-title">Fields</div>
      <dl className="flex flex-col gap-xs" style={{ margin: 0 }}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-sm" style={{ alignItems: 'baseline' }}>
            <dt className="text-xs text-light" style={{ minWidth: 120 }}>{k}</dt>
            <dd className="text-sm" style={{ margin: 0 }}>{v === null ? '—' : String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

### 4.17 — Create `components/result/RawJsonCard.tsx`

```tsx
type Props = {
  fieldName: string | null;
  value: unknown;
};

export default function RawJsonCard({ fieldName, value }: Props) {
  return (
    <section className="card">
      <div className="run-log-title">{fieldName ? `Raw — ${fieldName}` : 'Raw'}</div>
      <pre className="json-preview" style={{ maxHeight: 400 }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
```

### 4.18 — Create `components/RecentRunsPanel.tsx`

```tsx
import { Link } from 'react-router-dom';
import { useRecentRunsForTask } from '../api/queries';
import { statusLabel } from '../utils/runStatus';
import type { RunStatus } from '../api/types';

const DOT_FOR: Record<RunStatus, string> = {
  pending: 'pending', sent: 'pending', running: 'running', paused: 'pending',
  completed: 'success', failed: 'error', cancelled: 'error',
};

export default function RecentRunsPanel({ taskId, limit = 5 }: { taskId: string; limit?: number }) {
  const { data, isPending } = useRecentRunsForTask(taskId, limit);
  if (isPending || !data || data.length === 0) return null;

  return (
    <div className="flex items-center gap-sm text-sm text-light" style={{ flexWrap: 'wrap' }}>
      <span className="text-xs">Recent:</span>
      {data.map((r) => (
        <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-xs">
          <span className={`status-dot ${DOT_FOR[r.status]}`} />
          <span className="truncate" style={{ maxWidth: 120 }}>{statusLabel(r.status)}</span>
        </Link>
      ))}
      <Link to={`/runs?taskId=${encodeURIComponent(taskId)}`} className="text-sm">See all</Link>
    </div>
  );
}
```

### 4.19 — Create `pages/Runs.tsx`

```tsx
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useRunsList, useTasks } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunListQuery, RunStatus } from '../api/types';
import { statusLabel } from '../utils/runStatus';

const STATUS_OPTIONS: Array<{ value: '' | RunStatus; label: string }> = [
  { value: '',                          label: 'All statuses' },
  { value: RunItemStatus.Pending,       label: 'Pending' },
  { value: RunItemStatus.Sent,          label: 'Sent' },
  { value: RunItemStatus.Running,       label: 'Running' },
  { value: RunItemStatus.Paused,        label: 'Paused' },
  { value: RunItemStatus.Completed,     label: 'Completed' },
  { value: RunItemStatus.Failed,        label: 'Failed' },
  { value: RunItemStatus.Cancelled,     label: 'Cancelled' },
];

const DOT_FOR: Record<RunStatus, string> = {
  pending: 'pending', sent: 'pending', running: 'running', paused: 'pending',
  completed: 'success', failed: 'error', cancelled: 'error',
};

export default function Runs() {
  const [sp, setSp] = useSearchParams();
  const { data: tasks } = useTasks();

  const query: RunListQuery = useMemo(() => ({
    taskId:   sp.get('taskId') ?? undefined,
    status:   (sp.get('status') as RunStatus | null) ?? undefined,
    from:     sp.get('from') ?? undefined,
    to:       sp.get('to') ?? undefined,
    page:     Number(sp.get('page') ?? '1') || 1,
    pageSize: Number(sp.get('pageSize') ?? '25') || 25,
  }), [sp]);

  const { data, isPending } = useRunsList(query);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v); else next.delete(k);
    if (k !== 'page') next.delete('page'); // any filter change resets pagination
    setSp(next);
  };
  const clearAll = () => setSp(new URLSearchParams());

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Run History</h2>
      </div>
      <div className="view-subtitle">Browse and export every run across your tasks.</div>

      <div className="flex gap-sm items-center" style={{ flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 200 }}>
          <label className="form-label">Task</label>
          <select className="form-select" value={query.taskId ?? ''} onChange={(e) => setParam('taskId', e.target.value)}>
            <option value="">All tasks</option>
            {tasks?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
          <label className="form-label">Status</label>
          <select className="form-select" value={query.status ?? ''} onChange={(e) => setParam('status', e.target.value)}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">From</label>
          <input type="datetime-local" className="form-input" value={query.from ?? ''} onChange={(e) => setParam('from', e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">To</label>
          <input type="datetime-local" className="form-input" value={query.to ?? ''} onChange={(e) => setParam('to', e.target.value)} />
        </div>
        <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear</button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}
      {!isPending && data && data.items.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">{sp.toString() ? 'No matches' : 'No runs yet'}</div>
          <div className="empty-state-desc">{sp.toString() ? 'Try clearing some filters.' : 'Queue a batch from a task to get started.'}</div>
          {sp.toString() && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
        </div>
      )}

      {!isPending && data && data.items.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Task</th>
                <th>Iteration</th>
                <th>Worker</th>
                <th>Requested</th>
                <th>Completed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td><span className={`status-dot ${DOT_FOR[r.status]}`} /> <span className="text-sm">{statusLabel(r.status)}</span></td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={r.taskName}>{r.taskName}</td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={r.iterationLabel ?? ''}>{r.iterationLabel ?? '—'}</td>
                  <td>{r.workerName}</td>
                  <td className="text-sm text-light">{new Date(r.requestedAt).toLocaleString()}</td>
                  <td className="text-sm text-light">{r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}</td>
                  <td><Link to={`/runs/${r.id}`} className="btn btn-secondary btn-sm">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={data.total} page={data.page} pageSize={data.pageSize} setPage={(p) => setParam('page', String(p))} />
        </>
      )}
    </div>
  );
}

function Pagination({ total, page, pageSize, setPage }: { total: number; page: number; pageSize: number; setPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages === 1) return null;
  return (
    <div className="flex items-center justify-between gap-sm" style={{ marginTop: 'var(--spacing-md)' }}>
      <span className="text-sm text-light">Page {page} of {totalPages} · {total} total</span>
      <div className="flex gap-sm">
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
```

### 4.20 — Edit `pages/RunDetail.tsx`

Replace the full file:

```tsx
import { useParams, Link } from 'react-router-dom';
import { useRun } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunStatus } from '../api/types';
import { statusLabel } from '../utils/runStatus';
import ResultViewer from '../components/result/ResultViewer';
import RawJsonCard from '../components/result/RawJsonCard';
import { runExportUrl } from '../utils/exportLinks';
import type { DataMapping, IterationResult } from '../types/extraction';

const BANNER_CLASS: Partial<Record<RunStatus, string>> = {
  [RunItemStatus.Completed]: 'run-banner-success',
  [RunItemStatus.Failed]:    'run-banner-error',
  [RunItemStatus.Cancelled]: 'run-banner-error',
  [RunItemStatus.Paused]:    'run-banner-warning',
};

function isWholepageResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const iters = (result as { iterations?: unknown }).iterations;
  if (!Array.isArray(iters)) return false;
  return iters.some((it) => Array.isArray((it as { data?: unknown[] }).data) &&
    (it as { data: unknown[] }).data.some((row) =>
      row != null && typeof row === 'object'
      && Array.isArray((row as Record<string, unknown>).blocks)
      && Array.isArray((row as Record<string, unknown>).tables)
      && Array.isArray((row as Record<string, unknown>).charts)));
}

export default function RunDetail() {
  const { id } = useParams();
  const { data: run, isPending, error } = useRun(id);

  if (isPending) {
    return <div className="view"><div className="loading-state">Loading…</div></div>;
  }
  if (error || !run) {
    return <div className="view"><div className="danger-banner">Couldn't load this run. It may not exist.</div></div>;
  }

  const bannerClass = BANNER_CLASS[run.status];
  const pct = run.progressPercent ?? 0;
  const result = run.result as { iterations?: IterationResult[]; dataMapping?: DataMapping } | null;
  const iterations = result?.iterations ?? [];
  const dataMapping = result?.dataMapping;
  const isComplete = run.status === RunItemStatus.Completed;
  const csvDisabled = !isComplete || isWholepageResult(run.result);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back">←</Link>
          <h2 className="view-title">Run</h2>
          {run.batchId && (
            <Link to={`/run-batches/${run.batchId}`} className="text-sm">Back to batch</Link>
          )}
        </div>
        <div className="flex gap-sm">
          <a
            className={`btn btn-secondary btn-sm${isComplete ? '' : ' disabled'}`}
            href={isComplete ? runExportUrl(run.id, 'json') : undefined}
            aria-disabled={!isComplete}
            target="_blank"
            rel="noreferrer"
            title={isComplete ? '' : 'Run is not yet complete'}
            style={isComplete ? {} : { pointerEvents: 'none', opacity: 0.5 }}
          >
            Export JSON
          </a>
          <a
            className={`btn btn-secondary btn-sm${csvDisabled ? ' disabled' : ''}`}
            href={!csvDisabled ? runExportUrl(run.id, 'csv') : undefined}
            aria-disabled={csvDisabled}
            target="_blank"
            rel="noreferrer"
            title={csvDisabled ? "CSV isn't available for full-page results — use Export JSON" : ''}
            style={csvDisabled ? { pointerEvents: 'none', opacity: 0.5 } : {}}
          >
            Export CSV
          </a>
        </div>
      </div>

      {bannerClass ? (
        <div className={`run-banner ${bannerClass}`}>
          {statusLabel(run.status)}
          {run.errorMessage ? ` — ${run.errorMessage}` : ''}
        </div>
      ) : (
        <div className="view-subtitle">{statusLabel(run.status)}</div>
      )}

      <div className="run-progress-bar-wrap">
        <div className="run-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="run-progress-label">
        {pct}%
        {run.currentTerm ? ` · ${run.currentTerm}` : ''}
        {run.currentStep ? ` · ${run.currentStep}` : ''}
      </div>

      {iterations.length > 0 ? (
        <ResultViewer iterations={iterations} dataMapping={dataMapping} />
      ) : run.result != null ? (
        <RawJsonCard fieldName={null} value={run.result} />
      ) : null}
    </div>
  );
}
```

### 4.21 — Edit `pages/RunBatchDetail.tsx`

Add export buttons in the header. Replace the full file:

```tsx
import { Link, useParams } from 'react-router-dom';
import { useRunBatch } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunItemDto } from '../api/types';
import { allTerminal, statusLabel } from '../utils/runStatus';
import { batchExportUrl } from '../utils/exportLinks';

function batchBannerClass(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  if (!allTerminal(items)) return 'run-banner run-banner-warning';
  return items.some((r) => r.status === RunItemStatus.Failed)
    ? 'run-banner run-banner-error'
    : 'run-banner run-banner-success';
}

function batchBannerText(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  if (!allTerminal(items)) return 'Batch in progress…';
  const failed = items.filter((r) => r.status === RunItemStatus.Failed).length;
  return failed === 0 ? 'All done.' : `${failed} iteration${failed === 1 ? '' : 's'} failed.`;
}

export default function RunBatchDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isPending } = useRunBatch(id);

  if (isPending) return <div className="loading-state">Loading…</div>;
  if (!batch) return <div className="view"><div className="danger-banner">Batch not found.</div></div>;

  const bannerClass = batchBannerClass(batch.runItems);
  const bannerText = batchBannerText(batch.runItems);
  const isComplete = allTerminal(batch.runItems);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back to tasks">←</Link>
          <h2 className="view-title">{batch.taskName}</h2>
        </div>
        <div className="flex gap-sm items-center">
          <span className="meta-badge">{batch.workerName}</span>
          <a
            className={`btn btn-secondary btn-sm${isComplete ? '' : ' disabled'}`}
            href={isComplete ? batchExportUrl(batch.id, 'json') : undefined}
            target="_blank"
            rel="noreferrer"
            title={isComplete ? '' : 'Batch is still running'}
            style={isComplete ? {} : { pointerEvents: 'none', opacity: 0.5 }}
          >
            Export JSON
          </a>
          <a
            className={`btn btn-secondary btn-sm${isComplete ? '' : ' disabled'}`}
            href={isComplete ? batchExportUrl(batch.id, 'csv') : undefined}
            target="_blank"
            rel="noreferrer"
            title={isComplete ? '' : 'Batch is still running'}
            style={isComplete ? {} : { pointerEvents: 'none', opacity: 0.5 }}
          >
            Export CSV
          </a>
        </div>
      </div>

      {bannerClass && <div className={bannerClass}>{bannerText}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Iteration</th>
            <th>Status</th>
            <th>Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {batch.runItems.map((item, i) => (
            <tr key={item.id}>
              <td>{i + 1}</td>
              <td>{item.iterationLabel ?? item.currentTerm ?? '—'}</td>
              <td>{statusLabel(item.status)}</td>
              <td>{item.progressPercent != null ? `${item.progressPercent}%` : '—'}</td>
              <td>
                <Link to={`/runs/${item.id}`} className="btn btn-secondary btn-sm">View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### 4.22 — Edit `components/Sidebar.tsx`

**BEFORE:**
```tsx
      <NavLink to="/tasks" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Tasks
      </NavLink>
      <NavLink to="/configs" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Configs
      </NavLink>
```

**AFTER:**
```tsx
      <NavLink to="/tasks" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Tasks
      </NavLink>
      <NavLink to="/runs" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Run History
      </NavLink>
      <NavLink to="/configs" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Configs
      </NavLink>
```

### 4.23 — Edit `App.tsx`

Add the import and the route. Two edits:

**BEFORE (imports):**
```tsx
import RunDetail from './pages/RunDetail';
import Configs from './pages/Configs';
```

**AFTER:**
```tsx
import RunDetail from './pages/RunDetail';
import Runs from './pages/Runs';
import Configs from './pages/Configs';
```

**BEFORE (routes):**
```tsx
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/runs/:id" element={<RunDetail />} />
```

**AFTER:**
```tsx
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<RunDetail />} />
```

### 4.24 — Edit `pages/Tasks.tsx`

Embed `<RecentRunsPanel>` per task row.

**BEFORE (imports):**
```tsx
import Modal from '../components/Modal';
import PopulatePreviewModal from '../components/PopulatePreviewModal';
import type { TaskDto } from '../api/types';
import { configNameFor } from '../utils/configLookup';
```

**AFTER:**
```tsx
import Modal from '../components/Modal';
import PopulatePreviewModal from '../components/PopulatePreviewModal';
import RecentRunsPanel from '../components/RecentRunsPanel';
import type { TaskDto } from '../api/types';
import { configNameFor } from '../utils/configLookup';
```

**BEFORE (the card body):**
```tsx
                <div className="config-card-meta">
                  {configName ? (
                    <span className="domain-badge">{configName}</span>
                  ) : (
                    <span className="meta-badge">No config</span>
                  )}
                  <span className="meta-badge">
                    {t.searchTerms.length} value{t.searchTerms.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            );
          })}
```

**AFTER:**
```tsx
                <div className="config-card-meta">
                  {configName ? (
                    <span className="domain-badge">{configName}</span>
                  ) : (
                    <span className="meta-badge">No config</span>
                  )}
                  <span className="meta-badge">
                    {t.searchTerms.length} value{t.searchTerms.length === 1 ? '' : 's'}
                  </span>
                </div>
                <RecentRunsPanel taskId={t.id} />
              </div>
            );
          })}
```

---

## 5. Tests

### 5.1 — Backend: `tests/WebScrape.Tests/Services/RunCsvExporterTests.cs` (new)

```csharp
using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunCsvExporterTests
{
    private static RunItem RunWith(string resultJson, string? iterationLabel = "label-1")
    {
        return new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = Guid.NewGuid(),
            WorkerId = Guid.NewGuid(),
            Status = RunItemStatus.Completed,
            RequestedAt = DateTimeOffset.UtcNow,
            ResultJsonb = JsonDocument.Parse(resultJson),
            IterationLabel = iterationLabel,
        };
    }

    private static ScraperConfigEntity ConfigWith(string mappingJson)
    {
        return new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = Guid.NewGuid(),
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse($"{{\"dataMapping\":{mappingJson}}}"),
        };
    }

    [Fact]
    public void Empty_iterations_writes_header_only()
    {
        var run = RunWith("""{"iterations":[]}""");
        var bytes = new RunCsvExporter().ExportRun(run, null, null);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        Assert.Equal("iteration_label,iteration_status\r\n", text);
    }

    [Fact]
    public void Mapping_drives_columns_and_display_names()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"name":"A","price":1}]}]}""");
        var cfg = ConfigWith("""{"version":1,"columns":[
            {"id":"c1","originalName":"name","displayName":"Product","enabled":true,"position":0,"sourceType":"scrapeElement"},
            {"id":"c2","originalName":"price","displayName":"Price","enabled":true,"position":1,"sourceType":"scrapeElement"}
        ]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, cfg, null));
        Assert.Contains("iteration_label,iteration_status,Product,Price", text);
        Assert.Contains("label-1,success,A,1", text);
    }

    [Fact]
    public void Disabled_columns_excluded_and_position_orders()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"a":1,"b":2,"c":3}]}]}""");
        var cfg = ConfigWith("""{"version":1,"columns":[
            {"id":"c1","originalName":"a","displayName":"A","enabled":true,"position":2},
            {"id":"c2","originalName":"b","displayName":"B","enabled":false,"position":0},
            {"id":"c3","originalName":"c","displayName":"C","enabled":true,"position":1}
        ]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, cfg, null));
        var headerLine = text.Split("\r\n")[0];
        Assert.Equal("iteration_label,iteration_status,C,A", headerLine);
    }

    [Fact]
    public void Falls_back_to_union_of_keys_when_no_mapping()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"name":"A"},{"price":2}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        var headerLine = text.Split("\r\n")[0];
        Assert.Equal("iteration_label,iteration_status,name,price", headerLine);
    }

    [Fact]
    public void Nested_object_value_is_json_stringified()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"meta":{"x":1}}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains("\"{\"\"x\"\":1}\"", text);
    }

    [Theory]
    [InlineData("=cmd|x")]
    [InlineData("+1+1")]
    [InlineData("-1-1")]
    [InlineData("@SUM(A1)")]
    public void Formula_injection_prefixes_with_quote(string danger)
    {
        var json = $$"""{"iterations":[{"status":"success","data":[{"v":"{{danger}}"}]}]}""";
        var run = RunWith(json);
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains($"'{danger}", text);
    }

    [Fact]
    public void Comma_quote_newline_are_rfc4180_quoted()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"v":"a,b\"c\nd"}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains("\"a,b\"\"c\nd\"", text);
    }

    [Fact]
    public void IsTabular_true_for_flat_rows()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"a":1}]}]}""");
        Assert.True(new RunCsvExporter().IsTabular(run));
    }

    [Fact]
    public void IsTabular_false_for_wholepage_iteration()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"blocks":[],"tables":[],"charts":[]}]}]}""");
        Assert.False(new RunCsvExporter().IsTabular(run));
    }

    [Fact]
    public void ExportBatch_concatenates_run_rows_with_run_id_column()
    {
        var batch = new RunBatch { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), UserId = Guid.NewGuid(), WorkerId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow };
        var r1 = RunWith("""{"iterations":[{"status":"success","data":[{"a":1}]}]}""", "alpha");
        var r2 = RunWith("""{"iterations":[{"status":"success","data":[{"a":2}]}]}""", "beta");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportBatch(batch, new[] { r1, r2 }, null));
        var lines = text.Split("\r\n");
        Assert.StartsWith("run_id,iteration_label,iteration_status,a", lines[0]);
        Assert.Contains("alpha", lines[1]);
        Assert.Contains("beta", lines[2]);
    }
}
```

### 5.2 — Backend: `tests/WebScrape.Tests/Services/RunListAndExportTests.cs` (new)

> Sonnet should follow the [RunServiceTests.cs:18-48](c:\Users\und3r\blueberry-v3\backend\tests\WebScrape.Tests\Services\RunServiceTests.cs) `Build()` pattern. Required test cases (one `[Fact]` each):

1. `ListAsync_filters_by_user` — user A creates two runs; user B sees zero.
2. `ListAsync_filters_by_taskId` — narrow result set.
3. `ListAsync_filters_by_status` — narrow to `Completed`.
4. `ListAsync_filters_by_date_range` — `From` and `To` shrink the window.
5. `ListAsync_paginates_and_clamps_pageSize` — `pageSize=10000` returns at most 100; `page=2,pageSize=10` returns rows 11–20.
6. `ListAsync_orders_by_requestedAt_desc` — most-recent first.
7. `ExportAsync_returns_BadFormat_for_xml` — `format=xml` → `RunExportOutcome.BadFormat`.
8. `ExportAsync_returns_NotFound_for_missing_id`.
9. `ExportAsync_returns_Forbidden_for_other_users_run`.
10. `ExportAsync_returns_NotReady_when_result_jsonb_null`.
11. `ExportAsync_json_returns_raw_jsonb_bytes`.
12. `ExportAsync_csv_returns_NotTabular_for_wholepage_iteration`.
13. `ExportAsync_csv_uses_populate_snapshot_data_mapping_when_present` — verify column header is `displayName` from snapshot, not the live config (set them differently).

Construct a `RunService` with a mocked `IWorkerNotifier` and a real `RunCsvExporter`. Use `TestDb.CreateInMemory()` and `TestDb.CreateMapper()`.

### 5.3 — Backend: `tests/WebScrape.Tests/Services/RunBatchListAndExportTests.cs` (new)

Required `[Fact]`s:

1. `ListAsync_aggregates_total_completed_failed_pending`.
2. `ListAsync_filters_by_user`.
3. `ListAsync_filters_by_taskId`.
4. `ListAsync_clamps_pageSize`.
5. `ExportAsync_csv_concatenates_runs_with_run_id`.
6. `ExportAsync_json_returns_envelope_with_items`.
7. `ExportAsync_returns_Forbidden_for_other_users_batch`.
8. `ExportAsync_returns_BadFormat_for_xml`.

### 5.4 — Backend: `tests/WebScrape.Tests/Services/PopulateSnapshotReaderTests.cs` (new)

Required `[Fact]`s:

1. `Returns_null_when_batch_is_null`.
2. `Returns_null_when_snapshot_has_no_configSnapshots`.
3. `Returns_dataMapping_from_top_level`.
4. `Returns_dataMapping_from_nested_configJson`.
5. `Returns_null_when_mapping_missing`.

### 5.5 — Frontend: see §4.5 (`safeHref.test.ts`) and §4.7 (`cardDiscrimination.test.ts`)

Both files have full bodies inline above.

---

## 6. Pre-merge gate

Before declaring M3 done, run **one** real wholepage scrape end-to-end to confirm the discriminator's `isPageContent` branch matches what the extension produces:

1. Configure a scraper config with a `wholePage` scrape element against `https://example.com`.
2. Queue a one-iteration batch and let it complete.
3. Inspect `iter.data[0]` in the response of `GET /api/runs/{id}`. Confirm whether it's:
   - **Top-level**: row IS the `PageContent` (matches the second branch in `discriminateRow`).
   - **Wrapped**: row has a single key (e.g. `wholePage`) whose value is the `PageContent` (matches the first branch).
4. Save the literal payload to `WebScrape.Client/src/utils/__fixtures__/wholepage-iteration.json`.
5. Add a regression test in `cardDiscrimination.test.ts` that imports the fixture and asserts the resulting `kind`.
6. If the actual shape differs from both branches, update the discriminator before locking M3.

---

## 7. File checksum (post-merge tree)

Backend (under `backend/src/`):

```
WebScrape.Server/
  Controllers/
    RunsController.cs              [edited]
    RunBatchesController.cs        [edited]
  Program.cs                       [edited: AddSingleton<IRunCsvExporter>]
WebScrape.Services/
  Interfaces/
    IRunService.cs                 [edited: ListAsync, ExportAsync, RunExportOutcome]
    IRunBatchService.cs            [edited: ListAsync, ExportAsync, RunBatchExportOutcome]
    IRunCsvExporter.cs             [new]
  Implementations/
    RunService.cs                  [edited: ctor, ListAsync, ExportAsync]
    RunBatchService.cs             [edited: ctor, ListAsync, ExportAsync]
    RunCsvExporter.cs              [new]
    PopulateSnapshotReader.cs      [new]
WebScrape.Data/
  Dto/
    RunItemDto.cs                  [edited: BatchId field]
    PagedResultDto.cs              [new]
    RunListItemDto.cs              [new]
    RunListQueryDto.cs             [new]
    RunBatchListItemDto.cs         [new]
    RunBatchListQueryDto.cs        [new]
  Mapping/
    AutoMapperProfile.cs           [edited: RunItem → RunListItemDto]
```

Frontend (under `backend/src/WebScrape.Client/src/`):

```
api/
  types.ts                         [edited]
  queries.ts                       [edited]
components/
  Sidebar.tsx                      [edited]
  RecentRunsPanel.tsx              [new]
  result/
    ResultViewer.tsx               [new]
    IterationCards.tsx             [new]
    TableCard.tsx                  [new]
    ChartCard.tsx                  [new]
    PageBlocksCard.tsx             [new]
    TextCard.tsx                   [new]
    RawJsonCard.tsx                [new]
pages/
  App.tsx                          [edited]
  Tasks.tsx                        [edited]
  Runs.tsx                         [new]
  RunDetail.tsx                    [edited]
  RunBatchDetail.tsx               [edited]
types/
  extraction.ts                    [new]
utils/
  cardDiscrimination.ts            [new]
  cardDiscrimination.test.ts       [new]
  chartPalette.ts                  [new]
  exportLinks.ts                   [new]
  safeHref.ts                      [new]
  safeHref.test.ts                 [new]
  __fixtures__/
    wholepage-iteration.json       [new — added during pre-merge gate]
```

Tests (under `backend/tests/WebScrape.Tests/`):

```
Services/
  RunCsvExporterTests.cs           [new]
  RunListAndExportTests.cs         [new]
  RunBatchListAndExportTests.cs    [new]
  PopulateSnapshotReaderTests.cs   [new]
```

---

## 8. Verification commands

```bash
# Backend
cd c:\Users\und3r\blueberry-v3\backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests

# Frontend
cd c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client
npm install              # picks up recharts
npm run typecheck
npm run test:run
npm run build
```

All previously-passing tests must remain green. New tests in §5 must pass.

## 9. Manual end-to-end (gate before declaring done)

Per Stage E.3 of the plan ([ok-so-next-robust-pascal.md](C:\Users\und3r\.claude\plans\ok-so-next-robust-pascal.md)) — 23 numbered steps covering: navigate to Run History, apply/clear filters, refresh-restores-state, pagination, click-into-detail, structured cards visible, View raw toggles, Export JSON downloads, Export CSV downloads (tabular only), CSV-on-wholepage disabled tooltip, direct-API CSV-on-wholepage 422, RunBatchDetail header export buttons, Recent Runs panel on Tasks page, "See all" link, cross-user 403, pageSize clamp, format=xml 400, Recharts renders for canExtract:true chart, fallback message for canExtract:false chart.

## 10. Out of scope (do not implement)

- Streaming JSON/CSV export (M5 hardening).
- Chart axis/legend customisation beyond defaults.
- Server-side full-text search across `result_jsonb`.
- Run-vs-run diff/compare.
- WebSocket push of run-list updates.
- Lint rule for `dangerouslySetInnerHTML` (review-only enforcement for M3).
