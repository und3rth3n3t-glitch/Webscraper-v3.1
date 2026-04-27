using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Server.Seed;

public static class InitialSeed
{
    public const string AdminEmail = "admin@local";
    public const string AdminPassword = "admin123";
    public const string DemoConfigName = "Demo Local Fixture";
    public const string DemoTaskName = "Demo Task";

    public static async Task RunAsync(IServiceProvider services, ILogger logger, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;

        var db = sp.GetRequiredService<WebScrapeDbContext>();
        var userManager = sp.GetRequiredService<UserManager<User>>();

        await db.Database.MigrateAsync(ct);

        if (await db.Users.AnyAsync(ct))
        {
            logger.LogInformation("Seed skipped: users exist");
            return;
        }

        var admin = new User
        {
            Id = Guid.NewGuid(),
            UserName = AdminEmail,
            Email = AdminEmail,
            EmailConfirmed = true,
        };
        var createResult = await userManager.CreateAsync(admin, AdminPassword);
        if (!createResult.Succeeded)
        {
            logger.LogError("Failed to create admin user: {Errors}", string.Join("; ", createResult.Errors.Select(e => e.Description)));
            return;
        }

        var demoConfigJson = JsonDocument.Parse("""
        {
            "name": "Demo Local Fixture",
            "url": "https://example.com",
            "domain": "example.com",
            "schemaVersion": 3,
            "steps": []
        }
        """);

        var config = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = admin.Id,
            Name = DemoConfigName,
            Domain = "example.com",
            ConfigJson = demoConfigJson,
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ScraperConfigs.Add(config);

        var taskId = Guid.NewGuid();
        var loopBlockId = Guid.NewGuid();
        var scrapeBlockId = Guid.NewGuid();

        var task = new TaskEntity
        {
            Id = taskId,
            UserId = admin.Id,
            Name = DemoTaskName,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Tasks.Add(task);

        var loopConfig = JsonDocument.Parse("""
        {
            "name": "loop1",
            "values": ["alpha", "beta"]
        }
        """);
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = loopBlockId,
            TaskId = taskId,
            ParentBlockId = null,
            BlockType = BlockType.Loop,
            OrderIndex = 0,
            ConfigJsonb = loopConfig,
        });

        var scrapeConfig = JsonDocument.Parse($$"""
        {
            "scraperConfigId": "{{config.Id}}",
            "stepBindings": {}
        }
        """);
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = scrapeBlockId,
            TaskId = taskId,
            ParentBlockId = loopBlockId,
            BlockType = BlockType.Scrape,
            OrderIndex = 0,
            ConfigJsonb = scrapeConfig,
        });

        await db.SaveChangesAsync(ct);
        logger.LogInformation("Seed completed: admin user, demo config {ConfigId}, demo task {TaskId} (1-loop-1-scrape tree)", config.Id, task.Id);
    }
}
