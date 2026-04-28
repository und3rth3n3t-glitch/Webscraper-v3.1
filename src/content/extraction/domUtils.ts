import type { SelectorDescriptor } from '../../types/config';
import { naturalClick } from '../scraping/humanBehavior';

function debugLog(context: string, error: unknown): void {
  console.debug(`[Blueberry] ${context}:`, error instanceof Error ? error.message : error);
}

// Imported lazily at call site to avoid circular dependency with selectorEngine
let _generateSelectorDescriptor: ((el: Element) => SelectorDescriptor) | null = null;
export function injectSelectorGenerator(fn: (el: Element) => SelectorDescriptor): void {
  _generateSelectorDescriptor = fn;
}

export function detectElementType(element: Element | null): string | null {
  if (!element) return null;
  if (typeof element.getAttribute !== 'function') return null;
  const tag = element.tagName;
  const role = element.getAttribute('role') || '';

  if (tag === 'SELECT') return 'select';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'input';
  if (tag === 'TABLE') return 'table';
  if (role === 'table' || role === 'grid' || role === 'treegrid') return 'table';
  if (
    element.className &&
    element.className.toString().match(
      /(ag-root|handsontable|grid-container|p-datatable|p-treetable|dataTables_wrapper|dataTable|MuiDataGrid-root|ant-table|k-grid|tabulator|dx-datagrid|v-data-table|bootstrap-table|x-grid|ui-jqgrid|e-grid)/i,
    )
  )
    return 'table';
  if (tag === 'P-TABLE' || tag === 'KENDO-GRID' || tag === 'EJS-GRID') return 'table';

  if (isLikelyChart(element)) return 'chart';

  if (element.querySelector('table')) return 'table';

  const style = window.getComputedStyle(element as HTMLElement);
  if (style.display === 'grid' || style.display === 'inline-grid') {
    const children = Array.from(element.children);
    if (children.length >= 3) {
      const firstTag = children[0]?.tagName;
      const firstCls = children[0]?.className;
      if (children.slice(0, 5).every((c) => c.tagName === firstTag && c.className === firstCls)) {
        return 'grid';
      }
    }
  }

  if (tag === 'UL' || tag === 'OL' || tag === 'DL') return 'list';
  if (role === 'list' || role === 'listbox' || role === 'menu') return 'list';

  return null;
}

