namespace WebScrape.Data.Dto;

public class WorkerDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public bool Online { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset? LastConnectedAt { get; set; }
    public string? ExtensionVersion { get; set; }
}
