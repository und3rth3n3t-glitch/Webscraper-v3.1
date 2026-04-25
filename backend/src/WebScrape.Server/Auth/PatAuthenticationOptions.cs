using Microsoft.AspNetCore.Authentication;

namespace WebScrape.Server.Auth;

public class PatAuthenticationOptions : AuthenticationSchemeOptions
{
    public const string Scheme = "PAT";
    public const string ApiKeyIdClaim = "ApiKeyId";
    public string HubPath { get; set; } = "/api/scraper-hub";
    public TimeSpan LastUsedDebounce { get; set; } = TimeSpan.FromMinutes(1);
}

public static class WebScrapeSchemes
{
    public const string Cookie = "Identity.Application";
    public const string Pat = PatAuthenticationOptions.Scheme;
    public const string CookieAndPat = Cookie + "," + Pat;
}
