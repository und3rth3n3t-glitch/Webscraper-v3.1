namespace WebScrape.Data.Dto;

public class ApiKeyDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public class CreateApiKeyDto
{
    public string Name { get; set; } = "";
}

public class CreateApiKeyResponseDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public string Token { get; set; } = "";
}
