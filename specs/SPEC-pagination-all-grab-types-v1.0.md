# SPEC-Bot4 — Pagination for all grab-step element types
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR-Bot3 (`34755d7`, single-element table cross-nav pagination), plus uncommitted dogfooding fixes still on top of HEAD.

---

## Context

PR-Bot3 added cross-nav pagination support for **single-element table** scrapes only. The user noticed two related gaps:

1. **The paginate toggle in the element-config form is gated to tables only** (`isTable && treatAsTable`). Containers, lists, single elements — none expose the option in the UI.
2. **The runtime only routes paginated tables** through the cross-nav state machine. Containers and single-element scrapes have no paginate logic at all (the code path simply returns the single extraction).

The refactor extends both layers so paginate works for every grab type that can meaningfully repeat across pages: **single elements, containers/lists, and tables**. **Charts** are excluded — pagination doesn't have a useful semantic for one-shot chart extractions, and the user can repick as a different type if they need it.

The runtime state machine in `paginateAcrossNav<T>` is already generic; this PR generalizes the element-side wrappers and resume path to accept any extraction type.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Paginate toggle UI gate | `src/sidepanel/components/ScrapeElementsForm.tsx` | Lift out of `isTable && treatAsTable` block; show for `!isChart` (i.e., container, table, single) |
| `PaginationContinuation` `kind: 'element'` field | `src/content/scraping/paginationHandler.ts` | Rename `rowBatches: Record<string, unknown>[][]` → `contributions: unknown[]` (one entry per past page; type depends on elConfig) |
| `paginateRows` wrapper | `src/content/scraping/paginationHandler.ts` | Rename → `paginateElement` and generalize `T` from `Record<string, unknown>[]` to `unknown` |
| Existing in-page `paginateElement` | `src/content/scraping/paginationHandler.ts` | Rename → `paginateElementInPage` to free the name and reflect the in-page-only semantics |
| `runElementPaginationLoop` | `src/content/scraping/scrapingEngine.ts` | Generalize: build per-page extractor + final-merge based on `elConfig.detectedType + selectMode`. Returns `unknown` instead of `Record<string, unknown>[]` |
| `scrapeElement` container branch | `src/content/scraping/scrapingEngine.ts` | Add paginate routing — when single-element step + paginate=true, call `runElementPaginationLoop` with container extractor |
| `scrapeElement` single-element branch | `src/content/scraping/scrapingEngine.ts` | Same — add paginate routing for single-element extraction |
| `scrapeElement` multi-element fallback (paginated table) | `src/content/scraping/scrapingEngine.ts` | Update import name: `paginateElement` → `paginateElementInPage` |
| Resume branch dispatch | `src/content/scraping/scrapingEngine.ts` | Read `contributions` (was `rowBatches`); type-cast based on elConfig at engine boundary |
| Tests | `src/__tests__/paginationHandler.test.ts` | Rename references to new names; add coverage for the union narrow + generalized accumulator |

---

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Which types get paginate UI | Container, table, single. Skip chart (one-shot data, no pagination semantic). |
| 2 | Continuation field | One field for all element types: `contributions: unknown[]`. Type depends on elConfig at consumer. |
| 3 | Per-page extractor selection | Built inside `runElementPaginationLoop` from `elConfig.detectedType + selectMode`: table → `extractTable + filter`, container/all → `extractContainer`, single → `el.textContent?.trim() ?? ''`. |
| 4 | Final merge per type | Table: `contributions.flat()` (preserves existing rows-flat output shape). Container: `contributions` (array of per-page structures). Single: `contributions` (array of per-page values). |
| 5 | Single-element constraint | Same as PR-Bot3: cross-nav paginate engages only when the scrape step has one element. Multi-element scrapes use `paginateElementInPage` (in-page only) regardless of element type. |
| 6 | Charts | UI doesn't show toggle; runtime ignores `paginate` on chart configs. If a config has `detectedType: 'chart' && paginate: true` (e.g., a stale config from before this guard), runtime logs + treats as non-paginated. |
| 7 | Backward compat | Existing single-element paginated table configs keep working — the new shape is a strict superset. Old continuations with `rowBatches` field would be in chrome.runtime memory only — they don't survive SW restart, so no migration needed. |

