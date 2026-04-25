namespace WebScrape.Data.Dto;

public class TaskDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public List<TaskBlockTreeDto> Blocks { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; }
}
