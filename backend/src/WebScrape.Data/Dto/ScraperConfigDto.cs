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
}

public class CreateScraperConfigDto
{
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonElement ConfigJson { get; set; }
    public int SchemaVersion { get; set; } = 3;
}