---

## File 1 (MODIFIED): `src/content/scraping/paginationHandler.ts`

### 1a — Rename `paginateElement` → `paginateElementInPage`

The existing `paginateElement` is the in-page MutationObserver loop. Renaming clarifies it's in-page only and frees the name `paginateElement` for the new generalized cross-nav wrapper.

**Find** the existing function declaration:

```typescript
export async function paginateElement(params: {
  paginationSelector: SelectorDescriptor;
  paginationCount?: number;
  paginationDelayMs?: number;
  onPage?: (pageIndex: number) => Promise<void>;
  onProgress?: (msg: string) => void;
  container?: Element | null;
  afk?: boolean;
}): Promise<number> {
```

**Replace** the function name in the export only:

```typescript
export async function paginateElementInPage(params: {
  // ...same params...
}): Promise<number> {
```

The body is unchanged. Update the single existing caller in `scrapingEngine.ts` (see File 2).

### 1b — Update `PaginationContinuation` `kind: 'element'` field

**Find** the `kind: 'element'` branch of the union:

```typescript
| {
    kind: 'element';
    termIndex: number;
    stepIndex: number;
    elementIndex: number;
    pagesScraped: number;
    pageCountTarget: number;
    paginationDelayMs?: number;
    rowBatches: Record<string, unknown>[][];
  };
```

**Replace** with:

```typescript
| {
    kind: 'element';
    termIndex: number;
    stepIndex: number;
    elementIndex: number;
    pagesScraped: number;
    pageCountTarget: number;
    paginationDelayMs?: number;
    // One entry per past page. Shape depends on the elConfig the engine
    // resumed from: rows[] for tables, container extraction for
    // containers/lists, scalar for single elements. Engine-side casts
    // back to T at the boundary.
    contributions: unknown[];
  };
```

### 1c — Rename `paginateRows` → `paginateElement` and generalize

**Find** the existing `paginateRows` function:

```typescript
export interface PaginateRowsResult {
  finished: boolean;
  rowBatches: Record<string, unknown>[][];
}

export async function paginateRows(args: {
  // ...
  resumedRowBatches: Record<string, unknown>[][];
  extractCurrentPageRows: () => Promise<Record<string, unknown>[]>;
  // ...
}): Promise<PaginateRowsResult> {
  const result = await paginateAcrossNav<Record<string, unknown>[]>({
    // ...
    resumedAccumulator: args.resumedRowBatches,
    extractCurrentPage: args.extractCurrentPageRows,
    buildContinuation: ({ pagesScraped, accumulator }) => ({
      kind: 'element',
      // ...
      rowBatches: accumulator,
    }),
    // ...
  });
  return { finished: result.finished, rowBatches: result.accumulator };
}
```

**Replace** with the generalized version:

```typescript
export interface PaginateElementResult {
  finished: boolean;
  contributions: unknown[];
}

export async function paginateElement(args: {
  termIndex: number;
  stepIndex: number;
  elementIndex: number;
  paginationSelector: SelectorDescriptor;
  pageCountTarget: number;
  paginationDelayMs?: number;
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  previousIterations: WireIteration[];
  resumedContributions: unknown[];
  // Per-page extractor. Returns one page's contribution; the engine
  // determines the concrete shape based on elConfig.
  extractCurrentPage: () => Promise<unknown>;
  onProgress?: (msg: string) => void;
  afk?: boolean;
}): Promise<PaginateElementResult> {
  const result = await paginateAcrossNav<unknown>({
    termIndex: args.termIndex,
    stepIndex: args.stepIndex,
    paginationSelector: args.paginationSelector,
    pageCountTarget: args.pageCountTarget,
    paginationDelayMs: args.paginationDelayMs,
    config: args.config,
    searchTerms: args.searchTerms,
    taskId: args.taskId,
    previousIterations: args.previousIterations,
    resumedAccumulator: args.resumedContributions,
    extractCurrentPage: args.extractCurrentPage,
    buildContinuation: ({ pagesScraped, accumulator }) => ({
      kind: 'element',
      termIndex: args.termIndex,
      stepIndex: args.stepIndex,
      elementIndex: args.elementIndex,
      pagesScraped,
      pageCountTarget: args.pageCountTarget,
      paginationDelayMs: args.paginationDelayMs,
      contributions: accumulator,
    }),
    onProgress: args.onProgress,
    afk: args.afk,
  });

  return { finished: result.finished, contributions: result.accumulator };
}
```

