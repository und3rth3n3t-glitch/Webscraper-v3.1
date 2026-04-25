using WebScrape.Services.Security;
using Xunit;

namespace WebScrape.Tests.Security;

public class Argon2idApiKeyHasherTests
{
    private readonly Argon2idApiKeyHasher _hasher = new();

    [Fact]
    public void Hash_then_verify_succeeds_for_same_token()
    {
        var token = "wsk_TheQuickBrownFox";
        var phc = _hasher.Hash(token);
        Assert.True(_hasher.Verify(phc, token));
    }

    [Fact]
    public void Verify_fails_for_tampered_token()
    {
        var token = "wsk_TheQuickBrownFox";
        var phc = _hasher.Hash(token);
        Assert.False(_hasher.Verify(phc, "wsk_TheQuickBrownFoy"));
    }

    [Fact]
    public void Verify_fails_for_garbage_phc()
    {
        Assert.False(_hasher.Verify("not-a-real-phc", "wsk_AnyToken"));
    }

    [Fact]
    public void Hash_produces_argon2id_phc_format()
    {
        var phc = _hasher.Hash("wsk_Sample");
        var parts = phc.Split('$', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(5, parts.Length);
        Assert.Equal("argon2id", parts[0]);
        Assert.Equal("v=19", parts[1]);
        Assert.Contains("m=65536", parts[2]);
        Assert.Contains("t=3", parts[2]);
        Assert.Contains("p=2", parts[2]);
    }

    [Fact]
    public void Each_hash_uses_unique_salt()
    {
        var token = "wsk_Same";
        var first = _hasher.Hash(token);
        var second = _hasher.Hash(token);
        Assert.NotEqual(first, second);
        Assert.True(_hasher.Verify(first, token));
        Assert.True(_hasher.Verify(second, token));
    }
}
