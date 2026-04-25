# SPEC — step conditions ("only run if") (v1.0)

> Stage F implementation spec for sub-problem A.2 of the staged plan at `~/.claude/plans/in-specs-there-is-mossy-pelican.md`. Stages A–E confirmed; this is Stage F. Implementer should follow exactly; deviations need plan owner approval.

---

## Context

Some flows legitimately branch by page state. The canonical examples are Wikipedia (a `bestMatch` step is needed on a disambiguation page but must not run when search lands directly on an article) and Nomis census (search may land on a list of locations or, when there's a single match, jump straight to the report). The current engine has no way to express "only run this step if X."

A best-effort partial mitigation already exists for `bestMatch` ([scrapingEngine.ts:396-403](../src/content/scraping/scrapingEngine.ts#L396-L403)) — if the container selector doesn't resolve, the step assumes pass-through. But it's brittle (the container selector must not exist on the already-landed page) and applies only to `bestMatch`.

This spec adds an optional `condition` field to every step. Two predicate kinds: **URL matches a regex**, or **a selector resolves to an element**. Each predicate has a `negate` flag. The condition is evaluated immediately before step dispatch; on fail, the step is skipped (logged) and the next step runs. This is the minimal v1 from FUTURE-v3-resilience-and-ux.md section B; compound conditions, else-branches, and inter-step state are explicit non-goals.

---

## File 1 (MODIFIED): `src/types/config.ts`

### Change 1 — Add `StepCondition` discriminated union

Locate the `// ── Base step ──` section header at line 20. Insert the following block **immediately above** it (after the `SelectorDescriptor` interface declaration ending at line 18, before the section comment at line 20):

```ts
// ── Step conditions ───────────────────────────────────────────────────────────

export type StepCondition =
  | { kind: 'urlMatches';     pattern: string;              negate?: boolean }
  | { kind: 'elementPresent'; selector: SelectorDescriptor; negate?: boolean };
```

### Change 2 — Add `condition` to `BaseStep`

Locate `BaseStep` at lines 22–29. Replace the entire interface with:

```ts
export interface BaseStep {
  id: string;
  label: string;
  isSetup: boolean;
  selector: SelectorDescriptor | null;
  elementType: string | null;
  extra: Record<string, unknown> | null;
  condition?: StepCondition | null;
}
```

The new field is optional and defaults to absent (treated identically to `null`). No discriminated step interface changes required — `condition` rides on the base.

---

## File 2 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### Change 1 — Import `StepCondition`

Locate the existing import block at the top of the file. Find the import that pulls types from `../../types/config`. If `StepCondition` is not yet on it, add it. (The exact import statement depends on what's already there — preserve existing imports and add `StepCondition` alongside `Step`, `SetInputStep`, etc.)

### Change 2 — Add `evaluateCondition` helper

Locate the `// ── Step dispatch ──` section header at line 293. Insert the following function **immediately above** that comment (i.e. between the last existing helper and the dispatch section):

```ts
// ── Step conditions ──

function evaluateCondition(
  cond: import('../../types/config').StepCondition,
): boolean {
  try {
    if (cond.kind === 'urlMatches') {
      const regex = new RegExp(cond.pattern);
      const matches = regex.test(window.location.href);
      return cond.negate ? !matches : matches;
    }
    if (cond.kind === 'elementPresent') {
      const { confidence } = resolveElement(cond.selector);
      const present = confidence > 0;
      return cond.negate ? !present : present;
    }
    return true;
  } catch {
    // Invalid regex, missing selector fields, or any unexpected throw → fail-closed.
    // Running a step on the wrong page is worse than skipping it.
    return false;
  }
}
```

### Change 3 — Pre-dispatch condition check in `executeStep`

Locate `executeStep` starting at line 297. The function body begins with `switch (step.type) {` at line 304. Insert the following block **immediately before** that switch (between the closing `): Promise<...>` of the signature and the opening `switch`):

```ts
  if (step.condition) {
    const passed = evaluateCondition(step.condition);
    if (!passed) {
      onProgress?.(`Skipping ${step.label || step.type}: condition not met`);
      return null;
    }
  }

```

After this change, `executeStep` reads:

```ts
async function executeStep(
  step: Step,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown> | null> {
  if (step.condition) {
    const passed = evaluateCondition(step.condition);
    if (!passed) {
      onProgress?.(`Skipping ${step.label || step.type}: condition not met`);
      return null;
    }
  }

  switch (step.type) {
    // ...unchanged
  }
}
```

**Why `return null` and not `throw SkipIterationError`.** `SkipIterationError` aborts the whole search-term iteration. A skipped step must allow the next step to run. Returning `null` matches the existing return type (some step types already return `null`) and the caller's existing handling.

---

## File 3 (NEW): `src/content/scraping/scrapingEngine.test.ts` (or extend if it exists)

If a test file for `scrapingEngine.ts` does not yet exist, create it. If it does, append the following describe block.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./elementResolution', () => ({
  resolveElement: vi.fn(),
}));

import { resolveElement } from './elementResolution';
import type { StepCondition } from '../../types/config';

const resolveElementMock = resolveElement as unknown as ReturnType<typeof vi.fn>;

// Re-import the module under test AFTER mocks are set up.
// evaluateCondition is not exported; tests exercise it via a re-export shim.
// If evaluateCondition stays internal, expose it via:
//   export const __test = { evaluateCondition };
// and test through that shim. Otherwise export it directly.

describe('evaluateCondition', () => {
  beforeEach(() => {
    resolveElementMock.mockReset();
    Object.defineProperty(window, 'location', {
      value: { href: 'https://example.com/page?x=1' },
      writable: true,
    });
  });

  it('returns true when URL pattern matches', async () => {
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'example\\.com' };
    expect(evaluateCondition(cond)).toBe(true);
  });

  it('returns false when URL pattern does not match', async () => {
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'nope\\.test' };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('flips result when negate is true', async () => {
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'example', negate: true };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('returns false when regex pattern is invalid (fail-closed)', async () => {
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = { kind: 'urlMatches', pattern: '[unclosed' };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('returns true when elementPresent resolves with confidence > 0', async () => {
    resolveElementMock.mockReturnValue({ element: {} as Element, confidence: 0.5, strategy: 'css' });
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = {
      kind: 'elementPresent',
      selector: { cssSelector: '.x' } as never,
    };
    expect(evaluateCondition(cond)).toBe(true);
  });

  it('returns false when elementPresent resolves with confidence 0', async () => {
    resolveElementMock.mockReturnValue({ element: null, confidence: 0, strategy: 'none' });
    const { evaluateCondition } = await import('./scrapingEngine');
    const cond: StepCondition = {
      kind: 'elementPresent',
      selector: { cssSelector: '.x' } as never,
    };
    expect(evaluateCondition(cond)).toBe(false);
  });
});
```

If `evaluateCondition` cannot be exported (project convention), add a `export const __test = { evaluateCondition };` block at the bottom of `scrapingEngine.ts` and import via `__test.evaluateCondition` in tests. Either approach is acceptable.

---

## File 4 (NEW): `src/sidepanel/components/StepConditionEditor.tsx`

Create with **exactly** the following content:

```tsx
import { useState, useMemo } from 'react';
import PickedElementPreview from './PickedElementPreview';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import type { StepCondition, SelectorDescriptor } from '../../types/config';

interface Props {
  stepId: string;
}

type ConditionMode =
  | 'always'
  | 'urlMatches'
  | 'urlNotMatches'
  | 'elementPresent'
  | 'elementAbsent';

function modeFromCondition(c: StepCondition | null | undefined): ConditionMode {
  if (!c) return 'always';
  if (c.kind === 'urlMatches')     return c.negate ? 'urlNotMatches'   : 'urlMatches';
  if (c.kind === 'elementPresent') return c.negate ? 'elementAbsent'   : 'elementPresent';
  return 'always';
}

function conditionFromMode(
  mode: ConditionMode,
  prev: StepCondition | null | undefined,
): StepCondition | null {
  switch (mode) {
    case 'always':
      return null;
    case 'urlMatches':
      return { kind: 'urlMatches', pattern: prev?.kind === 'urlMatches' ? prev.pattern : '' };
    case 'urlNotMatches':
      return { kind: 'urlMatches', pattern: prev?.kind === 'urlMatches' ? prev.pattern : '', negate: true };
    case 'elementPresent':
      return { kind: 'elementPresent', selector: prev?.kind === 'elementPresent' ? prev.selector : (null as unknown as SelectorDescriptor) };
    case 'elementAbsent':
      return { kind: 'elementPresent', selector: prev?.kind === 'elementPresent' ? prev.selector : (null as unknown as SelectorDescriptor), negate: true };
  }
}

export default function StepConditionEditor({ stepId }: Props) {
  const { steps, draftStep, updateStep, pageUrl } = useConfigStore();
  const step = steps.find((s) => s.id === stepId) || (draftStep?.id === stepId ? draftStep : null);
  const [expanded, setExpanded] = useState(!!step?.condition);

  if (!step) return null;

  const cond = step.condition ?? null;
  const mode = modeFromCondition(cond);
  const summary =
    mode === 'always'         ? 'Always run' :
    mode === 'urlMatches'     ? `Only if URL matches: ${(cond as { pattern: string }).pattern || '(empty)'}` :
    mode === 'urlNotMatches'  ? `Only if URL does NOT match: ${(cond as { pattern: string }).pattern || '(empty)'}` :
    mode === 'elementPresent' ? 'Only if element exists' :
                                'Only if element does NOT exist';

  const setMode = (next: ConditionMode) => {
    updateStep(step.id, { condition: conditionFromMode(next, cond) });
    if (next !== 'always') setExpanded(true);
  };

  const setPattern = (pattern: string) => {
    if (cond?.kind !== 'urlMatches') return;
    updateStep(step.id, { condition: { ...cond, pattern } });
  };

  const handlePickConditionElement = async () => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField('condition');
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const livePreview = useMemo(() => {
    if (cond?.kind !== 'urlMatches') return null;
    const url = pageUrl || '';
    if (!cond.pattern) return null;
    try {
      const matches = new RegExp(cond.pattern).test(url);
      const effective = cond.negate ? !matches : matches;
      return { ok: effective, url, error: null as string | null };
    } catch (e) {
      return { ok: false, url, error: (e as Error).message };
    }
  }, [cond, pageUrl]);

  return (
    <div className="form-group">
      <label className="form-label" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        Run condition <span className="form-hint" style={{ marginLeft: 8 }}>{summary}</span>
      </label>

      {expanded && (
        <>
          <select
            className="form-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as ConditionMode)}
          >
            <option value="always">Always run</option>
            <option value="urlMatches">Only if URL matches</option>
            <option value="urlNotMatches">Only if URL does NOT match</option>
            <option value="elementPresent">Only if element exists</option>
            <option value="elementAbsent">Only if element does NOT exist</option>
          </select>

          {mode === 'always' && (
            <p className="form-hint">By default this step runs every time. Add a condition to skip it on specific pages.</p>
          )}

          {(mode === 'urlMatches' || mode === 'urlNotMatches') && cond?.kind === 'urlMatches' && (
            <div className="form-group form-group-indented">
              <label className="form-label">URL pattern (regex)</label>
              <input
                className="form-input"
                value={cond.pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="e.g. /wiki/.*\\(disambiguation\\)$"
              />
              {livePreview && (
                <p className="form-hint">
                  {livePreview.error
                    ? `✗ Invalid pattern: ${livePreview.error}`
                    : livePreview.ok
                      ? `✓ Matches current page`
                      : `✗ Does not match current page`}
                  <br />
                  <span style={{ opacity: 0.7 }}>{livePreview.url.length > 80 ? livePreview.url.substring(0, 80) + '…' : livePreview.url}</span>
                </p>
              )}
            </div>
          )}

          {(mode === 'elementPresent' || mode === 'elementAbsent') && cond?.kind === 'elementPresent' && (
            <div className="form-group form-group-indented">
              <label className="form-label">Element to check for</label>
              <PickedElementPreview
                selector={cond.selector ?? null}
                onRepick={handlePickConditionElement}
              />
              {!cond.selector && (
                <button className="btn btn-secondary btn-full mt-8" onClick={handlePickConditionElement}>
                  Pick Element
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

**Notes for the implementer:**
- Inline `style={{ cursor: 'pointer' }}` and `style={{ marginLeft: 8 }}` and `style={{ opacity: 0.7 }}` are placeholders for the "click row to expand" affordance. If the project has a collapsible-section primitive or a `.form-collapsible` class, swap the inline styles for that. **Do not introduce new global styles for this — match what already exists.**
- `pageUrl` already lives on the `useConfigStore` ([configStore.ts:80](../src/sidepanel/stores/configStore.ts#L80)) and is updated by `setPageInfo`; that's what powers the live preview.
- The component uses existing classes (`form-group`, `form-label`, `form-input`, `form-select`, `form-hint`, `form-group-indented`, `btn`, `btn-secondary`, `btn-full`, `mt-8`) — no new tokens, no new colours, no inline hex/rgb.

---

## File 5 (MODIFIED): `src/sidepanel/utils/pickerDispatch.ts`

### Change 1 — Add `handleCondition` handler

Locate `handleContainer` at lines 81–88. Insert **immediately after** it (before `handleRepick` at line 90):

```ts
function handleCondition(stepId: string, pickData: PickData): void {
  const { descriptor } = pickData;
  const { steps, draftStep, updateStep } = useConfigStore.getState();
  const step =
    steps.find((s) => s.id === stepId) ||
    (draftStep?.id === stepId ? draftStep : null);
  if (!step) return;

  const cond = step.condition;
  if (cond?.kind === 'elementPresent') {
    updateStep(stepId, { condition: { ...cond, selector: descriptor } });
  } else {
    // Defensive: condition kind drifted; reset to elementPresent with the picked selector.
    updateStep(stepId, { condition: { kind: 'elementPresent', selector: descriptor } });
  }
}
```

### Change 2 — Route `field === 'condition'` to the new handler

Locate `dispatchPickerResult` at lines 142–168. Find the `else if (field === 'container')` branch at line 161. Insert **immediately after** that branch (before the `field?.startsWith('repick:')` branch):

```ts
  } else if (field === 'condition') {
    handleCondition(stepId, pickData);
```

After this change the chain reads `... container → condition → repick: → pagination:`.

---

## File 6 (MODIFIED): `src/sidepanel/utils/storage.ts`

### Change 1 — Carry `condition` through `migrateConfig`

Locate `migrateConfig` at lines 19–55. The step-mapping block at lines 36–51 currently reconstructs each step. Replace the mapped-object literal at lines 40–48 with:

```ts
      return {
        id: step.id,
        type: step.type,
        label: step.label || '',
        isSetup: step.isSetup ?? false,
        selector: step.selector || null,
        elementType: step.elementType || null,
        extra: step.extra || null,
        condition: (step.condition as Record<string, unknown> | null | undefined) ?? null,
        options: { ...defaults, ...(step.options as Record<string, unknown> || {}) },
      };
```

**No schema-version bump required.** `condition` is additive and optional; legacy v2 configs without the field are valid (treated as "always run"). The existing `>= CURRENT_SCHEMA_VERSION` guard at line 22 will short-circuit on already-migrated configs, so the field gets defaulted only on first load of a legacy config.

---

## File 7 (MODIFIED): `src/sidepanel/components/SetInputForm.tsx`

### Change 1 — Import the editor

After the existing imports (the import block ending around line 7), add:

```ts
import StepConditionEditor from './StepConditionEditor';
```

### Change 2 — Render the editor before the save button

Locate `<div className="form-actions">` at line 166. Insert **immediately above** that line:

```tsx
      <StepConditionEditor stepId={step.id} />

```

(One blank line above and below the new element to keep spacing consistent with surrounding form-groups.)

---

## File 8 (MODIFIED): `src/sidepanel/components/ClickElementForm.tsx`

Same pattern as File 7:
- Add `import StepConditionEditor from './StepConditionEditor';` to the import block.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 119.

---

## File 9 (MODIFIED): `src/sidepanel/components/BestMatchForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 162.

---

## File 10 (MODIFIED): `src/sidepanel/components/GoBackForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 86.

---

## File 11 (MODIFIED): `src/sidepanel/components/SelectEachForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 194.

---

## File 12 (MODIFIED): `src/sidepanel/components/AwaitUserActionForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 55.

---

## File 13 (MODIFIED): `src/sidepanel/components/ScrapeElementsForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 297.

---

## File 14 (MODIFIED): `src/sidepanel/components/ScrapeWholePageForm.tsx`

Same pattern:
- Add the import.
- Insert `<StepConditionEditor stepId={step.id} />` immediately above `<div className="form-actions">` at line 113.

---

## Captured forms not modified

`captureApiCalls` does not have a dedicated form file in `src/sidepanel/components/` (verified by glob at planning time). If/when an editor exists for that step type, render `<StepConditionEditor>` in the same way. Out of scope for this spec.

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

All must pass with zero new errors. The new test cases in `scrapingEngine.test.ts` (or the equivalent file) must pass.

### Manual

1. **Wikipedia disambiguation flow.** Configure a flow with `setInput` → `bestMatch` → `scrape`. On the `bestMatch` step, set condition to *Only if URL matches* with pattern `\\(disambiguation\\)$` (or whatever distinguishes disambig URLs in the user's actual flow). Search "Bill" (which lands on a disambiguation page) → `bestMatch` runs and resolves the disambig link. Search "Albert Einstein" (direct article) → `bestMatch` is skipped, `scrape` runs on the article directly.
2. **Nomis multi-vs-single result.** On a `bestMatch` step, set condition to *Only if element exists* with the results-list container as the selector. Single-result query → step skipped (lands directly on the report). Multi-result query → step runs.
3. **Always-run regression.** Open an existing saved config (no condition set on any step). Run; behaviour identical to current build.
4. **Live regex preview.** Open the editor on a page where the URL matches your pattern. Confirm ✓ status. Edit pattern to break the match. Confirm ✗.
5. **Invalid regex authoring.** Type `(unclosed`. Confirm `✗ Invalid pattern: ...` in editor. Save anyway. Run flow. Confirm step is skipped (fail-closed).
6. **Negation correctness.** Set *Only if URL does NOT match* with a pattern that matches the current URL. Confirm preview shows ✗ and the step is skipped at runtime.

### Edge cases (covered by design)

- *Condition evaluator throws unexpectedly* — wrapped in `try/catch` in `evaluateCondition`; treated as condition unmet.
- *URL changes mid-flow (SPA navigation)* — `evaluateCondition` reads `window.location.href` at the moment of evaluation; no special handling needed.
- *Element-present resolves at low confidence (0.05)* — counts as present (matches `bestMatch`'s permissiveness).
- *User changes condition mid-run* — not a concern; saved config is read at flow start.

---

## Out of scope (do not add in v1)

- Compound conditions (AND/OR across predicates).
- Else-branch.
- Inter-step state ("if previous step was skipped, do X").
- Conditions on sub-step lists inside `selectEach` — the condition on the outer `selectEach` step controls whether the whole block runs; sub-steps cannot be individually conditioned in v1.
- Glob URL syntax. Regex only.
- ReDoS protection on user-authored regex.
- Per-condition "evaluate after step" (post-conditions).

---

## Rollback

If a regression is found post-merge, revert with:

```bash
git revert <commit-sha>
```

The change is additive: the `condition` field is optional, defaults to `null`, and existing saved configs are untouched (migration only adds a `null` field on first load). Reverting cleanly removes the field and the engine check.
