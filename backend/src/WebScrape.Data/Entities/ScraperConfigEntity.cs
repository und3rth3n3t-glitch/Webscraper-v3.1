using System.Text.Json;

namespace WebScrape.Data.Entities;

public class ScraperConfigEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string Domain { get; set; } = "";
    public JsonDocument ConfigJson { get; set; } = JsonDocument.Parse("{}");
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public User? User { get; set; }
}