**Notes:**
- `PaginateRowsResult` is removed — replaced by `PaginateElementResult`.
- The function is now generic over what `extractCurrentPage` returns. Per-page contribution shape is the caller's concern.

---

## File 2 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### 2a — Update imports

**Find** the existing import of `paginateRows`:

```typescript
import { paginateRows } from './paginationHandler';
```

**Replace** with:

```typescript
import { paginateElement, paginateElementInPage } from './paginationHandler';
import { extractTable } from '../extraction/tableExtractor';
```

(The `extractTable` import may already be present from PR-Bot3 — verify with Grep before adding a duplicate.)

### 2b — Generalize `runElementPaginationLoop`

**Find** the existing function (added in PR-Bot3):

```typescript
async function runElementPaginationLoop(
  elConfig: ScrapeElementConfig,
  ctx: ScrapeContext,
  startingRowBatches: Record<string, unknown>[][],
  onProgress: (msg: string) => void,
  afk: boolean,
): Promise<Record<string, unknown>[]> {
  let rowBatches: Record<string, unknown>[][] = startingRowBatches;

  const extractCurrentPageRows = async (): Promise<Record<string, unknown>[]> => {
    const { element: freshEl } = resolveElement(elConfig.selector);
    if (!freshEl) return [];
    const target = freshEl as HTMLElement;
    await smoothScrollToElement(target);
    const rows = extractTable(target);
    if (elConfig.dynamicHeaders) return filterByExcludedIndices(rows, elConfig.excludedColumnIndices);
    if (elConfig.tableFields?.length > 0) return applyFieldFilter(rows, elConfig.tableFields);
    return rows;
  };

  while (true) {
    const result = await paginateRows({
      // ...
      resumedRowBatches: rowBatches,
      extractCurrentPageRows,
      // ...
    });
    rowBatches = result.rowBatches;
    if (result.finished) break;
  }

  return rowBatches.flat();
}
```

**Replace** with the type-dispatching version:

