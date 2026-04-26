using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class RunListQueryDto
{
    public Guid? TaskId { get; set; }
    public Guid? WorkerId { get; set; }
    public Guid? BatchId { get; set; }
    public RunItemStatus? Status { get; set; }
    public DateTimeOffset? From { get; set; }
    public DateTimeOffset? To { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 25;
}
