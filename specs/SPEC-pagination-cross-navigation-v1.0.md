# SPEC-Bot2 — Cross-navigation pagination
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1–PR6 (batched scraping), PR-Bot1 (`e487ecd`, CDP + cascade) plus the uncommitted state from dogfooding (App.tsx selector fix, RESUME_FOR_DRAIN race fix, batch-complete tracking fix, humanize-scroll, drain-resumed continuation propagation, expand-all anchor guard, `debugger` permission moved to required).

---

## Context

`paginatePages` (whole-page pagination — `opts.paginate` on a `wholePage` scrape step) was implemented assuming **in-page** pagination: click "next" → AJAX updates DOM → MutationObserver/innerText snapshot detects the change → loop continues in the same JS realm. That assumption breaks for navigation-based paginators (`<a href="page-2.html">next</a>`), which are the *common* case on test sites like books.toscrape.com and on real-world e-commerce paginators.

What happens on navigation-based pagination today: page 1 scrapes successfully, paginator clicks the next link, the page actually navigates (whether via CDP-trusted click or even synthetic — anchor default-actions navigate either way), the content script's JS realm is destroyed mid-`await waitForContentChange`, and the engine never finishes. Tab is on page 2 but no scrape activity. The flow looks "stuck after page 1".

This refactor reshapes `paginatePages` to be a **stateful multi-leg sequence**:
- Each "scrape this page → click next → maybe navigate" is one engine invocation.
- A new `paginationContinuation` field rides on `EXECUTE_FLOW` payloads (matching how `setInput → click` already uses `REGISTER_CONTINUATION` + `tabs.onUpdated` re-delivery).
- The function tries in-page first (preserving zero-overhead for AJAX paginators) and falls through to cross-nav resume if the page actually navigates.

`paginateElement` (within-element pagination — sub-tables that update via JS) is unchanged. Only page-level `paginatePages` learns the new trick.

---

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | In-page detection | After click, `await waitForContentChange`. If page navigates mid-await, JS realm dies — continuation handles resume. If await resolves, no navigation happened: cancel the registered continuation, continue loop in-context. No explicit `beforeunload` race needed. |
| 2 | Continuation registration | Pre-emptively registered BEFORE the click. Cancelled (`CANCEL_CONTINUATION`) if in-page change wins. |
| 3 | Resume entry point | `executeFlow`'s step loop checks `paginationContinuation.termIndex === i && paginationContinuation.stepIndex === si` and skips normal `executeStep` to call a dedicated resume handler. |
| 4 | Accumulator | Carried in the continuation payload as `pages: PageContent[]`. Final `mergePages(pages)` runs only when pagination terminates. |
| 5 | Accumulator size guard | Hard cap at `PAGE_SAFETY_CAP = 200` (existing) AND a soft 10 MB serialized-payload guard — if accumulator JSON exceeds, abort pagination with a warning and return what we have. |
| 6 | Mismatch-on-resume | If `paginationContinuation` arrives but the resumed step is no longer a paginated scrape (config edited mid-flight, very rare), log + ignore the continuation, run normal step. Fail-safe. |
| 7 | Backward compat | Existing element-level pagination unchanged. Existing in-page page-pagination keeps working (the cross-nav path only kicks in on actual navigation). |
| 8 | `paginatePages` API shape | Becomes a single-page function (scrape-this-page + maybe-click-next), not an internal loop. The loop now lives in the engine via the resume mechanism. |

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| `PaginationContinuation` type | `src/content/scraping/paginationHandler.ts` | New exported interface |
| `paginatePages` signature | `src/content/scraping/paginationHandler.ts` | Refactored to single-page function with continuation registration |
| `ExecuteFlowParams` | `src/content/scraping/scrapingEngine.ts` | Add `paginationContinuation?: PaginationContinuation` |
| Resume detection in step loop | `src/content/scraping/scrapingEngine.ts` | Branch in step loop: if continuation matches, call `resumePagination(...)` instead of `executeStep` |
| Initial pagination entry | `src/content/scraping/scrapingEngine.ts` (`scrapeWholePage`) | Replace internal `paginatePages` loop with one call that may either return or hang awaiting nav |
| Wire-protocol field forwarding | `src/entrypoints/content.ts` | Add `paginationContinuation` to `ExecuteFlowPayload` and the `executeFlow({...})` forward call |
| SW continuation enrichment | `src/entrypoints/background.ts` | **No logic change** — `paginationContinuation` is part of the stored continuation payload and propagates through the existing `...continuation` spread |
| Tests | `src/__tests__/paginationHandler.test.ts` (new) | Unit tests for the single-page function + state-machine transitions |

