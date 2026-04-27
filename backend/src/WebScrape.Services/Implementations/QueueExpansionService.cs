using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Enums;
using WebScrape.Services.Expansion;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class QueueExpansionService : IQueueExpansionService
{
    private readonly WebScrapeDbContext _db;
    private readonly IReadOnlyDictionary<BlockType, IBlockExpander> _expandersByType;

    public QueueExpansionService(WebScrapeDbContext db, IEnumerable<IBlockExpander> expanders)
    {
        _db = db;
        _expandersByType = expanders.ToDictionary(e => e.Handles);
    }

    public async Task<ExpansionPreview> ExpandAsync(Guid userId, Guid taskId, CancellationToken ct = default)
    {
        var task = await _db.Tasks
            .Include(t => t.Blocks)
            .FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null)
            return new ExpansionPreview(ExpansionOutcome.NotFound, 0, new(), new(), "Task not found");
        if (task.UserId != userId)
            return new ExpansionPreview(ExpansionOutcome.Forbidden, 0, new(), new(), "Task does not belong to user");

        var blocks = task.Blocks.ToList();
        var roots = blocks.Where(b => b.ParentBlockId is null).OrderBy(b => b.OrderIndex).ToList();

        // Bundled expansion does not support nested loops. Reject early with a clear error.
        var loopIds = blocks.Where(b => b.BlockType == BlockType.Loop).Select(b => b.Id).ToHashSet();
        var hasNestedLoop = blocks.Any(b => b.BlockType == BlockType.Loop && b.ParentBlockId.HasValue && loopIds.Contains(b.ParentBlockId.Value));
        if (hasNestedLoop)
            return new ExpansionPreview(
                ExpansionOutcome.NestedLoopUnsupported, 0, new(), new(),
                "Nested loops are not yet supported. Place each scrape block in its own top-level loop.");

        var configIds = new HashSet<Guid>();
        foreach (var b in blocks.Where(b => b.BlockType == BlockType.Scrape))
        {
            if (b.ConfigJsonb.RootElement.TryGetProperty("scraperConfigId", out var idEl)
                && idEl.ValueKind == System.Text.Json.JsonValueKind.String
                && Guid.TryParse(idEl.GetString(), out var id))
                configIds.Add(id);
        }
        var configs = await _db.ScraperConfigs
            .Where(c => configIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, ct);

        var loopNames = new Dictionary<Guid, string>();
        foreach (var b in blocks.Where(b => b.BlockType == BlockType.Loop))
        {
            var name = b.ConfigJsonb.RootElement.TryGetProperty("name", out var n) && n.ValueKind == System.Text.Json.JsonValueKind.String
                ? n.GetString() ?? "" : "";
            loopNames[b.Id] = name;
        }

        var ctx = new ExpansionContext
        {
            AllBlocks = blocks,
            BlocksById = blocks.ToDictionary(b => b.Id),
            LoopNamesById = loopNames,
            ConfigsById = configs,
        };

        var emptyFrame = new ExpansionFrame(new Dictionary<Guid, string>(), Array.Empty<string>());
        var results = new List<ExpansionResult>();
        foreach (var root in roots)
        {
            if (!_expandersByType.TryGetValue(root.BlockType, out var expander)) continue;
            foreach (var r in expander.Expand(root, ctx, emptyFrame))
            {
                results.Add(r);
                if (results.Count > IQueueExpansionService.BatchCap)
                {
                    return new ExpansionPreview(
                        ExpansionOutcome.BatchTooLarge,
                        results.Count,
                        new(),
                        ctx.Warnings,
                        $"Expansion exceeds cap of {IQueueExpansionService.BatchCap}");
                }
            }
        }

        if (results.Count == 0)
            return new ExpansionPreview(ExpansionOutcome.BatchEmpty, 0, new(), ctx.Warnings, "Task produces no expanded items (no scrape blocks or all paths skipped).");

        return new ExpansionPreview(ExpansionOutcome.Ok, results.Count, results, ctx.Warnings);
    }
}
