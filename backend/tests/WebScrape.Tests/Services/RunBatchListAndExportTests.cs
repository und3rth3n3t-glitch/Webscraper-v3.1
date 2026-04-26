using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Hubs;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunBatchListAndExportTests
{
    private record Setup(
        RunBatchService Svc,
        WebScrapeDbContext Db,
        Guid UserId,
        Guid TaskId,
        Guid WorkerId);

    private static async Task<Setup> Build()
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);
        var expander = new Mock<IQueueExpansionService>(MockBehavior.Strict);
        var svc = new RunBatchService(db, TestDb.CreateMapper(), expander.Object, notifier.Object, new RunCsvExporter(), NullLogger<RunBatchService>.Instance);

        var userId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });

        var taskId = Guid.NewGuid();
        db.Tasks.Add(new TaskEntity { Id = taskId, UserId = userId, Name = "my-task", CreatedAt = DateTimeOffset.UtcNow });

        var workerId = Guid.NewGuid();
        db.WorkerConnections.Add(new WorkerConnection { Id = workerId, UserId = userId, Name = "w", ApiKeyId = Guid.NewGuid(), CurrentConnection = "conn-1" });

        await db.SaveChangesAsync();
        return new Setup(svc, db, userId, taskId, workerId);
    }

    private static async Task<RunBatch> SeedBatch(WebScrapeDbContext db, Guid userId, Guid taskId, Guid workerId, DateTimeOffset? createdAt = null)
    {
        var batch = new RunBatch
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            UserId = userId,
            WorkerId = workerId,
            PopulateSnapshot = JsonDocument.Parse("{}"),
            CreatedAt = createdAt ?? DateTimeOffset.UtcNow,
        };
        db.RunBatches.Add(batch);
        await db.SaveChangesAsync();
        return batch;
    }

    private static async Task<RunItem> SeedRun(WebScrapeDbContext db, Guid taskId, Guid workerId, Guid batchId, RunItemStatus status)
    {
        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            WorkerId = workerId,
            BatchId = batchId,
            Status = status,
            RequestedAt = DateTimeOffset.UtcNow,
            CompletedAt = status == RunItemStatus.Completed ? DateTimeOffset.UtcNow : null,
            ResultJsonb = status == RunItemStatus.Completed
                ? JsonDocument.Parse("""{"iterations":[{"status":"success","data":[{"v":"hello"}]}]}""")
                : null,
        };
        db.RunItems.Add(run);
        await db.SaveChangesAsync();
        return run;
    }

    [Fact]
    public async Task ListAsync_aggregates_total_completed_failed_pending()
    {
        var s = await Build();
        var batch = await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Completed);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Completed);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Failed);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Running);

        var result = await s.Svc.ListAsync(s.UserId, new RunBatchListQueryDto());

        Assert.Equal(1, result.Total);
        var item = result.Items[0];
        Assert.Equal(4, item.TotalItems);
        Assert.Equal(2, item.CompletedCount);
        Assert.Equal(1, item.FailedCount);
        Assert.Equal(1, item.PendingCount);
    }

    [Fact]
    public async Task ListAsync_filters_by_user()
    {
        var s = await Build();
        await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);

        var mine = await s.Svc.ListAsync(s.UserId, new RunBatchListQueryDto());
        Assert.Equal(1, mine.Total);

        var other = await s.Svc.ListAsync(Guid.NewGuid(), new RunBatchListQueryDto());
        Assert.Equal(0, other.Total);
    }

    [Fact]
    public async Task ListAsync_filters_by_taskId()
    {
        var s = await Build();

        var otherTask = new TaskEntity { Id = Guid.NewGuid(), UserId = s.UserId, Name = "other", CreatedAt = DateTimeOffset.UtcNow };
        s.Db.Tasks.Add(otherTask);
        await s.Db.SaveChangesAsync();

        await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);
        await SeedBatch(s.Db, s.UserId, otherTask.Id, s.WorkerId);

        var result = await s.Svc.ListAsync(s.UserId, new RunBatchListQueryDto { TaskId = s.TaskId });
        Assert.Equal(1, result.Total);
        Assert.All(result.Items, b => Assert.Equal(s.TaskId, b.TaskId));
    }

    [Fact]
    public async Task ListAsync_clamps_pageSize()
    {
        var s = await Build();
        for (var i = 0; i < 5; i++)
            await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId, DateTimeOffset.UtcNow.AddSeconds(i));

        var all = await s.Svc.ListAsync(s.UserId, new RunBatchListQueryDto { PageSize = 10000 });
        Assert.Equal(5, all.Total);
        Assert.Equal(5, all.Items.Count);

        var page2 = await s.Svc.ListAsync(s.UserId, new RunBatchListQueryDto { Page = 2, PageSize = 3 });
        Assert.Equal(2, page2.Items.Count);
    }

    [Fact]
    public async Task ExportAsync_returns_BadFormat_for_xml()
    {
        var s = await Build();
        var result = await s.Svc.ExportAsync(s.UserId, Guid.NewGuid(), "xml");
        Assert.Equal(RunBatchExportOutcome.BadFormat, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_returns_Forbidden_for_other_users_batch()
    {
        var s = await Build();
        var batch = await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);

        var result = await s.Svc.ExportAsync(Guid.NewGuid(), batch.Id, "json");
        Assert.Equal(RunBatchExportOutcome.Forbidden, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_json_returns_envelope_with_items()
    {
        var s = await Build();
        var batch = await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Completed);
        await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Failed);

        var result = await s.Svc.ExportAsync(s.UserId, batch.Id, "json");

        Assert.Equal(RunBatchExportOutcome.Ok, result.Outcome);
        Assert.Equal("application/json", result.ContentType);
        Assert.NotNull(result.Bytes);
        var json = System.Text.Encoding.UTF8.GetString(result.Bytes!);
        Assert.Contains("batchId", json);
        Assert.Contains("items", json);
        Assert.Contains(batch.Id.ToString(), json);
    }

    [Fact]
    public async Task ExportAsync_csv_concatenates_runs_with_run_id_column()
    {
        var s = await Build();
        var batch = await SeedBatch(s.Db, s.UserId, s.TaskId, s.WorkerId);
        var r1 = await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Completed);
        var r2 = await SeedRun(s.Db, s.TaskId, s.WorkerId, batch.Id, RunItemStatus.Completed);

        var result = await s.Svc.ExportAsync(s.UserId, batch.Id, "csv");

        Assert.Equal(RunBatchExportOutcome.Ok, result.Outcome);
        Assert.Equal("text/csv", result.ContentType);
        Assert.NotNull(result.Bytes);
        var csv = System.Text.Encoding.UTF8.GetString(result.Bytes!);
        var lines = csv.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.StartsWith("run_id,", lines[0]);
        Assert.Contains(r1.Id.ToString(), csv);
        Assert.Contains(r2.Id.ToString(), csv);
    }
}
