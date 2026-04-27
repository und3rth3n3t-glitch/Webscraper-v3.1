# SPEC-M6 — Bundled jobs, new window per job
**Version**: 1.0  
**Status**: Ready for implementation

---

## Context

Currently the expansion pipeline creates one `QueueTask` per (scrape block × loop value): a 3-term loop with 1 scrape block dispatches 3 jobs. Each job has `SearchTerms = []` and an `inlineConfig` with the loop value baked into `options.literalValue`.

This spec changes the model to:
- **C** — One job per scrape block. All loop values are bundled into `SearchTerms`. The extension already iterates `searchTerms` in a single tab — no extension loop change needed.
- **A1** — Each job runs in a new `focused: false` window instead of a tab.
- **A2** — Already the case: the extension reuses the same tab for all iterations. No change required.
- **Constraint** — Nested loops are rejected at the service layer with a clear error. Nested loop bundling is a future milestone.

No UI changes. No new permissions required (`chrome.windows` is available to all extension contexts without a manifest declaration).

---

## File 1: `backend/src/WebScrape.Services/Interfaces/IQueueExpansionService.cs`

Add `NestedLoopUnsupported` to the enum.

**Replace** the `ExpansionOutcome` enum (lines 5–12):

```csharp
public enum ExpansionOutcome
{
    Ok,
    NotFound,
    Forbidden,
    BatchEmpty,
    BatchTooLarge,
    NestedLoopUnsupported,
}
```

---

## File 2: `backend/src/WebScrape.Services/Interfaces/IRunBatchService.cs`

Add `NestedLoopUnsupported` to the enum.

**Replace** the `RunBatchOutcome` enum (lines 5–13):

```csharp
public enum RunBatchOutcome
{
    Created,
    NotFound,
    Forbidden,
    WorkerOffline,
    BatchEmpty,
    BatchTooLarge,
    NestedLoopUnsupported,
}
```

---

## File 3: `backend/src/WebScrape.Services/Expansion/IBlockExpander.cs`

Two changes: add `SearchTerms` to `ExpansionFrame`; add `SearchTerms` to `ExpansionResult`.

**Replace** lines 9 and 35–41 (the two records):

```csharp
public record ExpansionFrame(
    IReadOnlyDictionary<Guid, string> LoopAssignments,
    IReadOnlyList<string> SearchTerms);

// ...existing ExpansionContext and ExpansionWarning unchanged...

public record ExpansionResult(
    Guid ScrapeBlockId,
    Guid ScraperConfigId,
    string ConfigName,
    Dictionary<Guid, string> Assignments,
    string IterationLabel,
    System.Text.Json.JsonElement PatchedConfigJson,
    List<string> SearchTerms);
```

---

## File 4: `backend/src/WebScrape.Services/Expansion/LoopBlockExpander.cs`

**Full replacement** of `Expand` (lines 25–49):

```csharp
public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
{
    var values = ReadLoopValues(block);
    // Empty loop: one run with an empty search term, consistent with prior behaviour.
    var searchTerms = values.Count == 0 ? new List<string> { "" } : values;

    var children = ctx.AllBlocks
        .Where(b => b.ParentBlockId == block.Id)
        .OrderBy(b => b.OrderIndex)
        .ToList();

    // Bundle all terms into one frame. Children receive the full list; the
    // per-iteration cartesian walk is replaced by searchTerms on the wire.
    var childFrame = new ExpansionFrame(
        LoopAssignments: new Dictionary<Guid, string>(),
        SearchTerms: searchTerms);

    foreach (var child in children)
    {
        if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
        foreach (var result in expander.Expand(child, ctx, childFrame))
            yield return result;
    }
}
```

`ReadLoopValues` is unchanged.

---

## File 5: `backend/src/WebScrape.Services/Expansion/ScrapeBlockExpander.cs`

Three changes:
1. `loopRef` bindings are **no longer baked** into `literalValue` — the extension uses `searchTerms[i]` at runtime.
2. `ExpansionResult` now includes `SearchTerms` from the frame.
3. `Assignments` and `IterationLabel` are empty (no per-frame meaning in bundled mode).
4. `ResolveBinding` is deleted — replaced by inline logic below.

