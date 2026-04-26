using System.Text.Json;
using WebScrape.Data.Entities;

namespace WebScrape.Services.Implementations;

public static class PopulateSnapshotReader
{
    /// <summary>
    /// Returns the dataMapping element for the run's specific scraper config from the batch's
    /// frozen populate_snapshot, or null if absent. Looks up the snapshot by RunItem.ScraperConfigId
    /// (each RunItem corresponds to one specific config at dispatch time).
    /// </summary>
    public static JsonElement? GetDataMappingForRun(RunBatch? batch, RunItem? run)
    {
        if (batch is null || run is null || !run.ScraperConfigId.HasValue) return null;
        var root = batch.PopulateSnapshot.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("configSnapshots", out var snaps) || snaps.ValueKind != JsonValueKind.Object) return null;
        var key = run.ScraperConfigId.Value.ToString();
        if (!snaps.TryGetProperty(key, out var snap)) return null;
        return GetDataMapping(snap);
    }

    /// <summary>
    /// Reads dataMapping out of a stored config JSON root element. Tolerates the two shapes we
    /// observe in the wild: top-level dataMapping, or nested under configJson.dataMapping.
    /// </summary>
    public static JsonElement? GetDataMapping(JsonElement configElement)
    {
        if (configElement.ValueKind != JsonValueKind.Object) return null;
        if (configElement.TryGetProperty("dataMapping", out var dm) && dm.ValueKind == JsonValueKind.Object) return dm;
        if (configElement.TryGetProperty("configJson", out var cj) && cj.ValueKind == JsonValueKind.Object
            && cj.TryGetProperty("dataMapping", out var dm2) && dm2.ValueKind == JsonValueKind.Object) return dm2;
        return null;
    }
}
