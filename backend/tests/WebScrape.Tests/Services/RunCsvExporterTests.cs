using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using Xunit;

namespace WebScrape.Tests.Services;

public class RunCsvExporterTests
{
    private static RunItem RunWith(string resultJson, string? iterationLabel = "label-1")
    {
        return new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = Guid.NewGuid(),
            WorkerId = Guid.NewGuid(),
            Status = RunItemStatus.Completed,
            RequestedAt = DateTimeOffset.UtcNow,
            ResultJsonb = JsonDocument.Parse(resultJson),
            IterationLabel = iterationLabel,
        };
    }

    private static ScraperConfigEntity ConfigWith(string mappingJson)
    {
        return new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = Guid.NewGuid(),
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse($"{{\"dataMapping\":{mappingJson}}}"),
        };
    }

    [Fact]
    public void Empty_iterations_writes_header_only()
    {
        var run = RunWith("""{"iterations":[]}""");
        var bytes = new RunCsvExporter().ExportRun(run, null, null);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        Assert.Equal("iteration_label,iteration_status\r\n", text);
    }

    [Fact]
    public void Mapping_drives_columns_and_display_names()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"name":"A","price":1}]}]}""");
        var cfg = ConfigWith("""{"version":1,"columns":[{"id":"c1","originalName":"name","displayName":"Product","enabled":true,"position":0,"sourceType":"scrapeElement"},{"id":"c2","originalName":"price","displayName":"Price","enabled":true,"position":1,"sourceType":"scrapeElement"}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, cfg, null));
        Assert.Contains("iteration_label,iteration_status,Product,Price", text);
        Assert.Contains("label-1,success,A,1", text);
    }

    [Fact]
    public void Disabled_columns_excluded_and_position_orders()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"a":1,"b":2,"c":3}]}]}""");
        var cfg = ConfigWith("""{"version":1,"columns":[{"id":"c1","originalName":"a","displayName":"A","enabled":true,"position":2},{"id":"c2","originalName":"b","displayName":"B","enabled":false,"position":0},{"id":"c3","originalName":"c","displayName":"C","enabled":true,"position":1}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, cfg, null));
        var headerLine = text.Split("\r\n")[0];
        Assert.Equal("iteration_label,iteration_status,C,A", headerLine);
    }

    [Fact]
    public void Falls_back_to_union_of_keys_when_no_mapping()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"name":"A"},{"price":2}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        var headerLine = text.Split("\r\n")[0];
        Assert.Equal("iteration_label,iteration_status,name,price", headerLine);
    }

    [Fact]
    public void Nested_object_value_is_json_stringified()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"meta":{"x":1}}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains("\"{\"\"x\"\":1}\"", text);
    }

    [Theory]
    [InlineData("=cmd|x")]
    [InlineData("+1+1")]
    [InlineData("-1-1")]
    [InlineData("@SUM(A1)")]
    public void Formula_injection_prefixes_with_quote(string danger)
    {
        var json = $$"""{"iterations":[{"status":"success","data":[{"v":"{{danger}}"}]}]}""";
        var run = RunWith(json);
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains($"'{danger}", text);
    }

    [Fact]
    public void Comma_quote_newline_are_rfc4180_quoted()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"v":"a,b\"c\nd"}]}]}""");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportRun(run, null, null));
        Assert.Contains("\"a,b\"\"c\nd\"", text);
    }

    [Fact]
    public void IsTabular_true_for_flat_rows()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"a":1}]}]}""");
        Assert.True(new RunCsvExporter().IsTabular(run));
    }

    [Fact]
    public void IsTabular_false_for_wholepage_iteration()
    {
        var run = RunWith("""{"iterations":[{"status":"success","data":[{"blocks":[],"tables":[],"charts":[]}]}]}""");
        Assert.False(new RunCsvExporter().IsTabular(run));
    }

    [Fact]
    public void ExportBatch_concatenates_run_rows_with_run_id_column()
    {
        var batch = new RunBatch { Id = Guid.NewGuid(), TaskId = Guid.NewGuid(), UserId = Guid.NewGuid(), WorkerId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow };
        var r1 = RunWith("""{"iterations":[{"status":"success","data":[{"a":1}]}]}""", "alpha");
        var r2 = RunWith("""{"iterations":[{"status":"success","data":[{"a":2}]}]}""", "beta");
        var text = System.Text.Encoding.UTF8.GetString(new RunCsvExporter().ExportBatch(batch, new[] { r1, r2 }, null));
        var lines = text.Split("\r\n");
        Assert.StartsWith("run_id,iteration_label,iteration_status,a", lines[0]);
        Assert.Contains("alpha", lines[1]);
        Assert.Contains("beta", lines[2]);
    }
}
