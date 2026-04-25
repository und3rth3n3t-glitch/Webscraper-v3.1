using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Moq;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Hubs;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunServiceTests
{
    private static async Task<(RunService svc, WebScrape.Data.WebScrapeDbContext db, Mock<IWorkerNotifier> notifier, Guid userId, TaskEntity task, WorkerConnection worker)> Build(bool workerOnline = true)
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);
        var svc = new RunService(db, TestDb.CreateMapper(), notifier.Object);

        var user = new User { Id = Guid.NewGuid(), UserName = "u@x", Email = "u@x" };
        db.Users.Add(user);

        var config = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ScraperConfigs.Add(config);

        var task = new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "t",
            ScraperConfigId = config.Id,
            ScraperConfig = config,
            SearchTerms = new[] { "alpha", "beta" },
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Tasks.Add(task);

        var worker = new WorkerConnection
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "w",
            ApiKeyId = Guid.NewGuid(),
            CurrentConnection = workerOnline ? "conn-1" : null,
        };
        db.WorkerConnections.Add(worker);

        await db.SaveChangesAsync();
        return (svc, db, notifier, user.Id, task, worker);
    }

    [Fact]
    public async Task CreateAndDispatch_sends_to_hub_and_marks_run_sent()
    {
        var (svc, db, notifier, userId, task, worker) = await Build(workerOnline: true);
        notifier.Setup(n => n.SendReceiveTaskAsync(worker.CurrentConnection!, It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);

        var result = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);

        Assert.Equal(RunDispatchOutcome.Created, result.Outcome);
        Assert.NotNull(result.RunItemId);
        notifier.Verify(n => n.SendReceiveTaskAsync(
            worker.CurrentConnection!,
            It.Is<QueueTaskDto>(q => q.SearchTerms.Count == 2 && q.InlineConfig != null),
            It.IsAny<CancellationToken>()), Times.Once);

        var stored = await db.RunItems.SingleAsync(r => r.Id == result.RunItemId);
        Assert.Equal(RunItemStatus.Sent, stored.Status);
        Assert.NotNull(stored.SentAt);
    }

    [Fact]
    public async Task CreateAndDispatch_returns_offline_when_worker_has_no_connection()
    {
        var (svc, db, notifier, userId, task, worker) = await Build(workerOnline: false);

        var result = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);

        Assert.Equal(RunDispatchOutcome.WorkerOffline, result.Outcome);
        Assert.Null(result.RunItemId);
        Assert.Equal(0, await db.RunItems.CountAsync());
        notifier.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CreateAndDispatch_returns_forbidden_for_other_users_worker()
    {
        var (svc, db, notifier, _, task, worker) = await Build(workerOnline: true);
        var otherUser = Guid.NewGuid();

        var result = await svc.CreateAndDispatchAsync(otherUser, task.Id, worker.Id);

        Assert.Equal(RunDispatchOutcome.Forbidden, result.Outcome);
        Assert.Equal(0, await db.RunItems.CountAsync());
        notifier.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CreateAndDispatch_marks_failed_when_hub_send_throws()
    {
        var (svc, db, notifier, userId, task, worker) = await Build(workerOnline: true);
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("connection gone"));

        var result = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);

        Assert.Equal(RunDispatchOutcome.SendFailed, result.Outcome);
        Assert.NotNull(result.RunItemId);
        var stored = await db.RunItems.SingleAsync(r => r.Id == result.RunItemId);
        Assert.Equal(RunItemStatus.Failed, stored.Status);
        Assert.Contains("connection gone", stored.ErrorMessage);
        Assert.NotNull(stored.CompletedAt);
    }

    [Fact]
    public async Task RecordProgress_transitions_sent_to_running_and_stores_metrics()
    {
        var (svc, db, notifier, userId, task, worker) = await Build();
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var dispatch = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);
        var runId = dispatch.RunItemId!.Value;

        await svc.RecordProgressAsync(new TaskProgressDto
        {
            TaskId = runId.ToString(),
            ConfigId = task.ScraperConfigId.ToString(),
            CurrentTerm = "alpha",
            CurrentStep = "click-search",
            Progress = 50,
            Phase = "loop",
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Running, stored.Status);
        Assert.NotNull(stored.StartedAt);
        Assert.Equal(50, stored.ProgressPercent);
        Assert.Equal("alpha", stored.CurrentTerm);
        Assert.Equal("click-search", stored.CurrentStep);
        Assert.Equal("loop", stored.Phase);
    }

    [Fact]
    public async Task Complete_persists_result_jsonb_and_completes()
    {
        var (svc, db, notifier, userId, task, worker) = await Build();
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var dispatch = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);
        var runId = dispatch.RunItemId!.Value;

        await svc.CompleteAsync(new TaskCompleteDto
        {
            TaskId = runId.ToString(),
            ConfigId = task.ScraperConfigId.ToString(),
            CompletedAt = DateTimeOffset.UtcNow,
            Result = new TaskResultDto
            {
                TaskId = runId.ToString(),
                ConfigId = task.ScraperConfigId.ToString(),
                ConfigName = "demo",
                Status = "success",
                Iterations = JsonDocument.Parse("[]").RootElement,
                TotalTimeMs = 1234,
                Timestamp = DateTimeOffset.UtcNow,
            },
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Completed, stored.Status);
        Assert.NotNull(stored.ResultJsonb);
        Assert.Equal(100, stored.ProgressPercent);
    }

    [Fact]
    public async Task Fail_sets_failed_status_with_error()
    {
        var (svc, db, notifier, userId, task, worker) = await Build();
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var dispatch = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);
        var runId = dispatch.RunItemId!.Value;

        await svc.FailAsync(new TaskErrorDto
        {
            TaskId = runId.ToString(),
            ConfigId = task.ScraperConfigId.ToString(),
            Error = "timeout",
            StepLabel = "click-search",
            FailedAt = DateTimeOffset.UtcNow,
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Failed, stored.Status);
        Assert.Contains("timeout", stored.ErrorMessage);
        Assert.Contains("click-search", stored.ErrorMessage);
    }

    [Fact]
    public async Task MarkPaused_sets_status_and_reason()
    {
        var (svc, db, notifier, userId, task, worker) = await Build();
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var dispatch = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);
        var runId = dispatch.RunItemId!.Value;

        await svc.MarkPausedAsync(new TaskPausedDto
        {
            TaskId = runId.ToString(),
            ConfigId = task.ScraperConfigId.ToString(),
            Reason = "cloudflare",
            ChallengeType = "managed",
            PausedAt = DateTimeOffset.UtcNow,
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Paused, stored.Status);
        Assert.Equal("cloudflare", stored.PauseReason);
    }

    [Fact]
    public async Task Get_returns_null_for_other_users_run()
    {
        var (svc, db, notifier, userId, task, worker) = await Build();
        notifier.Setup(n => n.SendReceiveTaskAsync(It.IsAny<string>(), It.IsAny<QueueTaskDto>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var dispatch = await svc.CreateAndDispatchAsync(userId, task.Id, worker.Id);
        var runId = dispatch.RunItemId!.Value;

        var asOther = await svc.GetAsync(Guid.NewGuid(), runId);
        Assert.Null(asOther);

        var asOwner = await svc.GetAsync(userId, runId);
        Assert.NotNull(asOwner);
    }
}
