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
            Id = taskId, UserId = userId, Name = "T",
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
        var all = new List<IBlockExpander>();
        var loop = new LoopBlockExpander(all);
        all.Add(loop);
        all.Add(scrape);
        var expander = new QueueExpansionService(db, all);
        var svc = new RunBatchService(db, TestDb.CreateMapper(), expander, notifier.Object, new RunCsvExporter(), NullLogger<RunBatchService>.Instance);

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

    [Fact]
    public async Task CreateBatch_persists_scraperConfigId_per_run_item()
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);

        var userId = Guid.NewGuid();
        var configAId = Guid.NewGuid();
        var configBId = Guid.NewGuid();
        var taskId = Guid.NewGuid();
        var loopId = Guid.NewGuid();

        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configAId, UserId = userId, Name = "cfgA", Domain = "a.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[{"id":"sA","type":"setInput","options":{}}]}"""),
            SchemaVersion = 3, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configBId, UserId = userId, Name = "cfgB", Domain = "b.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[{"id":"sB","type":"setInput","options":{}}]}"""),
            SchemaVersion = 3, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.Tasks.Add(new TaskEntity { Id = taskId, UserId = userId, Name = "T", CreatedAt = DateTimeOffset.UtcNow });

        // Loop(1 value) → Scrape-A + Scrape-B → 2 RunItems with distinct ScraperConfigIds
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = loopId, TaskId = taskId, ParentBlockId = null, BlockType = BlockType.Loop, OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new { name = "loop1", values = new[] { "v0" } })),
        });
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = Guid.NewGuid(), TaskId = taskId, ParentBlockId = loopId, BlockType = BlockType.Scrape, OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                scraperConfigId = configAId.ToString(),
                stepBindings = new Dictionary<string, object> { ["sA"] = new { kind = "loopRef", loopBlockId = loopId.ToString() } },
            })),
        });
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = Guid.NewGuid(), TaskId = taskId, ParentBlockId = loopId, BlockType = BlockType.Scrape, OrderIndex = 1,
            ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                scraperConfigId = configBId.ToString(),
                stepBindings = new Dictionary<string, object> { ["sB"] = new { kind = "loopRef", loopBlockId = loopId.ToString() } },
            })),
        });

        var workerId = Guid.NewGuid();
        db.WorkerConnections.Add(new WorkerConnection
        {
            Id = workerId, UserId = userId, Name = "w", ApiKeyId = Guid.NewGuid(), CurrentConnection = "conn-1",
        });
        await db.SaveChangesAsync();

        var scrape = new ScrapeBlockExpander();
        var all = new List<IBlockExpander>();
        var loop = new LoopBlockExpander(all);
        all.Add(loop);
        all.Add(scrape);
        var expander = new QueueExpansionService(db, all);
        var svc = new RunBatchService(db, TestDb.CreateMapper(), expander, notifier.Object, new RunCsvExporter(), NullLogger<RunBatchService>.Instance);

        notifier.Setup(n => n.SendReceiveTaskAsync("conn-1", It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);

        var result = await svc.CreateAndDispatchAsync(userId, taskId, workerId);

        Assert.Equal(RunBatchOutcome.Created, result.Outcome);
        Assert.Equal(2, result.DispatchedCount);

        var runs = await db.RunItems.ToListAsync();
        Assert.Equal(2, runs.Count);
        Assert.Contains(runs, r => r.ScraperConfigId == configAId);
        Assert.Contains(runs, r => r.ScraperConfigId == configBId);
    }
}
