namespace WebScrape.Data.Dto;

public class ValidationErrorDto
{
    public string Code { get; set; } = "";
    public Guid? BlockId { get; set; }
    public Guid? LoopBlockId { get; set; }
    public Guid? ScraperConfigId { get; set; }
    public string? StepId { get; set; }
    public string? Message { get; set; }
}
