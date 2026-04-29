# SPEC-multi-column-loop-v1.0

## Context

Currently a loop block accepts a flat list of strings (one per iteration). For patient-data workflows the backend must type multiple distinct values into separate input elements within a single iteration (last name → field A, first name → field B, DOB → field C). The workaround of sending each field as a separate search term produces three separate scrape iterations instead of one.

Two use-paths are required:

**Path 1 — Extension manual run**: User defines named input slots on a config (one per setInput step). SearchVarInput renders a table grid (one column per slot, one row per patient). On run, each row's values are routed to the matching setInput step.

**Path 2 — Backend batch**: User defines column labels on a loop block in the Task Editor. Scrape step bindings target individual columns. The expansion pipeline bakes each column's value as `literalValue` in the patched config JSON before dispatching to the extension — the extension reads it as a static literal (no extension runtime change required for this path).

---

## Stages A–E (summary)

### A — Scope
- Build both halves independently; they share the wire format (`inputRows: Record<string, string>[]`) but are otherwise decoupled.
- `bestMatch` / `navigateTo` in multi-column mode: deferred (v1 limitation — these steps use `searchTerms[i]` which will be null/empty in inputRows mode, causing SkipIterationError on the backend batch path if bound as loopRef without column; the column-binding bakes a literalValue so they are unaffected on the batch path; on the manual run path they will just get an empty term if present, which is acceptable for v1).
- No CSV import, no nested multi-column loops, no cross-validation that extension inputSlots matches backend columns.

### B — Architecture
- Extension: `inputSlots` lives on `ScraperConfig` (persisted to config storage). `configStore` mirrors it as top-level state. `runStore.executeRun` gains `inputRows` param. All components read from stores.
- Backend expansion: `ExpansionFrame.LoopAssignments` key changes from `Guid` to `string` (currently always empty — safe). LoopBlockExpander adds per-row path. ScrapeBlockExpander reads `column` from binding JSON, looks up `"{loopBlockId}:{column}"` in LoopAssignments, bakes literalValue.

### C — UI checklist
- `LoopConfig.tsx`: new "Input Fields" section using existing `.list-card`, `.loop-section`, `.loop-section-header`, `.loop-section-title` classes. `Plus` and `X` from lucide-react. Slot row uses `step-toggle-row` class + `form-input` for label editing. No new CSS classes.
- `SetInputForm.tsx`: new `form-group` with `form-label` + `form-select`. Uses existing classes. Copy: "Which value to type here" hint.
- `SearchVarInput.tsx` table mode: inline table styles for compact grid. Existing `form-label`, `form-hint`, `btn btn-secondary btn-sm`, `form-input`, `btn btn-primary btn-full btn-lg`. Copy: "Enter one row per patient. Each column maps to a different field."
- `LoopBlockInspector.tsx`: multi-column table uses inline styles for grid layout. Existing `form-group`, `form-input`, `form-label`, `btn btn-ghost btn-sm`, `form-hint` classes. Copy: "One column per field. Each row is one patient."
- `BindingsEditor.tsx`: column select uses `form-select` inline with existing per-step row.
- No new CSS classes introduced in any file.

### D — Security
- `inputRows` values flow from extension UI → content script EXECUTE_FLOW → executeSetInput. They are user-typed strings used as text input values. Same trust level as existing `searchTerms`. No new attack surface.
- `columns`/`rows` from the backend are free-form JSONB; no SQL injection risk (values are typed into DOM elements, not interpolated into SQL). Column names are validated in TaskValidator before expansion.
- No new permissions required.

### E — Verification
- `dotnet test tests/WebScrape.Tests` — must pass after backend changes.
- `vitest run` in `blueberry-v3` — must pass after extension changes.
- Manual tests documented at end of spec.

---

## Stage F — Implementation

### File change order (Sonnet: implement in this order to keep TS compilation clean)

1. `src/types/config.ts` — add `InputSlot`, `inputKey`, `inputSlots`
2. `src/types/signalr.ts` — add `inputRows` to `QueueTask`
3. `src/types/messages.ts` — add `inputRows` to `EXECUTE_FLOW` payload
4. `src/background/remoteTaskHandler.ts` — add `inputRows` to `ResolvedTask`
5. `src/entrypoints/background.ts` — thread `inputRows` in initial EXECUTE_FLOW send
6. `src/content/scraping/scrapingEngine.ts` — inputRows in loop + executeSetInput + REGISTER_CONTINUATION
7. `src/sidepanel/stores/configStore.ts` — add `inputSlots` state
8. `src/sidepanel/stores/runStore.ts` — add `inputRows` param + thread inputSlots in config
9. `src/sidepanel/utils/queueDispatcher.ts` — pass `inputRows` from task
10. `src/sidepanel/components/LoopConfig.tsx` — Input Fields section
11. `src/sidepanel/components/SetInputForm.tsx` — inputKey dropdown
12. `src/sidepanel/components/SearchVarInput.tsx` — table grid mode
13. `backend/src/WebScrape.Client/src/api/types.ts` — extend `LoopBlockConfigDto` + `StepBindingDto`
14. `backend/src/WebScrape.Client/src/utils/taskTree.ts` — extend `LoopEditorBlock` + `LoopAncestor` + all mutators
15. `backend/src/WebScrape.Client/src/utils/taskEditor.ts` — extend `autoBindSteps`
16. `backend/src/WebScrape.Client/src/components/taskEditor/ScrapeBlockInspector.tsx` — pass columns to autoBindSteps
17. `backend/src/WebScrape.Client/src/components/BindingsEditor.tsx` — column selector
18. `backend/src/WebScrape.Client/src/components/taskEditor/LoopBlockInspector.tsx` — column management UI
19. `backend/src/WebScrape.Data/Dto/TaskBlockDto.cs` — add `Columns`, `Rows`, `Column`
20. `backend/src/WebScrape.Services/Interfaces/ITaskValidator.cs` — add `LoopColumnNotFound`
21. `backend/src/WebScrape.Services/Implementations/TaskValidator.cs` — validate column refs
22. `backend/src/WebScrape.Services/Expansion/IBlockExpander.cs` — change `LoopAssignments` key type
23. `backend/src/WebScrape.Services/Implementations/QueueExpansionService.cs` — fix dictionary literal
24. `backend/src/WebScrape.Services/Expansion/LoopBlockExpander.cs` — per-row expansion
25. `backend/src/WebScrape.Services/Expansion/ScrapeBlockExpander.cs` — column binding → literalValue

---

### 1. `src/types/config.ts`

**After line 19** (after `SelectorDescriptor` closing brace, before `// ── Step conditions`), **insert**:

```typescript
export interface InputSlot {
  id: string;
  key: string;
  label: string;
}
```

**In `SetInputOptions`** (currently lines 40–49), **add `inputKey` after `literalValue`**:

```typescript
export interface SetInputOptions {
  clearBefore: boolean;
  pressEnterAfter: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  isInitialInput: boolean;
  alternateSelector: SelectorDescriptor | null;
  // Server-set at populate time; takes precedence over searchTerm at runtime.
  literalValue?: string;
  // Extension manual multi-column: which input slot's value to type (undefined = use searchTerm).
  inputKey?: string;
}
```

**In `ScraperConfig`** (currently lines 200–216), **add `inputSlots` after `autoDetect`**:

```typescript
export interface ScraperConfig {
  id: string;
  name: string;
  description?: string;
  domain: string;
  domainLocked: boolean;
  url: string;
  steps: Step[];
  dataMapping?: DataMapping;
  autoDetect?: AutoDetectConfig;
  inputSlots?: InputSlot[];
  schemaVersion: 3 | 4 | 5;
  createdAt: number;
  updatedAt: number;
  shared?: boolean;
  lastSyncedAt?: string | null;
  dirty?: boolean;
}
```

