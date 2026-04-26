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

    public async Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId))
        {
            _log.LogWarning("RecordProgress: malformed TaskId {TaskIdPrefix}", Truncate(payload.TaskId));
            return;
        }

        var run = await _db.RunItems.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return;

        if (run.Status == RunItemStatus.Sent || run.Status == RunItemStatus.Paused)
        {
            run.Status = RunItemStatus.Running;
            run.StartedAt ??= DateTimeOffset.UtcNow;
        }

        run.ProgressPercent = payload.Progress;
        run.CurrentTerm = payload.CurrentTerm;
        run.CurrentStep = payload.CurrentStep;
        run.Phase = payload.Phase;

        await _db.SaveChangesAsync(ct);
    }

    public async Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId))
        {
            _log.LogWarning("Complete: malformed TaskId {TaskIdPrefix}", Truncate(payload.TaskId));
            return;
        }

        var run = await _db.RunItems.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return;

        var resultJson = JsonSerializer.Serialize(payload.Result);
        run.ResultJsonb = JsonDocument.Parse(resultJson);
        run.Status = RunItemStatus.Completed;
        run.CompletedAt = payload.CompletedAt == default ? DateTimeOffset.UtcNow : payload.CompletedAt;
        run.ProgressPercent = 100;

        await _db.SaveChangesAsync(ct);
    }

    public async Task FailAsync(TaskErrorDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId))
        {
            _log.LogWarning("Fail: malformed TaskId {TaskIdPrefix}", Truncate(payload.TaskId));
            return;
        }

        var run = await _db.RunItems.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return;

        run.Status = RunItemStatus.Failed;
        run.ErrorMessage = string.IsNullOrEmpty(payload.StepLabel) ? payload.Error : $"[{payload.StepLabel}] {payload.Error}";
        run.CompletedAt = payload.FailedAt == default ? DateTimeOffset.UtcNow : payload.FailedAt;

        await _db.SaveChangesAsync(ct);
    }

    public async Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId))
        {
            _log.LogWarning("MarkPaused: malformed TaskId {TaskIdPrefix}", Truncate(payload.TaskId));
            return;
        }

        var run = await _db.RunItems.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return;

        run.Status = RunItemStatus.Paused;
        run.PauseReason = payload.Reason;

        await _db.SaveChangesAsync(ct);
    }

    public async Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.RunItems
            .AsNoTracking()
            .Include(r => r.Task)
            .FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return null;
        if (row.Task is null || row.Task.UserId != userId) return null;
        return _mapper.Map<RunItemDto>(row);
    }

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
        if (run.ScraperConfigId.HasValue)
        {
            liveConfig = await _db.ScraperConfigs
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == run.ScraperConfigId.Value, ct);
        }

        var csvBytes = _csv.ExportRun(run, liveConfig, run.Batch);
        return new RunExportResult(RunExportOutcome.Ok, csvBytes, $"run-{run.Id}.csv", "text/csv");
    }

    private static string Truncate(string? s) =>
        string.IsNullOrEmpty(s) ? "(empty)" : (s.Length <= 8 ? s : s[..8] + "…");
}
