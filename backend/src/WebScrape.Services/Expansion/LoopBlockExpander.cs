using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class LoopBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Loop;

    // Stored as IEnumerable so the DI factory can pass a mutable List<IBlockExpander>
    // that includes `this` — populated after construction to break the circular dep.
    private readonly IEnumerable<IBlockExpander> _all;
    private IReadOnlyDictionary<BlockType, IBlockExpander>? _byTypeCache;

    // Lazily built from _all so the list can be populated after ctor returns.
    private IReadOnlyDictionary<BlockType, IBlockExpander> ByType =>
        _byTypeCache ??= _all.ToDictionary(e => e.Handles);

    public LoopBlockExpander(IEnumerable<IBlockExpander> all)
    {
        _all = all;
    }

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var values = ReadLoopValues(block);
        // Empty loop: one run with an empty search term, consistent with prior behaviour.
        var searchTerms = values.Count == 0 ? new List<string> { "" } : values;

        var children = ctx.AllBlocks
            .Where(b => b.ParentBlockId == block.Id)
            .OrderBy(b => b.OrderIndex)
            .ToList();

        // Bundle all terms into one frame. Children receive the full list; the
        // per-iteration cartesian walk is replaced by searchTerms on the wire.
        var childFrame = new ExpansionFrame(
            LoopAssignments: new Dictionary<Guid, string>(),
            SearchTerms: searchTerms);

        foreach (var child in children)
        {
            if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
            foreach (var result in expander.Expand(child, ctx, childFrame))
                yield return result;
        }
    }

    private static List<string> ReadLoopValues(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;
        if (!root.TryGetProperty("values", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return new();
        var list = new List<string>(arr.GetArrayLength());
        foreach (var v in arr.EnumerateArray())
            if (v.ValueKind == JsonValueKind.String) list.Add(v.GetString() ?? "");
        return list;
    }
}
