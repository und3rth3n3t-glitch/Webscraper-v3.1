using System.Text.Json;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Enums;
using WebScrape.Services.Hubs;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

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

    private static string Truncate(string? s) =>
        string.IsNullOrEmpty(s) ? "(empty)" : (s.Length <= 8 ? s : s[..8] + "…");
}
