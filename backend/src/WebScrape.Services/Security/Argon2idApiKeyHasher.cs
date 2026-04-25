using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace WebScrape.Services.Security;

public class Argon2idApiKeyHasher : IApiKeyHasher
{
    private const int Iterations = 3;
    private const int MemorySizeKb = 65536;
    private const int Parallelism = 2;
    private const int HashLengthBytes = 32;
    private const int SaltLengthBytes = 16;

    public string Hash(string token)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLengthBytes);
        var hash = ComputeHash(token, salt, MemorySizeKb, Iterations, Parallelism, HashLengthBytes);
        return $"$argon2id$v=19$m={MemorySizeKb},t={Iterations},p={Parallelism}${ToBase64Unpadded(salt)}${ToBase64Unpadded(hash)}";
    }

    public bool Verify(string phc, string token)
    {
        if (string.IsNullOrEmpty(phc) || string.IsNullOrEmpty(token)) return false;

        var parts = phc.Split('$', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 5) return false;
        if (parts[0] != "argon2id") return false;
        if (parts[1] != "v=19") return false;

        var paramTokens = parts[2].Split(',');
        if (paramTokens.Length != 3) return false;

        if (!TryParseKv(paramTokens[0], "m", out var memSize)) return false;
        if (!TryParseKv(paramTokens[1], "t", out var iter)) return false;
        if (!TryParseKv(paramTokens[2], "p", out var par)) return false;

        byte[] salt;
        byte[] expected;
        try
        {
            salt = FromBase64Unpadded(parts[3]);
            expected = FromBase64Unpadded(parts[4]);
        }
        catch
        {
            return false;
        }

        var actual = ComputeHash(token, salt, memSize, iter, par, expected.Length);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    private static byte[] ComputeHash(string token, byte[] salt, int memorySizeKb, int iterations, int parallelism, int hashLength)
    {
        using var argon = new Argon2id(Encoding.UTF8.GetBytes(token))
        {
            Salt = salt,
            DegreeOfParallelism = parallelism,
            Iterations = iterations,
            MemorySize = memorySizeKb,
        };
        return argon.GetBytes(hashLength);
    }

    private static bool TryParseKv(string token, string expectedKey, out int value)
    {
        value = 0;
        var idx = token.IndexOf('=');
        if (idx <= 0) return false;
        if (!token[..idx].Equals(expectedKey, StringComparison.Ordinal)) return false;
        return int.TryParse(token.AsSpan(idx + 1), out value);
    }

    private static string ToBase64Unpadded(byte[] data)
        => Convert.ToBase64String(data).TrimEnd('=');

    private static byte[] FromBase64Unpadded(string s)
    {
        var pad = (4 - (s.Length % 4)) % 4;
        return Convert.FromBase64String(s + new string('=', pad));
    }
}
