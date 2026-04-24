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

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const { type, payload } = message as { type: string; payload: Record<string, unknown> };

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
          startPicker((payload?.mode as 'single' | 'allSimilar' | 'container') || 'single', payload || {});
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

          (async () => {
            try {
              if (expand) await expandHiddenElements();

              const results: Array<Record<string, unknown>> = [];

              if (scanType === 'table') {
                const tableEls = new Set<Element>();
                for (const el of document.querySelectorAll(TABLE_FRAMEWORK_SELECTORS)) {
                  if (detectElementType(el as HTMLElement) === 'table') tableEls.add(el);
                }
                deduplicateNested(tableEls);
                for (const el of tableEls) {
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
                const seen = new Set<Element>();
                for (const sel of CHART_SELECTORS) {
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
                for (const el of seen) {
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