---

### 2. `src/types/signalr.ts`

**In `QueueTask`** (currently lines 12–28), **add `inputRows` after `iterationAssignments`**:

```typescript
export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  inputRows?: Record<string, string>[];
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction';
  pause?: TaskPauseInfo;
  progress?: { stepLabel: string; termIndex?: number };
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}
```

---

### 3. `src/types/messages.ts`

**Line 30**, change the `EXECUTE_FLOW` variant from:
```typescript
  | { type: 'EXECUTE_FLOW';           payload: { config: import('./config').ScraperConfig; searchTerms: string[]; taskId?: string } }
```
to:
```typescript
  | { type: 'EXECUTE_FLOW';           payload: { config: import('./config').ScraperConfig; searchTerms: string[]; inputRows?: Record<string, string>[]; taskId?: string } }
```

---

### 4. `src/background/remoteTaskHandler.ts`

**Replace the entire file** with:

```typescript
import type { QueueTask } from '../types/signalr';
import type { ScraperConfig } from '../types/config';

export class ConfigNotFoundError extends Error {
  constructor(public readonly configId: string) {
    super(`Config "${configId}" not found locally and no inline config provided`);
    this.name = 'ConfigNotFoundError';
  }
}

export interface ResolvedTask {
  config: ScraperConfig;
  searchTerms: string[];
  inputRows?: Record<string, string>[];
  taskId: string;
  configId: string;
  configName: string;
}

export function resolveQueueTask(
  task: QueueTask,
  localConfigs: ScraperConfig[],
): ResolvedTask {
  const config = task.inlineConfig ?? localConfigs.find((c) => c.id === task.configId);
  if (!config) throw new ConfigNotFoundError(task.configId);
  return {
    config,
    searchTerms: task.searchTerms,
    inputRows: task.inputRows,
    taskId: task.id,
    configId: task.configId,
    configName: task.configName,
  };
}
```

---

### 5. `src/entrypoints/background.ts`

**At the initial EXECUTE_FLOW send** (currently around line 332–339), **add `inputRows`** to the payload:

```typescript
    browser.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_FLOW',
      payload: {
        config: resolved.config,
        searchTerms: resolved.searchTerms,
        inputRows: resolved.inputRows,
        taskId: resolved.taskId,
        drainResumed: false,
      },
    }).catch((err: Error) => {
```

No other changes needed in background.ts — the continuation re-delivery spreads the stored REGISTER_CONTINUATION payload, and `inputRows` will be added to that payload in step 6.

---

### 6. `src/content/scraping/scrapingEngine.ts`

**6a. `ExecuteFlowParams`** (currently lines 161–175) — **add `inputRows`**:

```typescript
export interface ExecuteFlowParams {
  config: ScraperConfig;
  searchTerms: string[];
  inputRows?: Record<string, string>[];
  taskId?: string;
  afk?: boolean;
  startTermIndex?: number;
  startLoopStepIndex?: number;
  previousIterations?: WireIteration[];
  drainResumed?: boolean;
  paginationContinuation?: PaginationContinuation;
}
```

**6b. `executeFlow` destructuring** (currently lines 177–188) — **add `inputRows = undefined`**:

```typescript
export async function executeFlow(params: ExecuteFlowParams): Promise<ScrapingResult> {
  const {
    config,
    searchTerms,
    inputRows = undefined,
    taskId,
    afk = false,
    startTermIndex = 0,
    startLoopStepIndex = 0,
    previousIterations = [],
    drainResumed: paramDrainResumed = false,
    paginationContinuation,
  } = params;
```

**6c. Loop setup** (currently line 282–285):

Replace:
```typescript
    const terms = searchTerms.length > 0 ? searchTerms : [null];
    const usedIterKeys = new Set<string>(previousIterations.map((it) => it.iterationKey));

    for (let i = startTermIndex; i < terms.length; i++) {
      const term = terms[i];
```

With:
```typescript
    const useInputRows = !!(inputRows?.length);
    const iterCount = useInputRows ? inputRows!.length : (searchTerms.length > 0 ? searchTerms.length : 1);
    const usedIterKeys = new Set<string>(previousIterations.map((it) => it.iterationKey));

    for (let i = startTermIndex; i < iterCount; i++) {
      const term = useInputRows ? null : (searchTerms[i] ?? null);
      const fields = useInputRows ? inputRows![i] : null;
```

**6d. REGISTER_CONTINUATION payload** (currently lines 414–426) — **add `inputRows`**:

```typescript
          if (isNavigating) {
            try {
              browser.runtime.sendMessage({
                type: 'REGISTER_CONTINUATION',
                payload: {
                  config,
                  searchTerms,
                  inputRows,
                  taskId,
                  startTermIndex: i,
                  startLoopStepIndex: si + 1,
                  previousIterations: result.iterations,
                },
              });
            } catch { /* extension context may be invalidated */ }
          }
```

**6e. `executeStep` call site** (currently line 446) — **add `fields` argument after `term`**:

```typescript
                stepData = await executeStep(
                  step,
                  term,
                  fields,
                  i,
                  (msg) => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId }),
                  afk,
                  taskId,
                  scrapeCtx,
                );
```

**6f. Aborted iteration push** (currently around lines 527–536) — **replace `term` with `iterLabel`**:

The aborted case currently has:
```typescript
        if (e.message === 'ABORTED') {
          result.iterations.push({
            schemaVersion: 1,
            iterationKey: disambiguate(slugify(term ?? '') || 'default', usedIterKeys),
            iterationLabel: term ?? '',
            searchTerm: term,
            ...
          });
```

Replace `term ?? ''` (for iterationLabel and iterationKey) with:
```typescript
        if (e.message === 'ABORTED') {
          const abortIterLabel = useInputRows ? (Object.values(inputRows![i])[0] ?? '') : (term ?? '');
          result.iterations.push({
            schemaVersion: 1,
            iterationKey: disambiguate(slugify(abortIterLabel) || 'default', usedIterKeys),
            iterationLabel: abortIterLabel,
            searchTerm: term,
            outputs: iterOutputs,
            status: 'error',
            error: 'Aborted by user',
          });
          swLog('[executeFlow] iter ABORTED — breaking outer loop | taskId:', taskId, '| termIndex:', i);
          break;
        }
```

**6g. Normal iteration push** (currently lines 551–561) — **use `iterLabel` instead of bare `term`**:

Replace:
```typescript
      const iterKey = disambiguate(slugify(term ?? '') || 'default', usedIterKeys);
      usedIterKeys.add(iterKey);
      result.iterations.push({
        schemaVersion: 1,
        iterationKey: iterKey,
        iterationLabel: term ?? '',
        searchTerm: term,
        outputs: iterOutputs,
        status: iterStatus,
        error: iterError,
      });
```

With:
```typescript
      const iterLabel = useInputRows ? (Object.values(inputRows![i])[0] ?? '') : (term ?? '');
      const iterKey = disambiguate(slugify(iterLabel) || 'default', usedIterKeys);
      usedIterKeys.add(iterKey);
      result.iterations.push({
        schemaVersion: 1,
        iterationKey: iterKey,
        iterationLabel: iterLabel,
        searchTerm: term,
        outputs: iterOutputs,
        status: iterStatus,
        error: iterError,
      });
```

**6h. Inter-iteration boundary check** (currently line 563) — change `terms.length - 1` to `iterCount - 1`:

