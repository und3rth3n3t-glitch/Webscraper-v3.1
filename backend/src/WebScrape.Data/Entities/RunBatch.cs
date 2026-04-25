using System.Text.Json;

namespace WebScrape.Data.Entities;

public class RunBatch
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid UserId { get; set; }
    public Guid WorkerId { get; set; }
    // Frozen task tree + per-scrape resolved scraper_configs at populate time.
    // M2.3 will populate this; M2.1 leaves it as an empty object.
    public JsonDocument PopulateSnapshot { get; set; } = JsonDocument.Parse("{}");
    public DateTimeOffset CreatedAt { get; set; }
    public TaskEntity? Task { get; set; }
    public User? User { get; set; }
    public WorkerConnection? Worker { get; set; }
}
