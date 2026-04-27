using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class ScraperConfigServiceConflictTests
{
    private async Task<(ScraperConfigService Svc, WebScrape.Data.WebScrapeDbContext Db, Guid UserId, Guid ConfigId, Guid WorkerId)> Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var workerId = Guid.NewGuid();

        var user = new User { Id = userId, UserName = "test@test.com", Email = "test@test.com" };
        db.Users.Add(user);

        var key = new ApiKey
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "test-key",
            Hash = "hash",
            Prefix = "pre",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.ApiKeys.Add(key);

        var worker = new WorkerConnection
        {
            Id = workerId,
            UserId = userId,
            Name = "Test Worker",
            ApiKeyId = key.Id,
        };
        db.WorkerConnections.Add(worker);

        var config = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "Test Config",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 4,
            Shared = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ScraperConfigs.Add(config);
        await db.SaveChangesAsync();

        var svc = new ScraperConfigService(db, TestDb.CreateMapper());
        return (svc, db, userId, config.Id, workerId);
    }

    [Fact]
    public async Task UpdateAsync_with_matching_ifMatch_succeeds()
    {
        var (svc, db, userId, configId, workerId) = await Build();
        var config = await db.ScraperConfigs.FindAsync(configId);
        var etag = config!.UpdatedAt.ToUniversalTime().ToString("o");
        var dto = new CreateScraperConfigDto
        {
            Name = "Updated",
            Domain = "example.com",
            ConfigJson = JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: etag, workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.Updated, result.Outcome);
        Assert.NotNull(result.Dto);
        Assert.Equal("Updated", result.Dto!.Name);
        Assert.NotNull(result.Dto.LastSyncedAt);
    }

    [Fact]
    public async Task UpdateAsync_with_stale_ifMatch_returns_PreconditionFailed()
    {
        var (svc, _, userId, configId, workerId) = await Build();
        var dto = new CreateScraperConfigDto
        {
            Name = "Updated",
            Domain = "example.com",
            ConfigJson = JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: "stale-etag", workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.PreconditionFailed, result.Outcome);
        Assert.NotNull(result.Current);
    }

    [Fact]
    public async Task UpdateAsync_without_ifMatch_on_shared_config_via_PAT_returns_PreconditionRequired()
    {
        var (svc, _, userId, configId, workerId) = await Build();
        var dto = new CreateScraperConfigDto
        {
            Name = "Updated",
            Domain = "example.com",
            ConfigJson = JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: null, workerId: workerId);

        Assert.Equal(UpdateScraperConfigOutcome.PreconditionRequired, result.Outcome);
    }

    [Fact]
    public async Task UpdateAsync_without_ifMatch_via_cookie_auth_succeeds()
    {
        var (svc, _, userId, configId, _) = await Build();
        var dto = new CreateScraperConfigDto
        {
            Name = "Cookie edit",
            Domain = "example.com",
            ConfigJson = JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        // workerId = null simulates cookie auth
        var result = await svc.UpdateAsync(userId, configId, dto, ifMatch: null, workerId: null);

        Assert.Equal(UpdateScraperConfigOutcome.Updated, result.Outcome);
        Assert.Equal("Cookie edit", result.Dto!.Name);
    }

    [Fact]
    public async Task CreateAsync_with_suggestedId_uses_provided_id()
    {
        var (svc, _, userId, _, workerId) = await Build();
        var suggestedId = Guid.NewGuid();
        var dto = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "New config",
            Domain = "test.com",
            ConfigJson = JsonSerializer.SerializeToElement(new { steps = Array.Empty<object>() }),
            Shared = true,
        };

        var result = await svc.CreateAsync(userId, dto, workerId);

        Assert.Equal(suggestedId, result.Dto.Id);
    }

    // ── Idempotent create helpers ─────────────────────────────────────────────

    private static async Task<(WebScrape.Data.WebScrapeDbContext Db, ScraperConfigService Svc, User User)> SetupAsync()
    {
        var db = TestDb.CreateInMemory();
        var user = new User { Id = Guid.NewGuid(), UserName = "test@test.com", Email = "test@test.com" };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var svc = new ScraperConfigService(db, TestDb.CreateMapper());
        return (db, svc, user);
    }

    private static async Task<User> SeedUserAsync(WebScrape.Data.WebScrapeDbContext db, string email)
    {
        var user = new User { Id = Guid.NewGuid(), UserName = email, Email = email };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    [Fact]
    public async Task CreateAsync_with_existing_suggested_id_and_matching_content_returns_idempotent()
    {
        var (db, svc, user) = await SetupAsync();
        var suggestedId = Guid.NewGuid();
        var dto = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "Wikipedia",
            Domain = "en.wikipedia.org",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
            SchemaVersion = 4,
            Shared = true,
        };

        var first = await svc.CreateAsync(user.Id, dto);
        var second = await svc.CreateAsync(user.Id, dto);

        Assert.Equal(CreateScraperConfigOutcome.Created, first.Outcome);
        Assert.Equal(CreateScraperConfigOutcome.Idempotent, second.Outcome);
        Assert.Equal(first.Dto.Id, second.Dto.Id);
        Assert.Single(db.ScraperConfigs);
    }

    [Fact]
    public async Task CreateAsync_with_existing_suggested_id_and_mismatched_name_returns_conflict()
    {
        var (db, svc, user) = await SetupAsync();
        var suggestedId = Guid.NewGuid();
        var first = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "Wikipedia",
            Domain = "en.wikipedia.org",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
            SchemaVersion = 4,
        };
        await svc.CreateAsync(user.Id, first);

        var second = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "Wikipedia 2",
            Domain = "en.wikipedia.org",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
            SchemaVersion = 4,
        };
        var result = await svc.CreateAsync(user.Id, second);

        Assert.Equal(CreateScraperConfigOutcome.Conflict, result.Outcome);
        Assert.Equal("Wikipedia", result.Dto.Name);
        Assert.Single(db.ScraperConfigs);
    }

    [Fact]
    public async Task CreateAsync_with_suggested_id_owned_by_other_user_creates_new_row()
    {
        var (db, svc, user) = await SetupAsync();
        var otherUser = await SeedUserAsync(db, "other@example.com");
        var suggestedId = Guid.NewGuid();

        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = suggestedId,
            UserId = otherUser.Id,
            Name = "Other",
            Domain = "other.com",
            ConfigJson = JsonDocument.Parse("{}"),
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();

        var dto = new CreateScraperConfigDto
        {
            SuggestedId = suggestedId,
            Name = "Mine",
            Domain = "mine.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
            SchemaVersion = 4,
        };
        var result = await svc.CreateAsync(user.Id, dto);

        Assert.Equal(CreateScraperConfigOutcome.Created, result.Outcome);
        Assert.NotEqual(suggestedId, result.Dto.Id);
        Assert.Equal(user.Id, await db.ScraperConfigs.Where(c => c.Id == result.Dto.Id).Select(c => c.UserId).FirstAsync());
    }
}
