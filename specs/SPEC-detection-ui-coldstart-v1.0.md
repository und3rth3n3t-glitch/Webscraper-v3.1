# SPEC: Detection UI + cold-start watchdog (PR1.5)

**Slug:** `detection-ui-coldstart`
**Version:** 1.0
**Author:** Opus (planning) → Sonnet (implementation)
**Predecessor:** PR1 (commit `aff52ba` — detector watchdog + cookieBanner)
**Successor:** PR2 (state refactor: singleton → Map)

---

## 1. Context

PR1 hoisted `runDetectorWatchdog` from inside `executeAwaitUserAction` into a post-navigation hook in [src/content/scraping/scrapingEngine.ts:226-228](src/content/scraping/scrapingEngine.ts#L226-L228) and added the `cookieBanner` detector pack. This PR closes three remaining gaps that block end-to-end testing of PR1's behaviour:

1. **Cold-start blind spot.** The watchdog only runs inside `if (isNavigating)` (line 226). When a user clicks Run on a page that's already loaded (e.g. starts a scrape on `theguardian.com` with a cookie banner showing), no detector ever fires. The flow runs the first non-navigating step (e.g. `setInput`, `scrape`) right through the obstruction.

2. **`autoDetect` config has no UI.** PR1 added `ScraperConfig.autoDetect: AutoDetectConfig` (per-scraper opt-out) at [src/types/config.ts:209](src/types/config.ts#L209). There is no place in the sidepanel where a user can toggle these flags or set `extraSelectors`. The field is currently JSON-only.

3. **`navigateTo` step is JSON-only.** [src/sidepanel/components/AddStepMenu.tsx:12-21](src/sidepanel/components/AddStepMenu.tsx#L12-L21) lists 8 of the 9 step types in `Step` ([src/types/config.ts:170-179](src/types/config.ts#L170-L179)). The `navigateTo` step type (added in M4) was never exposed via UI; users cannot build a config that starts with a `navigateTo` step from the editor — required for the most natural test of the watchdog (have an explicit landing URL, then iterate).

This PR is **purely additive**: no backend changes, no manifest permissions, no schema-breaking changes, no deletions. It unblocks dogfooding PR1 and gives users the configuration surface needed to set up batch-friendly configs ahead of PR2-PR6.

**Locked decisions** (do not re-litigate during implementation):

- Cold-start hook fires inside the existing `if (!isResume) { ... }` block at [scrapingEngine.ts:143](src/content/scraping/scrapingEngine.ts#L143), **before** the setup-step loop. Resume path skips it (continuation already past initial gate).
- `autoDetect` UI uses **lazy-init**: panel reads default-true via `autoDetect?.[key] !== false`. Toggling materialises the object on the config; until then the config is byte-identical and `isDirty` does not flip.
- `schemaVersion` bumps to **5 only when `autoDetect` is present** on a saved config. v3/v4 configs without autoDetect remain v4 after save. `CURRENT_SCHEMA_VERSION` constant stays at `4` (it gates migration; v5 configs hit the early-return at [storage.ts:22](src/sidepanel/utils/storage.ts#L22) and skip migration).
- `awaitUserAction.detectionRules` UI surface is **out of scope** (still JSON-only — autoDetect supersedes the common case).
- NavigateToForm save button is **disabled when URL is empty** but otherwise allows save with malformed URLs (matches existing form leniency; `executeNavigateTo` validates at runtime).

---

## 2. File map

### Modified

| File | Concern |
|---|---|
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | Cold-start watchdog hook |
| [src/sidepanel/utils/storage.ts](src/sidepanel/utils/storage.ts) | Add `navigateTo` to `STEP_OPTION_DEFAULTS` |
| [src/sidepanel/stores/configStore.ts](src/sidepanel/stores/configStore.ts) | Plumb `navigateTo` step type and `autoDetect` field |
| [src/sidepanel/components/AddStepMenu.tsx](src/sidepanel/components/AddStepMenu.tsx) | Surface `navigateTo` in step menu |
| [src/sidepanel/components/ConfigTab.tsx](src/sidepanel/components/ConfigTab.tsx) | Register two new views; route `EDIT_STEP` for `navigateTo` |
| [src/sidepanel/components/StepList.tsx](src/sidepanel/components/StepList.tsx) | Add "Detection Settings" button |

### New

| File | Purpose |
|---|---|
| `src/sidepanel/utils/parseExtraSelectors.ts` | Pure util for textarea round-trip |
| `src/sidepanel/components/NavigateToForm.tsx` | Editor for `navigateTo` step |
| `src/sidepanel/components/DetectionSettings.tsx` | Editor for `ScraperConfig.autoDetect` |
| `src/__tests__/parseExtraSelectors.test.ts` | Vitest for the parser util |

### Deleted

None.

---

## 3. Detailed changes

### 3.1 — `src/content/scraping/scrapingEngine.ts`

**Single change: add cold-start watchdog inside the existing `if (!isResume) { ... try { ... } }` block, before the setup loop.**

Locate the existing block at lines 143-159:

```typescript
    if (!isResume) {
      try {
        for (const step of setupSteps) {
          checkAbort();
          await executeStep(step, null, 0, (msg) => sendProgress({ phase: 'setup', stepLabel: msg, status: 'running', taskId }), afk, taskId);
        }
      } catch (err) {
        const e = err as Error;
        if (e.message === 'ABORTED') {
          result.totalTimeMs = Date.now() - startTime;
          swLog('[executeFlow] setup ABORTED return | taskId:', taskId, '| iterations:', result.iterations.length, '| totalTimeMs:', result.totalTimeMs);
          return { ...result, aborted: true };
        }
        swLog('[executeFlow] setup phase error | taskId:', taskId, '| name:', e.name, '| msg:', e.message, '| stack:', e.stack);
        sendProgress({ phase: 'setup', stepLabel: '', status: 'error', taskId });
      }
    }
```

Replace with:

```typescript
    if (!isResume) {
      try {
        // Cold-start watchdog — runs once before any setup step so cookie
        // banners / login walls / cloudflare gates on the initial page are
        // caught even when the config has no leading navigateTo step.
        // Skipped on resume because the post-navigation watchdog at line ~227
        // already cleared the gate in the prior run-leg.
        await runWatchdogPause(config.autoDetect, taskId);

        for (const step of setupSteps) {
          checkAbort();
          await executeStep(step, null, 0, (msg) => sendProgress({ phase: 'setup', stepLabel: msg, status: 'running', taskId }), afk, taskId);
        }
      } catch (err) {
        const e = err as Error;
        if (e.message === 'ABORTED') {
          result.totalTimeMs = Date.now() - startTime;
          swLog('[executeFlow] setup ABORTED return | taskId:', taskId, '| iterations:', result.iterations.length, '| totalTimeMs:', result.totalTimeMs);
          return { ...result, aborted: true };
        }
        swLog('[executeFlow] setup phase error | taskId:', taskId, '| name:', e.name, '| msg:', e.message, '| stack:', e.stack);
        sendProgress({ phase: 'setup', stepLabel: '', status: 'error', taskId });
      }
    }
```

`runWatchdogPause` is already defined in this file at [scrapingEngine.ts:341-371](src/content/scraping/scrapingEngine.ts#L341-L371) (added by PR1) and imports are already in place. **No new imports required.**

No other edits to this file.

---

### 3.2 — `src/types/config.ts`

**No changes.** PR1 already added the `autoDetect` field at line 209, the `AutoDetectConfig` interface at lines 139-145, the `NavigateToOptions` interface at line 152, the `NavigateToStep` interface at line 166, and `NavigateToStep` in the union at line 179. Verify these exist before starting; if any are missing, stop and escalate (the spec assumed PR1 was complete).

---

### 3.3 — NEW: `src/sidepanel/utils/parseExtraSelectors.ts`

Create the file with this exact content:

```typescript
// Round-trip helpers for the "Extra selectors" textarea in DetectionSettings.
// Stored on disk as string[]; rendered to textarea as newline-joined.

export function parseExtraSelectors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function formatExtraSelectors(selectors: string[] | undefined): string {
  return (selectors ?? []).join('\n');
}
```

---

### 3.4 — `src/sidepanel/utils/storage.ts`

Add a default-options entry for `navigateTo` so `migrateConfig` can backfill any malformed step (defensive — currently no on-disk configs have navigateTo missing options, but the others all have entries here, and consistency matters).

Locate `STEP_OPTION_DEFAULTS` at [storage.ts:8-17](src/sidepanel/utils/storage.ts#L8-L17):

```typescript
const STEP_OPTION_DEFAULTS: Record<string, Record<string, unknown>> = {
  setInput:   { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null },
  click:      { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null },
  bestMatch:  { matchStrictness: 'normal', candidateSource: 'similar', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  goBack:     { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  scrape:     { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, scrollIncrementVh: 0.4, scrollDelayMs: 700, paginationDelayMs: 1500, expandDelayMs: 350, elements: [] },
  selectEach: { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } },
  captureApiCalls: { urlPattern: '', durationMs: 5000, includeResponseBody: true },
  awaitUserAction: { message: '' },
};
```

Add one line for `navigateTo`. The full block becomes:

```typescript
const STEP_OPTION_DEFAULTS: Record<string, Record<string, unknown>> = {
  setInput:   { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null },
  click:      { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null },
  bestMatch:  { matchStrictness: 'normal', candidateSource: 'similar', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  goBack:     { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  scrape:     { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, scrollIncrementVh: 0.4, scrollDelayMs: 700, paginationDelayMs: 1500, expandDelayMs: 350, elements: [] },
  selectEach: { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } },
  captureApiCalls: { urlPattern: '', durationMs: 5000, includeResponseBody: true },
  awaitUserAction: { message: '' },
  navigateTo: { url: '' },
};
```

No other edits to this file. **Do not bump `CURRENT_SCHEMA_VERSION`** — it stays at `4`.

---

### 3.5 — `src/sidepanel/stores/configStore.ts`

Five additive changes. Apply them in order.

#### 3.5.1 — Imports (line 5-18)

The current import block ends at line 18:

```typescript
import type {
  ScraperConfig,
  Step,
  StepType,
  DataMapping,
  SetInputOptions,
  ClickOptions,
  BestMatchOptions,
  GoBackOptions,
  ScrapeOptions,
  SelectEachOptions,
  CaptureApiCallsOptions,
  AwaitUserActionOptions,
} from '../../types/config';
```

Add `AutoDetectConfig` and `NavigateToOptions`:

```typescript
import type {
  ScraperConfig,
  Step,
  StepType,
  DataMapping,
  AutoDetectConfig,
  SetInputOptions,
  ClickOptions,
  BestMatchOptions,
  GoBackOptions,
  ScrapeOptions,
  SelectEachOptions,
  CaptureApiCallsOptions,
  AwaitUserActionOptions,
  NavigateToOptions,
} from '../../types/config';
```

#### 3.5.2 — `StepOptions` union (line 20-28)

Current:

```typescript
type StepOptions =
  | SetInputOptions
  | ClickOptions
  | BestMatchOptions
  | GoBackOptions
  | ScrapeOptions
  | SelectEachOptions
  | CaptureApiCallsOptions
  | AwaitUserActionOptions;
```

Add `NavigateToOptions`:

```typescript
type StepOptions =
  | SetInputOptions
  | ClickOptions
  | BestMatchOptions
  | GoBackOptions
  | ScrapeOptions
  | SelectEachOptions
  | CaptureApiCallsOptions
  | AwaitUserActionOptions
  | NavigateToOptions;
```

#### 3.5.3 — `DEFAULT_STEP_LABELS` (line 30-39)

Current:

```typescript
const DEFAULT_STEP_LABELS: Record<StepType, string> = {
  setInput:        'Type search term',
  click:           'Click element',
  bestMatch:       'Best search match',
  goBack:          'Go back',
  scrape:          'Scrape data',
  selectEach:      'Select each option',
  captureApiCalls: 'Capture API calls',
  awaitUserAction: 'Wait for user',
};
```

Replace with:

```typescript
const DEFAULT_STEP_LABELS: Record<StepType, string> = {
  setInput:        'Type search term',
  click:           'Click element',
  bestMatch:       'Best search match',
  goBack:          'Go back',
  scrape:          'Scrape data',
  selectEach:      'Select each option',
  captureApiCalls: 'Capture API calls',
  awaitUserAction: 'Wait for user',
  navigateTo:      'Go to URL',
};
```

#### 3.5.4 — `getDefaultOptions` switch (line 41-60)

Current:

```typescript
export function getDefaultOptions(type: StepType): StepOptions {
  switch (type) {
    case 'setInput':
      return { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null } satisfies SetInputOptions;
    case 'click':
      return { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } satisfies ClickOptions;
    case 'bestMatch':
      return { matchStrictness: 'normal', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', sameOriginOnly: true, waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies BestMatchOptions;
    case 'goBack':
      return { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies GoBackOptions;
    case 'scrape':
      return { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, elements: [] } satisfies ScrapeOptions;
    case 'selectEach':
      return { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } } satisfies SelectEachOptions;
    case 'captureApiCalls':
      return { urlPattern: '', durationMs: 5000, includeResponseBody: true } satisfies CaptureApiCallsOptions;
    case 'awaitUserAction':
      return { message: '' } satisfies AwaitUserActionOptions;
  }
}
```

Add `case 'navigateTo'`:

```typescript
export function getDefaultOptions(type: StepType): StepOptions {
  switch (type) {
    case 'setInput':
      return { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null } satisfies SetInputOptions;
    case 'click':
      return { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } satisfies ClickOptions;
    case 'bestMatch':
      return { matchStrictness: 'normal', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', sameOriginOnly: true, waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies BestMatchOptions;
    case 'goBack':
      return { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies GoBackOptions;
    case 'scrape':
      return { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, elements: [] } satisfies ScrapeOptions;
    case 'selectEach':
      return { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } } satisfies SelectEachOptions;
    case 'captureApiCalls':
      return { urlPattern: '', durationMs: 5000, includeResponseBody: true } satisfies CaptureApiCallsOptions;
    case 'awaitUserAction':
      return { message: '' } satisfies AwaitUserActionOptions;
    case 'navigateTo':
      return { url: '' } satisfies NavigateToOptions;
  }
}
```

This change tightens type-safety: TypeScript's exhaustiveness check will now confirm all 9 step types are handled.

#### 3.5.5 — Add `autoDetect` state field, init paths, and `setAutoDetect` action

Locate `interface ConfigState` at line 75-107. The current shape ends with the actions block. Two changes:

**(a) Add `autoDetect` to the state fields and a `setAutoDetect` action signature.**

Current (extract):

```typescript
interface ConfigState {
  currentConfig: ScraperConfig | null;
  steps: Step[];
  configName: string;
  isDirty: boolean;
  pageUrl: string;
  pageDomain: string;
  domainLocked: boolean;
  draftStep: Step | null;
  editingStepId: string | null;
  cameFromSaved: boolean;
  view: string;
  viewStack: string[];

  setPageInfo: (url: string, domain?: string) => void;
  pushView: (view: string) => void;
  goBack: () => void;
  setView: (view: string) => void;
  addStep: (type: StepType) => Step;
  createDraft: (type: StepType) => Step;
  commitDraft: () => void;
  updateStep: (id: string, changes: Partial<Step>) => void;
  updateStepOptions: (id: string, optionChanges: Partial<StepOptions>) => void;
  deleteStep: (id: string) => void;
  reorderSteps: (activeId: string, overId: string) => void;
  saveCurrentConfig: () => Promise<ScraperConfig>;
  loadConfig: (config: ScraperConfig | Record<string, unknown>) => void;
  newConfig: () => void;
  setConfigName: (name: string) => void;
  setDomainLocked: (v: boolean) => void;
  setEditingStepId: (id: string | null) => void;
  setDataMapping: (mapping: DataMapping) => void;
}
```

Replace with (additions: `autoDetect` field and `setAutoDetect` action):

```typescript
interface ConfigState {
  currentConfig: ScraperConfig | null;
  steps: Step[];
  configName: string;
  isDirty: boolean;
  pageUrl: string;
  pageDomain: string;
  domainLocked: boolean;
  draftStep: Step | null;
  editingStepId: string | null;
  cameFromSaved: boolean;
  view: string;
  viewStack: string[];
  autoDetect: AutoDetectConfig | undefined;

  setPageInfo: (url: string, domain?: string) => void;
  pushView: (view: string) => void;
  goBack: () => void;
  setView: (view: string) => void;
  addStep: (type: StepType) => Step;
  createDraft: (type: StepType) => Step;
  commitDraft: () => void;
  updateStep: (id: string, changes: Partial<Step>) => void;
  updateStepOptions: (id: string, optionChanges: Partial<StepOptions>) => void;
  deleteStep: (id: string) => void;
  reorderSteps: (activeId: string, overId: string) => void;
  saveCurrentConfig: () => Promise<ScraperConfig>;
  loadConfig: (config: ScraperConfig | Record<string, unknown>) => void;
  newConfig: () => void;
  setConfigName: (name: string) => void;
  setDomainLocked: (v: boolean) => void;
  setEditingStepId: (id: string | null) => void;
  setDataMapping: (mapping: DataMapping) => void;
  setAutoDetect: (cfg: AutoDetectConfig | undefined) => void;
}
```

**(b) Add `autoDetect: undefined` to the initial-state literal at line 109-122.**

Current:

```typescript
export const useConfigStore = create<ConfigState>((set, get) => ({
  currentConfig: null,
  steps: [],
  configName: '',
  isDirty: false,
  pageUrl: '',
  pageDomain: '',
  domainLocked: false,
  draftStep: null,
  editingStepId: null,
  cameFromSaved: false,
  view: 'NO_CONFIG',
  viewStack: [],
```

Replace with:

```typescript
export const useConfigStore = create<ConfigState>((set, get) => ({
  currentConfig: null,
  steps: [],
  configName: '',
  isDirty: false,
  pageUrl: '',
  pageDomain: '',
  domainLocked: false,
  draftStep: null,
  editingStepId: null,
  cameFromSaved: false,
  view: 'NO_CONFIG',
  viewStack: [],
  autoDetect: undefined,
```

**(c) Persist `autoDetect` in `saveCurrentConfig`.**

Locate `saveCurrentConfig` at lines 197-233. Current config-build block (lines 197-212):

```typescript
  saveCurrentConfig: async () => {
    const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked } = get();
    const config: ScraperConfig = {
      id: currentConfig?.id || generateId(),
      name: configName || 'Untitled Config',
      domain: domainLocked ? pageDomain : '',
      domainLocked,
      url: pageUrl,
      steps,
      dataMapping: currentConfig?.dataMapping,
      schemaVersion: CURRENT_SCHEMA_VERSION as 4,
      createdAt: currentConfig?.createdAt || Date.now(),
      updatedAt: Date.now(),
      shared: currentConfig?.shared ?? false,
      lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
    };
```

Replace with:

```typescript
  saveCurrentConfig: async () => {
    const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked, autoDetect } = get();
    const config: ScraperConfig = {
      id: currentConfig?.id || generateId(),
      name: configName || 'Untitled Config',
      domain: domainLocked ? pageDomain : '',
      domainLocked,
      url: pageUrl,
      steps,
      dataMapping: currentConfig?.dataMapping,
      autoDetect,
      schemaVersion: (autoDetect ? 5 : CURRENT_SCHEMA_VERSION) as 4 | 5,
      createdAt: currentConfig?.createdAt || Date.now(),
      updatedAt: Date.now(),
      shared: currentConfig?.shared ?? false,
      lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
    };
```

**(d) Initialise `autoDetect` from `loadConfig`.**

Locate `loadConfig` at lines 235-248. Current:

```typescript
  loadConfig: (config) => {
    const safe = migrateConfig(config as Record<string, unknown>) || config as ScraperConfig;
    set({
      currentConfig: safe,
      steps: safe.steps || [],
      configName: safe.name,
      domainLocked: safe.domainLocked ?? !!(safe.domain),
      isDirty: false,
      view: 'STEP_LIST',
      viewStack: [],
      draftStep: null,
      cameFromSaved: true,
    });
  },
```

Replace with:

```typescript
  loadConfig: (config) => {
    const safe = migrateConfig(config as Record<string, unknown>) || config as ScraperConfig;
    set({
      currentConfig: safe,
      steps: safe.steps || [],
      configName: safe.name,
      domainLocked: safe.domainLocked ?? !!(safe.domain),
      autoDetect: safe.autoDetect,
      isDirty: false,
      view: 'STEP_LIST',
      viewStack: [],
      draftStep: null,
      cameFromSaved: true,
    });
  },
```

**(e) Reset `autoDetect` in `newConfig`.**

Locate `newConfig` at lines 250-262. Current:

```typescript
  newConfig: () => {
    set({
      currentConfig: null,
      steps: [],
      configName: '',
      domainLocked: false,
      isDirty: false,
      view: 'NO_CONFIG',
      viewStack: [],
      draftStep: null,
      cameFromSaved: false,
    });
  },
```

Replace with:

```typescript
  newConfig: () => {
    set({
      currentConfig: null,
      steps: [],
      configName: '',
      domainLocked: false,
      autoDetect: undefined,
      isDirty: false,
      view: 'NO_CONFIG',
      viewStack: [],
      draftStep: null,
      cameFromSaved: false,
    });
  },
```

**(f) Add the `setAutoDetect` action right before the closing `}))` of the store.**

Locate the existing `setDataMapping` action at lines 267-270:

```typescript
  setDataMapping: (mapping) => set((s) => ({
    currentConfig: s.currentConfig ? { ...s.currentConfig, dataMapping: mapping } : null,
    isDirty: true,
  })),
}));
```

Replace with (`setAutoDetect` added directly after `setDataMapping`, before the closing `}))`):

```typescript
  setDataMapping: (mapping) => set((s) => ({
    currentConfig: s.currentConfig ? { ...s.currentConfig, dataMapping: mapping } : null,
    isDirty: true,
  })),

  setAutoDetect: (cfg) => set({ autoDetect: cfg, isDirty: true }),
}));
```

That completes the configStore changes.

---

### 3.6 — `src/sidepanel/components/AddStepMenu.tsx`

Two changes: extend `STEP_TYPES` and `FORM_MAP`.

Locate `STEP_TYPES` at lines 12-21:

```typescript
const STEP_TYPES: StepOption[] = [
  { type: 'setInput',        label: 'Type Text',         description: 'Fill in a search box, form field, or text input' },
  { type: 'click',           label: 'Click',              description: 'Tap a button, link, or anything on the page' },
  { type: 'bestMatch',       label: 'Best Search Match',  description: 'Auto-click the result that best matches your search term' },
  { type: 'goBack',          label: 'Go Back',            description: 'Return to the previous page using browser history' },
  { type: 'scrape',          label: 'Grab Data',          description: 'Copy text, numbers, or info from the page' },
  { type: 'selectEach',      label: 'Loop Through',       description: 'Repeat for each option in a dropdown or tab' },
  { type: 'captureApiCalls', label: 'Capture API Calls',  description: 'Record network requests made by the page' },
  { type: 'awaitUserAction', label: 'Await User Action',  description: 'Pause and wait for you to do something on the page' },
];
```

Insert the `navigateTo` entry directly after `goBack` (logical grouping with navigation steps). The new array:

```typescript
const STEP_TYPES: StepOption[] = [
  { type: 'setInput',        label: 'Type Text',         description: 'Fill in a search box, form field, or text input' },
  { type: 'click',           label: 'Click',              description: 'Tap a button, link, or anything on the page' },
  { type: 'bestMatch',       label: 'Best Search Match',  description: 'Auto-click the result that best matches your search term' },
  { type: 'goBack',          label: 'Go Back',            description: 'Return to the previous page using browser history' },
  { type: 'navigateTo',      label: 'Go to URL',          description: 'Open a specific page (e.g. before scraping starts)' },
  { type: 'scrape',          label: 'Grab Data',          description: 'Copy text, numbers, or info from the page' },
  { type: 'selectEach',      label: 'Loop Through',       description: 'Repeat for each option in a dropdown or tab' },
  { type: 'captureApiCalls', label: 'Capture API Calls',  description: 'Record network requests made by the page' },
  { type: 'awaitUserAction', label: 'Await User Action',  description: 'Pause and wait for you to do something on the page' },
];
```

Locate `FORM_MAP` at lines 23-32:

```typescript
const FORM_MAP: Record<StepType, string> = {
  setInput:        'SET_INPUT_FORM',
  click:           'CLICK_FORM',
  bestMatch:       'BEST_MATCH_FORM',
  goBack:          'GO_BACK_FORM',
  scrape:          'SCRAPE_FORM',
  selectEach:      'SELECT_EACH_FORM',
  captureApiCalls: 'CAPTURE_API_CALLS_FORM',
  awaitUserAction: 'AWAIT_USER_ACTION_FORM',
};
```

Replace with:

```typescript
const FORM_MAP: Record<StepType, string> = {
  setInput:        'SET_INPUT_FORM',
  click:           'CLICK_FORM',
  bestMatch:       'BEST_MATCH_FORM',
  goBack:          'GO_BACK_FORM',
  navigateTo:      'NAVIGATE_TO_FORM',
  scrape:          'SCRAPE_FORM',
  selectEach:      'SELECT_EACH_FORM',
  captureApiCalls: 'CAPTURE_API_CALLS_FORM',
  awaitUserAction: 'AWAIT_USER_ACTION_FORM',
};
```

The `Record<StepType, string>` typing means TS will now require `navigateTo` to be present (the previous code compiled because the union didn't include it as a key — verify via `npm run type-check`).

No other edits.

---

### 3.7 — `src/sidepanel/components/ConfigTab.tsx`

Three changes: import the new components, register two new view cases, route `EDIT_STEP` for `navigateTo`.

#### 3.7.1 — Imports (lines 1-22)

Add two import lines after the existing component imports (alphabetical groupings are loose in this file; place them with the other component imports). The block becomes:

```typescript
import StepList from './StepList';
import AddStepMenu from './AddStepMenu';
import SetInputForm from './SetInputForm';
import ClickElementForm from './ClickElementForm';
import ScrapeForm from './ScrapeForm';
import ScrapeWholePageForm from './ScrapeWholePageForm';
import ScrapeElementsForm from './ScrapeElementsForm';
import SelectEachForm from './SelectEachForm';
import BestMatchForm from './BestMatchForm';
import GoBackForm from './GoBackForm';
import NavigateToForm from './NavigateToForm';
import LoopConfig from './LoopConfig';
import SaveConfigForm from './SaveConfigForm';
import ElementPickerStatus from './ElementPickerStatus';
import SearchVarInput from './SearchVarInput';
import RunProgress from './RunProgress';
import ResultsView from './ResultsView';
import CreateConfigWelcome from './CreateConfigWelcome';
import CreateConfigForm from './CreateConfigForm';
import ConfigToolbar from './ConfigToolbar';
import AwaitUserActionForm from './AwaitUserActionForm';
import NetworkRecorderView from './NetworkRecorderView';
import DataMappingView from './DataMappingView';
import DetectionSettings from './DetectionSettings';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { dispatchPickerResult } from '../utils/pickerDispatch';
import { useContentMessage } from '../utils/messageDispatcher';
```

#### 3.7.2 — `renderView` switch (lines 40-105)

Two new cases need to be registered, and the `EDIT_STEP` switch needs a `navigateTo` branch.

Current `renderView`:

```typescript
  const renderView = () => {
    switch (view) {
      case 'NO_CONFIG':
        return <CreateConfigWelcome />;
      case 'CREATE_CONFIG':
        return <CreateConfigForm />;
      case 'STEP_LIST':
        return <StepList />;
      case 'ADD_STEP_MENU':
        return <AddStepMenu />;
      case 'SET_INPUT_FORM':
        return <SetInputForm />;
      case 'CLICK_FORM':
        return <ClickElementForm />;
      case 'BEST_MATCH_FORM':
        return <BestMatchForm />;
      case 'GO_BACK_FORM':
        return <GoBackForm />;
      case 'SCRAPE_FORM':
        return <ScrapeForm />;
      case 'SCRAPE_WHOLE_PAGE_FORM':
        return <ScrapeWholePageForm />;
      case 'SCRAPE_ELEMENTS_FORM':
        return <ScrapeElementsForm />;
      case 'SELECT_EACH_FORM':
        return <SelectEachForm />;
      case 'CAPTURE_API_CALLS_FORM':
        return <NetworkRecorderView />;
      case 'AWAIT_USER_ACTION_FORM':
        return <AwaitUserActionForm />;
      case 'LOOP_CONFIG':
        return <LoopConfig />;
      case 'SAVE_CONFIG':
        return <SaveConfigForm />;
      case 'EDIT_STEP': {
        const editStep = steps.find(s => s.id === editingStepId);
        if (!editStep) return <StepList />;
        switch (editStep.type) {
          case 'setInput':        return <SetInputForm editingStepId={editingStepId!} />;
          case 'click':           return <ClickElementForm editingStepId={editingStepId!} />;
          case 'bestMatch':       return <BestMatchForm editingStepId={editingStepId!} />;
          case 'goBack':          return <GoBackForm editingStepId={editingStepId!} />;
          case 'scrape':
            if ((editStep.options as { mode?: string }).mode === 'wholePage')
              return <ScrapeWholePageForm editingStepId={editingStepId!} />;
            if ((editStep.options as { mode?: string }).mode === 'specificElements')
              return <ScrapeElementsForm editingStepId={editingStepId!} />;
            return <ScrapeForm editingStepId={editingStepId!} />;
          case 'selectEach':      return <SelectEachForm editingStepId={editingStepId!} />;
          case 'captureApiCalls': return <NetworkRecorderView editingStepId={editingStepId!} />;
          case 'awaitUserAction': return <AwaitUserActionForm editingStepId={editingStepId!} />;
          default:                return <StepList />;
        }
      }
      case 'SEARCH_VAR_INPUT':
        return <SearchVarInput />;
      case 'RUNNING':
        return <RunProgress />;
      case 'RESULTS':
      case 'RUN_ERROR':
        return <ResultsView />;
      case 'DATA_MAPPING':
        return <DataMappingView />;
      default:
        return <CreateConfigWelcome />;
    }
  };
```

Replace with (additions: `'NAVIGATE_TO_FORM'` case after `'GO_BACK_FORM'`; `'DETECTION_SETTINGS'` case after `'LOOP_CONFIG'`; `case 'navigateTo'` inside `EDIT_STEP`):

```typescript
  const renderView = () => {
    switch (view) {
      case 'NO_CONFIG':
        return <CreateConfigWelcome />;
      case 'CREATE_CONFIG':
        return <CreateConfigForm />;
      case 'STEP_LIST':
        return <StepList />;
      case 'ADD_STEP_MENU':
        return <AddStepMenu />;
      case 'SET_INPUT_FORM':
        return <SetInputForm />;
      case 'CLICK_FORM':
        return <ClickElementForm />;
      case 'BEST_MATCH_FORM':
        return <BestMatchForm />;
      case 'GO_BACK_FORM':
        return <GoBackForm />;
      case 'NAVIGATE_TO_FORM':
        return <NavigateToForm />;
      case 'SCRAPE_FORM':
        return <ScrapeForm />;
      case 'SCRAPE_WHOLE_PAGE_FORM':
        return <ScrapeWholePageForm />;
      case 'SCRAPE_ELEMENTS_FORM':
        return <ScrapeElementsForm />;
      case 'SELECT_EACH_FORM':
        return <SelectEachForm />;
      case 'CAPTURE_API_CALLS_FORM':
        return <NetworkRecorderView />;
      case 'AWAIT_USER_ACTION_FORM':
        return <AwaitUserActionForm />;
      case 'LOOP_CONFIG':
        return <LoopConfig />;
      case 'DETECTION_SETTINGS':
        return <DetectionSettings />;
      case 'SAVE_CONFIG':
        return <SaveConfigForm />;
      case 'EDIT_STEP': {
        const editStep = steps.find(s => s.id === editingStepId);
        if (!editStep) return <StepList />;
        switch (editStep.type) {
          case 'setInput':        return <SetInputForm editingStepId={editingStepId!} />;
          case 'click':           return <ClickElementForm editingStepId={editingStepId!} />;
          case 'bestMatch':       return <BestMatchForm editingStepId={editingStepId!} />;
          case 'goBack':          return <GoBackForm editingStepId={editingStepId!} />;
          case 'navigateTo':      return <NavigateToForm editingStepId={editingStepId!} />;
          case 'scrape':
            if ((editStep.options as { mode?: string }).mode === 'wholePage')
              return <ScrapeWholePageForm editingStepId={editingStepId!} />;
            if ((editStep.options as { mode?: string }).mode === 'specificElements')
              return <ScrapeElementsForm editingStepId={editingStepId!} />;
            return <ScrapeForm editingStepId={editingStepId!} />;
          case 'selectEach':      return <SelectEachForm editingStepId={editingStepId!} />;
          case 'captureApiCalls': return <NetworkRecorderView editingStepId={editingStepId!} />;
          case 'awaitUserAction': return <AwaitUserActionForm editingStepId={editingStepId!} />;
          default:                return <StepList />;
        }
      }
      case 'SEARCH_VAR_INPUT':
        return <SearchVarInput />;
      case 'RUNNING':
        return <RunProgress />;
      case 'RESULTS':
      case 'RUN_ERROR':
        return <ResultsView />;
      case 'DATA_MAPPING':
        return <DataMappingView />;
      default:
        return <CreateConfigWelcome />;
    }
  };
```

No other edits.

---

### 3.8 — `src/sidepanel/components/StepList.tsx`

Add a "Detection Settings" button immediately after the existing "Configure Loop" button.

Locate the button block at lines 167-172:

```typescript
        <button
          className="btn btn-secondary btn-full mt-4"
          onClick={() => pushView('LOOP_CONFIG')}
        >
          Configure Loop
        </button>
```

Add a sibling button directly after it. The block becomes:

```typescript
        <button
          className="btn btn-secondary btn-full mt-4"
          onClick={() => pushView('LOOP_CONFIG')}
        >
          Configure Loop
        </button>

        <button
          className="btn btn-secondary btn-full mt-4"
          onClick={() => pushView('DETECTION_SETTINGS')}
        >
          Detection Settings
        </button>
```

No other edits.

---

### 3.9 — NEW: `src/sidepanel/components/NavigateToForm.tsx`

Create the file with this exact content:

```typescript
import BackButton from './BackButton';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import type { NavigateToOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function NavigateToForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<NavigateToOptions>;

  if (!step) return null;

  const url = opts.url ?? '';
  const canSave = url.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Go to URL</h2>
      </div>

      <p className="view-subtitle">
        Send the browser to a specific page. Useful as a starting point or to jump back to a known URL.
      </p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Open product page"
        />
      </div>

      <div className="form-group">
        <label className="form-label">URL</label>
        <input
          className="form-input"
          value={url}
          onChange={e => updateStepOptions(step.id, { url: e.target.value } as Partial<NavigateToOptions>)}
          placeholder="https://example.com/page/{searchTerm}"
        />
        <p className="form-hint">
          Use <code>{'{searchTerm}'}</code> anywhere in the URL to substitute the current loop term.
        </p>
      </div>

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full"
          onClick={handleSave}
          disabled={!canSave}
        >
          Save Step
        </button>
      </div>
    </div>
  );
}
```

---

### 3.10 — NEW: `src/sidepanel/components/DetectionSettings.tsx`

Create the file with this exact content:

```typescript
import { useState } from 'react';
import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { parseExtraSelectors, formatExtraSelectors } from '../utils/parseExtraSelectors';
import type { AutoDetectConfig } from '../../types/config';

type ToggleKey = 'cloudflare' | 'loginWall' | 'captcha' | 'cookieBanner';

interface ToggleSpec {
  key: ToggleKey;
  label: string;
  hint: string;
}

const TOGGLES: ToggleSpec[] = [
  { key: 'cloudflare',   label: 'Cloudflare challenges', hint: "Pause when Cloudflare 'verify you're human' shows up." },
  { key: 'loginWall',    label: 'Login walls',           hint: 'Pause when a sign-in form appears.' },
  { key: 'captcha',      label: 'Captchas',              hint: 'Pause when reCAPTCHA, hCaptcha, or similar shows up.' },
  { key: 'cookieBanner', label: 'Cookie banners',        hint: 'Pause when a cookie/consent prompt appears.' },
];

export default function DetectionSettings() {
  const { autoDetect, setAutoDetect, setView } = useConfigStore();
  const [extraText, setExtraText] = useState(() => formatExtraSelectors(autoDetect?.extraSelectors));

  // Lazy-init: a missing field reads as default-on (true).
  const isChecked = (key: ToggleKey): boolean => autoDetect?.[key] !== false;

  const toggle = (key: ToggleKey) => {
    const next: AutoDetectConfig = { ...(autoDetect ?? {}), [key]: !isChecked(key) };
    setAutoDetect(next);
  };

  const commitExtras = (text: string): void => {
    const selectors = parseExtraSelectors(text);
    const next: AutoDetectConfig = {
      ...(autoDetect ?? {}),
      extraSelectors: selectors.length > 0 ? selectors : undefined,
    };
    setAutoDetect(next);
  };

  const handleDone = () => {
    commitExtras(extraText);
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Detection Settings</h2>
      </div>

      <p className="view-subtitle">
        Auto-pause the scraper when these things appear on the page. The scraper waits for you to handle them, then continues.
      </p>

      {TOGGLES.map((t) => (
        <div key={t.key} className="form-group">
          <label className="form-check">
            <input
              type="checkbox"
              checked={isChecked(t.key)}
              onChange={() => toggle(t.key)}
            />
            {t.label}
          </label>
          <p className="form-hint">{t.hint}</p>
        </div>
      ))}

      <div className="form-group">
        <label className="form-label">Extra things to watch for (advanced)</label>
        <textarea
          className="form-textarea"
          rows={4}
          value={extraText}
          onChange={(e) => setExtraText(e.target.value)}
          onBlur={() => commitExtras(extraText)}
          placeholder="#some-blocker&#10;.paywall"
        />
        <p className="form-hint">
          One CSS selector per line. The scraper pauses if any of them appears on the page.
        </p>
      </div>

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleDone}>
          Done
        </button>
      </div>
    </div>
  );
}
```

---

### 3.11 — NEW: `src/__tests__/parseExtraSelectors.test.ts`

Create the file with this exact content:

```typescript
import { describe, it, expect } from 'vitest';
import { parseExtraSelectors, formatExtraSelectors } from '../sidepanel/utils/parseExtraSelectors';

describe('parseExtraSelectors', () => {
  it('returns empty array for empty string', () => {
    expect(parseExtraSelectors('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseExtraSelectors('   \n\n  \n')).toEqual([]);
  });

  it('parses a single selector', () => {
    expect(parseExtraSelectors('.foo')).toEqual(['.foo']);
  });

  it('parses multiple selectors split by newlines', () => {
    expect(parseExtraSelectors('.foo\n.bar')).toEqual(['.foo', '.bar']);
  });

  it('trims whitespace and drops empty lines', () => {
    expect(parseExtraSelectors('  .foo  \n\n  .bar  ')).toEqual(['.foo', '.bar']);
  });

  it('deduplicates while preserving first-seen order', () => {
    expect(parseExtraSelectors('.foo\n.bar\n.foo\n.baz\n.bar')).toEqual(['.foo', '.bar', '.baz']);
  });

  it('preserves complex selector strings verbatim', () => {
    expect(parseExtraSelectors('div[data-x="1"]:not(.hidden)\n#main > p'))
      .toEqual(['div[data-x="1"]:not(.hidden)', '#main > p']);
  });
});

describe('formatExtraSelectors', () => {
  it('returns empty string for undefined', () => {
    expect(formatExtraSelectors(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(formatExtraSelectors([])).toBe('');
  });

  it('joins with newlines', () => {
    expect(formatExtraSelectors(['.foo', '.bar'])).toBe('.foo\n.bar');
  });

  it('round-trips with parseExtraSelectors', () => {
    const input = ['.foo', '.bar', '.baz'];
    expect(parseExtraSelectors(formatExtraSelectors(input))).toEqual(input);
  });
});
```

---

## 4. Verification

### 4.1 — Automated

Run from the extension repo root (`c:\Users\und3r\blueberry-v3`):

```bash
npm run type-check    # MUST pass cleanly — Record<StepType, ...> exhaustiveness now requires navigateTo
npm test              # all existing vitest green + 11 new tests in parseExtraSelectors.test.ts
npm run lint          # ESLint clean
npm run build         # WXT build clean; no manifest changes expected
```

If `npm run type-check` fails after configStore + AddStepMenu changes, that almost certainly indicates a missed `navigateTo` case somewhere — re-read 3.5 and 3.6 carefully before adjusting types.

### 4.2 — Manual smoke (in this order)

Start the extension (`npm run dev` in WXT, load the unpacked dist into Chrome).

1. **Cold-start cookie banner pause.** Open https://www.theguardian.com (or any UK news site with a visible cookie banner). Open the extension sidepanel. Load any existing config that does **not** start with a `navigateTo` step (e.g. one that just scrapes the page). Click Run. Expected: scraper pauses **before any step** with the message "Dismiss the cookie banner to continue." After dismissing the banner manually, click Resume. Scrape proceeds.

2. **Cold-start clean page.** Open https://example.com. Run any config. Expected: no cold-start pause; scraper proceeds straight to step 1.

3. **navigateTo from menu.** Create a new config. Click Add First Step. Verify "Go to URL" appears in the menu, between "Go Back" and "Grab Data". Click it. The form opens with title "Go to URL". Fill URL: `https://en.wikipedia.org/wiki/{searchTerm}`. Save Step. Add a `Grab Data` step on the page. Save the config. Run with searchTerm `Cats`. Expected: browser navigates to the Cats Wikipedia article, then scrape runs.

4. **navigateTo URL validation.** Open the navigateTo step for editing. Clear the URL field. Verify Save Step button is disabled. Type `not a url`. Verify Save Step button enables. Save. Run config. Expected: at runtime, the scraper raises an error "navigateTo: invalid URL ..." and reports it in run progress.

5. **Detection Settings — disable cookie banners.** Load an existing config. From STEP_LIST, click "Detection Settings". Verify all 4 toggles show as checked (default-on, lazy-init). Uncheck "Cookie banners". Click Done. Save the config. Run on a cookie-banner site. Expected: scraper does NOT pause on the cookie banner. Other detectors (login, captcha, cloudflare) still fire normally.

6. **Detection Settings — extra selectors.** Open Detection Settings for any config. In the textarea type `.paywall` on one line and `#blocker` on another. Click Done. Save the config. Run on a page that has a `.paywall` element. Expected: scraper auto-pauses with "Action needed in your browser." After removing/dismissing the element, click Resume. Scrape continues.

7. **Lazy-init persistence.** Load a v3 or v4 config that's never had autoDetect set. Open Detection Settings without toggling anything. Click Done. Open the browser DevTools → Application → Storage → chrome.storage.local → `blueberry_scraper_configs`. Find the config and verify it does **not** have an `autoDetect` field, and `schemaVersion` is still 4. (If `isDirty` was set by entering the panel and the user saves, the config persists with `autoDetect: undefined` and `schemaVersion: 4` — verify field is absent in the persisted JSON.)

8. **Materialisation.** Repeat #7 but toggle one checkbox off, then save. Verify the persisted config now has `"autoDetect": { ..., "<toggled-key>": false }` and `"schemaVersion": 5`.

9. **Resume after cold-start pause.** Trigger the cold-start pause from #1. Dismiss the banner and click Resume. Continue running. If the config later navigates to another page with a banner, the post-navigation watchdog (PR1's existing path) fires. Expected: only one pause active at a time; no double-fire on the same gate.

10. **awaitUserAction step regression.** Load a config that already has an `awaitUserAction` step with `detectionRules.loginWall = true` (existing PR1 behaviour). Run on a login page. Expected: pause fires from the `awaitUserAction` step (not the cold-start hook — order: cold-start watchdog runs first, but on a login page it would also fire and cover this case; verify the awaitUserAction step still works in isolation by running on a non-login page that the step targets via condition).

11. **navigateTo in setup phase.** Edit a config and toggle the `navigateTo` step's `isSetup` flag (via JSON or by the existing setup-toggle UX in StepCard). Run. Expected: cold-start watchdog runs once before any step. The navigateTo runs as a setup step. Post-nav watchdog fires after navigateTo. Loop steps execute. No deadlock, no double-pause on the same gate.

### 4.3 — Smoke confirmation

After all 11 manual steps pass, report success with the same convention used for M3/M4/M5: list which steps passed, which (if any) had to be retried, and any incidental observations.

---

## 5. Maintainability checklist (per CLAUDE.md Stage F)

- [ ] **No magic strings.** New view names (`'NAVIGATE_TO_FORM'`, `'DETECTION_SETTINGS'`) are inline literals matching the existing convention in this file. No global string-constant module needed because the existing code uses inline literals throughout.
- [ ] **Narrow types.** `ToggleKey` is a literal-union type; `AutoDetectConfig` is the existing PR1 type; no `any`.
- [ ] **Minimal public surface.** `parseExtraSelectors` and `formatExtraSelectors` are the only new exports from utils. `NavigateToForm` and `DetectionSettings` are default exports of new components.
- [ ] **Configurable knobs.** No new tunables introduced. Detector priorities live in PR1's `runDetectorWatchdog`.
- [ ] **Reuse > create.** `runDetectorWatchdog` (PR1), `runWatchdogPause` (PR1), `BackButton`, `StepConditionEditor`, `useConfigStore`, all existing CSS classes — reused. No new design tokens, no new global styles.
- [ ] **One responsibility per module.** `parseExtraSelectors` is a pure parser; `DetectionSettings` is just the panel; `NavigateToForm` is just the step form; cold-start hook is two lines.
- [ ] **Tests.** `parseExtraSelectors.test.ts` covers the pure function. UI components are integration-tested via the manual smoke (deliberate — Vitest mocking of executeFlow + browser.runtime.* is brittle for one statement).
- [ ] **Backward compat.** v3/v4 configs unchanged on load (`autoDetect: undefined`). Save without toggling autoDetect produces a v4 config with `autoDetect: undefined`. Save after toggling produces a v5 config with `autoDetect` materialised. `migrateConfig` early-returns on v5 (already handled by line 22 of storage.ts).

---

## 6. Out of scope

The following are deliberately **not** addressed in this PR:

- Surfacing `awaitUserAction.detectionRules` in UI (still JSON-only — autoDetect supersedes the common case).
- Any change to `background.ts`, `scheduler.ts`, or task-state model (PR2).
- Pre-flight quiet timer (PR3).
- Phase machine / same-origin gate (PR4).
- BatchTaskList / BatchControls / consolidated PauseAlert (PR5).
- Notifications + manifest permission (PR6).
- Settings store batch knobs (PR3+).
- Any backend (.NET) or backend frontend changes.

If during implementation any spec assumption appears contradicted by the codebase (e.g. PR1's types or the `runWatchdogPause` helper are not where this spec says they are), **stop and escalate** rather than improvising — per the M3 spec-assumption-mismatch precedent recorded in memory.

---

## 7. Stuck-loop escalation

Per global CLAUDE.md: if two consecutive attempts at the same fix have failed, stop and report. Do not attempt a third variation in the same direction. Likely failure modes for this PR:

- **TypeScript exhaustiveness errors** after the `Record<StepType, ...>` change in AddStepMenu. Solution path: ensure `getDefaultOptions` has the `navigateTo` case (3.5.4) — if the error reports "missing 'navigateTo'" anywhere, the change in 3.5 was incomplete. If the error is elsewhere, escalate.
- **`autoDetect` not persisting** across save/reload. Solution path: confirm 3.5.5(c) (`saveCurrentConfig` includes `autoDetect`) AND 3.5.5(d) (`loadConfig` reads `safe.autoDetect`). If both are present and the value is still missing, escalate.
- **Cold-start watchdog not firing.** Solution path: confirm the line was added INSIDE `if (!isResume) { try { ... } }` and BEFORE `for (const step of setupSteps)`. Verify by checking that PR1's `runWatchdogPause` is in scope (it should be — defined in the same file). If the function is missing, PR1 was incomplete — escalate.
