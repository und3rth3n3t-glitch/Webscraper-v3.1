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

public class RunListAndExportTests
{
    private static async Task<(RunService svc, WebScrapeDbContext db, Guid userId, TaskEntity task, WorkerConnection worker)> Build()
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);
        var svc = new RunService(db, TestDb.CreateMapper(), notifier.Object, new RunCsvExporter(), NullLogger<RunService>.Instance);

        var user = new User { Id = Guid.NewGuid(), UserName = "u@x", Email = "u@x" };
        db.Users.Add(user);

        var task = new TaskEntity { Id = Guid.NewGuid(), UserId = user.Id, Name = "t", CreatedAt = DateTimeOffset.UtcNow };
        db.Tasks.Add(task);

        var worker = new WorkerConnection { Id = Guid.NewGuid(), UserId = user.Id, Name = "w", ApiKeyId = Guid.NewGuid(), CurrentConnection = "conn-1" };
        db.WorkerConnections.Add(worker);

        await db.SaveChangesAsync();
        return (svc, db, user.Id, task, worker);
    }

    private static async Task<RunItem> SeedRun(WebScrapeDbContext db, Guid taskId, Guid workerId,
        RunItemStatus status = RunItemStatus.Completed,
        DateTimeOffset? requestedAt = null,
        string? resultJson = null,
        Guid? scraperConfigId = null)
    {
        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            WorkerId = workerId,
            Status = status,
            RequestedAt = requestedAt ?? DateTimeOffset.UtcNow,
            CompletedAt = status == RunItemStatus.Completed ? DateTimeOffset.UtcNow : null,
            ResultJsonb = resultJson != null ? JsonDocument.Parse(resultJson) : null,
            ScraperConfigId = scraperConfigId,
        };
        db.RunItems.Add(run);
        await db.SaveChangesAsync();
        return run;
    }

    [Fact]
    public async Task ListAsync_filters_by_user()
    {
        var (svc, db, userId, task, worker) = await Build();
        await SeedRun(db, task.Id, worker.Id);

        // user A sees their run
        var result = await svc.ListAsync(userId, new RunListQueryDto());
        Assert.Equal(1, result.Total);

        // user B sees nothing
        var other = await svc.ListAsync(Guid.NewGuid(), new RunListQueryDto());
        Assert.Equal(0, other.Total);
    }

    [Fact]
    public async Task ListAsync_filters_by_taskId()
    {
        var (svc, db, userId, task, worker) = await Build();

        var otherTask = new TaskEntity { Id = Guid.NewGuid(), UserId = userId, Name = "other", CreatedAt = DateTimeOffset.UtcNow };
        db.Tasks.Add(otherTask);
        await db.SaveChangesAsync();

        await SeedRun(db, task.Id, worker.Id);
        await SeedRun(db, otherTask.Id, worker.Id);

        var result = await svc.ListAsync(userId, new RunListQueryDto { TaskId = task.Id });
        Assert.Equal(1, result.Total);
        Assert.All(result.Items, r => Assert.Equal(task.Id, r.TaskId));
    }

    [Fact]
    public async Task ListAsync_filters_by_status()
    {
        var (svc, db, userId, task, worker) = await Build();
        await SeedRun(db, task.Id, worker.Id, RunItemStatus.Completed);
        await SeedRun(db, task.Id, worker.Id, RunItemStatus.Failed);

        var result = await svc.ListAsync(userId, new RunListQueryDto { Status = RunItemStatus.Completed });
        Assert.Equal(1, result.Total);
        Assert.All(result.Items, r => Assert.Equal(RunItemStatus.Completed, r.Status));
    }

    [Fact]
    public async Task ListAsync_filters_by_date_range()
    {
        var (svc, db, userId, task, worker) = await Build();
        var t0 = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await SeedRun(db, task.Id, worker.Id, requestedAt: t0);
        await SeedRun(db, task.Id, worker.Id, requestedAt: t0.AddDays(5));
        await SeedRun(db, task.Id, worker.Id, requestedAt: t0.AddDays(10));

        var result = await svc.ListAsync(userId, new RunListQueryDto
        {
            From = t0.AddDays(2),
            To = t0.AddDays(7),
        });
        Assert.Equal(1, result.Total);
    }

    [Fact]
    public async Task ListAsync_paginates_and_clamps_pageSize()
    {
        var (svc, db, userId, task, worker) = await Build();
        for (var i = 0; i < 15; i++)
            await SeedRun(db, task.Id, worker.Id, requestedAt: DateTimeOffset.UtcNow.AddSeconds(i));

        // pageSize=10000 should be clamped to 100; we only have 15
        var all = await svc.ListAsync(userId, new RunListQueryDto { Page = 1, PageSize = 10000 });
        Assert.Equal(15, all.Total);
        Assert.Equal(15, all.Items.Count);

        // page 2, pageSize 10 → rows 11-15
        var page2 = await svc.ListAsync(userId, new RunListQueryDto { Page = 2, PageSize = 10 });
        Assert.Equal(5, page2.Items.Count);
    }

    [Fact]
    public async Task ListAsync_orders_by_requestedAt_desc()
    {
        var (svc, db, userId, task, worker) = await Build();
        var t0 = DateTimeOffset.UtcNow;
        await SeedRun(db, task.Id, worker.Id, requestedAt: t0);
        await SeedRun(db, task.Id, worker.Id, requestedAt: t0.AddSeconds(10));

        var result = await svc.ListAsync(userId, new RunListQueryDto());
        Assert.True(result.Items[0].RequestedAt > result.Items[1].RequestedAt);
    }

    [Fact]
    public async Task ExportAsync_returns_BadFormat_for_xml()
    {
        var (svc, _, userId, _, _) = await Build();
        var result = await svc.ExportAsync(userId, Guid.NewGuid(), "xml");
        Assert.Equal(RunExportOutcome.BadFormat, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_returns_NotFound_for_missing_id()
    {
        var (svc, _, userId, _, _) = await Build();
        var result = await svc.ExportAsync(userId, Guid.NewGuid(), "json");
        Assert.Equal(RunExportOutcome.NotFound, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_returns_Forbidden_for_other_users_run()
    {
        var (svc, db, _, task, worker) = await Build();
        var run = await SeedRun(db, task.Id, worker.Id);

        var result = await svc.ExportAsync(Guid.NewGuid(), run.Id, "json");
        Assert.Equal(RunExportOutcome.Forbidden, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_returns_NotReady_when_result_jsonb_null()
    {
        var (svc, db, userId, task, worker) = await Build();
        var run = await SeedRun(db, task.Id, worker.Id, RunItemStatus.Running);

        var result = await svc.ExportAsync(userId, run.Id, "json");
        Assert.Equal(RunExportOutcome.NotReady, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_json_returns_raw_jsonb_bytes()
    {
        var (svc, db, userId, task, worker) = await Build();
        var run = await SeedRun(db, task.Id, worker.Id, resultJson: """{"iterations":[]}""");

        var result = await svc.ExportAsync(userId, run.Id, "json");

        Assert.Equal(RunExportOutcome.Ok, result.Outcome);
        Assert.Equal("application/json", result.ContentType);
        Assert.NotNull(result.Bytes);
        var json = System.Text.Encoding.UTF8.GetString(result.Bytes!);
        Assert.Contains("iterations", json);
    }

    [Fact]
    public async Task ExportAsync_csv_returns_NotTabular_for_wholepage_iteration()
    {
        var (svc, db, userId, task, worker) = await Build();
        var run = await SeedRun(db, task.Id, worker.Id,
            resultJson: """{"iterations":[{"status":"success","data":[{"blocks":[],"tables":[],"charts":[]}]}]}""");

        var result = await svc.ExportAsync(userId, run.Id, "csv");
        Assert.Equal(RunExportOutcome.NotTabular, result.Outcome);
    }

    [Fact]
    public async Task ExportAsync_csv_uses_populate_snapshot_data_mapping_when_present()
    {
        var (svc, db, userId, task, worker) = await Build();
        var configId = Guid.NewGuid();

        // Snapshot has displayName "Snapshot Name"; live config has displayName "Live Name" — they differ
        var snapshotMapping = """{"columns":[{"id":"c1","originalName":"v","displayName":"Snapshot Name","enabled":true,"position":0}]}""";
        var liveMapping = """{"columns":[{"id":"c1","originalName":"v","displayName":"Live Name","enabled":true,"position":0}]}""";

        var batch = new RunBatch
        {
            Id = Guid.NewGuid(), TaskId = task.Id, UserId = userId, WorkerId = worker.Id,
            CreatedAt = DateTimeOffset.UtcNow,
            PopulateSnapshot = JsonDocument.Parse("{\"configSnapshots\":{\"" + configId + "\":{\"dataMapping\":" + snapshotMapping + "}}}"),
        };
        db.RunBatches.Add(batch);

        var liveConfig = new ScraperConfigEntity
        {
            Id = configId, UserId = userId, Name = "demo", Domain = "x.com",
            ConfigJson = JsonDocument.Parse($"{{\"dataMapping\":{liveMapping}}}"),
            SchemaVersion = 3, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ScraperConfigs.Add(liveConfig);

        var run = new RunItem
        {
            Id = Guid.NewGuid(), TaskId = task.Id, WorkerId = worker.Id,
            BatchId = batch.Id, ScraperConfigId = configId,
            Status = RunItemStatus.Completed, RequestedAt = DateTimeOffset.UtcNow,
            ResultJsonb = JsonDocument.Parse("""{"iterations":[{"status":"success","data":[{"v":"hello"}]}]}"""),
        };
        db.RunItems.Add(run);
        await db.SaveChangesAsync();

        var result = await svc.ExportAsync(userId, run.Id, "csv");

        Assert.Equal(RunExportOutcome.Ok, result.Outcome);
        var csv = System.Text.Encoding.UTF8.GetString(result.Bytes!);
        Assert.Contains("Snapshot Name", csv);
        Assert.DoesNotContain("Live Name", csv);
    }
}
