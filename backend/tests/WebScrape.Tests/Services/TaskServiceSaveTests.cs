using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class TaskServiceSaveTests
{
    private static (TaskService svc, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId,
            UserId = userId,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.SaveChanges();
        var svc = new TaskService(db, TestDb.CreateMapper(), new TaskValidator(db));
        return (svc, db, userId, configId);
    }

    private static SaveTaskDto MakeTree(Guid configId, params string[] values)
    {
        var loopId = Guid.NewGuid();
        var scrapeId = Guid.NewGuid();
        return new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loopId,   BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "loop1", Values = values.ToList() } },
                new TaskBlockTreeDto { Id = scrapeId, ParentBlockId = loopId, BlockType = BlockType.Scrape, OrderIndex = 0, Scrape = new() { ScraperConfigId = configId, StepBindings = new() } },
            },
        };
    }

    [Fact]
    public async Task SaveAsync_create_writes_blocks_and_returns_dto()
    {
        var (svc, db, userId, configId) = Build();
        var dto = MakeTree(configId, "alpha", "beta");

        var result = await svc.SaveAsync(userId, null, dto);

        Assert.Equal(SaveTaskOutcome.Created, result.Outcome);
        Assert.NotNull(result.Task);
        Assert.Equal(2, result.Task!.Blocks.Count);
        Assert.Equal(new[] { "alpha", "beta" }, result.Task.SearchTerms);
        Assert.Equal(2, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task SaveAsync_update_replaces_tree()
    {
        var (svc, db, userId, configId) = Build();
        var first = await svc.SaveAsync(userId, null, MakeTree(configId, "a", "b"));
        var taskId = first.Task!.Id;

        var second = await svc.SaveAsync(userId, taskId, MakeTree(configId, "x"));

        Assert.Equal(SaveTaskOutcome.Updated, second.Outcome);
        Assert.Equal(2, await db.TaskBlocks.CountAsync());
        Assert.Equal(new[] { "x" }, second.Task!.SearchTerms);
    }

    [Fact]
    public async Task SaveAsync_returns_forbidden_for_other_users_task()
    {
        var (svc, _, userId, configId) = Build();
        var first = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var taskId = first.Task!.Id;

        var asOther = await svc.SaveAsync(Guid.NewGuid(), taskId, MakeTree(configId, "b"));
        Assert.Equal(SaveTaskOutcome.Forbidden, asOther.Outcome);
    }

    [Fact]
    public async Task SaveAsync_returns_validation_failed_without_writing()
    {
        var (svc, db, userId, _) = Build();
        var phantomConfig = Guid.NewGuid();
        var bad = MakeTree(phantomConfig, "a");

        var result = await svc.SaveAsync(userId, null, bad);

        Assert.Equal(SaveTaskOutcome.ValidationFailed, result.Outcome);
        Assert.NotEmpty(result.Errors);
        Assert.Equal(0, await db.Tasks.CountAsync());
        Assert.Equal(0, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task SaveAsync_returns_not_found_for_unknown_taskId()
    {
        var (svc, _, userId, configId) = Build();
        var result = await svc.SaveAsync(userId, Guid.NewGuid(), MakeTree(configId, "a"));
        Assert.Equal(SaveTaskOutcome.NotFound, result.Outcome);
    }

    [Fact]
    public async Task DeleteAsync_removes_task_and_cascades_blocks()
    {
        var (svc, db, userId, configId) = Build();
        var created = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var outcome = await svc.DeleteAsync(userId, created.Task!.Id);

        Assert.Equal(DeleteTaskOutcome.Deleted, outcome);
        Assert.Equal(0, await db.Tasks.CountAsync());
        Assert.Equal(0, await db.TaskBlocks.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_returns_forbidden_for_other_users_task()
    {
        var (svc, _, userId, configId) = Build();
        var created = await svc.SaveAsync(userId, null, MakeTree(configId, "a"));
        var outcome = await svc.DeleteAsync(Guid.NewGuid(), created.Task!.Id);
        Assert.Equal(DeleteTaskOutcome.Forbidden, outcome);
    }

    [Fact]
    public async Task DeleteAsync_returns_not_found_for_missing_task()
    {
        var (svc, _, userId, _) = Build();
        var outcome = await svc.DeleteAsync(userId, Guid.NewGuid());
        Assert.Equal(DeleteTaskOutcome.NotFound, outcome);
    }

    [Fact]
    public async Task SaveAsync_create_persists_without_scraper_config_id_column()
    {
        // Verifies the M2.7 column drop: TaskEntity no longer has ScraperConfigId.
        // Compile-time proof: the property is gone. Runtime proof: the entity round-trips cleanly.
        var (svc, db, userId, configId) = Build();
        var dto = MakeTree(configId, "x");

        var result = await svc.SaveAsync(userId, null, dto);

        Assert.Equal(SaveTaskOutcome.Created, result.Outcome);
        var stored = await db.Tasks.FindAsync(result.Task!.Id);
        Assert.NotNull(stored);
        Assert.Equal("T", stored!.Name);
        Assert.Equal(userId, stored.UserId);
    }
}
