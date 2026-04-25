using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace WebScrape.Server.Auth;

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public class CookieCsrfAttribute : Attribute, IAsyncActionFilter
{
    public const string CookieName = "XSRF-TOKEN";
    public const string HeaderName = "X-XSRF-TOKEN";

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var http = context.HttpContext;
        var isPat = http.User.Identities.Any(i => string.Equals(i.AuthenticationType, PatAuthenticationOptions.Scheme, StringComparison.Ordinal));
        if (!isPat)
        {
            var cookie = http.Request.Cookies[CookieName];
            var header = http.Request.Headers[HeaderName].ToString();
            if (string.IsNullOrEmpty(cookie) || string.IsNullOrEmpty(header) || !TokensMatch(cookie, header))
            {
                context.Result = new ObjectResult(new { error = "CSRF token missing or invalid" })
                {
                    StatusCode = StatusCodes.Status400BadRequest,
                };
                return;
            }
        }

        await next();
    }

    private static bool TokensMatch(string a, string b)
    {
        var ab = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        if (ab.Length != bb.Length) return false;
        return CryptographicOperations.FixedTimeEquals(ab, bb);
    }
}