---

## Decision flow when pagination is enabled

```
                                ┌─────────────────────────┐
                                │  Initial scrape step    │
                                │  (no continuation yet)  │
                                └────────────┬────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ Extract current page's blocks │
                              │ Append to accumulator         │
                              └──────────────┬───────────────┘
                                             ▼
                                  pagesScraped >= cap?
                                  ├── yes → return mergePages(pages)
                                  └── no  ▼
                              ┌──────────────────────────────┐
                              │ Find next button              │
                              └──────────────┬───────────────┘
                                             ▼
                                  not-found OR disabled?
                                  ├── yes → return mergePages(pages)
                                  └── no  ▼
                              ┌──────────────────────────────┐
                              │ REGISTER_CONTINUATION         │
                              │ (with paginationContinuation) │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ delay + naturalClick(next)    │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │ await waitForContentChange    │
                              │   (12 s timeout)              │
                              └──────────────┬───────────────┘
                                             ▼
              ┌──────────────────────┬─────────────────────────────────┐
              │ Page navigated       │ Same-doc change resolved        │
              │ (await never resolves│  CANCEL_CONTINUATION             │
              │  — JS realm dies)    │  Loop back to "Extract current"  │
              └──────────────────────┴─────────────────────────────────┘
                       ▼                                                 │
       Engine resumes via continuation re-delivery                       │
       on next page; resumePagination handler picks                      │
       up at "Extract current page's blocks" with the                    │
       deserialised accumulator.                                         │
```

---

## File 1 (MODIFIED): `src/content/scraping/paginationHandler.ts`

Replace the existing `paginatePages` function and add the new types. Keep `paginateElement`, `isDisabledOrHidden`, `waitForElementContentChange`, `randomDelay`, `resolveButtonWithRetry`, and `PAGE_SAFETY_CAP` unchanged.

**Add new imports** at the top:

```typescript
import { MessageType } from '../../types/messages';
import type { ScraperConfig } from '../../types/config';
import type { PageContent } from '../extraction/pageBlockExtractor';
import type { WireIteration } from '../shaping';
```

**Add new types** below `PAGE_SAFETY_CAP`:

```typescript
// Soft cap on accumulator payload size. continuations ride on
// chrome.runtime.sendMessage which has a hard ~64 MB limit, but practical
// payloads should stay well under to avoid SW relay slowdowns.
const ACCUMULATOR_SOFT_LIMIT_BYTES = 10 * 1024 * 1024;

// Continuation payload carrying pagination state across page navigations.
// Serialised as JSON via chrome.runtime.sendMessage.
export interface PaginationContinuation {
  termIndex: number;            // which iteration of the search-term loop we're in
  stepIndex: number;            // which step in loopSteps is the paginated scrape step
  pagesScraped: number;         // number of pages already in `pages`
  pageCountTarget: number;      // 0 = use safety cap; otherwise hard cap
  paginationDelayMs?: number;
  pages: PageContent[];         // accumulated page extractions
}

export interface PaginatePageStepResult {
  // True if pagination is finished (cap reached, no next button, disabled,
  // size limit, or in-page change timeout). Caller should merge `pages`
  // and finalise the step's output.
  finished: boolean;
  // Pages accumulated so far (caller may pass back in via resumedPages on
  // the next leg).
  pages: PageContent[];
}
```

**Replace** the existing `paginatePages` function (lines 21–65) with:

