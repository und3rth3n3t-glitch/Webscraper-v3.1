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
