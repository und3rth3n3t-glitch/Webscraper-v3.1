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
  const pagesScraped = args.resumedPagesScraped + 1;

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

export async function paginateElement(params: {
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
