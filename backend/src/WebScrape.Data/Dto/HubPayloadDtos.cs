using System.Text.Json;

namespace WebScrape.Data.Dto;

public class TaskProgressDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string CurrentTerm { get; set; } = "";
    public string CurrentStep { get; set; } = "";
    public int Progress { get; set; }
    public string Phase { get; set; } = "loop";
}

public class TaskCompleteDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public TaskResultDto Result { get; set; } = new();
    public DateTimeOffset CompletedAt { get; set; }
}

public class TaskResultDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string ConfigName { get; set; } = "";
    public string Status { get; set; } = "success";
    public JsonElement Iterations { get; set; }
    public JsonElement? DataMapping { get; set; }
    public int TotalTimeMs { get; set; }
    public DateTimeOffset Timestamp { get; set; }
}

public class TaskErrorDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string Error { get; set; } = "";
    public string? StepLabel { get; set; }
    public DateTimeOffset FailedAt { get; set; }
}

public class TaskPausedDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string Reason { get; set; } = "cloudflare";
    public string ChallengeType { get; set; } = "";
    public DateTimeOffset PausedAt { get; set; }
}