**Full replacement** of `Expand` (lines 12–69):

```csharp
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
                    // Not baked — extension resolves against searchTerms[i] at runtime.
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
```

**Delete** `ResolveBinding` (lines 100–118) and `BuildIterationLabel` (lines 120–124) — no longer called.

`ReadScrapeConfig` and `BindingPayload` are unchanged.

---

## File 6: `backend/src/WebScrape.Services/Implementations/QueueExpansionService.cs`

Two changes: nested loop guard; empty frame now supplies `SearchTerms`.

**After line 31** (after `var roots = ...`), insert the nested loop guard:

```csharp
// Bundled expansion does not support nested loops. Reject early with a clear error.
var loopIds = blocks.Where(b => b.BlockType == BlockType.Loop).Select(b => b.Id).ToHashSet();
var hasNestedLoop = blocks.Any(b => b.BlockType == BlockType.Loop && b.ParentBlockId.HasValue && loopIds.Contains(b.ParentBlockId.Value));
if (hasNestedLoop)
    return new ExpansionPreview(
        ExpansionOutcome.NestedLoopUnsupported, 0, new(), new(),
        "Nested loops are not yet supported. Place each scrape block in its own top-level loop.");
```

**Replace line 61** (the `emptyFrame` construction):

```csharp
var emptyFrame = new ExpansionFrame(new Dictionary<Guid, string>(), Array.Empty<string>());
```

---

## File 7: `backend/src/WebScrape.Services/Implementations/RunBatchService.cs`

Two changes: handle new outcome; populate `SearchTerms` on the DTO.

**Add case after line 53** (inside the `preview.Outcome` switch):

```csharp
case ExpansionOutcome.NestedLoopUnsupported: return new(RunBatchOutcome.NestedLoopUnsupported, null, 0, 0, preview.Error);
```

**Replace line 124** (`SearchTerms = new()`) with:

```csharp
SearchTerms = r.SearchTerms,
```

---

## File 8: `backend/src/WebScrape.Server/Controllers/RunsController.cs`

Add the new outcome to the switch. **Insert before line 80** (`RunBatchOutcome.BatchTooLarge`):

```csharp
RunBatchOutcome.NestedLoopUnsupported => UnprocessableEntity(new { code = "NESTED_LOOP_UNSUPPORTED", error = result.Error }),
```

---

## File 9: `backend/src/WebScrape.Server/Controllers/TasksController.cs`

Add the new outcome to the preview switch. **Insert after line 91** (`ExpansionOutcome.BatchTooLarge`):

```csharp
ExpansionOutcome.NestedLoopUnsupported => UnprocessableEntity(new { code = "NESTED_LOOP_UNSUPPORTED", error = preview.Error }),
```

---

## File 10: `src/entrypoints/background.ts`

### 10a — Type: add `windowId` to active task state

**Replace line 27**:

```typescript
let activeRemoteTask: (ActiveTaskContext & { tabId: number; windowId: number }) | null = null;
```

### 10b — Replace tab creation with window creation (lines 162–184)

**Replace** lines 162–184:

