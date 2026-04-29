using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class TaskBlockTreeDto
{
    public Guid Id { get; set; }
    public Guid? ParentBlockId { get; set; }
    public BlockType BlockType { get; set; }
    public int OrderIndex { get; set; }
    public LoopBlockConfigDto? Loop { get; set; }
    public ScrapeBlockConfigDto? Scrape { get; set; }
}

public class LoopBlockConfigDto
{
    public string Name { get; set; } = "";
    public List<string> Values { get; set; } = new();
    public List<string>? Columns { get; set; }
    public List<List<string>>? Rows { get; set; }
}

public class ScrapeBlockConfigDto
{
    public Guid ScraperConfigId { get; set; }
    public Dictionary<string, StepBindingDto> StepBindings { get; set; } = new();
}

public class StepBindingDto
{
    public BindingKind Kind { get; set; }
    public string? Value { get; set; }
    public Guid? LoopBlockId { get; set; }
    public string? Column { get; set; }
}

public class SaveTaskDto
{
    public string Name { get; set; } = "";
    public List<TaskBlockTreeDto> Blocks { get; set; } = new();
}