```typescript
// Decides the per-page extractor and final-merge function based on
// elConfig.detectedType and elConfig.selectMode. Charts are not
// supported (no useful pagination semantic) — caller must guard.
function buildElementPagination(elConfig: ScrapeElementConfig): {
  extractor: () => Promise<unknown>;
  finalMerge: (contributions: unknown[]) => unknown;
} {
  // Container / 'all' mode: each page yields one extractContainer result.
  // Final output: array of per-page extractions (can't merge structurally
  // without knowing the shape).
  if (elConfig.selectMode === 'all' || elConfig.detectedType === 'container') {
    return {
      extractor: async () => {
        const { element: freshEl } = resolveElement(elConfig.selector);
        if (!freshEl) return null;
        const target = freshEl as HTMLElement;
        await smoothScrollToElement(target);
        return extractContainer(target);
      },
      finalMerge: (contributions) => contributions,
    };
  }

  // Table: each page yields rows[]. Final output: rows.flat() (preserves
  // PR-Bot3 shape).
  if (elConfig.detectedType === 'table') {
    return {
      extractor: async () => {
        const { element: freshEl } = resolveElement(elConfig.selector);
        if (!freshEl) return [] as Record<string, unknown>[];
        const target = freshEl as HTMLElement;
        await smoothScrollToElement(target);
        const rows = extractTable(target);
        if (elConfig.dynamicHeaders) return filterByExcludedIndices(rows, elConfig.excludedColumnIndices);
        if (elConfig.tableFields?.length > 0) return applyFieldFilter(rows, elConfig.tableFields);
        return rows;
      },
      finalMerge: (contributions) => (contributions as Record<string, unknown>[][]).flat(),
    };
  }

  // Single element (default fall-through): each page yields a scalar
  // (text content). Final output: array of scalars.
  return {
    extractor: async () => {
      const { element: freshEl } = resolveElement(elConfig.selector);
      if (!freshEl) return '';
      const target = freshEl as HTMLElement;
      await smoothScrollToElement(target);
      return target.textContent?.trim() ?? '';
    },
    finalMerge: (contributions) => contributions,
  };
}

async function runElementPaginationLoop(
  elConfig: ScrapeElementConfig,
  ctx: ScrapeContext,
  startingContributions: unknown[],
  onProgress: (msg: string) => void,
  afk: boolean,
): Promise<unknown> {
  const { extractor, finalMerge } = buildElementPagination(elConfig);
  let contributions: unknown[] = startingContributions;

  while (true) {
    const result = await paginateElement({
      termIndex: ctx.termIndex,
      stepIndex: ctx.stepIndex,
      elementIndex: ctx.stepElementIndex ?? 0,
      paginationSelector: elConfig.paginationSelector!,
      pageCountTarget: elConfig.paginationCount || 0,
      paginationDelayMs: ctx.paginationDelayMs,
      config: ctx.config,
      searchTerms: ctx.searchTerms,
      taskId: ctx.taskId,
      previousIterations: ctx.previousIterations,
      resumedContributions: contributions,
      extractCurrentPage: extractor,
      onProgress,
      afk,
    });

    contributions = result.contributions;
    if (result.finished) break;
    // In-page change — loop and re-extract from the updated DOM.
  }

  return finalMerge(contributions);
}
```

### 2c — Update the resume branch dispatch

**Find** the resume branch's `kind === 'element'` block (added in PR-Bot3). It currently reads `paginationContinuation.rowBatches` and asserts `elConfig.detectedType === 'table'`. Generalize:

```typescript
if (
  paginationContinuation.kind === 'element'
  && opts.mode === 'specificElements'
  && Array.isArray(opts.elements)
  && paginationContinuation.elementIndex >= 0
  && paginationContinuation.elementIndex < opts.elements.length
) {
  const elIdx = paginationContinuation.elementIndex;
  const elConfig = opts.elements[elIdx];

  if (opts.elements.length !== 1) {
    swLog('[executeFlow] element pagination resume — multi-element scrape (config drift?), falling through');
  } else if (elConfig.detectedType === 'chart') {
    swLog('[executeFlow] element pagination resume — element is a chart (paginate not supported), falling through');
  } else if (!elConfig.paginate || !elConfig.paginationSelector) {
    swLog('[executeFlow] element pagination resume — element is no longer paginated, falling through');
  } else {
    const finalOutput = await runElementPaginationLoop(
      elConfig,
      { ...ctx, stepElementIndex: elIdx, stepIsSingleElement: true, paginationDelayMs: opts.paginationDelayMs },
      paginationContinuation.contributions,
      onProgress,
      afk,
    );
    const outputKey = deriveElementOutputKey(elConfig, elIdx);
    Object.assign(iterOutputs, { [outputKey]: { kind: 'raw', data: finalOutput } });
    swLog('[executeFlow] element pagination resume done | taskId:', taskId, '| stepIndex:', si, '| elementIndex:', elIdx, '| detectedType:', elConfig.detectedType, '| selectMode:', elConfig.selectMode);
    continue;
  }
}
```

