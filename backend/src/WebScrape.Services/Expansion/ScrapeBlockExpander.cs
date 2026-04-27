using System.Text.Json;
using System.Text.Json.Nodes;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class ScrapeBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Scrape;

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var (scraperConfigId, stepBindings) = ReadScrapeConfig(block);
        if (!ctx.ConfigsById.TryGetValue(scraperConfigId, out var config))
        {
            ctx.Warnings.Add(new ExpansionWarning(
                ExpansionWarningCodes.ConfigNotFoundAtPopulate,
                BlockId: block.Id,
                ScraperConfigId: scraperConfigId));
            yield break;
        }

        var node = JsonNode.Parse(config.ConfigJson.RootElement.GetRawText())!.AsObject();
        node["id"] = config.Id.ToString();

        var liveSetInputStepIds = new HashSet<string>();
        if (node["steps"] is JsonArray stepsArr)
        {
            foreach (var stepNode in stepsArr.OfType<JsonObject>())
            {
                if (stepNode["type"]?.GetValue<string>() != "setInput") continue;
                var stepId = stepNode["id"]?.GetValue<string>();
                if (string.IsNullOrEmpty(stepId)) continue;
                liveSetInputStepIds.Add(stepId);

                if (!stepBindings.TryGetValue(stepId, out var binding))
                {
                    ctx.Warnings.Add(new ExpansionWarning(ExpansionWarningCodes.NewStepUnbound,
                        BlockId: block.Id, ScraperConfigId: config.Id, StepId: stepId));
                    continue;
                }

                switch (binding.Kind)
                {
                    case "literal":
                        // Bake static values as before.
                        if (stepNode["options"] is not JsonObject opts)
                        {
                            opts = new JsonObject();
                            stepNode["options"] = opts;
                        }
                        opts["literalValue"] = binding.Value ?? "";
                        break;

                    case "loopRef":
                        // Remove any stale literalValue so the extension falls through to searchTerms[i].
                        if (stepNode["options"] is JsonObject loopOpts)
                            loopOpts.Remove("literalValue");
                        break;

                    default: // "unbound"
                        ctx.Warnings.Add(new ExpansionWarning(ExpansionWarningCodes.BindingUnbound,
                            BlockId: block.Id, ScraperConfigId: config.Id, StepId: stepId));
                        break;
                }
            }
        }

        foreach (var stepId in stepBindings.Keys)
        {
            if (!liveSetInputStepIds.Contains(stepId))
                ctx.Warnings.Add(new ExpansionWarning(ExpansionWarningCodes.StepNoLongerExists,
                    BlockId: block.Id, ScraperConfigId: config.Id, StepId: stepId));
        }

        var patched = JsonSerializer.SerializeToElement(node);

        yield return new ExpansionResult(
            ScrapeBlockId: block.Id,
            ScraperConfigId: config.Id,
            ConfigName: config.Name,
            Assignments: new Dictionary<Guid, string>(),
            IterationLabel: "",
            PatchedConfigJson: patched,
            SearchTerms: new List<string>(frame.SearchTerms));
    }

    private static (Guid scraperConfigId, Dictionary<string, BindingPayload> bindings) ReadScrapeConfig(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;
        var configIdStr = root.TryGetProperty("scraperConfigId", out var cid) && cid.ValueKind == JsonValueKind.String
            ? cid.GetString() ?? "" : "";
        if (!Guid.TryParse(configIdStr, out var configId))
            return (Guid.Empty, new());

        var bindings = new Dictionary<string, BindingPayload>();
        if (root.TryGetProperty("stepBindings", out var b) && b.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in b.EnumerateObject())
            {
                var kindStr = prop.Value.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String
                    ? k.GetString() : null;
                if (kindStr is null) continue;

                var payload = new BindingPayload(kindStr,
                    prop.Value.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null,
                    prop.Value.TryGetProperty("loopBlockId", out var l) && l.ValueKind == JsonValueKind.String && Guid.TryParse(l.GetString(), out var lg) ? lg : null);
                bindings[prop.Name] = payload;
            }
        }
        return (configId, bindings);
    }

    private record BindingPayload(string Kind, string? Value, Guid? LoopBlockId);
}
