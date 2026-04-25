using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class TaskValidatorTests
{
    private static (TaskValidator validator, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId,
            UserId = userId,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = System.Text.Json.JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.SaveChanges();
        return (new TaskValidator(db), db, userId, configId);
    }

    [Fact]
    public async Task Happy_path_two_loops_one_scrape_returns_no_errors()
    {
        var (v, _, userId, configId) = Build();
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loop1,  BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "outer", Values = new() { "a", "b" } } },
                new TaskBlockTreeDto { Id = loop2,  ParentBlockId = loop1, BlockType = BlockType.Loop,   OrderIndex = 0, Loop = new() { Name = "inner", Values = new() { "x", "y" } } },
                new TaskBlockTreeDto { Id = scrape, ParentBlockId = loop2, BlockType = BlockType.Scrape, OrderIndex = 0, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["step-1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop1 },
                    ["step-2"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop2 },
                    ["step-3"] = new StepBindingDto { Kind = BindingKind.Literal, Value = "hello" },
                    ["step-4"] = new StepBindingDto { Kind = BindingKind.Unbound },
                }}},
            },
        };

        var errors = await v.ValidateAsync(userId, dto);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Missing_task_name_returns_MISSING_TASK_NAME()
    {
        var (v, _, userId, _) = Build();
        var errors = await v.ValidateAsync(userId, new SaveTaskDto { Name = "  " });
        Assert.Contains(errors, e => e.Code == ValidationCodes.MissingTaskName);
    }

    [Fact]
    public async Task Duplicate_block_id_is_caught()
    {
        var (v, _, userId, _) = Build();
        var dup = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = dup, BlockType = BlockType.Loop, Loop = new() { Name = "a" } },
                new TaskBlockTreeDto { Id = dup, BlockType = BlockType.Loop, Loop = new() { Name = "b" } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.DuplicateBlockId && e.BlockId == dup);
    }

    [Fact]
    public async Task Invalid_parent_reference_is_caught()
    {
        var (v, _, userId, _) = Build();
        var orphan = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new() { new TaskBlockTreeDto { Id = orphan, ParentBlockId = Guid.NewGuid(), BlockType = BlockType.Loop, Loop = new() { Name = "a" } } },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.InvalidParentReference && e.BlockId == orphan);
    }

    [Fact]
    public async Task Tree_cycle_is_caught()
    {
        var (v, _, userId, _) = Build();
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = a, ParentBlockId = b, BlockType = BlockType.Loop, Loop = new() { Name = "a" } },
                new TaskBlockTreeDto { Id = b, ParentBlockId = a, BlockType = BlockType.Loop, Loop = new() { Name = "b" } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.TreeCycle);
    }

    [Fact]
    public async Task Loop_block_missing_payload_returns_INVALID_BLOCK_CONFIG()
    {
        var (v, _, userId, _) = Build();
        var id = Guid.NewGuid();
        var dto = new SaveTaskDto { Name = "T", Blocks = new() { new TaskBlockTreeDto { Id = id, BlockType = BlockType.Loop, Loop = null } } };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.InvalidBlockConfig && e.BlockId == id);
    }

    [Fact]
    public async Task Missing_loop_name_is_caught()
    {
        var (v, _, userId, _) = Build();
        var id = Guid.NewGuid();
        var dto = new SaveTaskDto { Name = "T", Blocks = new() { new TaskBlockTreeDto { Id = id, BlockType = BlockType.Loop, Loop = new() { Name = "" } } } };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.MissingLoopName && e.BlockId == id);
    }

    [Fact]
    public async Task Loop_ref_to_non_ancestor_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var loop1 = Guid.NewGuid();
        var loop2 = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = loop1, BlockType = BlockType.Loop, Loop = new() { Name = "l1" } },
                new TaskBlockTreeDto { Id = loop2, BlockType = BlockType.Loop, Loop = new() { Name = "l2" } },
                new TaskBlockTreeDto { Id = scrape, ParentBlockId = loop1, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = loop2 },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefNonAncestor && e.LoopBlockId == loop2);
    }

    [Fact]
    public async Task Loop_ref_missing_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var scrape = Guid.NewGuid();
        var phantom = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = phantom },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefMissing && e.LoopBlockId == phantom);
    }

    [Fact]
    public async Task Loop_ref_to_non_loop_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var notALoop = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = notALoop, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId } },
                new TaskBlockTreeDto { Id = scrape,   ParentBlockId = notALoop, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.LoopRef, LoopBlockId = notALoop },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.LoopRefNotLoop && e.LoopBlockId == notALoop);
    }

    [Fact]
    public async Task Literal_binding_missing_value_is_caught()
    {
        var (v, _, userId, configId) = Build();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = configId, StepBindings = new() {
                    ["s1"] = new StepBindingDto { Kind = BindingKind.Literal, Value = null },
                }}},
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.BindingLiteralMissingValue && e.StepId == "s1");
    }

    [Fact]
    public async Task Config_not_owned_is_caught()
    {
        var (v, _, userId, _) = Build();
        var foreignConfig = Guid.NewGuid();
        var scrape = Guid.NewGuid();
        var dto = new SaveTaskDto
        {
            Name = "T",
            Blocks = new()
            {
                new TaskBlockTreeDto { Id = scrape, BlockType = BlockType.Scrape, Scrape = new() { ScraperConfigId = foreignConfig } },
            },
        };
        var errors = await v.ValidateAsync(userId, dto);
        Assert.Contains(errors, e => e.Code == ValidationCodes.ConfigNotOwned && e.ScraperConfigId == foreignConfig);
    }
}
