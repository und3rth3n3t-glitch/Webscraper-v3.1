namespace WebScrape.Data.Entities;

public class ScraperConfigSubscription
{
    public Guid ScraperConfigId { get; set; }
    public Guid WorkerId { get; set; }
    public DateTimeOffset LastPulledAt { get; set; }

    public ScraperConfigEntity? Config { get; set; }
    public WorkerConnection? Worker { get; set; }
}
