using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Entities;
using WebScrape.Services.Implementations;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class WorkerServiceTests
{
    [Fact]
    public async Task Register_inserts_new_row_for_first_connection()
    {
        var db = TestDb.CreateInMemory();
        var svc = new WorkerService(db, TestDb.CreateMapper());
        var userId = Guid.NewGuid();
        var apiKeyId = Guid.NewGuid();

        var worker = await svc.RegisterAsync(userId, apiKeyId, "Laptop", "1.0.0", "conn-1");

        Assert.Equal("Laptop", worker.Name);
        Assert.Equal("conn-1", worker.CurrentConnection);
        Assert.Equal("1.0.0", worker.ExtensionVersion);
        Assert.NotNull(worker.LastConnectedAt);
        Assert.NotNull(worker.LastSeenAt);
        Assert.Equal(1, await db.WorkerConnections.CountAsync());
    }

    [Fact]
    public async Task Register_reuses_row_for_same_user_and_api_key()
    {
        var db = TestDb.CreateInMemory();
        var svc = new WorkerService(db, TestDb.CreateMapper());
        var userId = Guid.NewGuid();
        var apiKeyId = Guid.NewGuid();

        var first = await svc.RegisterAsync(userId, apiKeyId, "Laptop", "1.0.0", "conn-1");
        var second = await svc.RegisterAsync(userId, apiKeyId, "Laptop Renamed", "1.0.1", "conn-2");

        Assert.Equal(first.Id, second.Id);
        Assert.Equal("Laptop Renamed", second.Name);
        Assert.Equal("conn-2", second.CurrentConnection);
        Assert.Equal("1.0.1", second.ExtensionVersion);
        Assert.Equal(1, await db.WorkerConnections.CountAsync());
    }

    [Fact]
    public async Task HandleDisconnect_clears_connection_and_fails_in_flight_runs()
    {
        var db = TestDb.CreateInMemory();
        var svc = new WorkerService(db, TestDb.CreateMapper());
        var userId = Guid.NewGuid();
        var worker = await svc.RegisterAsync(userId, Guid.NewGuid(), "L", "1", "conn-x");

        var sentRun = new RunItem { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), WorkerId = worker.Id, Status = RunItemStatus.Sent, RequestedAt = DateTimeOffset.UtcNow };
        var runningRun = new RunItem { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), WorkerId = worker.Id, Status = RunItemStatus.Running, RequestedAt = DateTimeOffset.UtcNow };
        var pausedRun = new RunItem { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), WorkerId = worker.Id, Status = RunItemStatus.Paused, RequestedAt = DateTimeOffset.UtcNow };
        var completedRun = new RunItem { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), WorkerId = worker.Id, Status = RunItemStatus.Completed, RequestedAt = DateTimeOffset.UtcNow };
        db.RunItems.AddRange(sentRun, runningRun, pausedRun, completedRun);
        await db.SaveChangesAsync();

        await svc.HandleDisconnectAsync("conn-x");

        var reloaded = await db.WorkerConnections.SingleAsync(w => w.Id == worker.Id);
        Assert.Null(reloaded.CurrentConnection);
        Assert.NotNull(reloaded.LastSeenAt);

        Assert.Equal(RunItemStatus.Failed, (await db.RunItems.SingleAsync(r => r.Id == sentRun.Id)).Status);
        Assert.Equal(RunItemStatus.Failed, (await db.RunItems.SingleAsync(r => r.Id == runningRun.Id)).Status);
        Assert.Equal(RunItemStatus.Failed, (await db.RunItems.SingleAsync(r => r.Id == pausedRun.Id)).Status);
        Assert.Equal(RunItemStatus.Completed, (await db.RunItems.SingleAsync(r => r.Id == completedRun.Id)).Status);
    }

    [Fact]
    public async Task HandleDisconnect_is_noop_for_unknown_connection()
    {
        var db = TestDb.CreateInMemory();
        var svc = new WorkerService(db, TestDb.CreateMapper());
        await svc.HandleDisconnectAsync("never-existed");
        Assert.Equal(0, await db.WorkerConnections.CountAsync());
    }
}
