namespace WebScrape.Data.Dto;

public class RunBatchListItemDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public string TaskName { get; set; } = "";
    public Guid WorkerId { get; set; }
    public string WorkerName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public int TotalItems { get; set; }
    public int CompletedCount { get; set; }
    public int FailedCount { get; set; }
    public int PendingCount { get; set; }
}
