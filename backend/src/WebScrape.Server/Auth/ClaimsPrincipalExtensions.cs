using System.Security.Claims;

namespace WebScrape.Server.Auth;

public static class ClaimsPrincipalExtensions
{
    public static Guid? TryGetUserId(this ClaimsPrincipal? principal)
    {
        var claim = principal?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    public static Guid GetUserId(this ClaimsPrincipal principal) =>
        principal.TryGetUserId() ?? throw new InvalidOperationException("Missing or malformed user id claim");

    public static Guid? TryGetApiKeyId(this ClaimsPrincipal? principal)
    {
        var claim = principal?.FindFirst(PatAuthenticationOptions.ApiKeyIdClaim)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    public static Guid GetApiKeyId(this ClaimsPrincipal principal) =>
        principal.TryGetApiKeyId() ?? throw new InvalidOperationException("Missing or malformed api key id claim");
}
