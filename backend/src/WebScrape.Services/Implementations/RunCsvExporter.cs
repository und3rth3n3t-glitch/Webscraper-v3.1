using System.Globalization;
using System.Text;
using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class RunCsvExporter : IRunCsvExporter
{
    private static readonly char[] FormulaTriggers = { '=', '+', '-', '@', '\t', '\r' };

    public bool IsTabular(RunItem run)
    {
        if (run.ResultJsonb is null) return false;
        var root = run.ResultJsonb.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return false;
        if (!root.TryGetProperty("iterations", out var iters) || iters.ValueKind != JsonValueKind.Array) return false;
        foreach (var iter in iters.EnumerateArray())
        {
            if (iter.ValueKind != JsonValueKind.Object) continue;
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                if (row.TryGetProperty("blocks", out _) && row.TryGetProperty("tables", out _) && row.TryGetProperty("charts", out _))
                    return false; // wholepage-flattened iteration is not CSV-friendly
            }
        }
        return true;
    }

    public byte[] ExportRun(RunItem run, ScraperConfigEntity? liveConfig, RunBatch? batch)
    {
        var columns = ResolveColumns(run, liveConfig, batch);
        var sb = new StringBuilder();
        WriteHeader(sb, columns, includeRunId: false);
        WriteRunRows(sb, run, columns, includeRunId: false);
        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    public byte[] ExportBatch(RunBatch batch, IReadOnlyList<RunItem> items, ScraperConfigEntity? liveConfig)
    {
        var firstRun = items.FirstOrDefault(r => r.ResultJsonb is not null);
        var columns = ResolveColumns(firstRun, liveConfig, batch);
        var sb = new StringBuilder();
        WriteHeader(sb, columns, includeRunId: true);
        foreach (var run in items) WriteRunRows(sb, run, columns, includeRunId: true);
        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static IReadOnlyList<ResolvedColumn> ResolveColumns(RunItem? run, ScraperConfigEntity? liveConfig, RunBatch? batch)
    {
        var snapshotMapping = PopulateSnapshotReader.GetDataMappingForRun(batch, run);
        if (snapshotMapping is JsonElement m1) { var cols = ColumnsFromMapping(m1); if (cols.Count > 0) return cols; }

        if (liveConfig is not null)
        {
            var liveMapping = PopulateSnapshotReader.GetDataMapping(liveConfig.ConfigJson.RootElement);
            if (liveMapping is JsonElement m2) { var cols = ColumnsFromMapping(m2); if (cols.Count > 0) return cols; }
        }

        return UnionOfKeys(run);
    }

    private static IReadOnlyList<ResolvedColumn> ColumnsFromMapping(JsonElement mapping)
    {
        if (!mapping.TryGetProperty("columns", out var cols) || cols.ValueKind != JsonValueKind.Array) return Array.Empty<ResolvedColumn>();
        return cols.EnumerateArray()
            .Where(c => c.ValueKind == JsonValueKind.Object)
            .Where(c => !c.TryGetProperty("enabled", out var e) || e.ValueKind != JsonValueKind.False)
            .OrderBy(c => c.TryGetProperty("position", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0)
            .Select(c => new ResolvedColumn(
                OriginalName: c.TryGetProperty("originalName", out var on) && on.ValueKind == JsonValueKind.String ? on.GetString() ?? "" : "",
                DisplayName:  c.TryGetProperty("displayName",  out var dn) && dn.ValueKind == JsonValueKind.String ? dn.GetString() ?? "" : ""))
            .Where(c => !string.IsNullOrEmpty(c.OriginalName))
            .ToList();
    }

    private static IReadOnlyList<ResolvedColumn> UnionOfKeys(RunItem? run)
    {
        if (run?.ResultJsonb is null) return Array.Empty<ResolvedColumn>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();
        if (!run.ResultJsonb.RootElement.TryGetProperty("iterations", out var iters)) return Array.Empty<ResolvedColumn>();
        foreach (var iter in iters.EnumerateArray())
        {
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                foreach (var prop in row.EnumerateObject())
                    if (seen.Add(prop.Name)) ordered.Add(prop.Name);
            }
        }
        return ordered.Select(k => new ResolvedColumn(k, k)).ToList();
    }

    private static void WriteHeader(StringBuilder sb, IReadOnlyList<ResolvedColumn> columns, bool includeRunId)
    {
        if (includeRunId) { sb.Append(EscapeCell("run_id")); sb.Append(','); }
        sb.Append(EscapeCell("iteration_label")); sb.Append(',');
        sb.Append(EscapeCell("iteration_status"));
        foreach (var c in columns) { sb.Append(','); sb.Append(EscapeCell(string.IsNullOrEmpty(c.DisplayName) ? c.OriginalName : c.DisplayName)); }
        sb.Append("\r\n");
    }

    private static void WriteRunRows(StringBuilder sb, RunItem run, IReadOnlyList<ResolvedColumn> columns, bool includeRunId)
    {
        if (run.ResultJsonb is null) return;
        if (!run.ResultJsonb.RootElement.TryGetProperty("iterations", out var iters) || iters.ValueKind != JsonValueKind.Array) return;
        foreach (var iter in iters.EnumerateArray())
        {
            if (iter.ValueKind != JsonValueKind.Object) continue;
            var iterStatus = iter.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "" : "";
            if (!iter.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) continue;
            foreach (var row in data.EnumerateArray())
            {
                if (includeRunId) { sb.Append(EscapeCell(run.Id.ToString())); sb.Append(','); }
                sb.Append(EscapeCell(run.IterationLabel ?? "")); sb.Append(',');
                sb.Append(EscapeCell(iterStatus));
                foreach (var col in columns)
                {
                    sb.Append(',');
                    sb.Append(EscapeCell(ExtractCell(row, col.OriginalName)));
                }
                sb.Append("\r\n");
            }
        }
    }

    private static string ExtractCell(JsonElement row, string key)
    {
        if (row.ValueKind != JsonValueKind.Object) return "";
        if (!row.TryGetProperty(key, out var v)) return "";
        return v.ValueKind switch
        {
            JsonValueKind.String                          => v.GetString() ?? "",
            JsonValueKind.Number                          => v.GetRawText(),
            JsonValueKind.True or JsonValueKind.False     => v.GetBoolean().ToString(CultureInfo.InvariantCulture).ToLowerInvariant(),
            JsonValueKind.Null or JsonValueKind.Undefined => "",
            _                                             => v.GetRawText(),
        };
    }

    private static string EscapeCell(string raw)
    {
        if (raw.Length > 0 && Array.IndexOf(FormulaTriggers, raw[0]) >= 0) raw = "'" + raw;
        if (raw.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0) return raw;
        return "\"" + raw.Replace("\"", "\"\"") + "\"";
    }

    private record ResolvedColumn(string OriginalName, string DisplayName);
}
