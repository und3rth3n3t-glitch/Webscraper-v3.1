import { resolveElement } from './elementResolution';
import { naturalClick } from './humanBehavior';
import { waitForContentChange } from '../extraction/domUtils';
import type { SelectorDescriptor } from '../../types/config';

const PAGE_SAFETY_CAP = 200;
const ELEMENT_SAFETY_CAP = 100;

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

export async function paginatePages(params: {
  paginationSelector: SelectorDescriptor;
  pageCount?: number;
  onPage?: (pageIndex: number) => Promise<void>;
  onProgress?: (msg: string) => void;
  afk?: boolean;
}): Promise<number> {
  const { paginationSelector, pageCount = 0, onPage, onProgress, afk } = params;
  const maxPages = pageCount > 0 ? Math.min(pageCount, PAGE_SAFETY_CAP) : PAGE_SAFETY_CAP;
  let pagesScraped = 1;

  let lastSnapshot = document.body.innerText.substring(0, 2000);

  for (let i = 1; i < maxPages; i++) {
    const nextBtn = await resolveButtonWithRetry(paginationSelector);
    if (!nextBtn) {
      onProgress?.('No next page button found — stopping pagination');
      break;
    }

    if (isDisabledOrHidden(nextBtn as HTMLElement)) {
      onProgress?.('Reached last page');
      break;
    }

    onProgress?.(`Loading page ${i + 1}...`);
    await naturalClick(nextBtn as HTMLElement, { afk });

    const changed = await waitForContentChange(lastSnapshot, 12000);
    if (!changed) {
      onProgress?.('Page content did not change after clicking next — stopping');
      break;
    }

    await randomDelay(400, 700);
    lastSnapshot = document.body.innerText.substring(0, 2000);
    pagesScraped++;
    await onPage?.(i);
    await randomDelay(600, 1400);
  }

  return pagesScraped;
}

export async function paginateElement(params: {
  paginationSelector: SelectorDescriptor;
  paginationCount?: number;
  onPage?: (pageIndex: number) => Promise<void>;
  onProgress?: (msg: string) => void;
  container?: Element | null;
  afk?: boolean;
}): Promise<number> {
  const { paginationSelector, paginationCount = 0, onPage, onProgress, container, afk } = params;
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

    await randomDelay(400, 700);
    pagesScraped++;
    await onPage?.(i);
    await randomDelay(600, 1400);
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
