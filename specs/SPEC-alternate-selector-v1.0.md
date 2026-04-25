# SPEC — alternate selector fallback (v1.0)

> Stage F implementation spec for sub-problem A.3 of the staged plan at `~/.claude/plans/in-specs-there-is-mossy-pelican.md`. Stages A–E confirmed; this is Stage F. Implementer should follow exactly; deviations need plan owner approval.

---

## Context

Some flows legitimately start from different page layouts where the same logical element (a search input, a button, a `bestMatch` container) lives at a different DOM position. Today every step has a single primary selector ([BaseStep.selector at config.ts:22-29](../src/types/config.ts#L22-L29)), and a narrow workaround — [SetInputOptions.subsequentSelector at config.ts:39](../src/types/config.ts#L39) — applies only to `setInput` and only on iteration 2+.

This spec replaces the iteration-gated `subsequentSelector` with a general **`alternateSelector`** (or **`alternateContainerSelector`** on `bestMatch`) on every step that has a primary action selector. Try primary first; if `resolveElement` returns `null`, try alternate. Decoupled from iteration index — applies on every iteration.

The full sticky-flowIndex / N-selector array design from [FUTURE-v3-resilience-and-ux.md section A](../specs/FUTURE-v3-resilience-and-ux.md) is **not** built. This is the smallest version that solves the user's actual blocked flows; the larger design is revisited only if a real case requires stickiness.

---

## File 1 (MODIFIED): `src/types/config.ts`

### Change 1 — Rename `subsequentSelector` → `alternateSelector` on `SetInputOptions`

Locate `SetInputOptions` at lines 33–40. Replace the entire interface with:

```ts
export interface SetInputOptions {
  clearBefore: boolean;
  pressEnterAfter: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  isInitialInput: boolean;
  alternateSelector: SelectorDescriptor | null;
}
```

(Field at line 39 changes `subsequentSelector` → `alternateSelector`. All other fields and order preserved. `isInitialInput` is retained even though it becomes unused at runtime; cleanup is out of scope for this pass.)

### Change 2 — Add `alternateSelector` to `ClickOptions`

Locate `ClickOptions` at lines 42–46. Replace with:

```ts
export interface ClickOptions {
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
  alternateSelector: SelectorDescriptor | null;
}
```

### Change 3 — Add `alternateContainerSelector` to `BestMatchOptions`

Locate `BestMatchOptions` at lines 48–56. Replace with:

```ts
export interface BestMatchOptions {
  matchStrictness: 'loose' | 'normal' | 'strict';
  containerSelector: SelectorDescriptor | null;
  alternateContainerSelector: SelectorDescriptor | null;
  clickableFilter: string;
  sameOriginOnly: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
}
```

### Change 4 — Bump `ScraperConfig.schemaVersion`

Locate `ScraperConfig` at lines 153–165. Change line 162 from:

```ts
  schemaVersion: 2;
```

to:

```ts
  schemaVersion: 3;
```

---

## File 2 (MODIFIED): `src/content/scraping/elementResolution.ts`

### Change 1 — Add `resolveWithAlternate` helper

Locate `resolveElement` at lines 128–271. Insert the following function **immediately after** the closing brace of `resolveElement` at line 271 (before `function classesOverlap` at line 273):

```ts
export function resolveWithAlternate(
  primary: SelectorDescriptor,
  alternate: SelectorDescriptor | null,
  root: Document | ShadowRoot = document,
): ResolveResult {
  const r = resolveElement(primary, root);
  if (r.element) return r;
  if (!alternate) return r;
  return resolveElement(alternate, root);
}
```

**Semantics:**
- Try `primary`. If `element` is non-null (i.e. any positive confidence), return it. Alternate is not consulted.
- If `primary` returns `{ element: null }`, fall through.
- If `alternate` is `null`, return primary's null result (preserves the original `confidence: 0, strategy: 'none'`).
- Otherwise, call `resolveElement(alternate, root)` and return its result regardless of outcome.

---

## File 3 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### Change 1 — Import `resolveWithAlternate`

Locate the existing import block at the top of the file. Find the line that imports from `./elementResolution`. Add `resolveWithAlternate` to that import alongside `resolveElement`. (Exact statement depends on what's already there.)

### Change 2 — Update `resolveWithRetry` to accept an alternate

Locate `resolveWithRetry` at lines 784–809. Replace the entire function with:

```ts
async function resolveWithRetry(
  primary: SelectorDescriptor,
  alternate: SelectorDescriptor | null,
  onProgress: OnProgress,
  label: string,
  maxRetries = 3,
): Promise<HTMLElement> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    checkAbort();
    const { element, confidence, strategy } = resolveWithAlternate(primary, alternate);
    if (element) {
      onProgress?.(`Resolved "${label}" via ${strategy} (${(confidence * 100).toFixed(0)}%)`);
      return element as HTMLElement;
    }

    if (attempt < maxRetries) {
      onProgress?.(`Couldn't find "${label}", retrying (${attempt}/${maxRetries})...`);
      await randomDelay(1000, 1500);
    }
  }

  const primaryHints = describeDescriptor(primary);
  const altHints = alternate ? `; alternate: ${describeDescriptor(alternate)}` : '';
  onProgress?.(`Resolver failed for "${label}". Tried: ${primaryHints}${altHints}`);
  throw new Error(
    `Element not found: Could not locate "${label}" after ${maxRetries} attempts. Tried: ${primaryHints}${altHints}`,
  );
}
```

**Rationale.** Each retry attempt tries primary then alternate before sleeping; this gives the alternate the same retry budget as primary without doubling wall-clock time. Error message now reports both descriptors when alternate was provided.

### Change 3 — Update `executeSetInput` to use alternate; delete `subsequentSelector` branch

Locate `executeSetInput` at lines 327–359. Replace the entire function with:

```ts
async function executeSetInput(
  step: import('../../types/config').SetInputStep,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;

  const el = await resolveWithRetry(
    step.selector!,
    opts.alternateSelector ?? null,
    onProgress,
    step.label || 'input',
  );

  onProgress?.(`Typing "${searchTerm ?? ''}" into ${step.label || 'input field'}`);

  if (opts.clearBefore !== false) {
    await clearInput(el);
  }

  await typeText(el, searchTerm ?? '');

  if (opts.pressEnterAfter) {
    await randomDelay(100, 300);
    await pressEnter(el);
    await waitAfterAction(opts, onProgress);
  } else {
    await randomDelay(600, 1200);
  }

  void iterationIndex; // No longer used — alternate is iteration-independent.
  void afk;
  return null;
}
```

**Removed:**
- `const isInitial = opts.isInitialInput !== false;`
- `const useSubsequent = iterationIndex > 0 && opts.subsequentSelector && isInitial;`
- `const descriptor = useSubsequent ? opts.subsequentSelector! : step.selector!;`

`iterationIndex` stays in the parameter list (the dispatcher passes it; signature stability avoids ripple changes), but is now `void`-tagged to satisfy lint.

### Change 4 — Update `executeClick` to use alternate

Locate `executeClick` at lines 361–374. Replace with:

```ts
async function executeClick(
  step: ClickStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;
  const el = await resolveWithRetry(
    step.selector!,
    opts.alternateSelector ?? null,
    onProgress,
    step.label || 'button',
  );

  onProgress?.(`Clicking ${step.label || 'element'}`);
  await naturalClick(el, { afk });

  await waitAfterAction(opts, onProgress);
  return null;
}
```

### Change 5 — Update `executeBestMatch` container resolution to use alternate

Locate `executeBestMatch` at lines 378–454. Find lines 396–404:

```ts
  const { element: container } = resolveElement(opts.containerSelector);
  if (!container) {
    // Pass-through: assume we've already landed on the destination page
    // (e.g. search that sometimes hits disambiguation, sometimes the article directly).
    // Caveat: relies on container selector being specific enough not to exist on
    // the "already-landed" page.
    onProgress?.('Best-match container not found on this page — continuing as if already on destination');
    return null;
  }