```typescript
      if (i < iterCount - 1) {
```

**6i. `executeStep` signature** (currently lines 812–820) — **add `fields` param**:

```typescript
async function executeStep(
  step: Step,
  searchTerm: string | null,
  fields: Record<string, string> | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
  taskId?: string,
  ctx?: ScrapeContext,
): Promise<Record<string, unknown> | null> {
```

**6j. `executeStep` switch** (currently line 831) — **pass `fields` to `executeSetInput`**:

```typescript
    case 'setInput':
      return executeSetInput(step, searchTerm, fields, iterationIndex, onProgress, afk);
```

**6k. `executeSetInput` signature and value resolution** (currently lines 854–893):

Replace the entire function:

```typescript
async function executeSetInput(
  step: import('../../types/config').SetInputStep,
  searchTerm: string | null,
  fields: Record<string, string> | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;
  swLog('[setInput] iterationIndex:', iterationIndex, '| literalValue:', opts.literalValue, '| inputKey:', opts.inputKey, '| searchTerm:', searchTerm, '| fields:', fields);

  const el = await resolveWithRetry(
    step.selector!,
    opts.alternateSelector ?? null,
    onProgress,
    step.label || 'input',
  );

  // Precedence: server-set literalValue > inputKey lookup in fields > per-iteration searchTerm > empty string.
  const valueToType =
    opts.literalValue ??
    (opts.inputKey && fields ? (fields[opts.inputKey] ?? '') : null) ??
    searchTerm ??
    '';

  onProgress?.(`Typing "${valueToType}" into ${step.label || 'input field'}`);

  if (opts.clearBefore !== false) {
    await clearInput(el);
  }

  await typeText(el, valueToType);

  if (opts.pressEnterAfter) {
    await randomDelay(100, 300);
    await pressEnter(el);
    await waitAfterAction(opts, onProgress);
  } else {
    await randomDelay(600, 1200);
  }

  void iterationIndex;
  void afk;
  return null;
}
```

---

### 7. `src/sidepanel/stores/configStore.ts`

**7a. Add `InputSlot` to the import** at line 5:

```typescript
import type {
  ScraperConfig,
  Step,
  StepType,
  DataMapping,
  AutoDetectConfig,
  InputSlot,
  SetInputOptions,
  ...
} from '../../types/config';
```

**7b. `ConfigState` interface** (currently lines 81–115) — **add `inputSlots` and `setInputSlots`**:

After `autoDetect: AutoDetectConfig | undefined;` add:
```typescript
  inputSlots: InputSlot[];
```

After `setAutoDetect: (cfg: AutoDetectConfig | undefined) => void;` add:
```typescript
  setInputSlots: (slots: InputSlot[]) => void;
```

**7c. Initial state** (currently lines 117–130) — **add `inputSlots: []`** after `autoDetect: undefined`:

```typescript
  autoDetect: undefined,
  inputSlots: [],
```

**7d. `saveCurrentConfig`** (currently lines 206–243) — **include `inputSlots` in the config object**:

The `config` object inside `saveCurrentConfig` should destructure `inputSlots` from `get()` and include it:

```typescript
  saveCurrentConfig: async () => {
    const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked, autoDetect, inputSlots } = get();
    const config: ScraperConfig = {
      id: currentConfig?.id || generateId(),
      name: configName || 'Untitled Config',
      domain: domainLocked ? pageDomain : '',
      domainLocked,
      url: pageUrl,
      steps,
      dataMapping: currentConfig?.dataMapping,
      autoDetect,
      inputSlots: inputSlots.length > 0 ? inputSlots : undefined,
      schemaVersion: (autoDetect ? 5 : CURRENT_SCHEMA_VERSION) as 4 | 5,
      createdAt: currentConfig?.createdAt || Date.now(),
      updatedAt: Date.now(),
      shared: currentConfig?.shared ?? false,
      lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
    };
    // ... rest unchanged
```

**7e. `loadConfig`** (currently lines 245–259) — **add `inputSlots` to set call**:

```typescript
  loadConfig: (config) => {
    const safe = migrateConfig(config as Record<string, unknown>) || config as ScraperConfig;
    set({
      currentConfig: safe,
      steps: safe.steps || [],
      configName: safe.name,
      domainLocked: safe.domainLocked ?? !!(safe.domain),
      autoDetect: safe.autoDetect,
      inputSlots: safe.inputSlots ?? [],
      isDirty: false,
      view: 'STEP_LIST',
      viewStack: [],
      draftStep: null,
      cameFromSaved: true,
    });
  },
```

**7f. `newConfig`** (currently lines 261–274) — **add `inputSlots: []`**:

```typescript
  newConfig: () => {
    set({
      currentConfig: null,
      steps: [],
      configName: '',
      domainLocked: false,
      autoDetect: undefined,
      inputSlots: [],
      isDirty: false,
      view: 'NO_CONFIG',
      viewStack: [],
      draftStep: null,
      cameFromSaved: false,
    });
  },
```

**7g. Add action** at the bottom of the store (after `setAutoDetect`):

```typescript
  setInputSlots: (slots) => set({ inputSlots: slots, isDirty: true }),
```

---

### 8. `src/sidepanel/stores/runStore.ts`

**8a. `RunState` interface** (lines 16–37) — **add `inputRows`** and update signatures:

```typescript
interface RunState {
  isRunning: boolean;
  taskId: string | null;
  searchTerms: (string | null)[];
  inputRows: Record<string, string>[] | null;
  progress: ProgressEntry[];
  logEntries: LogEntry[];
  results: ScrapingResult | null;
  error: string | null;
  runContext: 'config' | 'saved';

  startRun: (terms: (string | null)[], rowCount?: number) => void;
  stopRun: () => void;
  setTaskId: (id: string | null) => void;
  updateProgress: (termIndex: number, updates: Partial<ProgressEntry>) => void;
  appendLog: (message: string) => void;
  setResults: (results: ScrapingResult) => void;
  setError: (error: string) => void;
  launchRun: (context?: 'config' | 'saved') => Promise<void>;
  executeRun: (terms: (string | null)[], inputRows?: Record<string, string>[], taskId?: string) => Promise<void>;
  navigateRun: (view: string) => Promise<void>;
  goBackFromRun: () => Promise<void>;
}
```

**8b. Initial state** — add `inputRows: null`:

```typescript
export const useRunStore = create<RunState>((set, get) => ({
  isRunning: false,
  taskId: null,
  searchTerms: [],
  inputRows: null,
  progress: [],
  ...
```

**8c. `startRun`** (currently lines 49–59) — **add `rowCount` param**:

```typescript
  startRun: (terms, rowCount) => {
    const effectiveTerms = terms.length > 0 ? terms : [null];
    const progressCount = Math.max(rowCount ?? 0, effectiveTerms.length);
    set({
      isRunning: true,
      searchTerms: effectiveTerms,
      progress: Array.from({ length: progressCount }, () => ({ status: 'pending', message: null, stepLabel: null })),
      logEntries: [],
      results: null,
      error: null,
    });
  },
```

**8d. `executeRun`** (currently lines 123–144) — **add `inputRows` param, thread through**:

