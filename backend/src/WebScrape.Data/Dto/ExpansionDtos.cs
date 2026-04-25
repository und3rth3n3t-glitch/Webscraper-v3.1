namespace WebScrape.Data.Dto;

public class ExpandedItemDto
{
    public Guid ScrapeBlockId { get; set; }
    public Guid ScraperConfigId { get; set; }
    public string ConfigName { get; set; } = "";
    public Dictionary<string, string> Assignments { get; set; } = new();
    public string IterationLabel { get; set; } = "";
}

public class ExpansionWarningDto
{
    public string Code { get; set; } = "";
    public Guid? BlockId { get; set; }
    public Guid? ScraperConfigId { get; set; }
    public string? StepId { get; set; }
}

public class ExpansionPreviewDto
{
    public int Count { get; set; }
    public List<ExpandedItemDto> Items { get; set; } = new();
    public List<ExpansionWarningDto> Warnings { get; set; } = new();
}

public class CreateBatchDto
{
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
}

public class BatchDispatchResultDto
{
    public Guid BatchId { get; set; }
    public int DispatchedCount { get; set; }
    public int FailedCount { get; set; }
}

public class RunBatchDetailDto
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public string TaskName { get; set; } = "";
    public Guid WorkerId { get; set; }
    public string WorkerName { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public List<RunItemDto> RunItems { get; set; } = new();
}