```typescript
// Single-page pagination step. Refactored from a self-contained loop into
// a multi-leg state machine to support cross-navigation paginators
// (`<a href="page-2.html">`-style) where clicking next destroys the JS
// realm. Each call:
//   1. Scrapes the current page → appends to pages accumulator
//   2. Returns finished if cap reached / no next / disabled
//   3. Otherwise registers a continuation, clicks next
//   4. Either: page navigates → JS dies → engine resumes via continuation
//      Or:    in-page change → cancel continuation, return finished:false
//             so the engine loops in-context (next call extracts again)
export async function paginatePages(args: {
  termIndex: number;
  stepIndex: number;
  paginationSelector: SelectorDescriptor;
  pageCountTarget: number;
  paginationDelayMs?: number;
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  previousIterations: WireIteration[];
  resumedPages: PageContent[];
  resumedPagesScraped: number;
  // Per-page extractor (closure over current scrapeWholePage state for
  // scrolling + expansion before block extraction). Caller controls.
  extractCurrentPage: () => Promise<PageContent>;
  onProgress?: (msg: string) => void;
  afk?: boolean;
}): Promise<PaginatePageStepResult> {
  const cap = args.pageCountTarget > 0
    ? Math.min(args.pageCountTarget, PAGE_SAFETY_CAP)
    : PAGE_SAFETY_CAP;
  const interPageBase = args.paginationDelayMs ?? 1500;

  // Scrape this page. If we're resuming, this is the new (post-nav) page.
  const thisPage = await args.extractCurrentPage();
  const pages = [...args.resumedPages, thisPage];
  let pagesScraped = args.resumedPagesScraped + 1;

  args.onProgress?.(`Scraped page ${pagesScraped}${args.pageCountTarget > 0 ? ` of ${cap}` : ''}`);

  // Hard caps.
  if (pagesScraped >= cap) {
    args.onProgress?.(`Pagination cap reached (${cap}) — stopping`);
    return { finished: true, pages };
  }

  // Soft size guard.
  // Cheap probe: JSON.stringify only the new page; if it alone is huge,
  // bail. Otherwise sample by serialising the whole array length.
  // This is approximate (not a true byte count) but cheap enough to do
  // on every page.
  const accumulatorBytes = JSON.stringify(pages).length;  // chars ≈ bytes for ASCII-heavy text
  if (accumulatorBytes > ACCUMULATOR_SOFT_LIMIT_BYTES) {
    args.onProgress?.(`Pagination accumulator exceeded ${Math.floor(ACCUMULATOR_SOFT_LIMIT_BYTES / (1024 * 1024))} MB — stopping`);
    return { finished: true, pages };
  }

  // Find next button.
  const nextBtn = await resolveButtonWithRetry(args.paginationSelector);
  if (!nextBtn) {
    args.onProgress?.('No next page button found — pagination complete');
    return { finished: true, pages };
  }

  if (isDisabledOrHidden(nextBtn as HTMLElement)) {
    args.onProgress?.('Next page button is disabled — pagination complete');
    return { finished: true, pages };
  }

  // Pre-register the cross-nav continuation. Cancelled below if in-page
  // change resolves before the JS realm dies.
  const continuationPayload = {
    config: args.config,
    searchTerms: args.searchTerms,
    taskId: args.taskId,
    startTermIndex: args.termIndex,
    startLoopStepIndex: args.stepIndex,
    previousIterations: args.previousIterations,
    paginationContinuation: {
      termIndex: args.termIndex,
      stepIndex: args.stepIndex,
      pagesScraped,
      pageCountTarget: args.pageCountTarget,
      paginationDelayMs: args.paginationDelayMs,
      pages,
    } as PaginationContinuation,
  };

  try {
    await browser.runtime.sendMessage({
      type: MessageType.REGISTER_CONTINUATION,
      payload: continuationPayload,
    });
  } catch { /* extension context invalidated — fall through; click below will navigate or fail */ }

  const snapshotBefore = document.body.innerText.substring(0, 2000);

  // Inter-page jitter + click. Once we click an anchor with a real href,
  // the page may navigate immediately; the await below never resolves in
  // that case (JS realm dies). The continuation we just registered is
  // what drives the resume on the new page.
  await randomDelay(interPageBase * 0.7, interPageBase * 1.3);

  args.onProgress?.(`Loading page ${pagesScraped + 1}...`);
  await naturalClick(nextBtn as HTMLElement, { afk: args.afk });

  const changed = await waitForContentChange(snapshotBefore, 12000);

  // If we got here, the page did NOT navigate (in-page change or timeout).
  // Cancel the continuation we registered — we don't need it.
  try {
    await browser.runtime.sendMessage({ type: MessageType.CANCEL_CONTINUATION });
  } catch { /* ignore */ }

  if (!changed) {
    args.onProgress?.('Page content did not change after clicking next — stopping');
    return { finished: true, pages };
  }

  // In-page change: caller will loop and call paginatePages again. We've
  // accumulated `pages` so far and pages count.
  return { finished: false, pages };
}
```

