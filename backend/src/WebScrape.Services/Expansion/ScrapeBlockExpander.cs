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

                var (resolved, warning) = ResolveBinding(stepId, stepBindings, frame);
                if (warning is not null)
                    ctx.Warnings.Add(warning with { BlockId = block.Id, ScraperConfigId = config.Id, StepId = stepId });

                if (stepNode["options"] is not JsonObject options)
                {
                    options = new JsonObject();
                    stepNode["options"] = options;
                }
                options["literalValue"] = resolved;
            }
        }

        foreach (var stepId in stepBindings.Keys)
        {
            if (!liveSetInputStepIds.Contains(stepId))
                ctx.Warnings.Add(new ExpansionWarning(
                    ExpansionWarningCodes.StepNoLongerExists,
                    BlockId: block.Id,
                    ScraperConfigId: config.Id,
                    StepId: stepId));
        }

        var patched = JsonSerializer.SerializeToElement(node);
        var label = BuildIterationLabel(frame.LoopAssignments, ctx.LoopNamesById);

        yield return new ExpansionResult(
            ScrapeBlockId: block.Id,
            ScraperConfigId: config.Id,
            ConfigName: config.Name,
            Assignments: new Dictionary<Guid, string>(frame.LoopAssignments),
            IterationLabel: label,
            PatchedConfigJson: patched);
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

    private static (string resolved, ExpansionWarning? warning) ResolveBinding(string stepId, Dictionary<string, BindingPayload> bindings, ExpansionFrame frame)
    {
        if (!bindings.TryGetValue(stepId, out var binding))
            return ("", new ExpansionWarning(ExpansionWarningCodes.NewStepUnbound));

        switch (binding.Kind)
        {
            case "literal":
                return (binding.Value ?? "", null);
            case "loopRef":
                if (binding.LoopBlockId.HasValue && frame.LoopAssignments.TryGetValue(binding.LoopBlockId.Value, out var v))
                    return (v, null);
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
            case "unbound":
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
            default:
                return ("", new ExpansionWarning(ExpansionWarningCodes.BindingUnbound));
        }
    }

    private static string BuildIterationLabel(IReadOnlyDictionary<Guid, string> assignments, IReadOnlyDictionary<Guid, string> loopNames)
    {
        if (assignments.Count == 0) return "";
        return string.Join(", ", assignments.Select(kv => $"{(loopNames.TryGetValue(kv.Key, out var n) ? n : kv.Key.ToString())}={kv.Value}"));
    }
}
