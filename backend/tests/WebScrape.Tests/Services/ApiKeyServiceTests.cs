using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Entities;
using WebScrape.Services.Implementations;
using WebScrape.Services.Security;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class ApiKeyServiceTests
{
    private static (ApiKeyService svc, WebScrape.Data.WebScrapeDbContext db, IApiKeyHasher hasher) Build()
    {
        var db = TestDb.CreateInMemory();
        var hasher = new Argon2idApiKeyHasher();
        var tokens = new ApiKeyTokenGenerator();
        var mapper = TestDb.CreateMapper();
        var svc = new ApiKeyService(db, hasher, tokens, mapper);
        return (svc, db, hasher);
    }

    private static async Task<Guid> SeedUserAsync(WebScrape.Data.WebScrapeDbContext db)
    {
        var user = new User { Id = Guid.NewGuid(), UserName = "u@x", Email = "u@x" };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user.Id;
    }

    [Fact]
    public async Task Create_persists_hash_and_returns_raw_token_once()
    {
        var (svc, db, hasher) = Build();
        var userId = await SeedUserAsync(db);

        var result = await svc.CreateAsync(userId, "Laptop");

        Assert.StartsWith("wsk_", result.Token);
        Assert.Equal(8, result.Prefix.Length);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == result.Id);
        Assert.NotEqual(result.Token, stored.Hash);
        Assert.True(hasher.Verify(stored.Hash, result.Token));
        Assert.Equal(result.Prefix, stored.Prefix);
        Assert.Null(stored.RevokedAt);
        Assert.Null(stored.LastUsedAt);
    }

    [Fact]
    public async Task List_returns_user_keys_in_recency_order()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);

        await svc.CreateAsync(userId, "First");
        await Task.Delay(5);
        await svc.CreateAsync(userId, "Second");

        var list = await svc.ListAsync(userId);
        Assert.Equal(2, list.Count);
        Assert.Equal("Second", list[0].Name);
        Assert.Equal("First", list[1].Name);
    }

    [Fact]
    public async Task List_does_not_leak_other_users_keys()
    {
        var (svc, db, _) = Build();
        var alice = await SeedUserAsync(db);
        var bob = await SeedUserAsync(db);
        await svc.CreateAsync(alice, "alice-key");
        await svc.CreateAsync(bob, "bob-key");

        var aliceList = await svc.ListAsync(alice);
        Assert.Single(aliceList);
        Assert.Equal("alice-key", aliceList[0].Name);
    }

    [Fact]
    public async Task Revoke_sets_revoked_at_for_owner_and_blocks_re_revoke()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "k");

        var first = await svc.RevokeAsync(userId, created.Id);
        Assert.True(first);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.NotNull(stored.RevokedAt);

        var firstRevokedAt = stored.RevokedAt;
        var second = await svc.RevokeAsync(userId, created.Id);
        Assert.True(second);
        await db.Entry(stored).ReloadAsync();
        Assert.Equal(firstRevokedAt, stored.RevokedAt);
    }

    [Fact]
    public async Task Revoke_returns_false_for_other_users_key()
    {
        var (svc, db, _) = Build();
        var alice = await SeedUserAsync(db);
        var bob = await SeedUserAsync(db);
        var aliceKey = await svc.CreateAsync(alice, "alice");

        var result = await svc.RevokeAsync(bob, aliceKey.Id);
        Assert.False(result);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == aliceKey.Id);
        Assert.Null(stored.RevokedAt);
    }

    [Fact]
    public async Task Rename_updates_name_for_owner()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Old name");

        var renamed = await svc.RenameAsync(userId, created.Id, "New name");

        Assert.NotNull(renamed);
        Assert.Equal("New name", renamed!.Name);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("New name", stored.Name);
    }

    [Fact]
    public async Task Rename_trims_whitespace()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Old");

        var renamed = await svc.RenameAsync(userId, created.Id, "  Trimmed  ");

        Assert.Equal("Trimmed", renamed!.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_whitespace_name()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Original");

        var renamed = await svc.RenameAsync(userId, created.Id, "   ");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("Original", stored.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_other_users_key()
    {
        var (svc, db, _) = Build();
        var alice = await SeedUserAsync(db);
        var bob = await SeedUserAsync(db);
        var aliceKey = await svc.CreateAsync(alice, "alice-key");

        var renamed = await svc.RenameAsync(bob, aliceKey.Id, "hijacked");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == aliceKey.Id);
        Assert.Equal("alice-key", stored.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_revoked_key()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Original");
        await svc.RevokeAsync(userId, created.Id);

        var renamed = await svc.RenameAsync(userId, created.Id, "Renamed");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("Original", stored.Name);
    }
}
