using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Services.Implementations;
using Xunit;

namespace WebScrape.Tests.Services;

public class PopulateSnapshotReaderTests
{
    private static RunBatch BatchWith(string snapshotJson) => new RunBatch
    {
        Id = Guid.NewGuid(),
        TaskId = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        WorkerId = Guid.NewGuid(),
        PopulateSnapshot = JsonDocument.Parse(snapshotJson),
        CreatedAt = DateTimeOffset.UtcNow,
    };

    private static RunItem RunWithConfig(Guid? configId) => new RunItem
    {
        Id = Guid.NewGuid(),
        TaskId = Guid.NewGuid(),
        WorkerId = Guid.NewGuid(),
        ScraperConfigId = configId,
        RequestedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public void Returns_null_when_batch_is_null()
    {
        var run = RunWithConfig(Guid.NewGuid());
        Assert.Null(PopulateSnapshotReader.GetDataMappingForRun(null, run));
    }

    [Fact]
    public void Returns_null_when_snapshot_has_no_configSnapshots()
    {
        var batch = BatchWith("""{"expandedAt":"2026-01-01T00:00:00Z"}""");
        var run = RunWithConfig(Guid.NewGuid());
        Assert.Null(PopulateSnapshotReader.GetDataMappingForRun(batch, run));
    }

    [Fact]
    public void Returns_dataMapping_from_top_level()
    {
        var configId = Guid.NewGuid();
        var mapping = """{"columns":[{"id":"c1","originalName":"name","displayName":"Name","enabled":true,"position":0}]}""";
        var snapshot = "{\"configSnapshots\":{\"" + configId + "\":{\"dataMapping\":" + mapping + "}}}";
        var batch = BatchWith(snapshot);
        var run = RunWithConfig(configId);

        var result = PopulateSnapshotReader.GetDataMappingForRun(batch, run);

        Assert.NotNull(result);
        Assert.True(result!.Value.TryGetProperty("columns", out _));
    }

    [Fact]
    public void Returns_dataMapping_from_nested_configJson()
    {
        var configId = Guid.NewGuid();
        var mapping = """{"columns":[{"id":"c1","originalName":"price","displayName":"Price","enabled":true,"position":0}]}""";
        var snapshot = "{\"configSnapshots\":{\"" + configId + "\":{\"configJson\":{\"dataMapping\":" + mapping + "}}}}";
        var batch = BatchWith(snapshot);
        var run = RunWithConfig(configId);

        var result = PopulateSnapshotReader.GetDataMappingForRun(batch, run);

        Assert.NotNull(result);
        Assert.True(result!.Value.TryGetProperty("columns", out _));
    }

    [Fact]
    public void Returns_null_when_mapping_missing()
    {
        var configId = Guid.NewGuid();
        var snapshot = "{\"configSnapshots\":{\"" + configId + "\":{\"steps\":[]}}}";
        var batch = BatchWith(snapshot);
        var run = RunWithConfig(configId);

        Assert.Null(PopulateSnapshotReader.GetDataMappingForRun(batch, run));
    }

    [Fact]
    public void Selects_correct_config_when_snapshot_has_multiple_entries()
    {
        var configA = Guid.NewGuid();
        var configB = Guid.NewGuid();
        // Only configB has a dataMapping
        var snapshot = "{\"configSnapshots\":{\"" + configA + "\":{\"steps\":[]},\"" + configB + "\":{\"dataMapping\":{\"columns\":[]}}}}";
        var batch = BatchWith(snapshot);

        var runA = RunWithConfig(configA);
        var runB = RunWithConfig(configB);

        Assert.Null(PopulateSnapshotReader.GetDataMappingForRun(batch, runA));
        Assert.NotNull(PopulateSnapshotReader.GetDataMappingForRun(batch, runB));
    }

    [Fact]
    public void Returns_null_when_run_has_no_ScraperConfigId()
    {
        var configId = Guid.NewGuid();
        var snapshot = "{\"configSnapshots\":{\"" + configId + "\":{\"dataMapping\":{\"columns\":[]}}}}";
        var batch = BatchWith(snapshot);
        var run = RunWithConfig(null);

        Assert.Null(PopulateSnapshotReader.GetDataMappingForRun(batch, run));
    }
}
