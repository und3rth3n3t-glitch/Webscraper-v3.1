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

public class ScraperConfigServiceTests
{
    private static (ScraperConfigService svc, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
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
        return (new ScraperConfigService(db, TestDb.CreateMapper()), db, userId, configId);
    }

    [Fact]
    public async Task DeleteAsync_unreferenced_config_succeeds()
    {
        var (svc, db, userId, configId) = Build();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Deleted, result.Outcome);
        Assert.Equal(0, result.ReferencingTaskCount);
        Assert.Equal(0, await db.ScraperConfigs.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_blocked_when_scrape_block_references_config()
    {
        var (svc, db, userId, configId) = Build();
        var taskId = Guid.NewGuid();
        db.Tasks.Add(new TaskEntity { Id = taskId, UserId = userId, Name = "T", CreatedAt = DateTimeOffset.UtcNow });
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            BlockType = BlockType.Scrape,
            OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse($$"""{ "scraperConfigId": "{{configId}}", "stepBindings": {} }"""),
        });
        await db.SaveChangesAsync();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Referenced, result.Outcome);
        Assert.Equal(1, result.ReferencingTaskCount);
        Assert.Equal(1, await db.ScraperConfigs.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_not_blocked_when_task_has_no_scrape_blocks()
    {
        var (svc, db, userId, configId) = Build();
        db.Tasks.Add(new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "NoBlocks",
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Deleted, result.Outcome);
    }

    [Fact]
    public async Task DeleteAsync_returns_forbidden_for_other_user()
    {
        var (svc, _, _, configId) = Build();
        var otherUser = Guid.NewGuid();

        var result = await svc.DeleteAsync(otherUser, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Forbidden, result.Outcome);
    }

    [Fact]
    public async Task DeleteAsync_returns_not_found_for_unknown_id()
    {
        var (svc, _, userId, _) = Build();

        var result = await svc.DeleteAsync(userId, Guid.NewGuid());

        Assert.Equal(DeleteScraperConfigOutcome.NotFound, result.Outcome);
    }
}