**Note**: `deriveElementOutputKey` is the helper PR-Bot3 inlined. If it's still inline, extract it now to avoid drift between the resume branch and `scrapeElementToWire`. The logic (per PR-Bot3's report):

```typescript
function deriveElementOutputKey(elConfig: ScrapeElementConfig, elementIndex: number): string {
  const baseKey =
    slugify((elConfig.outputKey ?? '').toString().trim())
    || slugify((elConfig.name ?? '').toString())
    || `element_${elementIndex}`;
  return baseKey;
}
```

(No `disambiguate(...)` call — single-element resume has no key collisions.)

### 2d — Add paginate routing to `scrapeElement` container + single-element branches

**Find** the container branch (currently around line 1514):

```typescript
if (elConfig.selectMode === 'all') {
  return extractContainer(el);
}

return el.textContent?.trim() ?? '';
```

**Replace** with:

```typescript
if (elConfig.selectMode === 'all') {
  if (elConfig.paginate && elConfig.paginationSelector && ctx?.stepIsSingleElement === true) {
    return runElementPaginationLoop(
      elConfig,
      { ...ctx, stepElementIndex: ctx.stepElementIndex ?? 0, paginationDelayMs },
      [],
      onProgress ?? (() => {}),
      afk,
    );
  }
  return extractContainer(el);
}

// Single-element extraction (default fall-through).
if (elConfig.paginate && elConfig.paginationSelector && ctx?.stepIsSingleElement === true) {
  return runElementPaginationLoop(
    elConfig,
    { ...ctx, stepElementIndex: ctx.stepElementIndex ?? 0, paginationDelayMs },
    [],
    onProgress ?? (() => {}),
    afk,
  );
}
return el.textContent?.trim() ?? '';
```

### 2e — Update existing table-paginate routing to match the new signatures

**Find** the existing table-paginate branch in `scrapeElement` (added in PR-Bot3):

```typescript
if (elConfig.paginate && elConfig.paginationSelector) {
  const isSingleElementStep = ctx && ctx.stepIsSingleElement === true;

  if (isSingleElementStep) {
    const elementCtx: ScrapeContext = {
      ...ctx!,
      stepElementIndex: ctx!.stepElementIndex ?? 0,
      paginationDelayMs,
    };
    const allRows = await runElementPaginationLoop(
      elConfig,
      elementCtx,
      [],
      onProgress ?? (() => {}),
      afk,
    );
    return allRows;
  }

  // Multi-element fallback: existing in-page pagination.
  // ... (calls paginateElement)
}
```

**Replace** the multi-element fallback's `paginateElement` call with `paginateElementInPage` (the rename from 1a). Don't change anything else in this block — the single-element path's call to `runElementPaginationLoop` keeps working because the function now returns `unknown` and the caller treats it as the table-row case via the dispatched extractor.

```typescript
// Multi-element fallback: existing in-page pagination.
allData.push(...scrapeCurrentPage());
const container = findPaginationContainer(el, elConfig.paginationSelector);

await paginateElementInPage({
  paginationSelector: elConfig.paginationSelector,
  paginationCount: elConfig.paginationCount || 0,
  paginationDelayMs,
  container,
  onPage: async () => { allData.push(...scrapeCurrentPage()); },
  onProgress,
  afk,
});

return allData;
```

The single-element path's return type is now `unknown` (was `Record<string, unknown>[]`). TypeScript will complain if downstream code relied on the narrower type — verify the call site in `scrapeElementToWire` (or wherever it's consumed) accepts `unknown`. The eventual `WireOutput.data` is `unknown`-shaped anyway, so no change should be needed.

---

## File 3 (MODIFIED): `src/sidepanel/components/ScrapeElementsForm.tsx`

### 3a — Lift the paginate toggle out of `isTable && treatAsTable`

**Find** the existing toggle block (currently around line 665):

