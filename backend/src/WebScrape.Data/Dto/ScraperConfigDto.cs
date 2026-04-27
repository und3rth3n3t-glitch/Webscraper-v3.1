using System.Text.Json;

namespace WebScrape.Data.Dto;

public class ScraperConfigDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonElement ConfigJson { get; set; }
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public bool Shared { get; set; }
    public DateTimeOffset? LastSyncedAt { get; set; }
    public string? OriginClientId { get; set; }
    public string? OriginWorkerName { get; set; }
}

public class CreateScraperConfigDto
{
    public Guid? SuggestedId { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonElement ConfigJson { get; set; }
    public int SchemaVersion { get; set; } = 3;
    public bool Shared { get; set; } = false;
}

public class ScraperConfigSubscriberDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public bool Online { get; set; }
    public DateTimeOffset LastPulledAt { get; set; }
}
