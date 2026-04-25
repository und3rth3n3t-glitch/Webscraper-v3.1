using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using WebScrape.Data.Entities;
using WebScrape.Server.Auth;
using WebScrape.Services.Security;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Auth;

public class PatAuthenticationHandlerTests
{
    private static async Task<(PatAuthenticationHandler handler, HttpContext http, string rawToken, ApiKey stored)> BuildAsync(bool revoke = false, bool tamperToken = false)
    {
        var db = TestDb.CreateInMemory();
        var hasher = new Argon2idApiKeyHasher();
        var tokens = new ApiKeyTokenGenerator();

        var user = new User { Id = Guid.NewGuid(), UserName = "u@x", Email = "u@x" };
        db.Users.Add(user);

        var rawToken = tokens.Generate();
        var apiKey = new ApiKey
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = "k",
            Hash = hasher.Hash(rawToken),
            Prefix = tokens.GetPrefix(rawToken),
            CreatedAt = DateTimeOffset.UtcNow,
            RevokedAt = revoke ? DateTimeOffset.UtcNow : null,
        };
        db.ApiKeys.Add(apiKey);
        await db.SaveChangesAsync();

        var options = new OptionsWrapper<PatAuthenticationOptions>(new PatAuthenticationOptions());
        var optionsMonitor = new TestOptionsMonitor<PatAuthenticationOptions>(options.Value);
        var mockScopeFactory = new Mock<IServiceScopeFactory>();
        var handler = new PatAuthenticationHandler(optionsMonitor, NullLoggerFactory.Instance, UrlEncoder.Default, db, hasher, tokens, mockScopeFactory.Object);

        var http = new DefaultHttpContext();
        await handler.InitializeAsync(new AuthenticationScheme(PatAuthenticationOptions.Scheme, null, typeof(PatAuthenticationHandler)), http);

        return (handler, http, tamperToken ? rawToken + "X" : rawToken, apiKey);
    }

    [Fact]
    public async Task Bearer_header_with_valid_token_succeeds_with_claims()
    {
        var (handler, http, rawToken, stored) = await BuildAsync();
        http.Request.Headers["Authorization"] = $"Bearer {rawToken}";

        var result = await handler.AuthenticateAsync();

        Assert.True(result.Succeeded);
        var principal = result.Principal!;
        Assert.Equal(stored.UserId.ToString(), principal.FindFirst(ClaimTypes.NameIdentifier)!.Value);
        Assert.Equal(stored.Id.ToString(), principal.FindFirst(PatAuthenticationOptions.ApiKeyIdClaim)!.Value);
    }

    [Fact]
    public async Task Query_access_token_on_hub_path_succeeds()
    {
        var (handler, http, rawToken, _) = await BuildAsync();
        http.Request.Path = "/api/scraper-hub";
        http.Request.QueryString = new QueryString($"?access_token={Uri.EscapeDataString(rawToken)}");

        var result = await handler.AuthenticateAsync();

        Assert.True(result.Succeeded);
    }

    [Fact]
    public async Task Query_access_token_off_hub_path_is_ignored()
    {
        var (handler, http, rawToken, _) = await BuildAsync();
        http.Request.Path = "/api/something-else";
        http.Request.QueryString = new QueryString($"?access_token={Uri.EscapeDataString(rawToken)}");

        var result = await handler.AuthenticateAsync();

        Assert.False(result.Succeeded);
        Assert.True(result.None);
    }

    [Fact]
    public async Task Non_wsk_token_returns_no_result()
    {
        var (handler, http, _, _) = await BuildAsync();
        http.Request.Headers["Authorization"] = "Bearer some-jwt-style-token";

        var result = await handler.AuthenticateAsync();

        Assert.True(result.None);
    }

    [Fact]
    public async Task Missing_authorization_returns_no_result()
    {
        var (handler, _, _, _) = await BuildAsync();

        var result = await handler.AuthenticateAsync();

        Assert.True(result.None);
    }

    [Fact]
    public async Task Revoked_token_fails()
    {
        var (handler, http, rawToken, _) = await BuildAsync(revoke: true);
        http.Request.Headers["Authorization"] = $"Bearer {rawToken}";

        var result = await handler.AuthenticateAsync();

        Assert.False(result.Succeeded);
        Assert.False(result.None);
    }

    [Fact]
    public async Task Tampered_token_fails()
    {
        var (handler, http, rawToken, _) = await BuildAsync(tamperToken: true);
        http.Request.Headers["Authorization"] = $"Bearer {rawToken}";

        var result = await handler.AuthenticateAsync();

        Assert.False(result.Succeeded);
    }

    private class TestOptionsMonitor<T> : IOptionsMonitor<T>
    {
        public TestOptionsMonitor(T value) { CurrentValue = value; }
        public T CurrentValue { get; }
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