```tsx
{isTable && treatAsTable && (
  <div className="form-group">
    <label className="form-check">
      <input type="checkbox" checked={!!config.paginate}
        onChange={e => onChange({ paginate: e.target.checked })} />
      Paginate
    </label>
    {config.paginate && (
      <div className="form-group-indented">
        <PaginationControlBanner
          descriptor={config.paginationSelector}
          onPick={onPickPagination}
        />
        <label className="form-label mt-8">Max pages</label>
        <input
          type="text"
          className="form-input"
          value={config.paginationCount || ''}
          onChange={e => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            onChange({ paginationCount: val === '' ? 0 : Number(val) });
          }}
          placeholder="All"
        />
      </div>
    )}
  </div>
)}
```

**Cut** that block from inside `{!isContainer && (<>...</>)}`. **Paste** it as a top-level form-group inside the `<div className="element-config-body">` wrapper, OUTSIDE both the `{isContainer && (...)}` and `{!isContainer && (...)}` branches, with a guard for `!isChart`:

```tsx
{/* Paginate toggle — applies to all extractable types except charts.
    Cross-nav pagination engages only for single-element scrape steps;
    multi-element steps fall back to in-page pagination at runtime. */}
{!isChart && (
  <div className="form-group">
    <label className="form-check">
      <input type="checkbox" checked={!!config.paginate}
        onChange={e => onChange({ paginate: e.target.checked })} />
      Paginate
    </label>
    {config.paginate && (
      <div className="form-group-indented">
        <PaginationControlBanner
          descriptor={config.paginationSelector}
          onPick={onPickPagination}
        />
        <label className="form-label mt-8">Max pages</label>
        <input
          type="text"
          className="form-input"
          value={config.paginationCount || ''}
          onChange={e => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            onChange({ paginationCount: val === '' ? 0 : Number(val) });
          }}
          placeholder="All"
        />
      </div>
    )}
  </div>
)}
```

Place it AFTER the `{isContainer && (...)}` and `{!isContainer && (...)}` blocks but inside `<div className="element-config-body">`. Visually it becomes a uniform "Paginate" section regardless of detected type.

### 3b — Note on `isTable && treatAsTable === false` (Individual mode)

When the user picks a `<table>` and switches to "Individual" extract mode (`treatAsTable === false`), the runtime treats it as a single element. The lifted toggle stays visible (because `!isChart`), and runtime falls through to the single-element paginate path. ✓

---

## File 4 (MODIFIED): `src/__tests__/paginationHandler.test.ts`

Mechanical updates:

- Replace all `paginateRows` references with `paginateElement`.
- Replace all `paginateElement` references that pointed to the old in-page function with `paginateElementInPage`.
- Replace `rowBatches` field references with `contributions`.
- Replace `extractCurrentPageRows` → `extractCurrentPage`.
- Replace `resumedRowBatches` → `resumedContributions`.

The test cases stay structurally the same. Add one new test exercising a non-row contribution shape (e.g., an object) to verify the generalized type:

```typescript
describe('paginateElement — generalized contributions', () => {
  it('accepts arbitrary per-page contribution shapes', async () => {
    const fakeContribution = { items: [1, 2, 3], pageMeta: 'a' };
    const result = await paginateElement({
      termIndex: 0,
      stepIndex: 0,
      elementIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 1,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedContributions: [],
      extractCurrentPage: () => Promise.resolve(fakeContribution),
    });
    expect(result.finished).toBe(true);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]).toEqual(fakeContribution);
  });
});
```

---

## What is NOT in scope

- **Multi-element cross-nav pagination**: same constraint as PR-Bot3. Multi-element scrape steps with paginate=true continue to use `paginateElementInPage` (in-page only). Adding multi-element cross-nav requires the priorOutputs-serialization design that's still deferred.
- **Chart pagination**: explicitly skipped. UI doesn't expose toggle for charts; runtime ignores `paginate` on chart configs.
- **Sidepanel UI warning** when paginate is enabled on a multi-element step: still deferred.

---

## Verification

### Automated