```

Replace with:

```ts
  const { element: container } = resolveWithAlternate(
    opts.containerSelector,
    opts.alternateContainerSelector ?? null,
  );
  if (!container) {
    // Pass-through: assume we've already landed on the destination page
    // (e.g. search that sometimes hits disambiguation, sometimes the article directly).
    // Caveat: relies on container (and alternate) selectors being specific enough not
    // to exist on the "already-landed" page.
    onProgress?.('Best-match container not found on this page — continuing as if already on destination');
    return null;
  }
```

(The pass-through behaviour for "no container at all" is preserved; alternate is consulted before pass-through fires.)

---

## File 4 (MODIFIED): `src/sidepanel/utils/storage.ts`

### Change 1 — Bump schema version

Change line 6 from:

```ts
export const CURRENT_SCHEMA_VERSION = 2;
```

to:

```ts
export const CURRENT_SCHEMA_VERSION = 3;
```

### Change 2 — Update step-option defaults

Replace the `STEP_OPTION_DEFAULTS` object at lines 8–17 with:

```ts
const STEP_OPTION_DEFAULTS: Record<string, Record<string, unknown>> = {
  setInput:   { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null },
  click:      { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null },
  bestMatch:  { matchStrictness: 'normal', candidateSource: 'similar', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  goBack:     { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  scrape:     { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, elements: [] },
  selectEach: { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } },
  captureApiCalls: { urlPattern: '', durationMs: 5000, includeResponseBody: true },
  awaitUserAction: { message: '' },
};
```

(Setting `subsequentSelector: null` on `setInput` is replaced with `alternateSelector: null`. New `alternateSelector: null` added to `click`. New `alternateContainerSelector: null` added to `bestMatch`.)

### Change 3 — Migrate legacy `subsequentSelector` to `alternateSelector`

Locate `migrateConfig` at lines 19–55. Replace the step-mapping block at lines 36–51 with:

```ts
  migrated.steps = (migrated.steps as Array<Record<string, unknown>>)
    .map((step) => {
      if (!step || typeof step !== 'object') return null;
      const defaults = STEP_OPTION_DEFAULTS[step.type as string] || {};
      const rawOpts = (step.options as Record<string, unknown>) || {};

      // v2 → v3: SetInputOptions.subsequentSelector → alternateSelector.
      if (step.type === 'setInput' && 'subsequentSelector' in rawOpts) {
        rawOpts.alternateSelector = rawOpts.subsequentSelector ?? null;
        delete rawOpts.subsequentSelector;
      }

      return {
        id: step.id,
        type: step.type,
        label: step.label || '',
        isSetup: step.isSetup ?? false,
        selector: step.selector || null,
        elementType: step.elementType || null,
        extra: step.extra || null,
        options: { ...defaults, ...rawOpts },
      };
    })
    .filter(Boolean);
```

**Note:** if [SPEC-step-conditions-v1.0.md](./SPEC-step-conditions-v1.0.md) has already been merged (it adds a `condition` field carry-through to this same block), preserve that line — add `condition: (step.condition as Record<string, unknown> | null | undefined) ?? null,` to the returned object as it appears in that spec. This spec assumes step-conditions has not yet been merged; if it has, merge the two diffs.

The version guard at line 22 (`(config.schemaVersion as number || 0) >= CURRENT_SCHEMA_VERSION`) now short-circuits at v3, so migration runs once on first load of a v2 config.

---

## File 5 (MODIFIED): `src/sidepanel/stores/configStore.ts`

### Change 1 — Update default-options literals

Locate `getDefaultOptions` at lines 41–60. Replace each affected case:

**Line 44 (`setInput` default):** Replace
```ts
      return { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, subsequentSelector: null } satisfies SetInputOptions;
```
with
```ts
      return { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null } satisfies SetInputOptions;
```

**Line 46 (`click` default):** Replace
```ts
      return { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null } satisfies ClickOptions;
```
with
```ts
      return { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } satisfies ClickOptions;
```

**Line 48 (`bestMatch` default):** Replace
```ts
      return { matchStrictness: 'normal', containerSelector: null, clickableFilter: 'a, button', sameOriginOnly: true, waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies BestMatchOptions;
```
with
```ts
      return { matchStrictness: 'normal', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', sameOriginOnly: true, waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies BestMatchOptions;
```

### Change 2 — Update `schemaVersion` literal type

Locate `saveCurrentConfig` at lines 197–214. Change line 207 from:

```ts
      schemaVersion: CURRENT_SCHEMA_VERSION as 2,
```

to:

```ts
      schemaVersion: CURRENT_SCHEMA_VERSION as 3,
```

---

## File 6 (MODIFIED): `src/sidepanel/utils/pickerDispatch.ts`

### Change 1 — Replace `handleSubsequent` with `handleAlternate`

Locate `handleSubsequent` at lines 26–29. Replace the entire function with:

```ts
function handleAlternate(stepId: string, pickData: PickData): void {
  const { descriptor } = pickData;
  const { steps, draftStep, updateStepOptions } = useConfigStore.getState();
  const step =
    steps.find((s) => s.id === stepId) ||
    (draftStep?.id === stepId ? draftStep : null);
  if (!step) return;

  if (step.type === 'bestMatch') {
    updateStepOptions(stepId, { alternateContainerSelector: descriptor } as never);
  } else {
    // setInput, click — both store alternate under `alternateSelector`.
    updateStepOptions(stepId, { alternateSelector: descriptor } as never);
  }
}
```

### Change 2 — Update `dispatchPickerResult` field routing

Locate `dispatchPickerResult` at lines 142–168. Find the branch at lines 155–156:

```ts
  } else if (field === 'subsequent') {
    handleSubsequent(stepId, pickData);
```

Replace with:

```ts
  } else if (field === 'alternate') {
    handleAlternate(stepId, pickData);
```

---

## File 7 (MODIFIED): `src/sidepanel/components/SetInputForm.tsx`

### Change 1 — Rename "subsequent" UI to "alternate"

Locate the `useState` at line 19. Replace:

```ts
  const [showSubsequent, setShowSubsequent] = useState(!!opts.subsequentSelector);
```

with:

```ts
  const [showAlternate, setShowAlternate] = useState(!!opts.alternateSelector);
```

### Change 2 — Update the picker dispatch field name

Locate `handlePickElement` at lines 26–35. Find line 31:

```ts
      useUiStore.getState().setPendingPickerField(field);
```

The `field` parameter currently accepts `'primary'` or `'subsequent'`. Update the function's default and call sites in this file:
- Line 26 default: `(field = 'primary')` — unchanged.
- Line 156 call: change `handlePickElement('subsequent')` to `handlePickElement('alternate')`.
- Line 159 call: change `handlePickElement('subsequent')` to `handlePickElement('alternate')`.

### Change 3 — Replace the "subsequent" form-group with the new "alternate" form-group

Locate lines 136–164. Replace the entire block (the `form-group` with the `showSubsequent` checkbox plus the conditional `{showSubsequent && (...)}` block) with:

```tsx
      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={showAlternate}
            onChange={e => {
              setShowAlternate(e.target.checked);
              if (!e.target.checked) updateOpt('alternateSelector', null);
            }}
          />
          Add fallback location
        </label>
        <p className="form-hint">Try this if the primary input can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback input element</label>
          <PickedElementPreview
            selector={opts.alternateSelector ?? null}
            onRepick={() => handlePickElement('alternate')}
          />
          {!opts.alternateSelector && (
            <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickElement('alternate')}>
              Pick Fallback Element
            </button>
          )}
        </div>
      )}
