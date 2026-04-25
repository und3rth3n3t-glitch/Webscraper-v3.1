using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using WebScrape.Data;
using WebScrape.Services.Security;

namespace WebScrape.Server.Auth;

public class PatAuthenticationHandler : AuthenticationHandler<PatAuthenticationOptions>
{
    private readonly WebScrapeDbContext _db;
    private readonly IApiKeyHasher _hasher;
    private readonly IApiKeyTokenGenerator _tokens;
    private readonly IServiceScopeFactory _scopeFactory;

    public PatAuthenticationHandler(
        IOptionsMonitor<PatAuthenticationOptions> options,
        ILoggerFactory loggerFactory,
        UrlEncoder encoder,
        WebScrapeDbContext db,
        IApiKeyHasher hasher,
        IApiKeyTokenGenerator tokens,
        IServiceScopeFactory scopeFactory)
        : base(options, loggerFactory, encoder)
    {
        _db = db;
        _hasher = hasher;
        _tokens = tokens;
        _scopeFactory = scopeFactory;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var token = ExtractToken();
        if (string.IsNullOrEmpty(token))
        {
            return AuthenticateResult.NoResult();
        }

        if (!token.StartsWith(ApiKeyTokenGenerator.TokenPrefix, StringComparison.Ordinal))
        {
            return AuthenticateResult.NoResult();
        }

        var prefix = _tokens.GetPrefix(token);
        var candidates = await _db.ApiKeys
            .AsNoTracking()
            .Include(k => k.User)
            .Where(k => k.Prefix == prefix && k.RevokedAt == null)
            .ToListAsync();

        foreach (var candidate in candidates)
        {
            if (!_hasher.Verify(candidate.Hash, token)) continue;
            if (candidate.User is null) continue;

            _ = MaybeTouchLastUsedAsync(candidate.Id);

            var claims = new List<Claim>
            {
                new(ClaimTypes.NameIdentifier, candidate.UserId.ToString()),
                new(ClaimTypes.Name, candidate.User.UserName ?? candidate.User.Email ?? candidate.UserId.ToString()),
                new(PatAuthenticationOptions.ApiKeyIdClaim, candidate.Id.ToString()),
            };
            var identity = new ClaimsIdentity(claims, Scheme.Name);
            var principal = new ClaimsPrincipal(identity);
            var ticket = new AuthenticationTicket(principal, Scheme.Name);
            return AuthenticateResult.Success(ticket);
        }

        Logger.LogWarning("PAT auth failed for prefix {Prefix}", prefix);
        return AuthenticateResult.Fail("Invalid token");
    }

    private string? ExtractToken()
    {
        if (Request.Headers.TryGetValue("Authorization", out var authValues))
        {
            foreach (var raw in authValues)
            {
                if (string.IsNullOrEmpty(raw)) continue;
                if (raw.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                {
                    return raw["Bearer ".Length..].Trim();
                }
            }
        }

        if (Request.Path.StartsWithSegments(Options.HubPath, StringComparison.OrdinalIgnoreCase))
        {
            var qs = Request.Query["access_token"].ToString();
            if (!string.IsNullOrEmpty(qs))
            {
                return qs;
            }
        }

        return null;
    }

    private async Task MaybeTouchLastUsedAsync(Guid apiKeyId)
    {
        // Runs as a fire-and-forget task that may outlive the request scope.
        // Use a fresh scope so the DbContext isn't already disposed when we hit it.
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<WebScrapeDbContext>();
            var threshold = DateTimeOffset.UtcNow - Options.LastUsedDebounce;
            var rows = await db.ApiKeys
                .Where(k => k.Id == apiKeyId && (k.LastUsedAt == null || k.LastUsedAt < threshold))
                .ExecuteUpdateAsync(s => s.SetProperty(k => k.LastUsedAt, DateTimeOffset.UtcNow));
            _ = rows;
        }
        catch (Exception ex)
        {
            Logger.LogDebug(ex, "Failed to update LastUsedAt for ApiKey {Id}", apiKeyId);
        }
    }
}