```typescript
  executeRun: async (terms, inputRows, taskId) => {
    const { useConfigStore } = await import('./configStore');
    const { useUiStore } = await import('./uiStore');
    const { currentConfig, configName, steps, inputSlots } = useConfigStore.getState();
    const { showToast } = useUiStore.getState();

    get().startRun(terms, inputRows?.length);
    set({ taskId: taskId ?? null, inputRows: inputRows ?? null });
    await get().navigateRun('RUNNING');

    const config = {
      id: currentConfig?.id || 'draft',
      name: configName || 'Untitled',
      steps,
      inputSlots: inputSlots.length > 0 ? inputSlots : undefined,
    };

    try {
      await sendToContent('EXECUTE_FLOW', { config, searchTerms: terms, inputRows, taskId });
    } catch (err) {
      showToast(`Failed to start: ${(err as Error).message}`, 'error');
    }
  },
```

Note: `SearchVarInput` calls `executeRun(terms)` (single-column) or `executeRun([], rows)` (multi-column). The existing `launchRun` calls `executeRun([])` for no-search-term configs. All compatible.

---

### 9. `src/sidepanel/utils/queueDispatcher.ts`

**In the `TASK_RECEIVED` raw listener** (currently lines 14–19) — **pass `inputRows`** when resuming or setting the current task. The `addTask`/`setCurrentTask` API doesn't need inputRows (those are stored on the QueueTask object itself). However, when dispatching the task to run, we need to ensure inputRows flows through.

The actual dispatch happens in background.ts (step 5), not here. The queueDispatcher only manages the queue store UI state. No change needed here beyond what background.ts already does.

**Wait** — re-check: for `TASK_RESUMED`, the background.ts calls `startRemoteTask(taskId)` which calls `resolveQueueTask(task, ...)`. The `resolveQueueTask` now returns `inputRows` (step 4), and background.ts now sends it in EXECUTE_FLOW (step 5). So queueDispatcher needs no changes. The comment in the existing code already says resume is done via PauseAlert → queueStore.resumeTask directly.

No changes to `queueDispatcher.ts`.

---

### 10. `src/sidepanel/components/LoopConfig.tsx`

**Replace entire file**:

```tsx
import { useState } from 'react';
import { Type, MousePointerClick, Database, Repeat2, ArrowRight, Plus, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import BackButton from './BackButton';
import Tooltip from './Tooltip';
import { useConfigStore } from '../stores/configStore';
import type { Step, InputSlot } from '../../types/config';
import { generateId } from '../utils/uuid';

const STEP_ICONS: Record<string, LucideIcon> = {
  setInput:   Type,
  click:      MousePointerClick,
  scrape:     Database,
  selectEach: Repeat2,
};

function labelToKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export default function LoopConfig() {
  const { steps, updateStep, goBack, inputSlots, setInputSlots } = useConfigStore();

  const setupSteps = steps.filter(s => s.isSetup);
  const loopSteps = steps.filter(s => !s.isSetup);
  const hasSetInputLoop = loopSteps.some(s => s.type === 'setInput');

  const addSlot = () => {
    const label = `Field ${inputSlots.length + 1}`;
    const newSlot: InputSlot = { id: generateId(), key: labelToKey(label) || `field-${inputSlots.length + 1}`, label };
    setInputSlots([...inputSlots, newSlot]);
  };

  const removeSlot = (id: string) => {
    setInputSlots(inputSlots.filter(s => s.id !== id));
  };

  const updateSlotLabel = (id: string, label: string) => {
    setInputSlots(inputSlots.map(s =>
      s.id === id ? { ...s, label, key: labelToKey(label) || s.key } : s,
    ));
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Configure Loop</h2>
      </div>

      <p className="view-subtitle">
        Choose which steps run once (setup) vs. for each search term (loop).
      </p>

      <section className="list-card loop-section">
        <div className="loop-section-header">
          <h3 className="loop-section-title">Setup Steps</h3>
          <Tooltip text="Setup steps run once at the start. Use these for things like accepting cookie banners or navigating to a search page." />
        </div>
        <p className="loop-section-hint">Run once at the beginning</p>

        {setupSteps.length === 0 && (
          <p className="empty-hint">No setup steps. Toggle steps below to mark them as setup.</p>
        )}

        {setupSteps.map(step => (
          <StepToggleRow
            key={step.id}
            step={step}
            onToggle={() => updateStep(step.id, { isSetup: false })}
          />
        ))}
      </section>

      <section className="list-card loop-section">
        <div className="loop-section-header">
          <h3 className="loop-section-title">Loop Steps</h3>
          <Tooltip text="Loop steps repeat for each search term you provide." />
        </div>
        <p className="loop-section-hint">Run for each search term</p>

        {loopSteps.length === 0 && (
          <p className="empty-hint">All steps are in Setup. Move at least one step here for the scraper to loop.</p>
        )}

        {loopSteps.map(step => (
          <StepToggleRow
            key={step.id}
            step={step}
            isLoop
            onToggle={() => updateStep(step.id, { isSetup: true })}
          />
        ))}
      </section>

      {hasSetInputLoop && (
        <section className="list-card loop-section">
          <div className="loop-section-header">
            <h3 className="loop-section-title">Input Fields</h3>
            <Tooltip text="Define named columns when each loop iteration fills multiple fields. Each column maps to one Type Text step." />
          </div>
          <p className="loop-section-hint">One column per field — used when running with a table of rows</p>

          {inputSlots.map(slot => (
            <div key={slot.id} className="step-toggle-row">
              <span className="step-toggle-icon"><Type size={14} /></span>
              <input
                className="form-input"
                style={{ flex: 1, marginRight: 'var(--spacing-sm)' }}
                value={slot.label}
                onChange={e => updateSlotLabel(slot.id, e.target.value)}
                placeholder="Field label"
              />
              <span className="form-hint" style={{ marginRight: 'var(--spacing-sm)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                key: {slot.key || '—'}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => removeSlot(slot.id)}
                title="Remove field"
              >
                <X size={12} />
              </button>
            </div>
          ))}

          {inputSlots.length === 0 && (
            <p className="empty-hint">No input fields. Add one below to enable multi-column input.</p>
          )}

          <button className="btn btn-secondary btn-sm" style={{ marginTop: 'var(--spacing-sm)' }} onClick={addSlot}>
            <Plus size={12} /> Add field
          </button>
        </section>
      )}

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={goBack}>
          Done
        </button>
      </div>
    </div>
  );
}

interface StepToggleRowProps {
  step: Step;
  onToggle: () => void;
  isLoop?: boolean;
}

function StepToggleRow({ step, onToggle, isLoop }: StepToggleRowProps) {
  const Icon = STEP_ICONS[step.type] || Database;
  return (
    <div className="step-toggle-row">
      <span className="step-toggle-icon"><Icon size={14} /></span>
      <span className="step-toggle-label">{step.label || step.type}</span>
      <button
        className="btn btn-ghost btn-sm"
        onClick={onToggle}
        title={isLoop ? 'Move to Setup' : 'Move to Loop'}
      >
        <ArrowRight size={12} />
        {isLoop ? 'Setup' : 'Loop'}
      </button>
    </div>
  );
}
```

---

### 11. `src/sidepanel/components/SetInputForm.tsx`

**Add import** for `useConfigStore` at top (after existing imports):

```tsx
import { useConfigStore } from '../stores/configStore';
```

**In the component body**, after the `const step = ...` line and before the `if (!step) return null;` line, **add**:

```tsx
  const { inputSlots } = useConfigStore();
```

**After the label `form-group`** (currently lines 56–64), **insert a new `form-group`** for the input field selector (only when inputSlots are defined):

```tsx
      {inputSlots.length > 0 && (
        <div className="form-group">
          <label className="form-label">Input field</label>
          <select
            className="form-select"
            value={opts.inputKey ?? ''}
            onChange={e => updateOpt('inputKey', e.target.value || undefined)}
          >
            <option value="">Use search term (default)</option>
            {inputSlots.map(slot => (
              <option key={slot.id} value={slot.key}>{slot.label}</option>
            ))}
          </select>
          <p className="form-hint">Which column's value to type here.</p>
        </div>
      )}
```