```

---

## File 8 (MODIFIED): `src/sidepanel/components/ClickElementForm.tsx`

### Change 1 — Add `useState` import and alternate state

Update line 1 from:

```ts
import BackButton from './BackButton';
```

to add `useState` (place at the very top, before `BackButton`):

```ts
import { useState } from 'react';
import BackButton from './BackButton';
```

Locate the destructuring at line 13 and the `opts` derivation at line 16. Insert **after** line 16 (before line 18's early return):

```ts
  const [showAlternate, setShowAlternate] = useState(!!opts.alternateSelector);
```

### Change 2 — Update `handlePickElement` to support a field parameter

Replace `handlePickElement` at lines 23–32 with:

```tsx
  const handlePickElement = async (field = 'primary') => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(field);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };
```

(Only change is `()` → `(field = 'primary')` and `'primary'` → `field` in the `setPendingPickerField` call.)

Update the existing call at line 68 (`onRepick={handlePickElement}`) — leave as-is; default `'primary'` applies. Update line 71 (`onClick={handlePickElement}`) — leave as-is.

### Change 3 — Insert "Add fallback location" toggle and picker

Locate `<div className="form-actions">` at line 119. Insert **immediately above** that line:

```tsx
      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={showAlternate}
            onChange={e => {
              setShowAlternate(e.target.checked);
              if (!e.target.checked) updateOpt('alternateSelector', null);
            }}
          />
          Add fallback location
        </label>
        <p className="form-hint">Try this if the primary button can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback element to click</label>
          <PickedElementPreview
            selector={opts.alternateSelector ?? null}
            onRepick={() => handlePickElement('alternate')}
          />
          {!opts.alternateSelector && (
            <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickElement('alternate')}>
              Pick Fallback Element
            </button>
          )}
        </div>
      )}

