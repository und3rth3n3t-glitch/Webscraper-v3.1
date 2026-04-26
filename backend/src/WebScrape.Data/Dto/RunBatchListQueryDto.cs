namespace WebScrape.Data.Dto;

public class RunBatchListQueryDto
{
    public Guid? TaskId { get; set; }
    public DateTimeOffset? From { get; set; }
    public DateTimeOffset? To { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 25;
}
