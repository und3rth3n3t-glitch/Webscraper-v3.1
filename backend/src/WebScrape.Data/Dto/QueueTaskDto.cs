using System.Text.Json;

namespace WebScrape.Data.Dto;

public class QueueTaskDto
{
    public string Id { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string ConfigName { get; set; } = "";
    public List<string> SearchTerms { get; set; } = new();
    public int Priority { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public string Status { get; set; } = "pending";
    // Flat ScraperConfig shape matching the extension's QueueTask.inlineConfig type.
    // Value is configJson blob with "id" injected at top level.
    public JsonElement? InlineConfig { get; set; }
}
