import { resolveElement } from './elementResolution';
import { naturalClick } from './humanBehavior';
import { waitForContentChange } from '../extraction/domUtils';
import type { SelectorDescriptor } from '../../types/config';
import { MessageType } from '../../types/messages';
import type { ScraperConfig } from '../../types/config';
import type { PageContent } from '../extraction/pageBlockExtractor';
import type { WireIteration } from '../shaping';

const PAGE_SAFETY_CAP = 200;
const ELEMENT_SAFETY_CAP = 100;

// Soft cap on accumulator payload size. continuations ride on
// chrome.runtime.sendMessage which has a hard ~64 MB limit, but practical
// payloads should stay well under to avoid SW relay slowdowns.
const ACCUMULATOR_SOFT_LIMIT_BYTES = 10 * 1024 * 1024;

// Discriminated union for resumable pagination state.
//   - 'wholePage' carries an array of full-page extractions
//   - 'element'   carries per-page row batches scoped to one specific
//                 element within the step
export type PaginationContinuation =
  | {
      kind: 'wholePage';
      termIndex: number;
      stepIndex: number;
      pagesScraped: number;
      pageCountTarget: number;
      paginationDelayMs?: number;
      pages: PageContent[];
    }
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

export interface PaginatePageStepResult {
  // True if pagination is finished (cap reached, no next button, disabled,
  // size limit, or in-page change timeout). Caller should merge `pages`
  // and finalise the step's output.
  finished: boolean;
  // Pages accumulated so far (caller may pass back in via resumedPages on
  // the next leg).
  pages: PageContent[];
}

async function resolveButtonWithRetry(
  descriptor: SelectorDescriptor,
  maxAttempts = 3,
): Promise<Element | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { element } = resolveElement(descriptor);
    if (element) return element;
    if (attempt < maxAttempts) await randomDelay(400, 600);
  }
  return null;
}

interface PaginateAcrossNavArgs<T> {
  termIndex: number;
  stepIndex: number;
  paginationSelector: SelectorDescriptor;
  pageCountTarget: number;
  paginationDelayMs?: number;
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  previousIterations: WireIteration[];
  // Accumulator state. resumedAccumulator length reflects pages already
  // scraped on prior legs.
  resumedAccumulator: T[];
  // Closure that extracts THIS page's contribution (one element of T).
  extractCurrentPage: () => Promise<T>;
  // Caller-provided builder that wraps the in-flight accumulator into
  // a kind-specific PaginationContinuation. Lets the generic stay agnostic
  // about the union variants.
  buildContinuation: (state: { pagesScraped: number; accumulator: T[] }) => PaginationContinuation;
  onProgress?: (msg: string) => void;
  afk?: boolean;
}

interface PaginateAcrossNavResult<T> {
  finished: boolean;
  accumulator: T[];
}