```bash
npm test -- src/__tests__/paginationHandler.test.ts
npm test
npm run type-check
npm run lint -- src/content/scraping/paginationHandler.ts src/content/scraping/scrapingEngine.ts src/sidepanel/components/ScrapeElementsForm.tsx
npm run build
```

**Pre-existing typecheck baseline**: same set as prior PRs. Output must be identical.

### Manual smoke (5 cases)

Build with `npm run build`. Reload the extension. Open SW DevTools console.

1. **Single-element container with cross-nav pagination** — set up a scrape config on books.toscrape.com:
   - mode: specificElements
   - one element: pick the book grid (`<ol class="row">` or `<section>`) → detected as container
   - paginate: true, paginationSelector: `li.next a`, paginationCount: 5
   Expect:
   - Page 1's container extracted
   - SW: `[SW] REGISTER_CONTINUATION` with `paginationContinuation.kind: 'element'`, `contributions` carrying one container structure
   - Page navigates → resume → `runElementPaginationLoop` → 5 pages total
   - Final output: array of 5 container structures

2. **Single-element single-value with paginate** — pick a small element (e.g., a paragraph showing "Page 1 of 50") on a paginated site, set paginate=true. Expect: array of 5 text values across pages.

3. **Single-element table with paginate (regression check)** — same config style as PR-Bot3's smoke #1. Should keep working with merged rows-flat output.

4. **Multi-element container scrape with paginate=true on one element** — should show toggle in UI now (it's lifted out of table gate). Runtime still uses `paginateElementInPage` because `stepIsSingleElement === false`. Click navigates → engine hangs (existing multi-element bug, deferred).

5. **Chart with paginate flag in config (back-compat)** — manually edit a saved config to add `paginate: true` on a chart element. Runtime should log + ignore (treat as non-paginated). UI should not show the toggle.

### Edge cases

| Case | Behaviour |
|---|---|
| `selectMode === 'all'` AND `paginate === true` AND `stepIsSingleElement === true` | New container-paginate path engages |
| `selectMode === 'single'` (or default) AND `paginate === true` AND `stepIsSingleElement === true` | New single-element-paginate path engages |
| `detectedType === 'chart'` AND `paginate === true` (config drift) | Runtime logs + skips paginate; returns single chart extraction |
| Existing in-flight continuation from PR-Bot3 with `rowBatches` field | None — continuations don't survive across builds; SW restart on extension reload wipes pendingContinuations |
| Container extraction returns null (element gone) | `contributions[i] = null`. Final array contains nulls; downstream consumer can filter |

---

## Maintainability checklist

- [x] No magic strings — `MessageType.REGISTER_CONTINUATION`, `MessageType.CANCEL_CONTINUATION` reused
- [x] Single source of truth for the cross-nav state machine — `paginateAcrossNav<T>` (added in PR-Bot3) is unchanged; both whole-page and element wrappers ride on it
- [x] Type safety — `PaginationContinuation` discriminated union; element-side `contributions` typed as `unknown[]` with type narrowing inside `runElementPaginationLoop`'s `buildElementPagination`
- [x] Backward compat — existing single-element paginated tables keep working (final output is `rows.flat()`); existing in-page table paginate keeps working via renamed `paginateElementInPage`
- [x] UI — paginate toggle now uniform across all non-chart element types
- [x] Tests — extended with non-row contribution shape

---

## Stuck-loop reminder

If two consecutive attempts at the same fix fail, STOP and report. Common gotchas: (a) the `paginateElement` rename collides with the existing in-page function — make sure the rename to `paginateElementInPage` happens FIRST so the new generalized `paginateElement` doesn't shadow it; (b) the resume branch reads `paginationContinuation.contributions` (was `rowBatches`) — every reference must be updated; (c) `runElementPaginationLoop` now returns `unknown` not `Record<string, unknown>[]` — check `scrapeElement` callers don't rely on the narrower type; (d) the generalized extractor for single elements returns `string` (text content) — make sure downstream output writers don't assume an object/array shape.
