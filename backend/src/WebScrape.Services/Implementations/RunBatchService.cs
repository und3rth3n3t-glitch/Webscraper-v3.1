using System.Text;
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
            case ExpansionOutcome.NestedLoopUnsupported: return new(RunBatchOutcome.NestedLoopUnsupported, null, 0, 0, preview.Error);
        }

        var task = await _db.Tasks.Include(t => t.Blocks).FirstAsync(t => t.Id == taskId, ct);
        var configIds = preview.Results.Select(r => r.ScraperConfigId).Distinct().ToList();
        var configs = await _db.ScraperConfigs.Where(c => configIds.Contains(c.Id)).ToListAsync(ct);
        var sharedIds = configs.Where(c => c.Shared).Select(c => c.Id).ToHashSet();

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
                ScraperConfigId = r.ScraperConfigId,
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
                SearchTerms = r.SearchTerms,
                Priority = 0,
                CreatedAt = run.RequestedAt,
                InlineConfig = sharedIds.Contains(r.ScraperConfigId) ? null : r.PatchedConfigJson,
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

        var csvBytes = _csv.ExportBatch(batch, items, null);
        return new RunBatchExportResult(RunBatchExportOutcome.Ok, csvBytes, $"batch-{batch.Id}.csv", "text/csv");
    }
}