**Note**: the `SelectorDescriptor` import already exists at the top of the file. Don't double-import.

---

## File 2 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

Three changes here: ExecuteFlowParams, the resume entry point in the step loop, and the rewrite of `scrapeWholePage`'s pagination block.

### 2a — Extend `ExecuteFlowParams`

**Find** the existing interface (currently around line 158):

```typescript
export interface ExecuteFlowParams {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  afk?: boolean;
  startTermIndex?: number;
  startLoopStepIndex?: number;
  previousIterations?: WireIteration[];
  drainResumed?: boolean;
}
```

**Add** the new field:

```typescript
export interface ExecuteFlowParams {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  afk?: boolean;
  startTermIndex?: number;
  startLoopStepIndex?: number;
  previousIterations?: WireIteration[];
  drainResumed?: boolean;
  paginationContinuation?: import('./paginationHandler').PaginationContinuation;
}
```

**And** in the destructuring at the top of `executeFlow`:

```typescript
  const {
    config,
    searchTerms,
    taskId,
    afk = false,
    startTermIndex = 0,
    startLoopStepIndex = 0,
    previousIterations = [],
    drainResumed: paramDrainResumed = false,
    paginationContinuation,
  } = params;
```

### 2b — Resume detection in the step loop

**Locate** the inner `for (let si = siStart; si < loopSteps.length; si++)` loop. After `checkAbort()` and `await maybePauseForDrain(taskId);` and the `sendProgress(...)` call but **before** the `const isNavigating = NAVIGATING_STEP_TYPES.has(step.type);` line, **insert** the resume branch:

```typescript
          // Pagination resume: if SW re-delivered EXECUTE_FLOW with a
          // paginationContinuation that targets this exact (term, step),
          // skip the normal step execution and call the resume handler.
          // The handler does its own scrape + maybe-click-next, registers
          // a fresh continuation if more pages are needed, and either
          // hangs (cross-nav) or returns finished:true with merged pages.
          //
          // If the continuation references a different (term, step) — e.g.
          // user edited the config and step layout shifted — fall through
          // to normal execution.
          if (
            paginationContinuation
            && paginationContinuation.termIndex === i
            && paginationContinuation.stepIndex === si
            && step.type === 'scrape'
            && (step as ScrapeStep).options.paginate
          ) {
            try {
              const opts = (step as ScrapeStep).options;
              const ctx: ScrapeContext = {
                config,
                searchTerms,
                taskId,
                termIndex: i,
                stepIndex: si,
                previousIterations: result.iterations,
              };
              const onProgress = (msg: string): void => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId });

              const resumed = await runPaginationLoop(opts, ctx, paginationContinuation.pages, onProgress, afk);

              // runPaginationLoop only returns when finished:true. (When the
              // click navigates, paginatePages never returns and we resume
              // in a fresh content-script context via continuation.)
              const stepOutput: WireOutput = { kind: 'raw', data: resumed };
              Object.assign(iterOutputs, { page: stepOutput });
              swLog('[executeFlow] pagination resume done | taskId:', taskId, '| stepIndex:', si, '| pagesScraped:', resumed.pagesScraped);
              continue; // skip the rest of this step iteration
            } catch (err) {
              const e = err as Error;
              swLog('[executeFlow] pagination resume failed — falling back to normal step | taskId:', taskId, '| err:', e.message);
              // Fall through to normal step execution as a safety net.
            }
          }
```

