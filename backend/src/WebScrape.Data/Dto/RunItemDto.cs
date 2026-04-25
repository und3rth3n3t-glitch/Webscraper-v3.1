using System.Text.Json;

namespace WebScrape.Data.Dto;

public class RunItemDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public string Status { get; set; } = "";
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonElement? Result { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PauseReason { get; set; }
    public int? ProgressPercent { get; set; }
    public string? CurrentTerm { get; set; }
    public string? CurrentStep { get; set; }
    public string? Phase { get; set; }
}

public class CreateRunDto
{
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
}