async function paginateAcrossNav<T>(args: PaginateAcrossNavArgs<T>): Promise<PaginateAcrossNavResult<T>> {
  const cap = args.pageCountTarget > 0
    ? Math.min(args.pageCountTarget, PAGE_SAFETY_CAP)
    : PAGE_SAFETY_CAP;
  const interPageBase = args.paginationDelayMs ?? 1500;

  // 1. Extract current page (initial entry → page 1; resumed leg → page N)
  const thisPage = await args.extractCurrentPage();
  const accumulator = [...args.resumedAccumulator, thisPage];
  const pagesScraped = args.resumedAccumulator.length + 1;

  args.onProgress?.(`Scraped page ${pagesScraped}${args.pageCountTarget > 0 ? ` of ${cap}` : ''}`);

  // 2. Cap check
  if (pagesScraped >= cap) {
    args.onProgress?.(`Pagination cap reached (${cap}) — stopping`);
    return { finished: true, accumulator };
  }

  // 3. Soft size guard
  const accumulatorBytes = JSON.stringify(accumulator).length;
  if (accumulatorBytes > ACCUMULATOR_SOFT_LIMIT_BYTES) {
    args.onProgress?.(`Pagination accumulator exceeded ${Math.floor(ACCUMULATOR_SOFT_LIMIT_BYTES / (1024 * 1024))} MB — stopping`);
    return { finished: true, accumulator };
  }

  // 4. Find next button
  const nextBtn = await resolveButtonWithRetry(args.paginationSelector);
  if (!nextBtn) {
    args.onProgress?.('No next page button found — pagination complete');
    return { finished: true, accumulator };
  }

  // 5. Disabled check
  if (isDisabledOrHidden(nextBtn as HTMLElement)) {
    args.onProgress?.('Next page button is disabled — pagination complete');
    return { finished: true, accumulator };
  }

  // 6. Pre-emptive continuation registration (cross-nav fallback)
  const continuationPayload = {
    config: args.config,
    searchTerms: args.searchTerms,
    taskId: args.taskId,
    startTermIndex: args.termIndex,
    startLoopStepIndex: args.stepIndex,
    previousIterations: args.previousIterations,
    paginationContinuation: args.buildContinuation({ pagesScraped, accumulator }),
  };
  try {
    await browser.runtime.sendMessage({
      type: MessageType.REGISTER_CONTINUATION,
      payload: continuationPayload,
    });
  } catch { /* extension context invalidated — fall through */ }

  // 7. Click + race
  const snapshotBefore = document.body.innerText.substring(0, 2000);
  await randomDelay(interPageBase * 0.7, interPageBase * 1.3);
  args.onProgress?.(`Loading page ${pagesScraped + 1}...`);
  await naturalClick(nextBtn as HTMLElement, { afk: args.afk });

  // 8. Wait for content change OR die. If page navigates, JS realm dies
  //    here — control resumes via the continuation registered above.
  const changed = await waitForContentChange(snapshotBefore, 12000);

  // 9. We didn't navigate. Cancel the continuation we registered.
  try {
    await browser.runtime.sendMessage({ type: MessageType.CANCEL_CONTINUATION });
  } catch { /* ignore */ }

  if (!changed) {
    args.onProgress?.('Page content did not change after clicking next — stopping');
    return { finished: true, accumulator };
  }

  // 10. In-page change. Caller loops and calls again.
  return { finished: false, accumulator };
}

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
  const result = await paginateAcrossNav<PageContent>({
    termIndex: args.termIndex,
    stepIndex: args.stepIndex,
    paginationSelector: args.paginationSelector,
    pageCountTarget: args.pageCountTarget,
    paginationDelayMs: args.paginationDelayMs,
    config: args.config,
    searchTerms: args.searchTerms,
    taskId: args.taskId,
    previousIterations: args.previousIterations,
    resumedAccumulator: args.resumedPages,
    extractCurrentPage: args.extractCurrentPage,
    buildContinuation: ({ pagesScraped, accumulator }) => ({
      kind: 'wholePage',
      termIndex: args.termIndex,
      stepIndex: args.stepIndex,
      pagesScraped,
      pageCountTarget: args.pageCountTarget,
      paginationDelayMs: args.paginationDelayMs,
      pages: accumulator,
    }),
    onProgress: args.onProgress,
    afk: args.afk,
  });

  return { finished: result.finished, pages: result.accumulator };
}

export async function paginateElementInPage(params: {
  paginationSelector: SelectorDescriptor;
  paginationCount?: number;
  paginationDelayMs?: number;
  onPage?: (pageIndex: number) => Promise<void>;
  onProgress?: (msg: string) => void;
  container?: Element | null;
  afk?: boolean;
}): Promise<number> {
  const { paginationSelector, paginationCount = 0, onPage, onProgress, container, afk } = params;
  const interPageBase = params.paginationDelayMs ?? 1500;
  const maxPages = paginationCount > 0 ? Math.min(paginationCount, ELEMENT_SAFETY_CAP) : ELEMENT_SAFETY_CAP;
  let pagesScraped = 1;

  const scope = container || document.body;

  for (let i = 1; i < maxPages; i++) {
    const nextBtn = await resolveButtonWithRetry(paginationSelector);
    if (!nextBtn) {
      onProgress?.('Element pagination: next button not found');
      break;
    }

    if (isDisabledOrHidden(nextBtn as HTMLElement)) {
      onProgress?.('Element pagination: reached last page');
      break;
    }

    const beforeClickHTML = (scope as HTMLElement).innerHTML;

    onProgress?.(`Loading element page ${i + 1}...`);
    await naturalClick(nextBtn as HTMLElement, { afk });

    const changed = await waitForElementContentChange(scope as HTMLElement, beforeClickHTML, 10000);
    if (!changed) {
      onProgress?.('Element content did not change — stopping element pagination');
      break;
    }

    await randomDelay(200, 400);
    pagesScraped++;
    await onPage?.(i);
    await randomDelay(interPageBase * 0.7, interPageBase * 1.3);
  }

  return pagesScraped;
}

function isDisabledOrHidden(el: HTMLElement): boolean {
  if (!el) return true;
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;

  const cls = el.className?.toString() || '';
  if (/(disabled|inactive|hidden)/i.test(cls)) return true;

  return false;
}

function waitForElementContentChange(
  container: HTMLElement,
  referenceHTML: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const settle = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timeoutTimer);
      resolve(true);
    };

    const onMutation = () => {
      if (container.innerHTML !== referenceHTML) {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(settle, 600);
      }
    };

    const observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    onMutation();

    const timeoutTimer = setTimeout(() => {
      if (!resolved) { resolved = true; observer.disconnect(); resolve(false); }
    }, timeoutMs);
  });
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

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