```

(Trailing blank line above `<div className="form-actions">`.)

---

## File 9 (MODIFIED): `src/sidepanel/components/BestMatchForm.tsx`

### Change 1 — Add `useState` import and alternate state

Update line 1 from:

```ts
import BackButton from './BackButton';
```

to:

```ts
import { useState } from 'react';
import BackButton from './BackButton';
```

Locate the early return and `opts` derivation. Insert before the early `if (!step) return null;` at line 24:

```ts
  const [showAlternate, setShowAlternate] = useState(!!(opts as Record<string, unknown>).alternateContainerSelector);
```

### Change 2 — Update `handlePickContainer` to take a field parameter

Replace `handlePickContainer` at lines 29–38 with:

```tsx
  const handlePickContainer = async (field = 'container') => {
    try {
      await sendToContent('START_PICKER', { mode: 'container' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(field);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };
```

Existing call sites at lines 78 (`onRepick={handlePickContainer}`) and 88 (`onClick={handlePickContainer}`) — leave as-is; default `'container'` applies.

### Change 3 — Insert "Add fallback container" toggle and picker

Locate `<div className="form-actions">` at line 162. Insert **immediately above** that line:

```tsx
      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={showAlternate}
            onChange={e => {
              setShowAlternate(e.target.checked);
              if (!e.target.checked) updateOpt('alternateContainerSelector', null);
            }}
          />
          Add fallback location
        </label>
        <p className="form-hint">Try this if the primary container can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback container element</label>
          <PickedElementPreview
            selector={(opts as { alternateContainerSelector: typeof opts.containerSelector }).alternateContainerSelector ?? null}
            elementType="generic"
            onRepick={() => handlePickContainer('alternate')}
          />
          {!(opts as { alternateContainerSelector: typeof opts.containerSelector }).alternateContainerSelector && (
            <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickContainer('alternate')}>
              Pick Fallback Container
            </button>
          )}
        </div>
      )}

