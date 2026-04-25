using System.Text.Json;
using System.Text.Json.Nodes;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Hubs;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class RunService : IRunService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IWorkerNotifier _notifier;

    public RunService(WebScrapeDbContext db, IMapper mapper, IWorkerNotifier notifier)
    {
        _db = db;
        _mapper = mapper;
        _notifier = notifier;
    }

    public async Task<RunDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.Id == workerId, ct);
        if (worker is null) return new(RunDispatchOutcome.NotFound, null, "Worker not found");
        if (worker.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, "Worker does not belong to user");

        var task = await _db.Tasks
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null) return new(RunDispatchOutcome.NotFound, null, "Task not found");
        if (task.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, "Task does not belong to user");

        if (string.IsNullOrEmpty(worker.CurrentConnection))
            return new(RunDispatchOutcome.WorkerOffline, null, "Worker is offline");

        var connectionId = worker.CurrentConnection;
        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = task.Id,
            WorkerId = worker.Id,
            Status = RunItemStatus.Pending,
            RequestedAt = DateTimeOffset.UtcNow,
        };
        _db.RunItems.Add(run);
        await _db.SaveChangesAsync(ct);

        var config = task.ScraperConfig!;
        var queueDto = new QueueTaskDto
        {
            Id = run.Id.ToString(),
            ConfigId = config.Id.ToString(),
            ConfigName = config.Name,
            SearchTerms = task.SearchTerms.ToList(),
            Priority = 0,
            CreatedAt = run.RequestedAt,
            Status = "pending",
            InlineConfig = BuildInlineConfig(config),
        };

        try
        {
            await _notifier.SendReceiveTaskAsync(connectionId, queueDto, ct);
        }
        catch (Exception ex)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = $"Worker disconnected before task could be sent: {ex.Message}";
            run.CompletedAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(CancellationToken.None);
            return new(RunDispatchOutcome.SendFailed, run.Id, run.ErrorMessage);
        }

        run.Status = RunItemStatus.Sent;
        run.SentAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        return new(RunDispatchOutcome.Created, run.Id, null);
    }

    // Builds the flat ScraperConfig JSON the extension expects as inlineConfig.
    // Takes the stored configJson blob and injects "id" at the top level.
    private static JsonElement BuildInlineConfig(ScraperConfigEntity config)
    {
        var node = JsonNode.Parse(config.ConfigJson.RootElement.GetRawText())!.AsObject();
        node["id"] = config.Id.ToString();
        return JsonSerializer.SerializeToElement(node);
    }

    public async Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;

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
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;

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
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;

        var run = await _db.RunItems.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return;

        run.Status = RunItemStatus.Failed;
        run.ErrorMessage = string.IsNullOrEmpty(payload.StepLabel) ? payload.Error : $"[{payload.StepLabel}] {payload.Error}";
        run.CompletedAt = payload.FailedAt == default ? DateTimeOffset.UtcNow : payload.FailedAt;

        await _db.SaveChangesAsync(ct);
    }

    public async Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;

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
}
