using System.Text.Json;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Entities;

public class RunItem
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public Guid? BatchId { get; set; }
    public RunItemStatus Status { get; set; } = RunItemStatus.Pending;
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
    public string? IterationLabel { get; set; }
    public JsonDocument? IterationAssignments { get; set; }
    public TaskEntity? Task { get; set; }
    public WorkerConnection? Worker { get; set; }
    public RunBatch? Batch { get; set; }
}