```

---

## File 10 (NEW or APPEND): `src/content/scraping/elementResolution.test.ts`

If the file does not exist, create it. If it does, append the following describe block.

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveWithAlternate } from './elementResolution';
import type { SelectorDescriptor } from '../../types/config';

describe('resolveWithAlternate', () => {
  it('returns primary result when primary resolves', () => {
    document.body.innerHTML = `<button id="p">primary</button><button id="a">alt</button>`;
    const primary = { cssSelector: '#p' } as SelectorDescriptor;
    const alternate = { cssSelector: '#a' } as SelectorDescriptor;
    const r = resolveWithAlternate(primary, alternate);
    expect((r.element as HTMLElement)?.id).toBe('p');
  });

  it('falls back to alternate when primary fails', () => {
    document.body.innerHTML = `<button id="a">alt</button>`;
    const primary = { cssSelector: '#missing' } as SelectorDescriptor;
    const alternate = { cssSelector: '#a' } as SelectorDescriptor;
    const r = resolveWithAlternate(primary, alternate);
    expect((r.element as HTMLElement)?.id).toBe('a');
  });

  it('returns null result when both fail', () => {
    document.body.innerHTML = ``;
    const primary = { cssSelector: '#missing' } as SelectorDescriptor;
    const alternate = { cssSelector: '#alsoMissing' } as SelectorDescriptor;
    const r = resolveWithAlternate(primary, alternate);
    expect(r.element).toBe(null);
    expect(r.confidence).toBe(0);
  });

  it('returns null result when primary fails and alternate is null', () => {
    document.body.innerHTML = ``;
    const primary = { cssSelector: '#missing' } as SelectorDescriptor;
    const r = resolveWithAlternate(primary, null);
    expect(r.element).toBe(null);
  });
});
```

---

## File 11 (NEW or APPEND): `src/sidepanel/utils/storage.test.ts`

If the file does not exist, create it. If it does, append the following describe block.

```ts
import { describe, it, expect } from 'vitest';
import { migrateConfig } from './storage';

describe('migrateConfig — v2 → v3 (alternate selector rename)', () => {
  it('renames subsequentSelector → alternateSelector on setInput steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x',
      name: 'n',
      domain: '',
      url: '',
      domainLocked: false,
      steps: [{
        id: 's1',
        type: 'setInput',
        label: '',
        isSetup: false,
        selector: null,
        elementType: null,
        extra: null,
        options: { subsequentSelector: { cssSelector: '#alt' }, clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false },
      }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    expect(migrated).not.toBeNull();
    const opts = migrated!.steps[0].options as Record<string, unknown>;
    expect(opts.alternateSelector).toEqual({ cssSelector: '#alt' });
    expect('subsequentSelector' in opts).toBe(false);
  });

  it('defaults alternateSelector to null on setInput when no subsequentSelector', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'setInput', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as Record<string, unknown>;
    expect(opts.alternateSelector).toBe(null);
  });

  it('defaults alternateSelector to null on click steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'click', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as Record<string, unknown>;
    expect(opts.alternateSelector).toBe(null);
  });

  it('defaults alternateContainerSelector to null on bestMatch steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'bestMatch', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as Record<string, unknown>;
    expect(opts.alternateContainerSelector).toBe(null);
  });

  it('is a no-op on already-v3 configs', () => {
    const v3 = {
      schemaVersion: 3,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'setInput', options: { alternateSelector: null } }],
    };
    const migrated = migrateConfig(v3 as Record<string, unknown>);
    expect((migrated!.steps[0].options as Record<string, unknown>).alternateSelector).toBe(null);
    expect((migrated!.steps[0].options as Record<string, unknown>).subsequentSelector).toBeUndefined();
  });
});
```

