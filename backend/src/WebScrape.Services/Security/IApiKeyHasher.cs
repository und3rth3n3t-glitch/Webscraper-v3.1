namespace WebScrape.Services.Security;

public interface IApiKeyHasher
{
    string Hash(string token);
    bool Verify(string phc, string token);
}
