using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using WebScrape.Data.Constants;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Hubs;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunServiceTests
{
    private static async Task<(RunService svc, WebScrape.Data.WebScrapeDbContext db, Guid userId, TaskEntity task, WorkerConnection worker)> Build()
    {
        var db = TestDb.CreateInMemory();
        var notifier = new Mock<IWorkerNotifier>(MockBehavior.Strict);
        var svc = new RunService(db, TestDb.CreateMapper(), notifier.Object, new RunCsvExporter(), NullLogger<RunService>.Instance);

        var user = new User { Id = Guid.NewGuid(), UserName = "u@x", Email = "u@x" };
        db.Users.Add(user);

        var task = new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "t",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Tasks.Add(task);

        var worker = new WorkerConnection
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "w",
            ApiKeyId = Guid.NewGuid(),
            CurrentConnection = "conn-1",
        };
        db.WorkerConnections.Add(worker);

        await db.SaveChangesAsync();
        return (svc, db, user.Id, task, worker);
    }

    private static async Task<Guid> SeedSentRun(WebScrape.Data.WebScrapeDbContext db, Guid taskId, Guid workerId)
    {
        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            WorkerId = workerId,
            BatchId = null,
            Status = RunItemStatus.Sent,
            RequestedAt = DateTimeOffset.UtcNow,
            SentAt = DateTimeOffset.UtcNow,
        };
        db.RunItems.Add(run);
        await db.SaveChangesAsync();
        return run.Id;
    }

    [Fact]
    public async Task RecordProgress_transitions_sent_to_running_and_stores_metrics()
    {
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.RecordProgressAsync(new TaskProgressDto
        {
            TaskId = runId.ToString(),
            ConfigId = "",
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
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.CompleteAsync(new TaskCompleteDto
        {
            TaskId = runId.ToString(),
            ConfigId = "",
            CompletedAt = DateTimeOffset.UtcNow,
            Result = new TaskResultDto
            {
                TaskId = runId.ToString(),
                ConfigId = "",
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
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.FailAsync(new TaskErrorDto
        {
            TaskId = runId.ToString(),
            ConfigId = "",
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
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.MarkPausedAsync(new TaskPausedDto
        {
            TaskId = runId.ToString(),
            ConfigId = "",
            Reason = "cloudflare",
            ChallengeType = "managed",
            PausedAt = DateTimeOffset.UtcNow,
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Paused, stored.Status);
        Assert.Equal("cloudflare", stored.PauseReason);
    }

    [Fact]
    public async Task MarkPaused_With_AwaitUserAction_Reason_PersistsReason()
    {
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.MarkPausedAsync(new TaskPausedDto
        {
            TaskId = runId.ToString(),
            ConfigId = Guid.NewGuid().ToString(),
            Reason = PauseReasonConstants.AwaitUserAction,
            Trigger = "loginWall",
            Message = "Sign in",
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Paused, stored.Status);
        Assert.Equal("awaitUserAction", stored.PauseReason);
    }

    [Theory]
    [InlineData("cloudflare")]
    [InlineData("awaitUserAction")]
    public async Task RecordProgress_After_Pause_Flips_To_Running(string reason)
    {
        var (svc, db, _, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        await svc.MarkPausedAsync(new TaskPausedDto
        {
            TaskId = runId.ToString(),
            ConfigId = Guid.NewGuid().ToString(),
            Reason = reason,
        });

        await svc.RecordProgressAsync(new TaskProgressDto
        {
            TaskId = runId.ToString(),
            ConfigId = Guid.NewGuid().ToString(),
            CurrentStep = "next step",
            CurrentTerm = "alpha",
            Progress = 50,
            Phase = "loop",
        });

        var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
        Assert.Equal(RunItemStatus.Running, stored.Status);
        Assert.Equal(50, stored.ProgressPercent);
    }

    [Fact]
    public async Task Get_returns_null_for_other_users_run()
    {
        var (svc, db, userId, task, worker) = await Build();
        var runId = await SeedSentRun(db, task.Id, worker.Id);

        var asOther = await svc.GetAsync(Guid.NewGuid(), runId);
        Assert.Null(asOther);

        var asOwner = await svc.GetAsync(userId, runId);
        Assert.NotNull(asOwner);
    }
}
