using WebScrape.Services.Security;
using Xunit;

namespace WebScrape.Tests.Security;

public class ApiKeyTokenGeneratorTests
{
    private readonly ApiKeyTokenGenerator _gen = new();

    [Fact]
    public void Generate_starts_with_wsk_prefix()
    {
        var token = _gen.Generate();
        Assert.StartsWith("wsk_", token);
    }

    [Fact]
    public void Generate_produces_unique_tokens()
    {
        var a = _gen.Generate();
        var b = _gen.Generate();
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void GetPrefix_returns_first_eight_chars()
    {
        var token = "wsk_AbCdEFgH...";
        Assert.Equal("wsk_AbCd", _gen.GetPrefix(token));
    }

    [Fact]
    public void GetPrefix_returns_eight_chars_for_real_token()
    {
        var token = _gen.Generate();
        Assert.Equal(8, _gen.GetPrefix(token).Length);
        Assert.StartsWith("wsk_", _gen.GetPrefix(token));
    }
}
