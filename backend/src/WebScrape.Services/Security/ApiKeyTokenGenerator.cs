using System.Security.Cryptography;

namespace WebScrape.Services.Security;

public interface IApiKeyTokenGenerator
{
    string Generate();
    string GetPrefix(string token);
}

public class ApiKeyTokenGenerator : IApiKeyTokenGenerator
{
    public const string TokenPrefix = "wsk_";
    public const int RandomBytes = 24;
    public const int PrefixLength = 8;

    public string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(RandomBytes);
        var random = Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
        return TokenPrefix + random;
    }

    public string GetPrefix(string token)
    {
        if (string.IsNullOrEmpty(token) || token.Length < PrefixLength)
            return token ?? "";
        return token[..PrefixLength];
    }
}
