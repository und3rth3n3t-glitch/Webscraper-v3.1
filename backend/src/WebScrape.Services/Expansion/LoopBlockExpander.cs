using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class LoopBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Loop;

    private readonly IEnumerable<IBlockExpander> _all;
    private IReadOnlyDictionary<BlockType, IBlockExpander>? _byTypeCache;

    private IReadOnlyDictionary<BlockType, IBlockExpander> ByType =>
        _byTypeCache ??= _all.ToDictionary(e => e.Handles);

    public LoopBlockExpander(IEnumerable<IBlockExpander> all)
    {
        _all = all;
    }

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var children = ctx.AllBlocks
            .Where(b => b.ParentBlockId == block.Id)
            .OrderBy(b => b.OrderIndex)
            .ToList();

        var (columns, rows) = ReadLoopColumnsAndRows(block);

        if (columns.Count > 0 && rows.Count > 0)
        {
            // Multi-column path: one frame per row with baked assignments.
            foreach (var row in rows)
            {
                var assignments = new Dictionary<string, string>(columns.Count);
                for (var c = 0; c < columns.Count; c++)
                    assignments[$"{block.Id}:{columns[c]}"] = row.Count > c ? row[c] : "";

                // First column becomes the iteration label / searchTerm[0].
                var iterLabel = row.Count > 0 ? row[0] : "";
                var childFrame = new ExpansionFrame(
                    LoopAssignments: assignments,
                    SearchTerms: new List<string> { iterLabel });

                foreach (var child in children)
                {
                    if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
                    foreach (var result in expander.Expand(child, ctx, childFrame))
                        yield return result;
                }
            }
        }
        else
        {
            // Single-column path: bundle all values into one frame (existing behaviour).
            var values = ReadLoopValues(block);
            var searchTerms = values.Count == 0 ? new List<string> { "" } : values;

            var childFrame = new ExpansionFrame(
                LoopAssignments: new Dictionary<string, string>(),
                SearchTerms: searchTerms);

            foreach (var child in children)
            {
                if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
                foreach (var result in expander.Expand(child, ctx, childFrame))
                    yield return result;
            }
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

    private static (List<string> columns, List<List<string>> rows) ReadLoopColumnsAndRows(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;

        var columns = new List<string>();
        if (root.TryGetProperty("columns", out var colsEl) && colsEl.ValueKind == JsonValueKind.Array)
            foreach (var c in colsEl.EnumerateArray())
                if (c.ValueKind == JsonValueKind.String) columns.Add(c.GetString() ?? "");

        var rows = new List<List<string>>();
        if (root.TryGetProperty("rows", out var rowsEl) && rowsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var rowEl in rowsEl.EnumerateArray())
            {
                if (rowEl.ValueKind != JsonValueKind.Array) continue;
                var row = new List<string>();
                foreach (var cell in rowEl.EnumerateArray())
                    row.Add(cell.ValueKind == JsonValueKind.String ? cell.GetString() ?? "" : "");
                rows.Add(row);
            }
        }

        return (columns, rows);
    }
}