Insert this block **between** the label group and the input-element picker group.

---

### 12. `src/sidepanel/components/SearchVarInput.tsx`

**Replace entire file**:

```tsx
import { useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import BackButton from './BackButton';
import { useRunStore } from '../stores/runStore';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { generateId } from '../utils/uuid';

type Row = { _id: string; [key: string]: string };

export default function SearchVarInput() {
  const { showToast } = useUiStore();
  const { inputSlots } = useConfigStore();
  const [termsText, setTermsText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [starting, setStarting] = useState(false);

  const isMultiColumn = inputSlots.length > 0;
  const terms = termsText.split('\n').map(t => t.trim()).filter(Boolean);

  const addRow = () => {
    const empty: Row = { _id: generateId() };
    for (const slot of inputSlots) empty[slot.key] = '';
    setRows(r => [...r, empty]);
  };

  const removeRow = (id: string) => setRows(r => r.filter(row => row._id !== id));

  const updateCell = (id: string, key: string, value: string) => {
    setRows(r => r.map(row => row._id === id ? { ...row, [key]: value } : row));
  };

  const handleStart = async () => {
    if (isMultiColumn) {
      if (rows.length === 0) {
        showToast('Add at least one row.', 'error');
        return;
      }
      setStarting(true);
      try {
        const inputRows = rows.map(({ _id, ...rest }) => rest as Record<string, string>);
        await useRunStore.getState().executeRun([], inputRows);
      } catch {
        setStarting(false);
      }
    } else {
      if (terms.length === 0) {
        showToast('Enter at least one search term.', 'error');
        return;
      }
      setStarting(true);
      try {
        await useRunStore.getState().executeRun(terms);
      } catch {
        setStarting(false);
      }
    }
  };

  if (isMultiColumn) {
    return (
      <div className="view">
        <div className="view-header">
          <BackButton />
          <h2 className="view-title">Patient Data</h2>
        </div>

        <p className="view-subtitle">
          Enter one row per patient. Each column is typed into a different field.
        </p>

        <div className="form-group" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {inputSlots.map(slot => (
                  <th key={slot.id} style={{ textAlign: 'left', padding: '4px 6px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', fontWeight: 600, borderBottom: '1px solid var(--border-color)' }}>
                    {slot.label}
                  </th>
                ))}
                <th style={{ width: 32, borderBottom: '1px solid var(--border-color)' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._id}>
                  {inputSlots.map(slot => (
                    <td key={slot.id} style={{ padding: '3px 4px' }}>
                      <input
                        className="form-input"
                        style={{ fontSize: 'var(--font-size-sm)' }}
                        value={row[slot.key] ?? ''}
                        onChange={e => updateCell(row._id, slot.key, e.target.value)}
                        placeholder={slot.label}
                      />
                    </td>
                  ))}
                  <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeRow(row._id)} title="Remove row">
                      <X size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <p className="form-hint" style={{ marginTop: 'var(--spacing-sm)' }}>No rows yet. Add one below.</p>
          )}

          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addRow}
          >
            <Plus size={12} /> Add row
          </button>

          {rows.length > 0 && (
            <p className="form-hint">{rows.length} row{rows.length !== 1 ? 's' : ''} entered</p>
          )}
        </div>

        <div className="form-actions">
          <button
            className="btn btn-primary btn-full btn-lg"
            onClick={handleStart}
            disabled={starting || rows.length === 0}
          >
            {starting
              ? 'Starting...'
              : <><Play size={12} /> Run Scraper ({rows.length} row{rows.length !== 1 ? 's' : ''})</>
            }
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Search Terms</h2>
      </div>

      <p className="view-subtitle">
        Enter one search term per line. The scraper will run once for each term.
      </p>

      <div className="form-group">
        <label className="form-label">Search terms</label>
        <textarea
          className="form-textarea"
          value={termsText}
          onChange={e => setTermsText(e.target.value)}
          placeholder={"Blueberry Consultants\nAcme Corp\nTechStart Ltd"}
          rows={8}
          autoFocus
        />
        {terms.length > 0 && (
          <p className="form-hint">{terms.length} term{terms.length !== 1 ? 's' : ''} entered</p>
        )}
      </div>

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full btn-lg"
          onClick={handleStart}
          disabled={starting || terms.length === 0}
        >
          {starting
            ? 'Starting...'
            : <><Play size={12} /> Run Scraper ({terms.length} term{terms.length !== 1 ? 's' : ''})</>
          }
        </button>
      </div>
    </div>
  );
}
```

---

### 13. `backend/src/WebScrape.Client/src/api/types.ts`

**Replace `LoopBlockConfigDto`** (currently lines 84–87):

```typescript
export type LoopBlockConfigDto = {
  name: string;
  values: string[];
  columns?: string[];
  rows?: string[][];
};
```

**Replace `StepBindingDto`** (currently lines 89–92):

```typescript
export type StepBindingDto =
  | { kind: 'literal'; value: string }
  | { kind: 'loopRef'; loopBlockId: string; column?: string }
  | { kind: 'unbound' };
```

---

### 14. `backend/src/WebScrape.Client/src/utils/taskTree.ts`

**14a. `LoopEditorBlock`** (currently lines 6–13) — **add `columns` and `rows`**:

```typescript
export type LoopEditorBlock = {
  id: string;
  parentBlockId: string | null;
  blockType: 'loop';
  orderIndex: number;
  name: string;
  values: string[];
  columns: string[];
  rows: string[][];
};
```

**14b. `LoopAncestor`** (currently line 26) — **add `columns`**:

```typescript
export type LoopAncestor = { id: string; name: string; columns: string[] };
```

**14c. `BlocksAction UPDATE_LOOP`** (currently line 39) — **add `columns` and `rows` to patch**:

```typescript
  | { type: 'UPDATE_LOOP'; id: string; patch: Partial<Pick<LoopEditorBlock, 'name' | 'values' | 'columns' | 'rows'>> }
```

**14d. `loopAncestorsOf`** (currently lines 76–89) — **include `columns` in result**:

```typescript
export function loopAncestorsOf(blocks: EditorBlock[], blockId: string): LoopAncestor[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const result: LoopAncestor[] = [];
  let current = byId.get(blockId);
  while (current?.parentBlockId) {
    const parent = byId.get(current.parentBlockId);
    if (!parent) break;
    if (parent.blockType === 'loop') {
      result.push({ id: parent.id, name: parent.name, columns: parent.columns });
    }
    current = parent;
  }
  return result;
}
```

**14e. `addLoopChild`** (currently lines 108–123) — **init `columns: [], rows: []`**:

```typescript
  const newBlock: LoopEditorBlock = {
    id: newId,
    parentBlockId: parentId,
    blockType: 'loop',
    orderIndex: siblings.length,
    name: `loop${loopCount + 1}`,
    values: [],
    columns: [],
    rows: [],
  };
```

**14f. `updateLoop`** (currently lines 183–191) — **extend patch type**:

```typescript
export function updateLoop(
  blocks: EditorBlock[],
  id: string,
  patch: Partial<Pick<LoopEditorBlock, 'name' | 'values' | 'columns' | 'rows'>>,
): EditorBlock[] {
  return blocks.map((b) =>
    b.id === id && b.blockType === 'loop' ? { ...b, ...patch } : b,
  );
}
```

