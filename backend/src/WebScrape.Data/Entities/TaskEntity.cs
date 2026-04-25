namespace WebScrape.Data.Entities;

public class TaskEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public Guid ScraperConfigId { get; set; }
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public DateTimeOffset CreatedAt { get; set; }
    public User? User { get; set; }
    public ScraperConfigEntity? ScraperConfig { get; set; }
}