---

## Verify nothing else broke

After all edits, run from the repo root:

```bash
grep -rn "subsequentSelector" src/
```

Expected output: **zero matches**. Every reference must be migrated to `alternateSelector` or removed.

```bash
grep -rn "schemaVersion: 2" src/
```

Expected output: **zero matches**. The schema version literal should be 3 everywhere it appears.

```bash
grep -rn "field === 'subsequent'" src/
```

Expected output: **zero matches**. Picker field renamed to `'alternate'`.

---

## Verification

### Automated

Run from the repo root:

```bash
npm run lint
npm run type-check
npm run build
npm run test
```

All must pass with zero new errors. The new tests in `elementResolution.test.ts` and `storage.test.ts` must pass.

### Manual

1. **Layout-A vs Layout-B input.** Find a site where the search input lives in different DOM positions on landing vs. results pages (the user's motivating flow). Configure a `setInput` step. Pick the layout-A input as primary; toggle "Add fallback location" and pick the layout-B input as alternate. Save.
   - Run from layout A: should resolve via primary; alternate not used.
   - Run from layout B: primary fails, alternate resolves; flow continues.

2. **Legacy config migration.** Open browser devtools → Application → Local Storage → find the saved configs. Manually edit one to revert it to `schemaVersion: 2` with an old `subsequentSelector` field on a `setInput` step. Reload the extension. Open the editor. Confirm:
   - The "Add fallback location" toggle is on.
   - The Fallback element preview shows the old descriptor.
   - Save — `schemaVersion` becomes 3 and `subsequentSelector` is gone from storage.

3. **Click step alternate.** Configure a `click` step on a button that exists on page A. Toggle "Add fallback location" and pick a different button on page B. Run from each page; both succeed.

4. **BestMatch alternate container.** Configure a `bestMatch` step. `containerSelector` references a class absent on landing page B; `alternateContainerSelector` references a class present. Run; confirm alternate fires and the match is performed against the alternate container.

5. **No-alternate regression.** Open an existing config with no alternate set on any step. Run. Behaviour identical to current build.

### Edge cases (covered by design)

- *Both primary and alternate fail.* `resolveWithRetry` retries 3× and throws, identical failure mode to before.
- *Primary resolves with low confidence.* Alternate not consulted (Stage A.3 explicit decision).
- *Alternate identical to primary.* Both checks succeed first time; wasteful but correct.
- *Migration on a v3 config that has `subsequentSelector`* (corrupted state): the version guard short-circuits, the field stays. To force re-migration the user would have to manually downgrade `schemaVersion`.
- *SelectEach sub-step setInput/click.* Sub-steps still go through the same engine functions, so alternate applies wherever the step runs, including inside `selectEach`.

---

## Out of scope (do not add in v1)

- Priority-ordered arrays of N selectors (FUTURE-spec section A's full design).
- Sticky `flowIndex` threading across steps.
- Page-state detection / classification.
- Alternate selectors on nested step types: `ScrapeElementConfig.selector`, `SelectEachOptions.controlSelector`, etc.
- Cleanup of the now-unused `isInitialInput` field on `SetInputOptions`.
- UI for marking which alternate was used at runtime (debugging aid).

---

## Rollback

If a regression is found post-merge, revert with:

```bash
git revert <commit-sha>
```

The change includes a schema-version bump from 2 to 3. Reverting the code without addressing storage will leave saved configs at `schemaVersion: 3` with `alternateSelector` fields. The pre-revert `migrateConfig` (v2-only) would treat them as already-migrated and pass them through unchanged; the new field would be ignored at runtime. This is a soft incompatibility but not a corruption — saved configs continue to load. To clean up, users can re-save each config under the reverted code, which would write `schemaVersion: 2` back.