**14g. `hydrateFromDto`** (currently lines 205–226) — **read `columns` and `rows`**:

```typescript
    if (dto.blockType === 'loop') {
      return {
        id: dto.id,
        parentBlockId: dto.parentBlockId,
        blockType: 'loop',
        orderIndex: dto.orderIndex,
        name: dto.loop?.name ?? 'loop',
        values: dto.loop?.values ?? [],
        columns: dto.loop?.columns ?? [],
        rows: dto.loop?.rows ?? [],
      };
    }
```

**14h. `buildSaveBlocks`** (currently lines 228–249) — **write `columns` and `rows`**:

```typescript
    if (b.blockType === 'loop') {
      return {
        id: b.id,
        parentBlockId: b.parentBlockId,
        blockType: BlockType.Loop,
        orderIndex: b.orderIndex,
        loop: {
          name: b.name,
          values: b.values.filter((v) => v.trim().length > 0),
          ...(b.columns.length > 0 ? { columns: b.columns, rows: b.rows } : {}),
        },
        scrape: null,
      };
    }
```

---

### 15. `backend/src/WebScrape.Client/src/utils/taskEditor.ts`

**Replace `autoBindSteps`** entirely (currently lines 21–36):

```typescript
export function autoBindSteps(
  steps: SetInputStep[],
  innermostLoopBlockId: string | null,
  loopColumns: string[] = [],
): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  const isMultiColumn = loopColumns.length > 0 && !!innermostLoopBlockId;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (isMultiColumn) {
      const col = loopColumns[i];
      result[step.id] = col
        ? { kind: 'loopRef', loopBlockId: innermostLoopBlockId!, column: col }
        : { kind: 'unbound' };
    } else if (i === 0 && innermostLoopBlockId) {
      result[step.id] = { kind: 'loopRef', loopBlockId: innermostLoopBlockId };
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}
```

---

### 16. `backend/src/WebScrape.Client/src/components/taskEditor/ScrapeBlockInspector.tsx`

**In `handleConfigChange`** (currently lines 35–47) — **pass `innermostLoop?.columns ?? []` to `autoBindSteps`**:

```typescript
  const handleConfigChange = (configId: string) => {
    const config = configs.find((c) => c.id === configId);
    const steps = config ? parseSetInputSteps(config.configJson) : [];
    const innermostLoop = loopAncestors[0] ?? null;
    const innermostLoopId = innermostLoop?.id ?? null;
    dispatch({
      type: 'UPDATE_SCRAPE',
      id: block.id,
      patch: {
        scraperConfigId: configId,
        stepBindings: autoBindSteps(steps, innermostLoopId, innermostLoop?.columns ?? []),
      },
    });
  };
```

---

### 17. `backend/src/WebScrape.Client/src/components/BindingsEditor.tsx`

**Replace entire file**:

```tsx
import type { StepBindingDto } from '../api/types';
import type { LoopAncestor } from '../utils/taskTree';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type Props = {
  steps: SetInputStep[];
  loopAncestors: LoopAncestor[];
  stepBindings: Record<string, StepBindingDto>;
  onChange: (bindings: Record<string, StepBindingDto>) => void;
};

function selectValue(binding: StepBindingDto): string {
  if (binding.kind === 'loopRef') {
    return binding.column
      ? `loopRef:${binding.loopBlockId}:${binding.column}`
      : `loopRef:${binding.loopBlockId}`;
  }
  return binding.kind;
}

function bindingFromSelect(value: string): StepBindingDto {
  if (value.startsWith('loopRef:')) {
    const rest = value.slice('loopRef:'.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx !== -1) {
      const loopBlockId = rest.slice(0, colonIdx);
      const column = rest.slice(colonIdx + 1);
      return { kind: 'loopRef', loopBlockId, column };
    }
    return { kind: 'loopRef', loopBlockId: rest };
  }
  if (value === 'literal') return { kind: 'literal', value: '' };
  return { kind: 'unbound' };
}

export default function BindingsEditor({ steps, loopAncestors, stepBindings, onChange }: Props) {
  if (steps.length === 0) {
    return (
      <div className="form-hint">
        This config has no inputs. Loop values will run the scrape, but won't be substituted.
      </div>
    );
  }

  if (loopAncestors.length === 0) {
    return (
      <div className="form-hint">
        This scrape has no parent loops. Add a loop ancestor to bind values.
      </div>
    );
  }

  const update = (stepId: string, binding: StepBindingDto) => {
    onChange({ ...stepBindings, [stepId]: binding });
  };

  return (
    <div>
      {steps.length > 1 && (
        <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>
          Other inputs default to Unbound — bind them manually.
        </div>
      )}
      {steps.map((step) => {
        const binding = stepBindings[step.id] ?? { kind: 'unbound' as const };
        return (
          <div key={step.id} className="form-group">
            <label className="form-label">{step.id}</label>
            <select
              className="form-select"
              value={selectValue(binding)}
              onChange={(e) => update(step.id, bindingFromSelect(e.target.value))}
            >
              {loopAncestors.map((a) => {
                if (a.columns.length > 0) {
                  return a.columns.map((col) => (
                    <option key={`${a.id}:${col}`} value={`loopRef:${a.id}:${col}`}>
                      {a.name} → {col}
                    </option>
                  ));
                }
                return (
                  <option key={a.id} value={`loopRef:${a.id}`}>
                    Loop value ({a.name}.currentItem)
                  </option>
                );
              })}
              <option value="literal">Literal value</option>
              <option value="unbound">Unbound</option>
            </select>
            {binding.kind === 'literal' && (
              <input
                className="form-input"
                placeholder="Static text"
                value={binding.value}
                onChange={(e) => update(step.id, { kind: 'literal', value: e.target.value })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

---

### 18. `backend/src/WebScrape.Client/src/components/taskEditor/LoopBlockInspector.tsx`

**Replace entire file**:

```tsx
import type React from 'react';
import { Plus, X } from 'lucide-react';
import type { LoopEditorBlock, BlocksAction } from '../../utils/taskTree';

type Props = {
  block: LoopEditorBlock;
  dispatch: React.Dispatch<BlocksAction>;
};