### 2c — `runPaginationLoop` helper (shared by initial entry + resume)

**Append** at file scope (next to `runWatchdogPause` or after the term loop, doesn't matter — module-private async helper):

```typescript
import { paginatePages, type PaginationContinuation } from './paginationHandler';
import { mergePages, extractPageBlocks } from '../extraction/pageBlockExtractor';

interface ScrapeContext {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  termIndex: number;
  stepIndex: number;
  previousIterations: WireIteration[];
}

// Shared loop used by both initial entry (scrapeWholePage) and the
// post-navigation resume entry (called from the step-loop resume branch).
// Each iteration calls paginatePages which scrapes the current page and
// EITHER returns finished (cap reached / no next / disabled) OR clicks
// next. If the click navigates, the JS realm dies — we never return from
// paginatePages, the engine resumes via continuation. If the click
// produced an in-page change, paginatePages returns finished:false and
// we loop again (re-scrolling/expanding the updated content).
//
// Returns the final scraped output. ONLY returns when finished:true.
async function runPaginationLoop(
  opts: ScrapeStep['options'],
  ctx: ScrapeContext,
  startingPages: PageContent[],
  onProgress: (msg: string) => void,
  afk: boolean,
): Promise<{ content: ReturnType<typeof mergePages>; pagesScraped: number }> {
  let pages: PageContent[] = startingPages;
  let firstIteration = true;

  while (true) {
    // On every iteration AFTER the first, do scroll/expand prep (the
    // initial-entry caller already prepped the page-1 DOM). On resume
    // entry from a continuation, the first iteration ALSO needs prep
    // because we're on a freshly-loaded post-navigation page — caller
    // sets firstIteration=false in that case via `runPaginationLoop`'s
    // `startingPages` being non-empty.
    const needsPrep = !firstIteration || pages.length > 0;
    if (needsPrep) {
      if (opts.scrollToBottom) {
        onProgress('Scrolling to load all content...');
        await scrollToBottom(undefined, { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });
      }
      if (opts.expandHidden) {
        onProgress('Expanding hidden sections...');
        await expandHiddenElements({ delayMs: opts.expandDelayMs });
      }
    }
    firstIteration = false;

    const result = await paginatePages({
      termIndex: ctx.termIndex,
      stepIndex: ctx.stepIndex,
      paginationSelector: opts.paginationSelector!,
      pageCountTarget: opts.pageCount || 0,
      paginationDelayMs: opts.paginationDelayMs,
      config: ctx.config,
      searchTerms: ctx.searchTerms,
      taskId: ctx.taskId,
      previousIterations: ctx.previousIterations,
      resumedPages: pages,
      resumedPagesScraped: pages.length,
      extractCurrentPage: () => extractPageBlocks(),
      onProgress,
      afk,
    });

    pages = result.pages;
    if (result.finished) break;
    // In-page change — loop and re-scrape.
  }

  return { content: mergePages(pages), pagesScraped: pages.length };
}
```

**Recursion / loop note:** the loop is bounded by `PAGE_SAFETY_CAP = 200` (enforced inside `paginatePages`). Cross-nav clicks never return from `paginatePages` (JS realm dies), so the loop only iterates for in-page change cases.

### 2d — Rewrite the initial pagination entry in `scrapeWholePage`

**Locate** the existing `if (opts.paginate && opts.paginationSelector) { ... }` block in `scrapeWholePage` (currently lines 1112–1130). It uses the old internal-loop `paginatePages`. Replace it with a single-page entry that may either return final pages OR register a continuation and never return (page navigates).

**Replace** the block:

```typescript
  const pages: PageContent[] = [];

  if (opts.paginate && opts.paginationSelector) {
    pages.push(await extractPageBlocks());

    const pagesScraped = await paginatePages({
      paginationSelector: opts.paginationSelector,
      pageCount: opts.pageCount || 0,
      paginationDelayMs: opts.paginationDelayMs,
      onPage: async () => {
        if (opts.scrollToBottom) await scrollToBottom(undefined, { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });
        pages.push(await extractPageBlocks());
      },
      onProgress,
      afk,
    });

    return { content: mergePages(pages), pagesScraped };
  }

  return { content: await extractPageBlocks(), pagesScraped: 1 };
}
```

with:

```typescript
  if (opts.paginate && opts.paginationSelector && ctx) {
    // Initial entry into the pagination state machine. runPaginationLoop
    // calls paginatePages once per page; on cross-navigation click the
    // function never returns (JS realm dies — engine resumes via
    // continuation in a new context), and on in-page change the loop
    // simply iterates again.
    return await runPaginationLoop(opts, ctx, [], onProgress!, !!afk);
  }

  return { content: await extractPageBlocks(), pagesScraped: 1 };
}
```

**Note on the `ctx` parameter:** `scrapeWholePage` doesn't currently receive context (config/searchTerms/etc.). You'll need to thread it down from `executeScrape` → `scrapeWholePage`. Add `ctx?: ScrapeContext` to both signatures and pass it through. `ScrapeContext` is a minimal interface:

```typescript
interface ScrapeContext {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  termIndex: number;
  stepIndex: number;
  previousIterations: WireIteration[];
}
```

Update `executeStep` → `executeScrape` → `scrapeWholePage` to pass `ctx`. The call in the term loop's step iteration already has `i` and `si` in scope; build the ctx there:

```typescript
            const scrapeCtx: ScrapeContext = {
              config,
              searchTerms,
              taskId,
              termIndex: i,
              stepIndex: si,
              previousIterations: result.iterations,
            };
            stepData = await executeStep(step, term, i, ..., afk, taskId, scrapeCtx);
```

Threading `ScrapeContext` through `executeStep` is mechanical: add an optional last param, pass through to `executeScrape`, pass through to `scrapeWholePage`. Other step types ignore it.


---

## File 3 (MODIFIED): `src/entrypoints/content.ts`

Mirror the wire-protocol field through the relay layer (this is the bug from the previous PR — content.ts strips fields it doesn't know about).

**Find** the `ExecuteFlowPayload` type (currently around line 92):

```typescript
    type ExecuteFlowPayload = {
      config: ScraperConfig;
      searchTerms: string[];
      taskId?: string;
      startTermIndex?: number;
      startLoopStepIndex?: number;
      previousIterations?: [];
      drainResumed?: boolean;
    };
```

**Replace** with:

```typescript
    type ExecuteFlowPayload = {
      config: ScraperConfig;
      searchTerms: string[];
      taskId?: string;
      startTermIndex?: number;
      startLoopStepIndex?: number;
      previousIterations?: [];
      drainResumed?: boolean;
      paginationContinuation?: import('../content/scraping/paginationHandler').PaginationContinuation;
    };
```

**Find** the `executeFlow({...})` call (currently around line 148) and **add** the field:

```typescript
          executeFlow({
            config: fp.config,
            searchTerms: fp.searchTerms ?? [],
            taskId: fp.taskId,
            startTermIndex: fp.startTermIndex ?? 0,
            startLoopStepIndex: fp.startLoopStepIndex ?? 0,
            previousIterations: fp.previousIterations ?? [],
            drainResumed: fp.drainResumed ?? false,
            paginationContinuation: fp.paginationContinuation,
          })
```

---

## File 4 (NO CHANGE NEEDED): `src/entrypoints/background.ts`

The SW's `tabs.onUpdated` continuation handler already does:

```typescript
const enriched = {
  ...(continuation as Record<string, unknown>),
  drainResumed: scheduler.findByTabId(tabId)?.drainResumed ?? false,
};
```

The `...continuation` spread carries `paginationContinuation` through automatically. Same for the two RESUME_AFTER_PAUSE held-continuation paths. No background.ts change needed.

**Verify** at implementation time that the `pendingContinuations.set(tabId, message.payload)` in the `REGISTER_CONTINUATION` handler stores the entire payload (including `paginationContinuation`) — not a stripped version. (It does — it stores `message.payload` whole.)

---

## File 5 (NEW): `src/__tests__/paginationHandler.test.ts`

Pure-ish tests for the single-page function. We can't test `chrome.runtime.sendMessage` round-trips without a real runtime, but we can stub it and verify the state-machine transitions.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { paginatePages } from '../content/scraping/paginationHandler';
import type { SelectorDescriptor } from '../types/config';
import type { PageContent } from '../content/extraction/pageBlockExtractor';

const FAKE_SELECTOR: SelectorDescriptor = {
  cssSelector: 'li.next a',
  xpathSelector: null,
  textContent: 'next',
  tagName: 'A',
  attributes: {},
  position: { parentSelector: null, childIndex: 0 },
  ariaLabel: null,
};

const PAGE_FIXTURE: PageContent = {
  blocks: [],
  tables: [],
  charts: [],
  apiCalls: [],
};

const messages: Array<{ type: string; payload?: unknown }> = [];

beforeEach(() => {
  messages.length = 0;
  document.body.innerHTML = '';

  // Stub global browser.runtime.sendMessage
  (globalThis as unknown as { browser?: unknown }).browser = {
    runtime: {
      sendMessage: vi.fn((msg: unknown) => {
        messages.push(msg as { type: string; payload?: unknown });
        return Promise.resolve();
      }),
    },
  };

  // Stub elementResolution.resolveElement to return whatever button we put in the DOM.
  // The actual resolver is tested elsewhere; here we just need it to find the next btn.
});

describe('paginatePages — finished states', () => {
  it('returns finished when pageCountTarget is reached', async () => {
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 1,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.finished).toBe(true);
    expect(result.pages).toHaveLength(1);
    // No continuation registered (we hit cap).
    expect(messages.find((m) => m.type === 'REGISTER_CONTINUATION')).toBeUndefined();
  });

  it('returns finished when no next button is found', async () => {
    document.body.innerHTML = '<div>no pagination here</div>';
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 10,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.finished).toBe(true);
    expect(result.pages).toHaveLength(1);
  });

  it('appends to resumedPages when resuming', async () => {
    const earlier: PageContent = { ...PAGE_FIXTURE, blocks: [{ type: 'paragraph', text: 'page 1' }] };
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 2,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [earlier],
      resumedPagesScraped: 1,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].blocks).toEqual([{ type: 'paragraph', text: 'page 1' }]);
    expect(result.finished).toBe(true); // hit pageCountTarget=2
  });
});

