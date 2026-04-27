using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public record ExpansionFrame(
    IReadOnlyDictionary<Guid, string> LoopAssignments,
    IReadOnlyList<string> SearchTerms);

// Context passed top-down so expanders can reach siblings/children of the
// current block + look up loop names for label rendering.
public class ExpansionContext
{
    public required IReadOnlyList<TaskBlock> AllBlocks { get; init; }
    public required IReadOnlyDictionary<Guid, TaskBlock> BlocksById { get; init; }
    // loopBlockId -> human name from LoopBlockConfig.Name, captured at expansion time.
    public required IReadOnlyDictionary<Guid, string> LoopNamesById { get; init; }
    // Maps scraperConfigId -> the cloned configJson (already deep-copied per leaf).
    public required IReadOnlyDictionary<Guid, ScraperConfigEntity> ConfigsById { get; init; }
    public List<ExpansionWarning> Warnings { get; } = new();
}

public record ExpansionWarning(string Code, Guid? BlockId = null, Guid? ScraperConfigId = null, string? StepId = null);

public static class ExpansionWarningCodes
{
    public const string BindingUnbound           = "BINDING_UNBOUND";
    public const string StepNoLongerExists       = "STEP_NO_LONGER_EXISTS";
    public const string NewStepUnbound           = "NEW_STEP_UNBOUND";
    public const string ConfigNotFoundAtPopulate = "CONFIG_NOT_FOUND_AT_POPULATE";
}

public record ExpansionResult(
    Guid ScrapeBlockId,
    Guid ScraperConfigId,
    string ConfigName,
    Dictionary<Guid, string> Assignments,
    string IterationLabel,
    System.Text.Json.JsonElement PatchedConfigJson,
    List<string> SearchTerms);

public interface IBlockExpander
{
    BlockType Handles { get; }
    IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame);
}