export default function LoopBlockInspector({ block, dispatch }: Props) {
  const isMultiColumn = block.columns.length > 0;

  const addColumn = () => {
    const label = `Column ${block.columns.length + 1}`;
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: [...block.columns, label] } });
  };

  const removeColumn = (idx: number) => {
    const cols = block.columns.filter((_, i) => i !== idx);
    const rows = block.rows.map(r => r.filter((_, i) => i !== idx));
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: cols, rows } });
  };

  const renameColumn = (idx: number, name: string) => {
    const cols = block.columns.map((c, i) => i === idx ? name : c);
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: cols } });
  };

  const addRow = () => {
    const newRow = block.columns.map(() => '');
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows: [...block.rows, newRow] } });
  };

  const removeRow = (rowIdx: number) => {
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows: block.rows.filter((_, i) => i !== rowIdx) } });
  };

  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    const rows = block.rows.map((r, ri) =>
      ri === rowIdx ? r.map((c, ci) => ci === colIdx ? value : c) : r,
    );
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows } });
  };

  const revertToSingleColumn = () => {
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: [], rows: [] } });
  };

  return (
    <div className="card">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Loop
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="loop-name">Name</label>
        <input
          id="loop-name"
          className="form-input"
          value={block.name}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { name: e.target.value } })
          }
          placeholder="e.g. loop1"
        />
        <div className="form-hint">Used to reference this loop's current value in bindings.</div>
      </div>

      {!isMultiColumn ? (
        <div className="form-group">
          <label className="form-label" htmlFor="loop-values">Values</label>
          <textarea
            id="loop-values"
            className="form-textarea"
            rows={8}
            value={block.values.join('\n')}
            onChange={(e) => {
              dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: e.target.value.split('\n') } });
            }}
            onBlur={(e) => {
              const vals = e.target.value.split('\n').map((v) => v.trimEnd());
              dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: vals } });
            }}
            placeholder="One value per line. Each value runs the loop once."
          />
          <div className="form-hint">One value per line. Each value runs the loop once.</div>
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addColumn}
          >
            <Plus size={12} /> Add column
          </button>
        </div>
      ) : (
        <div className="form-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
            <label className="form-label" style={{ margin: 0 }}>Columns &amp; rows</label>
            <button className="btn btn-ghost btn-sm" onClick={revertToSingleColumn} title="Remove all columns">
              <X size={12} /> Remove columns
            </button>
          </div>
          <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>One column per field. Each row is one patient.</div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
              <thead>
                <tr>
                  {block.columns.map((col, ci) => (
                    <th key={ci} style={{ padding: '4px' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          className="form-input"
                          style={{ fontSize: 'var(--font-size-sm)', minWidth: 80 }}
                          value={col}
                          onChange={e => renameColumn(ci, e.target.value)}
                          placeholder={`Column ${ci + 1}`}
                        />
                        <button className="btn btn-ghost btn-sm" onClick={() => removeColumn(ci)} title="Remove column">
                          <X size={10} />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th style={{ width: 32 }}>
                    <button className="btn btn-ghost btn-sm" onClick={addColumn} title="Add column">
                      <Plus size={10} />
                    </button>
                  </th>
                  <th style={{ width: 32 }} />
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri}>
                    {block.columns.map((_, ci) => (
                      <td key={ci} style={{ padding: '3px 4px' }}>
                        <input
                          className="form-input"
                          style={{ fontSize: 'var(--font-size-sm)' }}
                          value={row[ci] ?? ''}
                          onChange={e => updateCell(ri, ci, e.target.value)}
                          placeholder={block.columns[ci] ?? ''}
                        />
                      </td>
                    ))}
                    <td />
                    <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeRow(ri)} title="Remove row">
                        <X size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addRow}
          >
            <Plus size={12} /> Add row
          </button>
        </div>
      )}
    </div>
  );
}
```

---

### 19. `backend/src/WebScrape.Data/Dto/TaskBlockDto.cs`

**Replace the file** with:

```csharp
using WebScrape.Data.Enums;

namespace WebScrape.Data.Dto;

public class TaskBlockTreeDto
{
    public Guid Id { get; set; }
    public Guid? ParentBlockId { get; set; }
    public BlockType BlockType { get; set; }
    public int OrderIndex { get; set; }
    public LoopBlockConfigDto? Loop { get; set; }
    public ScrapeBlockConfigDto? Scrape { get; set; }
}

public class LoopBlockConfigDto
{
    public string Name { get; set; } = "";
    public List<string> Values { get; set; } = new();
    public List<string>? Columns { get; set; }
    public List<List<string>>? Rows { get; set; }
}

public class ScrapeBlockConfigDto
{
    public Guid ScraperConfigId { get; set; }
    public Dictionary<string, StepBindingDto> StepBindings { get; set; } = new();
}

public class StepBindingDto
{
    public BindingKind Kind { get; set; }
    public string? Value { get; set; }
    public Guid? LoopBlockId { get; set; }
    public string? Column { get; set; }
}

public class SaveTaskDto
{
    public string Name { get; set; } = "";
    public List<TaskBlockTreeDto> Blocks { get; set; } = new();
}
```

---

### 20. `backend/src/WebScrape.Services/Interfaces/ITaskValidator.cs`

**In `ValidationCodes`**, add after `LoopRefNotLoop`:

```csharp
    public const string LoopColumnNotFound          = "LOOP_COLUMN_NOT_FOUND";