describe('paginatePages — accumulator size guard', () => {
  it('stops when accumulator exceeds soft byte limit', async () => {
    // Build a fixture that's just over 10 MB worth of strings.
    const huge: PageContent = {
      ...PAGE_FIXTURE,
      blocks: Array.from({ length: 1000 }, () => ({
        type: 'paragraph' as const,
        text: 'X'.repeat(11_000),
      })),
    };
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 10,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(huge),
    });

    expect(result.finished).toBe(true);
  });
});
```

**Note on test brittleness:** the resolver for `paginationSelector` in real code uses CSS path lookups against the DOM. In the tests above, an empty/unrelated DOM means `resolveButtonWithRetry` returns `null` — which is the "no next button" path we want to exercise. Tests don't assert against the click + waitForContentChange flow because that requires a live navigating page.

---

## What's NOT covered by automated tests

- **Cross-navigation resume**: end-to-end requires a real browser. Verify manually with books.toscrape.com.
- **In-page change loop**: requires a real DOM + AJAX paginator. Verify manually with quotes.toscrape.com/scroll or scrapingclub.com.
- **`pendingContinuations` carrying `paginationContinuation` across SW restart**: integration-level concern, manually verifiable.

---

## Verification

### Automated

```bash
npm test -- src/__tests__/paginationHandler.test.ts
npm test                             # full suite (~306+ tests)
npm run type-check                   # output must equal pre-PR baseline
npm run lint -- src/content/scraping/paginationHandler.ts src/content/scraping/scrapingEngine.ts src/entrypoints/content.ts
npm run build
```

**Pre-existing typecheck baseline**: same set as prior PRs (DataMappingView, ResultsView, types/index.ts, OnMessageListener, runDetectorWatchdog mock). Output must be identical.

### Manual smoke (3 cases)

Build with `npm run build`. Reload the extension. Open the SW DevTools console.

1. **Cross-navigation paginator (books.toscrape.com)** — set up a wholePage scrape config:
   - Starting URL: `http://books.toscrape.com/`
   - paginate: true
   - paginationSelector: pick the `<li class="next"><a>next</a></li>` link
   - pageCount: 5
   Run. Expect:
   - Page 1 scrapes
   - SW console: `[SW] tabs.onUpdated firing continuation` after each "next" click
   - Each new page logged via `[page] [executeFlow] called | ... | paginationContinuation: { pagesScraped: N, ... }` (consider adding this log to the executeFlow entry)
   - After 5 pages, FLOW_COMPLETE with merged page content

