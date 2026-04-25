using System.Text.Json;
using WebScrape.Data;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Expansion;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class QueueExpansionServiceTests
{
    private static QueueExpansionService BuildService(WebScrapeDbContext db)
    {
        var scrape = new ScrapeBlockExpander();
        var all = new List<IBlockExpander>();
        var loop = new LoopBlockExpander(all);
        all.Add(loop);
        all.Add(scrape);
        return new QueueExpansionService(db, all);
    }

    private static (WebScrapeDbContext db, Guid userId, Guid configId, Guid taskId) Seed(
        Func<Guid, Guid, Guid, List<TaskBlock>> buildTree,
        string configJson = """{"steps":[{"id":"s1","type":"setInput","options":{}}]}""")
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        var taskId = Guid.NewGuid();

        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId, UserId = userId, Name = "demo", Domain = "example.com",
            ConfigJson = JsonDocument.Parse(configJson),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.Tasks.Add(new TaskEntity
        {
            Id = taskId, UserId = userId, Name = "T",
            CreatedAt = DateTimeOffset.UtcNow,
        });
        foreach (var b in buildTree(taskId, configId, Guid.NewGuid())) db.TaskBlocks.Add(b);
        db.SaveChanges();
        return (db, userId, configId, taskId);
    }

    private static TaskBlock LoopBlock(Guid id, Guid taskId, Guid? parent, string name, string[] values, int order = 0) => new()
    {
        Id = id, TaskId = taskId, ParentBlockId = parent, BlockType = BlockType.Loop, OrderIndex = order,
        ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new { name, values })),
    };

    private static TaskBlock ScrapeBlock(Guid id, Guid taskId, Guid? parent, Guid configId, Dictionary<string, object>? bindings = null, int order = 0) => new()
    {
        Id = id, TaskId = taskId, ParentBlockId = parent, BlockType = BlockType.Scrape, OrderIndex = order,
        ConfigJsonb = JsonDocument.Parse(JsonSerializer.Serialize(new {
            scraperConfigId = configId.ToString(),
            stepBindings = bindings ?? new Dictionary<string, object>(),
        })),
    };

    [Fact]
    public async Task Single_loop_three_values_one_scrape_yields_three_results()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a", "b", "c" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(ExpansionOutcome.Ok, preview.Outcome);
        Assert.Equal(3, preview.Count);
        Assert.Collection(preview.Results,
            r => Assert.Equal("loop1=a", r.IterationLabel),
            r => Assert.Equal("loop1=b", r.IterationLabel),
            r => Assert.Equal("loop1=c", r.IterationLabel));
    }

    [Fact]
    public async Task Two_nested_loops_one_scrape_yields_cartesian_product()
    {
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loop1, tid, null, "loop1", new[] { "a", "b" }),
            LoopBlock(loop2, tid, loop1, "loop2", new[] { "x", "y" }),
            ScrapeBlock(Guid.NewGuid(), tid, loop2, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(4, preview.Count);
        var labels = preview.Results.Select(r => r.IterationLabel).ToList();
        Assert.Contains("loop1=a, loop2=x", labels);
        Assert.Contains("loop1=a, loop2=y", labels);
        Assert.Contains("loop1=b, loop2=x", labels);
        Assert.Contains("loop1=b, loop2=y", labels);
    }

    [Fact]
    public async Task Loop_with_two_scrape_children_yields_2N_results()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a", "b", "c" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, order: 0),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, order: 1),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(6, preview.Count);
    }

    [Fact]
    public async Task Empty_tree_returns_BATCH_EMPTY()
    {
        var (db, userId, _, taskId) = Seed((tid, cid, _) => new List<TaskBlock>());
        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(ExpansionOutcome.BatchEmpty, preview.Outcome);
    }

    [Fact]
    public async Task Cap_exceeded_returns_BATCH_TOO_LARGE()
    {
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var loop3 = Guid.NewGuid();
        var loop4 = Guid.NewGuid();
        var values = Enumerable.Range(0, 7).Select(i => i.ToString()).ToArray(); // 7^4 = 2401 > 1000
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loop1, tid, null, "l1", values),
            LoopBlock(loop2, tid, loop1, "l2", values),
            LoopBlock(loop3, tid, loop2, "l3", values),
            LoopBlock(loop4, tid, loop3, "l4", values),
            ScrapeBlock(Guid.NewGuid(), tid, loop4, cid),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal(ExpansionOutcome.BatchTooLarge, preview.Outcome);
    }

    [Fact]
    public async Task LoopRef_binding_is_baked_into_literalValue()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "alpha", "beta" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new Dictionary<string, object> {
                ["s1"] = new { kind = "loopRef", loopBlockId = loopId.ToString() },
            }),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);

        Assert.Equal(2, preview.Results.Count);
        var first = preview.Results[0].PatchedConfigJson;
        var step = first.GetProperty("steps")[0];
        Assert.Equal("alpha", step.GetProperty("options").GetProperty("literalValue").GetString());

        var second = preview.Results[1].PatchedConfigJson;
        Assert.Equal("beta", second.GetProperty("steps")[0].GetProperty("options").GetProperty("literalValue").GetString());
    }

    [Fact]
    public async Task Literal_binding_baked_directly()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new Dictionary<string, object> {
                ["s1"] = new { kind = "literal", value = "constant" },
            }),
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        var step = preview.Results[0].PatchedConfigJson.GetProperty("steps")[0];
        Assert.Equal("constant", step.GetProperty("options").GetProperty("literalValue").GetString());
    }

    [Fact]
    public async Task Unbound_setInput_emits_warning_and_resolves_to_empty()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid), // no bindings
        });

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Equal("", preview.Results[0].PatchedConfigJson.GetProperty("steps")[0].GetProperty("options").GetProperty("literalValue").GetString());
        Assert.Contains(preview.Warnings, w => w.Code == ExpansionWarningCodes.NewStepUnbound);
    }

    [Fact]
    public async Task Bound_step_no_longer_in_config_emits_warning()
    {
        var loopId = Guid.NewGuid();
        var (db, userId, configId, taskId) = Seed(
            (tid, cid, _) => new List<TaskBlock>
            {
                LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
                ScrapeBlock(Guid.NewGuid(), tid, loopId, cid, bindings: new Dictionary<string, object> {
                    ["ghost-step"] = new { kind = "literal", value = "x" },
                }),
            },
            configJson: """{"steps":[{"id":"s1","type":"setInput","options":{}}]}""");

        var preview = await BuildService(db).ExpandAsync(userId, taskId);
        Assert.Contains(preview.Warnings, w => w.Code == ExpansionWarningCodes.StepNoLongerExists && w.StepId == "ghost-step");
    }

    [Fact]
    public async Task Cross_user_task_returns_Forbidden()
    {
        var loopId = Guid.NewGuid();
        var (db, _, configId, taskId) = Seed((tid, cid, _) => new List<TaskBlock>
        {
            LoopBlock(loopId, tid, null, "loop1", new[] { "a" }),
            ScrapeBlock(Guid.NewGuid(), tid, loopId, cid),
        });
        var preview = await BuildService(db).ExpandAsync(Guid.NewGuid(), taskId);
        Assert.Equal(ExpansionOutcome.Forbidden, preview.Outcome);
    }
}