```

Full updated `ValidationCodes`:

```csharp
public static class ValidationCodes
{
    public const string MissingTaskName            = "MISSING_TASK_NAME";
    public const string DuplicateBlockId           = "DUPLICATE_BLOCK_ID";
    public const string InvalidParentReference     = "INVALID_PARENT_REFERENCE";
    public const string TreeCycle                  = "TREE_CYCLE";
    public const string InvalidBlockConfig         = "INVALID_BLOCK_CONFIG";
    public const string MissingLoopName            = "MISSING_LOOP_NAME";
    public const string LoopRefNonAncestor         = "LOOP_REF_NON_ANCESTOR";
    public const string LoopRefMissing             = "LOOP_REF_MISSING";
    public const string LoopRefNotLoop             = "LOOP_REF_NOT_LOOP";
    public const string LoopColumnNotFound         = "LOOP_COLUMN_NOT_FOUND";
    public const string BindingLiteralMissingValue = "BINDING_LITERAL_MISSING_VALUE";
    public const string ConfigNotOwned             = "CONFIG_NOT_OWNED";
}
```

---

### 21. `backend/src/WebScrape.Services/Implementations/TaskValidator.cs`

**In Pass 3**, after the existing `LoopRefNonAncestor` check (currently line 115), **add column validation** inside the `BindingKind.LoopRef` case:

Replace the entire `BindingKind.LoopRef` case:

```csharp
                    case BindingKind.LoopRef:
                        if (!binding.LoopBlockId.HasValue || !byId.ContainsKey(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefMissing, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (byId[binding.LoopBlockId.Value].BlockType != BlockType.Loop)
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNotLoop, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (!ancestors.Contains(binding.LoopBlockId.Value))
                            errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopRefNonAncestor, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        else if (binding.Column is not null)
                        {
                            var loopColumns = GetLoopColumns(byId[binding.LoopBlockId.Value]);
                            if (!loopColumns.Contains(binding.Column))
                                errors.Add(new ValidationErrorDto { Code = ValidationCodes.LoopColumnNotFound, BlockId = block.Id, LoopBlockId = binding.LoopBlockId, StepId = stepId });
                        }
                        break;
```

**Add `GetLoopColumns` helper method** at the bottom of the class (before the closing `}`):

```csharp
    private static List<string> GetLoopColumns(TaskBlockTreeDto loopBlock)
    {
        return loopBlock.Loop?.Columns ?? new List<string>();
    }
```

---

### 22. `backend/src/WebScrape.Services/Expansion/IBlockExpander.cs`

**Change `ExpansionFrame`** (lines 6–8):

```csharp
public record ExpansionFrame(
    IReadOnlyDictionary<string, string> LoopAssignments,
    IReadOnlyList<string> SearchTerms);
```

---

### 23. `backend/src/WebScrape.Services/Implementations/QueueExpansionService.cs`

**Line 69** — change `Dictionary<Guid, string>` to `Dictionary<string, string>`:

```csharp
        var emptyFrame = new ExpansionFrame(new Dictionary<string, string>(), Array.Empty<string>());
```

---

### 24. `backend/src/WebScrape.Services/Expansion/LoopBlockExpander.cs`

**Replace entire file**:

```csharp
using System.Text.Json;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Services.Expansion;

public class LoopBlockExpander : IBlockExpander
{
    public BlockType Handles => BlockType.Loop;

    private readonly IEnumerable<IBlockExpander> _all;
    private IReadOnlyDictionary<BlockType, IBlockExpander>? _byTypeCache;

    private IReadOnlyDictionary<BlockType, IBlockExpander> ByType =>
        _byTypeCache ??= _all.ToDictionary(e => e.Handles);

    public LoopBlockExpander(IEnumerable<IBlockExpander> all)
    {
        _all = all;
    }

    public IEnumerable<ExpansionResult> Expand(TaskBlock block, ExpansionContext ctx, ExpansionFrame frame)
    {
        var children = ctx.AllBlocks
            .Where(b => b.ParentBlockId == block.Id)
            .OrderBy(b => b.OrderIndex)
            .ToList();

        var (columns, rows) = ReadLoopColumnsAndRows(block);

        if (columns.Count > 0 && rows.Count > 0)
        {
            // Multi-column path: one frame per row with baked assignments.
            foreach (var row in rows)
            {
                var assignments = new Dictionary<string, string>(columns.Count);
                for (var c = 0; c < columns.Count; c++)
                    assignments[$"{block.Id}:{columns[c]}"] = row.Count > c ? row[c] : "";

                // First column becomes the iteration label / searchTerm[0].
                var iterLabel = row.Count > 0 ? row[0] : "";
                var childFrame = new ExpansionFrame(
                    LoopAssignments: assignments,
                    SearchTerms: new List<string> { iterLabel });

                foreach (var child in children)
                {
                    if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
                    foreach (var result in expander.Expand(child, ctx, childFrame))
                        yield return result;
                }
            }
        }
        else
        {
            // Single-column path: bundle all values into one frame (existing behaviour).
            var values = ReadLoopValues(block);
            var searchTerms = values.Count == 0 ? new List<string> { "" } : values;

            var childFrame = new ExpansionFrame(
                LoopAssignments: new Dictionary<string, string>(),
                SearchTerms: searchTerms);

            foreach (var child in children)
            {
                if (!ByType.TryGetValue(child.BlockType, out var expander)) continue;
                foreach (var result in expander.Expand(child, ctx, childFrame))
                    yield return result;
            }
        }
    }

    private static List<string> ReadLoopValues(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;
        if (!root.TryGetProperty("values", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return new();
        var list = new List<string>(arr.GetArrayLength());
        foreach (var v in arr.EnumerateArray())
            if (v.ValueKind == JsonValueKind.String) list.Add(v.GetString() ?? "");
        return list;
    }

    private static (List<string> columns, List<List<string>> rows) ReadLoopColumnsAndRows(TaskBlock block)
    {
        var root = block.ConfigJsonb.RootElement;

        var columns = new List<string>();
        if (root.TryGetProperty("columns", out var colsEl) && colsEl.ValueKind == JsonValueKind.Array)
            foreach (var c in colsEl.EnumerateArray())
                if (c.ValueKind == JsonValueKind.String) columns.Add(c.GetString() ?? "");

        var rows = new List<List<string>>();
        if (root.TryGetProperty("rows", out var rowsEl) && rowsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var rowEl in rowsEl.EnumerateArray())
            {
                if (rowEl.ValueKind != JsonValueKind.Array) continue;
                var row = new List<string>();
                foreach (var cell in rowEl.EnumerateArray())
                    row.Add(cell.ValueKind == JsonValueKind.String ? cell.GetString() ?? "" : "");
                rows.Add(row);
            }
        }

        return (columns, rows);
    }
}
```

---

### 25. `backend/src/WebScrape.Services/Expansion/ScrapeBlockExpander.cs`

**25a. `BindingPayload` record** (currently line 115) — **add `Column`**:

```csharp
    private record BindingPayload(string Kind, string? Value, Guid? LoopBlockId, string? Column = null);
```

**25b. `ReadScrapeConfig` — read `column` from binding JSON** (currently lines 100–111):

```csharp
        if (root.TryGetProperty("stepBindings", out var b) && b.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in b.EnumerateObject())
            {
                var kindStr = prop.Value.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String
                    ? k.GetString() : null;
                if (kindStr is null) continue;

                var column = prop.Value.TryGetProperty("column", out var col) && col.ValueKind == JsonValueKind.String
                    ? col.GetString() : null;

                var payload = new BindingPayload(kindStr,
                    prop.Value.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null,
                    prop.Value.TryGetProperty("loopBlockId", out var l) && l.ValueKind == JsonValueKind.String && Guid.TryParse(l.GetString(), out var lg) ? lg : null,
                    column);
                bindings[prop.Name] = payload;
            }
        }
```

**25c. `loopRef` case in the switch** (currently lines 56–59) — **resolve column binding**:

Replace:
```csharp
                    case "loopRef":
                        // Remove any stale literalValue so the extension falls through to searchTerms[i].
                        if (stepNode["options"] is JsonObject loopOpts)
                            loopOpts.Remove("literalValue");
                        break;
```

With:
```csharp
                    case "loopRef":
                        if (binding.Column is not null && binding.LoopBlockId.HasValue)
                        {
                            var assignmentKey = $"{binding.LoopBlockId.Value}:{binding.Column}";
                            if (frame.LoopAssignments.TryGetValue(assignmentKey, out var assignedValue))
                            {
                                if (stepNode["options"] is not JsonObject colOpts)
                                {
                                    colOpts = new JsonObject();
                                    stepNode["options"] = colOpts;
                                }
                                colOpts["literalValue"] = assignedValue;
                            }
                        }
                        else
                        {
                            // Single-column loopRef: remove stale literalValue; extension falls through to searchTerms[i].
                            if (stepNode["options"] is JsonObject loopOpts)
                                loopOpts.Remove("literalValue");
                        }
                        break;
```

---

## Verification

### Backend

```
cd c:\Users\und3r\blueberry-v3\backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests
```

### Extension

```
cd c:\Users\und3r\blueberry-v3
npx vitest run
```

### Manual test — Extension manual multi-column run

1. Open a config with 2 setInput loop-phase steps on a real page.
2. Go to Configure Loop → Input Fields section appears (because there are setInput loop steps).
3. Add "Last Name" and "First Name" fields. Confirm keys auto-generate (`last-name`, `first-name`).
4. Go to each setInput step form → "Input field" dropdown appears → assign Last Name to step A, First Name to step B.
5. Click Run → SearchVarInput shows table grid with "Last Name" and "First Name" columns (not the textarea).
6. Add 2 rows, fill in values → click Run Scraper.
7. Verify scraper types correct values into correct elements for each row. Verify 2 iterations in results.
8. Reload extension (or open new config with no inputSlots) → SearchVarInput shows original textarea unchanged.

### Manual test — Backend batch multi-column path

1. In the Task Editor, create a loop block. Click "Add column" → add "Last Name" + "First Name" columns. Add 2 rows with test data.
2. Add a scrape child block using a config with 2 setInput steps.
3. In Input bindings, confirm each step shows options "{loopName} → Last Name" and "{loopName} → First Name". Bind appropriately.
4. Click Preview → verify 2 expansion items with correct IterationLabels (first column values).
5. Click Dispatch → verify 2 run items dispatched. In extension, confirm correct literalValues typed per row.
6. Save the task (PUT /api/tasks) → reload → confirm columns/rows persisted.

### Backward-compat test

- Open an existing task with single-column loop (values list) → LoopBlockInspector shows textarea, "Add column" button. No regression.
- Open an existing config with no inputSlots → SearchVarInput shows textarea. No regression.
- Run `dotnet test` on existing test suite — all green.

---

## What is NOT in scope (v1)

- `bestMatch` / `navigateTo` column bindings — these continue using `searchTerms[i]`.
- Nested multi-column loops.
- CSV import of rows.
- Cross-validation that extension `inputSlots` matches backend loop `columns`.
- Validation that multi-column loops have at least one row before dispatch (runtime no-op if rows=[]).