2. **In-page paginator (quotes.toscrape.com)** — same config but on `https://quotes.toscrape.com/scroll` or any AJAX paginator. Expect:
   - SW console: NO continuation re-deliveries (each click stays in same realm)
   - SW console: `[page] CANCEL_CONTINUATION` after each in-page change
   - All pages in one engine invocation
   - FLOW_COMPLETE with merged content

3. **Hit the pageCount cap** — run book scrape with pageCount: 3 on a 50-page paginator. Expect:
   - Exactly 3 pages scraped, then FLOW_COMPLETE
   - No further continuation re-deliveries after the 3rd page

### Edge cases

| Case | Behaviour |
|---|---|
| User edits the config mid-batch and step layout shifts | Resume `paginationContinuation` mismatches `(termIndex, stepIndex)` against the new step layout → fall through to normal `executeStep` |
| Tab closed mid-pagination | Existing `chrome.tabs.onRemoved` handler fires → `drainNextRemoteTask` → task ends → no resume |
| Last page has no "next" button | Resume picks up on what the SW thinks is page N+1, scrapes it, finds no next button → returns finished |
| Last page has a *disabled* "next" button | `isDisabledOrHidden` short-circuits → returns finished |
| In-page paginator that triggers a content change but the change isn't textually-distinct (e.g. infinite scroll where new items append) | `waitForContentChange` is innerText-snapshot-based; new content extends the snapshot → detected as changed. Edge case where new content is identical to a sliced 2000-char window: theoretical; ignored in v1 |
| Content script context invalidated mid-scrape (extension reload) | `browser.runtime.sendMessage` throws inside the catch wrapping. Pagination falls through cleanly without registering a continuation. SW won't have the continuation; tab dies. Acceptable. |
| Pagination accumulator exceeds 10 MB soft cap | Returns finished with what we have, logs a progress message |

