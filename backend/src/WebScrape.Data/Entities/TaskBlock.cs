using System.Text.Json;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Entities;

public class TaskBlock
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid? ParentBlockId { get; set; }
    public BlockType BlockType { get; set; }
    public int OrderIndex { get; set; }
    // Shape varies by BlockType:
    //   Loop:   { "name": string, "values": string[] }
    //   Scrape: { "scraperConfigId": guid-string, "stepBindings": { [setInputStepId]: { kind, ... } } }
    public JsonDocument ConfigJsonb { get; set; } = JsonDocument.Parse("{}");
    public TaskEntity? Task { get; set; }
    public TaskBlock? ParentBlock { get; set; }
    public ICollection<TaskBlock> Children { get; set; } = new List<TaskBlock>();
}
