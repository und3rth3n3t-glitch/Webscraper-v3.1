namespace WebScrape.Data.Dto;

public class TaskDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public Guid ScraperConfigId { get; set; }
    public string ScraperConfigName { get; set; } = "";
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public DateTimeOffset CreatedAt { get; set; }
}

public class CreateTaskDto
{
    public string Name { get; set; } = "";
    public Guid ScraperConfigId { get; set; }
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
}