export function getElementLabel(element: Element | null): string {
  if (!element) return 'Element';

  const text = ((element as HTMLElement).innerText || element.textContent || '').trim();
  if (text && text.length <= 40 && element.tagName.match(/^(BUTTON|A|SPAN|DIV|H[1-6])$/)) {
    return text;
  }

  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    const inputEl = element as HTMLInputElement;
    const labelEl = inputEl.id
      ? document.querySelector(`label[for="${inputEl.id}"]`)
      : inputEl.closest('label');
    if (labelEl) {
      const labelText = labelEl.textContent?.trim();
      if (labelText) return `Type in "${labelText}"`;
    }
    if (inputEl.placeholder) return `Type in "${inputEl.placeholder}"`;
    if (inputEl.getAttribute('aria-label')) return `Type in "${inputEl.getAttribute('aria-label')}"`;
    return 'Text input';
  }

  if (element.tagName === 'SELECT') {
    const sel = element as HTMLSelectElement;
    const labelEl = document.querySelector(`label[for="${sel.id}"]`);
    if (labelEl) return `Select from "${labelEl.textContent?.trim()}"`;
    return 'Dropdown';
  }

  if (element.tagName === 'TABLE') {
    const caption = element.querySelector('caption');
    if (caption) return `Table: ${caption.textContent?.trim()}`;
    const heading = findNearestHeading(element);
    if (heading) return `Table near "${heading.substring(0, 30)}"`;
    return 'Data table';
  }

  if (isLikelyChart(element)) {
    const figure = element.closest('figure');
    if (figure) {
      const cap = figure.querySelector('figcaption');
      if (cap?.textContent?.trim()) return `Chart: ${cap.textContent.trim().substring(0, 30)}`;
    }
    const aria = element.getAttribute('aria-label');
    if (aria) return `Chart: ${aria.substring(0, 30)}`;
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref?.textContent?.trim()) return `Chart: ${ref.textContent.trim().substring(0, 30)}`;
    }
    if (element.tagName === 'SVG' || element.querySelector('svg')) {
      const svg = element.tagName === 'SVG' ? element : element.querySelector('svg');
      const title = svg?.querySelector(':scope > title');
      if (title?.textContent?.trim()) return `Chart: ${title.textContent.trim().substring(0, 30)}`;
    }
    const heading = findNearestHeading(element);
    if (heading) return `Chart near "${heading.substring(0, 30)}"`;
    const parent = element.parentElement;
    if (parent) {
      const titleEl = parent.querySelector('[class*="title" i], [class*="caption" i]');
      if (titleEl?.textContent?.trim()) return `Chart: ${titleEl.textContent.trim().substring(0, 30)}`;
    }
    return 'Chart';
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.substring(0, 40);

  const cls = Array.from(element.classList).slice(0, 1).join('.');
  return `${element.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
}

export function detectPagination(element: Element | null): SelectorDescriptor | null {
  if (!element) return null;
  const container = element.parentElement || element;

  const patterns = [
    'a[rel="next"]',
    'button[aria-label*="next" i]',
    'button[aria-label*="Next" i]',
    '[class*="next-page"]',
    '[class*="nextPage"]',
    '[aria-label*="next page" i]',
    'li.next > a',
    '.pagination .next',
    'nav[aria-label*="pagination" i]',
    'button[title*="next" i]',
    'a[title*="next" i]',
    '[class*="load-more"]',
    '[class*="loadMore"]',
    '[class*="show-more"]',
    '[class*="showMore"]',
    '[class*="ag-paging-button"][ref="btNext"]',
    '.dataTables_paginate .next',
    '[class*="MuiTablePagination"] button:last-of-type',
    '.k-pager-nav:last-of-type',
    '.pager .next a',
    '[class*="pagination"] [class*="next"]',
    '.pagination li:last-child a',
  ];

  for (const pattern of patterns) {
    try {
      const el =
        container.closest('section, div, nav, table')?.querySelector(pattern) ||
        document.querySelector(pattern);
      if (el && _generateSelectorDescriptor) {
        const descriptor = _generateSelectorDescriptor(el);
        descriptor._paginationMeta = {
          text: (el.textContent || '').trim().substring(0, 30),
          tagName: el.tagName,
        };
        return descriptor;
      }
    } catch (e) {
      debugLog('pagination selector generation', e);
    }
  }

  const scope = container.closest('section, div, nav, table') || document;
  const textMatch = findNextByText(scope as Element | Document);
  if (textMatch && _generateSelectorDescriptor) {
    const descriptor = _generateSelectorDescriptor(textMatch);
    descriptor._paginationMeta = {
      text: (textMatch.textContent || '').trim().substring(0, 30),
      tagName: textMatch.tagName,
    };
    return descriptor;
  }
  return null;
}

function findNextByText(scope: Element | Document): Element | null {
  const candidates = scope.querySelectorAll('button, a, [role="button"]');
  const nextTexts = ['next', '›', '»', '→', '>>'];
  for (const el of candidates) {
    const text = (el.textContent || '').trim().toLowerCase();
    if (text.length > 0 && text.length < 20 && nextTexts.some((t) => text.includes(t))) {
      if (text.includes('prev')) continue;
      return el;
    }
  }
  return null;
}

function findNearestHeading(element: Element): string | null {
  let node: Element | null = element;
  while (node && node !== document.body) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.matches('h1,h2,h3,h4,h5,h6')) return sibling.textContent?.trim() ?? null;
      const childHeading = sibling.querySelector(
        ':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6',
      );
      if (childHeading) return childHeading.textContent?.trim() ?? null;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

const MIN_CHART_WIDTH = 120;
const MIN_CHART_HEIGHT = 80;

export const CHART_LIB_PATTERN =
  /highcharts|recharts|visx|victory|nivo|chart\.?js|chartjs|echarts|apexcharts|plotly|c3-|billboard|nvd3|frappe-chart|vega|amcharts|fusioncharts|canvasjs|google-visualization|d3-|p-chart|ngx-charts|ng2-charts/i;
const CHART_CLASS_PATTERN = /\bchart\b|\bgraph\b|\bplot\b|\bheatmap\b|\bhistogram\b/i;
const FALSE_POSITIVE_PATTERN = /graphql|graph-ql|icon|logo|badge|avatar|sprite|illustration/i;

export const TABLE_FRAMEWORK_SELECTORS =
  'table, [role="table"], [role="grid"], [role="treegrid"],' +
  ' .ag-root, .handsontable, .grid-container,' +
  ' .p-datatable, p-table,' +
  ' .dataTables_wrapper,' +
  ' .MuiDataGrid-root,' +
  ' .ant-table-wrapper, .ant-table,' +
  ' .k-grid,' +
  ' .tabulator,' +
  ' .dx-datagrid,' +
  ' .v-data-table,' +
  ' .bootstrap-table,' +
  ' .slick-header,' +
  ' .x-grid,' +
  ' .ui-jqgrid,' +
  ' .e-grid';

export const CHART_SELECTORS = [
  'canvas',
  'svg',
  '[class*="chart" i]',
  '[class*="graph" i]',
  '.highcharts-container',
  '[class*="echarts"]',
  '.recharts-wrapper',
  '.apexcharts-canvas',
  '.plotly',
  '.c3',
  '.billboard-js',
  '[class*="visx"]',
  '[class*="victory"]',
  '[class*="nivo"]',
  '.nvd3-svg',
  '.frappe-chart',
  '[class*="amcharts"]',
  '.fusioncharts-container',
  '.canvasjs-chart-container',
  '[class*="google-visualization"]',
];

export function promoteToChartContainer(el: Element): Element {
  if (el.tagName !== 'CANVAS' && el.tagName !== 'SVG' && !(el as SVGElement).ownerSVGElement) return el;
  const startEl = (el as SVGElement).ownerSVGElement || el;
  let ancestor = startEl.parentElement;
  for (let i = 0; i < 4 && ancestor; i++) {
    const cls = ancestor.className?.toString() || '';
    if (CHART_LIB_PATTERN.test(cls)) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return startEl;
}

export function deduplicateNested(elementSet: Set<Element>): void {
  const snapshot = [...elementSet];
  for (const el of snapshot) {
    let ancestor = el.parentElement;
    while (ancestor) {
      if (elementSet.has(ancestor)) {
        elementSet.delete(el);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
}

function hasChartLibraryClass(cls: string): boolean {
  return CHART_LIB_PATTERN.test(cls);
}
function hasChartClass(cls: string): boolean {
  return CHART_CLASS_PATTERN.test(cls) && !FALSE_POSITIVE_PATTERN.test(cls);
}

function isLikelyChart(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_CHART_WIDTH || rect.height < MIN_CHART_HEIGHT) return false;
  if (el.closest('button, a, nav, li[role="menuitem"]')) return false;

  const elRole = el.getAttribute('role');
  if (elRole === 'img' || elRole === 'button') {
    const cls = ((el as SVGElement).className?.baseVal || el.className?.toString() || '');
    const parentCls = el.parentElement?.className?.toString() || '';
    if (!hasChartLibraryClass(cls) && !hasChartLibraryClass(parentCls)) return false;
  }

  const tag = el.tagName;
  if (tag === 'CANVAS') return isChartCanvas(el as HTMLCanvasElement);
  if (tag === 'SVG') return isChartSvg(el as SVGSVGElement);

  const canvas = el.querySelector('canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const cRect = canvas.getBoundingClientRect();
    if (cRect.width >= MIN_CHART_WIDTH && cRect.height >= MIN_CHART_HEIGHT) return isChartCanvas(canvas);
  }
  const svg = el.querySelector('svg') as SVGSVGElement | null;
  if (svg) {
    const sRect = svg.getBoundingClientRect();
    if (sRect.width >= MIN_CHART_WIDTH && sRect.height >= MIN_CHART_HEIGHT) return isChartSvg(svg);
  }

  if ((el as SVGElement).ownerSVGElement) {
    const ownerSvg = (el as SVGElement).ownerSVGElement!;
    const svgRect = ownerSvg.getBoundingClientRect();
    if (svgRect.width >= MIN_CHART_WIDTH && svgRect.height >= MIN_CHART_HEIGHT) return isChartSvg(ownerSvg);
  }

  const cls = el.className?.toString() || '';
  if (cls.includes('flourish-embed') && el.getAttribute('data-src')) return true;
  if (hasChartClass(cls)) {
    return el.querySelector('canvas, svg') !== null;
  }

  return false;
}

function isChartCanvas(canvas: HTMLCanvasElement): boolean {
  if (canvas.getAttribute('_echarts_instance_')) return true;

  let parent = canvas.parentElement;
  for (let i = 0; i < 4 && parent; i++) {
    const pcls = parent.className?.toString() || '';
    if (hasChartLibraryClass(pcls) || hasChartClass(pcls)) return true;
    const tag = parent.tagName?.toLowerCase() || '';
    if (/^(p-chart|ngx-|app-.*chart|ejs-chart)/.test(tag)) return true;
    parent = parent.parentElement;
  }

  const container = canvas.parentElement;
  if (container) {
    const chartUI = container.querySelectorAll(
      '[class*="legend"], [class*="axis"], [class*="tooltip"], [class*="label"]',
    );
    if (chartUI.length >= 2) return true;
  }

  return false;
}

function isChartSvg(svg: SVGSVGElement): boolean {
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] <= 32 && parts[3] <= 32) return false;
  }

  const svgCls = svg.className?.baseVal || svg.getAttribute('class') || '';
  if (hasChartLibraryClass(svgCls)) return true;
  let parent = svg.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const pcls = parent.className?.toString() || '';
    if (hasChartLibraryClass(pcls)) return true;
    parent = parent.parentElement;
  }

  let hasAxis = false;
  for (const g of svg.querySelectorAll('g')) {
    const gcls = (g.className?.baseVal || g.getAttribute('class') || '').toLowerCase();
    if (/axis|tick|grid|scale|x-axis|y-axis|domain/.test(gcls)) {
      hasAxis = true;
      break;
    }
  }

  const rects = svg.querySelectorAll('rect');
  const circles = svg.querySelectorAll('circle');
  const paths = svg.querySelectorAll('path');
  const textEls = svg.querySelectorAll('text');

  if (rects.length >= 3 && hasAxis) return true;
  if (circles.length >= 5 && hasAxis) return true;
  if (paths.length >= 2 && textEls.length >= 4 && hasAxis) return true;

  if (paths.length >= 2) {
    const arcPaths = Array.from(paths).filter((p) => {
      const d = p.getAttribute('d') || '';
      return /[Aa]/.test(d) && d.length > 30;
    });
    if (arcPaths.length >= 2) return true;
  }

  const totalShapes = rects.length + circles.length + paths.length;
  if (totalShapes > 15 && textEls.length >= 3) return true;

  return false;
}

export function waitForElement(selectorFn: () => Element | null, timeoutMs = 8000): Promise<Element | null> {
  return new Promise((resolve) => {
    const check = () => {
      const el = selectorFn();
      if (el) { resolve(el); return; }
    };
    check();

    const observer = new MutationObserver(() => {
      const el = selectorFn();
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

export function waitForContentChange(
  referenceText: string,
  timeoutMs = 8000,
  scope: Element = document.body,
): Promise<boolean> {
  return new Promise((resolve) => {
    const ref = referenceText.substring(0, 800);
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
      const current = ((scope as HTMLElement).innerText || scope.textContent || '').substring(0, 800);
      if (current !== ref) {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(settle, 600);
      }
    };

    const observer = new MutationObserver(onMutation);
    observer.observe(scope, { childList: true, subtree: true, characterData: true });
    onMutation();

    const timeoutTimer = setTimeout(() => {
      if (!resolved) { resolved = true; observer.disconnect(); resolve(false); }
    }, timeoutMs);
  });
}

const MAX_EXPAND_CLICKS = 100; // safety cap on hostile pages with hundreds of [aria-expanded="false"]

export async function expandHiddenElements(opts: {
  isAborted?: () => boolean;
  onProgress?: (msg: string) => void;
  delayMs?: number;
} = {}): Promise<void> {
  const patterns = [
    '[aria-expanded="false"]',
    'details:not([open])',
    'button[class*="show-more" i]',
    'button[class*="load-more" i]',
    'a[class*="show-more" i]',
    '[data-toggle="collapse"].collapsed',   // Bootstrap: .collapsed = currently collapsed
    '.accordion-toggle[aria-expanded="false"]',
    '.expand-btn[aria-expanded="false"]',
  ];

  // Skip elements that look already-expanded (catches non-ARIA patterns and
  // any cases where the selector is too broad).
  const isLikelyExpanded = (el: HTMLElement): boolean => {
    if (el.getAttribute('aria-expanded') === 'true') return true;
    const cls = el.className?.toString().toLowerCase() ?? '';
    return /\bopen\b|\bexpanded\b/.test(cls);
  };

  // Skip anchors that would navigate or open a new tab. Now that we may be
  // dispatching real isTrusted: true clicks via CDP, anchor default actions
  // actually fire — clicking a Wikipedia coordinate link, for example, can
  // redirect the scrape window mid-flow. Fragment-only and javascript: hrefs
  // are safe (in-page scroll / no-op).
  //
  // Walks up to document.body checking ancestors too: clicking ANY descendant
  // of an <a href="..."> triggers the anchor's navigation when the click
  // event bubbles. The original element-only check missed cases like
  // <a href="..."><span class="show-more">…</span></a>.
  const wouldNavigateOrOpen = (el: HTMLElement): boolean => {
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.body) {
      if (cur instanceof HTMLAnchorElement) {
        if (cur.target && cur.target !== '_self') return true;
        const href = cur.getAttribute('href');
        if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) {
          return true;
        }
      }
      cur = cur.parentElement;
    }
    return false;
  };

  const baseDelay = opts.delayMs ?? 350;
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  let totalClicked = 0;
  for (const pattern of patterns) {
    if (opts.isAborted?.()) return;
    if (totalClicked >= MAX_EXPAND_CLICKS) {
      opts.onProgress?.(`Expand cap reached (${MAX_EXPAND_CLICKS}) — moving on`);
      return;
    }
    const elements = document.querySelectorAll(pattern);
    for (const el of elements) {
      if (opts.isAborted?.()) return;
      if (totalClicked >= MAX_EXPAND_CLICKS) return;
      if ((el as HTMLElement).offsetParent === null) continue;
      if (isLikelyExpanded(el as HTMLElement)) continue;
      if (wouldNavigateOrOpen(el as HTMLElement)) continue;
      try {
        // naturalClick runs the Fitts curve regardless of cursor visibility — afk:false
        // keeps the anti-ban benefit even when the operator hasn't enabled the cosmetic cursor.
        await naturalClick(el as HTMLElement, { afk: false });
        totalClicked++;
        if (totalClicked % 5 === 0) {
          opts.onProgress?.(`Expanding hidden sections... (${totalClicked} so far)`);
        }
        await delay(baseDelay * (0.7 + Math.random() * 0.6)); // ±30 % jitter
      } catch { /* expected */ }
    }
  }
}
