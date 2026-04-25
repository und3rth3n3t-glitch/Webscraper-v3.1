import { startPicker, stopPicker } from '../content/picker/elementPicker';
import { executeFlow, abortFlow } from '../content/scraping/scrapingEngine';
import { generateSelectorDescriptor, resolveElement } from '../content/scraping/elementResolution';
import { injectSelectorGenerator } from '../content/extraction/domUtils';
import {
  detectElementType,
  getElementLabel,
  detectPagination,
  expandHiddenElements,
  TABLE_FRAMEWORK_SELECTORS,
  CHART_SELECTORS,
  promoteToChartContainer,
  deduplicateNested,
} from '../content/extraction/domUtils';
import { getTableColumnNames, getTablePreview } from '../content/extraction/tableExtractor';
import { detectChartExtractionMethod } from '../content/extraction/chartExtractor';
import type { SelectorDescriptor, ScraperConfig } from '../types/config';
import type { ApiCall } from '../types/extraction';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    const w = window as Window & { __blueberryScraper?: boolean; __bb_nonce?: string };
    if (w.__blueberryScraper) return;
    w.__blueberryScraper = true;

    // ── Wire up dependency injection (avoids circular import) ──
    injectSelectorGenerator(generateSelectorDescriptor);

    // ── Nonce for postMessage verification (MAIN ↔ ISOLATED) ──
    const BB_NONCE = crypto.randomUUID();
    w.__bb_nonce = BB_NONCE;

    // ── Network events from MAIN world → forward to SW ──
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data as { type?: string; nonce?: string; call?: ApiCall } | null;
      if (!msg || msg.type !== '__bb_network_event') return;
      if (msg.nonce !== BB_NONCE) return;
      try {
        browser.runtime.sendMessage({ type: 'NETWORK_CALL_CAPTURED', payload: msg.call });
      } catch { /* extension context may be invalidated */ }
    });

    // ── Register this frame with the service worker ──
    try {
      browser.runtime.sendMessage({ type: 'FRAME_REGISTER' });
    } catch { /* expected */ }

    // ── Element picker event bridge ──
    window.addEventListener('__blueberry_element_picked', (e) => {
      try {
        browser.runtime.sendMessage({ type: 'ELEMENT_PICKED', payload: (e as CustomEvent).detail });
      } catch { /* expected */ }
    });

    window.addEventListener('__blueberry_picker_cancelled', () => {
      try {
        browser.runtime.sendMessage({ type: 'PICKER_CANCELLED' });
      } catch { /* expected */ }
    });

    window.addEventListener('__blueberry_element_hover', (e) => {
      try {
        browser.runtime.sendMessage({ type: 'ELEMENT_HOVER', payload: (e as CustomEvent).detail });
      } catch { /* expected */ }
    });

    // ── Highlight state ──
    type HighlightState = { el: HTMLElement; outline: string; boxShadow: string } | null;
    const highlightW = window as Window & { __blueberryHighlight?: HighlightState };

    function clearHighlight(): void {
      const prev = highlightW.__blueberryHighlight;
      if (prev) {
        prev.el.style.outline = prev.outline;
        prev.el.style.boxShadow = prev.boxShadow;
        highlightW.__blueberryHighlight = null;
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearHighlight();
    });

    // ── Message listener ──

    type ExecuteFlowPayload = {
      config: ScraperConfig;
      searchTerms: string[];
      taskId?: string;
      startTermIndex?: number;
      startLoopStepIndex?: number;
      previousIterations?: [];
    };

    // Messages that must only run in the top frame. Without this guard,
    // every iframe (e.g. Adobe AudienceManager tracking iframes injected by
    // many sites) receives broadcast tabs.sendMessage calls and runs them
    // against its own document, producing wrong results that can overwrite
    // the top frame's output.
    const TOP_FRAME_ONLY = new Set(['EXECUTE_FLOW', 'SCAN_ELEMENTS', 'GET_PAGE_INFO']);

    // Per-frame scan abort flag. Set true on SCAN_ABORT; checked between
    // expand-clicks and per-element work in SCAN_ELEMENTS.
    let scanAbortSignal = false;

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const { type, payload } = message as { type: string; payload: Record<string, unknown> };

      if (TOP_FRAME_ONLY.has(type) && window !== window.top) {
        return true; // Subframe — silently no-op; top frame's sendResponse will win.
      }

      switch (type) {
        case 'PING':
          sendResponse({ type: 'PONG' });
          break;

        case 'GET_PAGE_INFO':
          sendResponse({
            type: 'PAGE_INFO',
            payload: {
              url: window.location.href,
              title: document.title,
              domain: window.location.hostname,
            },
          });
          break;

        case 'START_PICKER':
          startPicker((payload?.mode as 'single' | 'allSimilar' | 'container') || 'single');
          sendResponse({ ok: true });
          break;

        case 'CANCEL_PICKER':
          stopPicker();
          sendResponse({ ok: true });
          break;

        case 'EXECUTE_FLOW': {
          const fp = payload as unknown as ExecuteFlowPayload;
          executeFlow({
            config: fp.config,
            searchTerms: fp.searchTerms ?? [],
            taskId: fp.taskId,
            startTermIndex: fp.startTermIndex ?? 0,
            startLoopStepIndex: fp.startLoopStepIndex ?? 0,
            previousIterations: fp.previousIterations ?? [],
          })
            .then((result) => {
              try {
                browser.runtime.sendMessage({ type: 'FLOW_COMPLETE', payload: { result, taskId: fp.taskId } });
              } catch { /* expected */ }
            })
            .catch((err: Error) => {
              try {
                browser.runtime.sendMessage({ type: 'FLOW_ERROR', payload: { error: err.message, taskId: fp.taskId } });
              } catch { /* expected */ }
            });
          sendResponse({ ok: true });
          break;
        }

        case 'ABORT_FLOW':
          abortFlow();
          sendResponse({ ok: true });
          break;

        case 'SCAN_ABORT':
          scanAbortSignal = true;
          sendResponse({ ok: true });
          break;

        case 'RESUME_AFTER_CLOUDFLARE':
          // Handled internally by scrapingEngine via onMessage listener
          break;

        case 'HIGHLIGHT_ELEMENT': {
          try {
            const desc = (payload as { descriptor: SelectorDescriptor }).descriptor;
            const { element } = resolveElement(desc);
            if (element) {
              clearHighlight();
              const el = element as HTMLElement;
              highlightW.__blueberryHighlight = {
                el,
                outline: el.style.outline,
                boxShadow: el.style.boxShadow,
              };
              el.style.outline = '2px solid #5F259F';
              el.style.boxShadow = '0 0 0 4px rgba(95, 37, 159, 0.25)';
              el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          } catch { /* expected */ }
          sendResponse({ ok: true });
          break;
        }

        case 'UNHIGHLIGHT_ELEMENT':
          clearHighlight();
          sendResponse({ ok: true });
          break;

        case 'SCAN_ELEMENTS': {
          const { scanType, expand } = payload as { scanType: string; expand?: boolean };

          scanAbortSignal = false;

          const sendProgress = (msg: string): void => {
            try {
              browser.runtime.sendMessage({ type: 'SCAN_PROGRESS', payload: { message: msg } });
            } catch { /* expected */ }
          };

          const sendAborted = (): void => {
            try {
              browser.runtime.sendMessage({
                type: 'SCAN_COMPLETE',
                payload: { elements: [], scanType, found: 0, aborted: true },
              });
            } catch { /* expected */ }
          };

          (async () => {
            try {
              if (expand) {
                sendProgress('Expanding hidden sections...');
                await expandHiddenElements({
                  isAborted: () => scanAbortSignal,
                  onProgress: sendProgress,
                });
                if (scanAbortSignal) { sendAborted(); return; }
              }

              const results: Array<Record<string, unknown>> = [];

              if (scanType === 'table') {
                sendProgress('Looking for tables...');
                const tableEls = new Set<Element>();
                for (const el of document.querySelectorAll(TABLE_FRAMEWORK_SELECTORS)) {
                  if (detectElementType(el as HTMLElement) === 'table') tableEls.add(el);
                }
                deduplicateNested(tableEls);

                const total = tableEls.size;
                let i = 0;
                for (const el of tableEls) {
                  if (scanAbortSignal) { sendAborted(); return; }
                  i++;
                  sendProgress(`Analyzing table ${i} of ${total}...`);
                  try {
                    const descriptor = generateSelectorDescriptor(el);
                    results.push({
                      descriptor,
                      elementType: 'table',
                      label: getElementLabel(el as HTMLElement),
                      extra: {
                        columnNames: getTableColumnNames(el as HTMLElement) || [],
                        preview: getTablePreview(el as HTMLElement, 3) || [],
                        paginationDetected: detectPagination(el as HTMLElement),
                      },
                    });
                  } catch { /* expected */ }
                }
              } else if (scanType === 'chart') {
                sendProgress('Looking for charts...');
                const seen = new Set<Element>();
                for (const sel of CHART_SELECTORS) {
                  if (scanAbortSignal) { sendAborted(); return; }
                  let nodeList: NodeListOf<Element>;
                  try { nodeList = document.querySelectorAll(sel); } catch { continue; }
                  for (const el of nodeList) {
                    try {
                      if (seen.has(el)) continue;
                      const chartEl = promoteToChartContainer(el as HTMLElement);
                      if (!seen.has(chartEl) && detectElementType(chartEl) === 'chart') {
                        seen.add(chartEl);
                      }
                    } catch { /* expected */ }
                  }
                }
                deduplicateNested(seen);

                const total = seen.size;
                let i = 0;
                for (const el of seen) {
                  if (scanAbortSignal) { sendAborted(); return; }
                  i++;
                  sendProgress(`Analyzing chart ${i} of ${total}...`);
                  try {
                    const descriptor = generateSelectorDescriptor(el);
                    const chartMethod = await detectChartExtractionMethod(el as HTMLElement);
                    results.push({
                      descriptor,
                      elementType: 'chart',
                      label: getElementLabel(el as HTMLElement),
                      extra: { chartMethod },
                    });
                  } catch { /* expected */ }
                }
              }

              try {
                browser.runtime.sendMessage({
                  type: 'SCAN_COMPLETE',
                  payload: { elements: results, scanType, found: results.length },
                });
              } catch { /* expected */ }
            } catch (err) {
              try {
                browser.runtime.sendMessage({
                  type: 'SCAN_ERROR',
                  payload: { error: (err as Error).message },
                });
              } catch { /* expected */ }
            }
          })();

          sendResponse({ ok: true });
          break;
        }

        default:
          break;
      }

      return true;
    });
  },
});