---

## Maintainability checklist

- [x] No magic strings — `MessageType.REGISTER_CONTINUATION`, `MessageType.CANCEL_CONTINUATION` reused
- [x] Reuse — `resolveButtonWithRetry`, `isDisabledOrHidden`, `waitForContentChange`, `mergePages`, `extractPageBlocks` all reused
- [x] Backward compat — element-level pagination unchanged; in-page page-pagination still works (hits the in-page change branch)
- [x] One responsibility per module — `paginationHandler.ts` knows about the pagination state machine; `scrapingEngine.ts` knows about engine resume; SW just propagates payloads
- [x] Pure-ish testing — single-page function tested with stubs; cross-nav paths covered manually
- [x] Configurable knobs — `pageCount`, `paginationDelayMs` from step options; soft byte limit + safety cap as module constants

---

## Stuck-loop reminder

If two consecutive attempts at the same fix fail, STOP and report. Common gotchas: (a) the `ScrapeContext` plumbing through `executeStep` is mechanical but easy to miss a call site — grep for `executeStep(` to find them all; (b) the resume branch in 2b runs BEFORE `executeStep` — the early `continue;` in the loop is critical; (c) the `await new Promise<never>(() => {})` after `kind: 'continued'` MUST be unreachable in real flows where the click triggered a navigation (the JS realm dies first). If a test or real run hangs at that promise without navigating, it means the in-page change detection failed — debug `waitForContentChange`'s snapshot logic, not the resume logic.
