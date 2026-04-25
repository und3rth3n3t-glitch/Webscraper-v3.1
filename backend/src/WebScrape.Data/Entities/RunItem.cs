using System.Text.Json;

namespace WebScrape.Data.Entities;

public static class RunItemStatus
{
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Running = "running";
    public const string Paused = "paused";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public class RunItem
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public string Status { get; set; } = RunItemStatus.Pending;
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonDocument? ResultJsonb { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PauseReason { get; set; }
    public int? ProgressPercent { get; set; }
    public string? CurrentTerm { get; set; }
    public string? CurrentStep { get; set; }
    public string? Phase { get; set; }
    public TaskEntity? Task { get; set; }
    public WorkerConnection? Worker { get; set; }
}
