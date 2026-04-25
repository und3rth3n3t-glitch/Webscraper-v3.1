namespace WebScrape.Data.Entities;

public class WorkerConnection
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public Guid ApiKeyId { get; set; }
    public string? CurrentConnection { get; set; }
    public string? ExtensionVersion { get; set; }
    public DateTimeOffset? LastConnectedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public User? User { get; set; }
    public ApiKey? ApiKey { get; set; }
}