```typescript
const win = await browser.windows.create({ url: resolved.config.url, focused: false });
const tab = win?.tabs?.[0];
if (!tab?.id || !win?.id) {
  relayHubInvocation('SEND_TASK_ERROR', {
    taskId: task.id,
    configId: task.configId,
    error: "Couldn't open a window for the task",
    failedAt: new Date().toISOString(),
  });
  drainNextRemoteTask();
  return;
}

activeRemoteTask = {
  tabId: tab.id,
  windowId: win.id,
  taskId: resolved.taskId,
  configId: resolved.configId,
  configName: resolved.configName,
  searchTerms: resolved.searchTerms,
  dataMapping: resolved.config.dataMapping,
};
isStartingTask = false;
chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
lastFocusedTabId = tab.id;

await waitForTabComplete(tab.id);

browser.tabs.sendMessage(tab.id, {
  type: 'EXECUTE_FLOW',
  payload: {
    config: resolved.config,
    searchTerms: resolved.searchTerms,
    taskId: resolved.taskId,
  },
}).catch((err: Error) => {
  relayHubInvocation('SEND_TASK_ERROR', {
    taskId: resolved.taskId,
    configId: resolved.configId,
    error: `Couldn't dispatch task to page: ${err.message}`,
    failedAt: new Date().toISOString(),
  });
  activeRemoteTask = null;
  drainNextRemoteTask();
});
```

### 10c — Close window on drain (lines 207–217)

**Replace** `drainNextRemoteTask` (lines 207–217):

```typescript
function drainNextRemoteTask(): void {
  activePauseState = null;
  if (activeRemoteTask?.windowId) {
    browser.windows.remove(activeRemoteTask.windowId).catch(() => {});
  }
  activeRemoteTask = null;
  isStartingTask = false;
  chrome.storage.session.remove('activeRemoteTask').catch(() => {});
  const next = pendingRemoteTasks.shift();
  if (next) {
    isStartingTask = true;
    startRemoteTask(next).catch((err) => console.error('[SW] Failed to start queued task:', err));
  }
}
```

---

## File 11: `backend/tests/WebScrape.Tests/Services/QueueExpansionServiceTests.cs`

All tests that assert result count equals the number of loop values need rewriting. For each affected test:

- **Before**: `Assert.Equal(3, preview.Results.Count)` (3 loop values × 1 scrape = 3 tasks)
- **After**: `Assert.Equal(1, preview.Results.Count)` and `Assert.Equal(new[] { "a", "b", "c" }, preview.Results[0].SearchTerms)`

Specific changes to make:

1. Any test asserting `Results.Count == N` for N loop values on 1 scrape block: change to `Count == 1` and assert `SearchTerms` contains all N values.

2. Any test asserting `Results[i].Assignments` contains loop variable values: change to `Results[0].Assignments` is empty and `Results[0].SearchTerms` contains the values.

3. Any test asserting `PatchedConfigJson` contains `literalValue` for a `loopRef` binding: change to assert `literalValue` is **absent** for that step.

4. Any test asserting nested loops produce a cartesian product: change to assert `preview.Outcome == ExpansionOutcome.NestedLoopUnsupported`.

5. Add a new test: empty loop → `Results.Count == 1`, `SearchTerms == [""]`.

6. Add a new test: nested loop (loop inside loop) → `Outcome == NestedLoopUnsupported`.

7. Add a new test: `literal` binding → `literalValue` still baked into `PatchedConfigJson`; `loopRef` binding → `literalValue` absent from `PatchedConfigJson`.

---

## Verification

### Build and test

```bash
cd backend
dotnet build --nologo -c Release 2>&1 | tail -5
dotnet test tests/WebScrape.Tests --nologo 2>&1 | tail -20
```

### Manual test script

1. **Single loop, 3 terms, 1 scrape block**: Run → queue shows **1 job** in sidepanel. A new unfocused window opens. Extension runs 3 iterations in it. Window closes on completion. React app shows result with 3 iterations.

2. **Single loop, 3 terms, 2 sibling scrape blocks**: Run → **2 jobs** dispatched. Each job uses a new window sequentially. Both results land.

3. **Nested loop task**: Click "Run" on a task with `loop > loop > scrape`. Should receive HTTP 422 with `code: "NESTED_LOOP_UNSUPPORTED"`. React app shows an error (existing error banner).

4. **Literal binding**: Verify `PatchedConfigJson` still contains `literalValue` for steps with `kind: literal`. Verify loopRef steps have no `literalValue`.

5. **Window cleanup**: Cancel a running job (or let it error). Verify the window is closed automatically.

---

## What is deleted

| What | Where |
|---|---|
| `ResolveBinding` method | `ScrapeBlockExpander.cs` lines 100–118 |
| `BuildIterationLabel` method | `ScrapeBlockExpander.cs` lines 120–124 |
| Per-value cartesian loop | `LoopBlockExpander.cs` lines 35–48 |
