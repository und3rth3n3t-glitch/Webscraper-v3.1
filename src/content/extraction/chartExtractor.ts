import { extractTable } from './tableExtractor';
import { extractValuesFromSvg, HIGHCHARTS_LOCATOR, APEXCHARTS_LOCATOR } from './svgValueEngine';
import brand from '@/themes';

function debugLog(context: string, error: unknown): void {
  console.debug(`${brand.logPrefix} ${context}:`, error instanceof Error ? error.message : error);
}

const MARKER_ATTR = 'data-blueberry-chart-target';
const ARIA_VALUE_MAX_LENGTH = 1000;

interface ChartResult {
  data: unknown;
  title: string | null;
  method: string | null;
  canExtract: boolean;
  message: string;
  _extractionNote: string;
}

export async function extractChartData(element: Element | null): Promise<ChartResult> {
  if (!element) {
    return {
      data: null, title: null, method: null, canExtract: false,
      message: 'No chart element found.',
      _extractionNote: 'No element was provided to the extractor.',
    };
  }

  const title = findChartTitle(element);

  const hiddenTable = findHiddenDataTable(element);
  if (hiddenTable) {
    try {
      const data = extractTable(hiddenTable);
      if (data.length > 0) {
        return {
          data, title, method: 'accessible_table', canExtract: true,
          message: 'Data extracted from accessible table',
          _extractionNote: 'Structured data extracted from a hidden accessible data table associated with this chart.',
        };
      }
    } catch (e) { debugLog('accessible table extraction', e); }
  }

  const flourishData = await extractFlourishData(element);
  if (flourishData) {
    return {
      data: { ...(flourishData as Record<string, unknown>), title: (flourishData as Record<string, unknown>).title || title },
      title: (flourishData as Record<string, unknown>).title as string || title,
      method: 'flourish_api',
      canExtract: true,
      message: 'Data extracted from Flourish visualization',
      _extractionNote: 'Structured data fetched from Flourish public visualization API.',
    };
  }

  try {
    const chartData = await extractFromChartLibrary(element);
    if (chartData) {
      enrichBridgeCategories(chartData as Record<string, unknown>, element);
      // Prefer the bridge's title (read directly from the chart's library API)
      // over the heading-walker fallback. The bridge title is the chart's own
      // declared title; the heading-walker is a guess at the nearest H1-H6.
      const bridgeTitle = (chartData as { title?: string | null }).title;
      const effectiveTitle = bridgeTitle || title;
      return {
        data: { ...(chartData as Record<string, unknown>), title: effectiveTitle },
        title: effectiveTitle,
        method: 'js_library',
        canExtract: true,
        message: `Data extracted from ${(chartData as Record<string, unknown>)._library} instance`,
        _extractionNote: `Actual data values extracted from the ${(chartData as Record<string, unknown>)._library} JavaScript API.`,
      };
    }
  } catch (e) { debugLog('chart library bridge', e); }

  const svgEl = element.tagName?.toUpperCase() === 'SVG' ? element : element.querySelector('svg');
  if (svgEl) {
    const svg = svgEl as SVGSVGElement;
    const ariaData = extractAriaData(svg);
    if (ariaData) {
      return {
        data: { ...ariaData, title }, title, method: 'aria', canExtract: true,
        message: 'Data extracted from ARIA accessibility labels',
        _extractionNote: 'Data values extracted from aria-label attributes on chart data elements.',
      };
    }

    const structuredData = extractStructuredSvg(svg);
    if (structuredData) {
      if ((structuredData as Record<string, unknown>)._canExtract) {
        return {
          data: { ...(structuredData as Record<string, unknown>), title }, title, method: 'svg_computed', canExtract: true,
          message: `Data extracted from ${(structuredData as Record<string, unknown>)._library} chart`,
          _extractionNote: `Data values computed from ${(structuredData as Record<string, unknown>)._library} SVG axis positions.`,
        };
      }
      return {
        data: { ...(structuredData as Record<string, unknown>), title }, title, method: 'svg_structure', canExtract: false,
        message: "We found a chart but couldn't read its data. The chart uses a format we don't fully support yet.",
        _extractionNote: `Labels and series structure extracted from ${(structuredData as Record<string, unknown>)._library} SVG class names.`,
      };
    }

    const metadata = extractMetadataOnly(svg);
    return {
      data: { ...metadata, title }, title, method: 'metadata_only', canExtract: false,
      message: "We found a chart but couldn't read its data values.",
      _extractionNote: "We could see this is a chart but weren't able to read its data.",
    };
  }

  const canvasEl = element.tagName?.toUpperCase() === 'CANVAS' ? element : element.querySelector('canvas');
  if (canvasEl) {
    try {
      const chartData = await extractFromChartLibrary(canvasEl);
      if (chartData) {
        return {
          data: { ...(chartData as Record<string, unknown>), title }, title, method: 'js_library', canExtract: true,
          message: `Data extracted from ${(chartData as Record<string, unknown>)._library} instance`,
          _extractionNote: `Actual data values extracted from the ${(chartData as Record<string, unknown>)._library} JavaScript API via canvas element.`,
        };
      }
    } catch (e) { debugLog('canvas library bridge', e); }
    return {
      data: null, title, method: 'canvas', canExtract: false,
      message: "This chart is drawn as an image, so we can't read the data directly. Try using a 'Select Each' step to capture values from the chart's controls instead.",
      _extractionNote: 'Canvas-based chart with no accessible JavaScript library API.',
    };
  }

  return {
    data: null, title, method: null, canExtract: false,
    message: 'No chart could be found in this element.',
    _extractionNote: 'No chart rendering (SVG or Canvas) was found within this element.',
  };
}

export async function detectChartExtractionMethod(
  element: Element | null,
): Promise<{ method: string | null; confidence: string; library?: string }> {
  if (!element) return { method: null, confidence: 'unknown' };

  if (findHiddenDataTable(element)) return { method: 'accessible_table', confidence: 'high' };

  const flourishEl = findFlourishEmbed(element);
  if (flourishEl) return { method: 'flourish_api', confidence: 'high', library: 'Flourish' };

  const libraryInfo = await queryChartLibrary();
  if (libraryInfo) return { method: 'js_library', confidence: 'high', library: libraryInfo };

  const svg = element.tagName?.toUpperCase() === 'SVG' ? element as SVGSVGElement : element.querySelector('svg') as SVGSVGElement | null;
  if (svg) {
    const ariaEls = svg.querySelectorAll('[aria-label]');
    if (ariaEls.length >= 2) return { method: 'aria', confidence: 'high' };

    if (svg.querySelector('.highcharts-series, .apexcharts-series')) {
      const hasYAxis = !!(svg.querySelector(
        '.highcharts-yaxis-labels text, .apexcharts-yaxis-texts-g text, .apexcharts-yaxis text',
      ));
      return { method: hasYAxis ? 'svg_computed' : 'svg_structure', confidence: hasYAxis ? 'high' : 'medium' };
    }
    return { method: 'metadata_only', confidence: 'low' };
  }

  const canvas = element.tagName?.toUpperCase() === 'CANVAS' ? element : element.querySelector('canvas');
  if (canvas) return { method: 'canvas', confidence: 'none' };

  return { method: null, confidence: 'unknown' };
}

function enrichBridgeCategories(chartData: Record<string, unknown>, element: Element): void {
  if (chartData._library !== 'Highcharts') return;
  if (chartData.xAxisCategories && chartData.yAxisCategories) return;

  const svg = element.tagName?.toUpperCase() === 'SVG'
    ? element as SVGSVGElement
    : element.querySelector('svg') as SVGSVGElement | null;
  if (!svg) return;

  if (!chartData.xAxisCategories) {
    const labels = Array.from(svg.querySelectorAll(HIGHCHARTS_LOCATOR.xAxisLabels))
      .map((el) => el.textContent?.trim()).filter(Boolean);
    if (labels.length > 0) chartData.xAxisCategories = labels;
  }

  if (!chartData.yAxisCategories) {
    const labels = Array.from(svg.querySelectorAll(HIGHCHARTS_LOCATOR.yAxisLabels))
      .map((el) => el.textContent?.trim()).filter(Boolean);
    if (labels.length > 0) chartData.yAxisCategories = labels;
  }
}

function findHiddenDataTable(element: Element): Element | null {
  const container = element.closest('figure, section, div') || element.parentElement;
  if (!container) return null;

  let searchRoot: Element | null = container;
  for (let i = 0; i < 3; i++) {
    if (!searchRoot) break;
    const hcTable = searchRoot.querySelector('.highcharts-data-table table, table.highcharts-data-table');
    if (hcTable) return hcTable;

    const tables = searchRoot.querySelectorAll('table');
    for (const table of tables) {
      const style = window.getComputedStyle(table);
      const cls = table.className?.toString() || '';
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        cls.match(/(sr-only|visually-hidden|screen-reader|a11y)/i) ||
        table.getAttribute('aria-hidden') === 'true'
      ) {
        return table;
      }
    }

    const details = searchRoot.querySelector('details');
    if (details) {
      const table = details.querySelector('table');
      if (table) return table;
    }

    if (!searchRoot.parentElement || searchRoot.parentElement === document.body) break;
    searchRoot = searchRoot.parentElement;
  }

  return null;
}

function queryChartLibrary(): Promise<string | null> {
  return new Promise((resolve) => {
    const messageId = Date.now().toString() + '_detect';

    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'CHART_LIBRARY_RESULT' && event.data?.messageId === messageId) {
        window.removeEventListener('message', handler);
        resolve((event.data.library as string) || null);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'DETECT_CHART_LIBRARY', messageId }, '*');
    setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 2000);
  });
}

function findChartTitle(element: Element): string | null {
  if (element.tagName?.toUpperCase() === 'SVG' || element.querySelector('svg')) {
    const svg = element.tagName?.toUpperCase() === 'SVG' ? element : element.querySelector('svg');
    const svgTitle = svg?.querySelector(':scope > title');
    if (svgTitle?.textContent?.trim()) return svgTitle.textContent.trim();
  }

  const aria = element.getAttribute?.('aria-label');
  if (aria) return aria;

  const labelledBy = element.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const ref = document.getElementById(labelledBy);
    if (ref?.textContent?.trim()) return ref.textContent.trim();
  }

  const figure = element.closest('figure');
  if (figure) {
    const cap = figure.querySelector('figcaption');
    if (cap?.textContent?.trim()) return cap.textContent.trim();
  }

  let node: Element | null = element;
  while (node && node !== document.body) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.matches('h1,h2,h3,h4,h5,h6')) return sibling.textContent?.trim() ?? null;
      const childHeading = sibling.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6');
      if (childHeading) return childHeading.textContent?.trim() ?? null;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }

  const parent = element.parentElement;
  if (parent) {
    const titleEl = parent.querySelector('[class*="title" i], [class*="heading" i]');
    if (titleEl?.textContent?.trim()) return titleEl.textContent.trim();
  }

  return null;
}

function markElement(element: Element): string {
  const id = 'blueberry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  element.setAttribute(MARKER_ATTR, id);
  return id;
}

function unmarkElement(element: Element): void {
  element.removeAttribute(MARKER_ATTR);
}

function extractFromChartLibrary(element: Element): Promise<unknown> {
  return new Promise((resolve) => {
    const messageId = Date.now().toString();
    const markerId = markElement(element);

    const cleanup = () => {
      try { unmarkElement(element); } catch { /* expected */ }
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'CHART_DATA_RESULT' && event.data?.messageId === messageId) {
        window.removeEventListener('message', handler);
        cleanup();
        resolve(event.data.chartData || null);
      }
    };
    window.addEventListener('message', handler);

    window.postMessage({
      type: 'EXTRACT_CHART_DATA',
      messageId,
      elementIndex: { marker: MARKER_ATTR + '="' + markerId + '"' },
    }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      cleanup();
      resolve(null);
    }, 3000);
  });
}

function truncateAriaValue(value: string): string {
  return value.length > ARIA_VALUE_MAX_LENGTH ? value.slice(0, ARIA_VALUE_MAX_LENGTH) : value;
}

function parseAriaLabel(ariaLabel: string): { label: string; value: string | null } | null {
  const trimmed = truncateAriaValue(ariaLabel).trim();
  if (!trimmed) return null;

  for (const sep of [':', ' - ', ' – ', ' — ', '=']) {
    const idx = trimmed.indexOf(sep);
    if (idx > 0 && idx < trimmed.length - sep.length) {
      return { label: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + sep.length).trim() };
    }
  }

  const commaIdx = trimmed.indexOf(',');
  if (commaIdx > 0 && commaIdx < trimmed.length - 1) {
    const afterComma = trimmed.slice(commaIdx + 1).trim();
    if (/^[\d$£€¥-]/.test(afterComma)) {
      return { label: trimmed.slice(0, commaIdx).trim(), value: afterComma };
    }
  }

  return { label: trimmed, value: null };
}

function extractAriaData(svg: SVGSVGElement): Record<string, unknown> | null {
  const ariaEls = Array.from(svg.querySelectorAll('[aria-label]'));
  if (ariaEls.length < 2) return null;

  const dataEls = ariaEls.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (['rect', 'circle', 'path', 'g', 'line', 'polygon', 'ellipse'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && ['img', 'graphics-symbol', 'listitem', 'option'].includes(role)) return true;
    return false;
  });

  if (dataEls.length < 2) return null;

  const items = dataEls
    .map((el) => parseAriaLabel(el.getAttribute('aria-label') || ''))
    .filter(Boolean);
  if (items.length < 2) return null;

  const hasValues = items.some((item) => item!.value !== null);

  return { _chartType: detectSvgChartType(svg), items, _hasValues: hasValues };
}

function extractStructuredSvg(svg: SVGSVGElement): Record<string, unknown> | null {
  const hcSeries = svg.querySelectorAll('.highcharts-series');
  if (hcSeries.length > 0) {
    const chartType = detectSvgChartType(svg);
    const computed = extractValuesFromSvg(svg, HIGHCHARTS_LOCATOR, chartType);
    if (computed) return { _library: 'Highcharts', _canExtract: true, ...computed };

    const series = [];
    for (const s of hcSeries) {
      const name = s.getAttribute('class')?.match(/highcharts-series-(\d+)/)?.[1];
      const dataLabels: string[] = [];
      const parent = s.parentElement;
      if (parent) {
        const labelGroup = parent.querySelector('.highcharts-data-labels');
        if (labelGroup) {
          for (const lbl of labelGroup.querySelectorAll('.highcharts-data-label text, .highcharts-data-label span')) {
            const text = lbl.textContent?.trim();
            if (text) dataLabels.push(text);
          }
        }
      }
      series.push({ seriesIndex: name || String(series.length), dataLabels });
    }

    const xLabels = Array.from(svg.querySelectorAll('.highcharts-xaxis-labels text'))
      .map((el) => el.textContent?.trim()).filter(Boolean);
    const yLabels = Array.from(svg.querySelectorAll('.highcharts-yaxis-labels text'))
      .map((el) => el.textContent?.trim()).filter(Boolean);
    const hcTitle = svg.querySelector('.highcharts-title')?.textContent?.trim() || null;

    return {
      _library: 'Highcharts', _canExtract: false, _chartType: chartType, hcTitle, series,
      xAxisLabels: xLabels.length > 0 ? xLabels : null,
      yAxisLabels: yLabels.length > 0 ? yLabels : null,
    };
  }

  const apexSeries = svg.querySelectorAll('.apexcharts-series');
  if (apexSeries.length > 0) {
    const chartType = detectSvgChartType(svg);
    const computed = extractValuesFromSvg(svg, APEXCHARTS_LOCATOR, chartType);
    if (computed) return { _library: 'ApexCharts', _canExtract: true, ...computed };

    const series = [];
    for (const s of apexSeries) {
      const name = s.getAttribute('seriesName') || null;
      const dataLabels: string[] = [];
      for (const lbl of s.querySelectorAll('.apexcharts-datalabel, .apexcharts-data-labels text')) {
        const text = lbl.textContent?.trim();
        if (text) dataLabels.push(text);
      }
      series.push({ seriesName: name, dataLabels });
    }

    const xLabels = Array.from(svg.querySelectorAll('.apexcharts-xaxis-texts-g text, .apexcharts-xaxis text'))
      .map((el) => el.textContent?.trim()).filter(Boolean);
    const apexTitle = svg.querySelector('.apexcharts-title-text')?.textContent?.trim() || null;

    return {
      _library: 'ApexCharts', _canExtract: false, _chartType: chartType, apexTitle, series,
      xAxisLabels: xLabels.length > 0 ? xLabels : null,
    };
  }

  return null;
}

function extractMetadataOnly(svg: SVGSVGElement): Record<string, unknown> {
  const rects = svg.querySelectorAll('rect');
  const paths = svg.querySelectorAll('path');
  const circles = svg.querySelectorAll('circle');
  const texts = Array.from(svg.querySelectorAll('text'))
    .map((t) => t.textContent?.trim())
    .filter(Boolean)
    .slice(0, 50);

  return {
    _chartType: detectSvgChartType(svg),
    elementCounts: {
      rects: Math.min(rects.length, 500),
      paths: Math.min(paths.length, 500),
      circles: Math.min(circles.length, 500),
      textElements: texts.length,
    },
    textContent: texts,
  };
}

function detectSvgChartType(svg: SVGSVGElement): string {
  const rects = svg.querySelectorAll('rect').length;
  const circles = svg.querySelectorAll('circle').length;
  const paths = svg.querySelectorAll('path').length;

  if (circles > 5 && circles > rects) return 'scatter_or_bubble';
  if (rects > 5 && rects > paths) return 'bar';
  if (paths > 2 && paths > rects) return 'line_or_area';

  const arcPaths = Array.from(svg.querySelectorAll('path')).filter((p) => {
    const d = p.getAttribute('d') || '';
    return d.includes('A') || d.includes('a');
  });
  if (arcPaths.length >= 2) return 'pie_or_donut';

  return 'unknown';
}

function findFlourishEmbed(element: Element): Element | null {
  let el: Element | null = element;
  for (let i = 0; i < 5 && el && el !== document.body; i++) {
    const cls = el.className?.toString() || '';
    if (cls.includes('flourish-embed') && el.getAttribute('data-src')) return el;
    el = el.parentElement;
  }
  return null;
}

function parseFlourishId(dataSrc: string): string | null {
  const match = dataSrc.match(/visualisation\/(\d+)/);
  return match ? match[1] : null;
}

async function extractFlourishData(element: Element): Promise<unknown> {
  const flourishEl = findFlourishEmbed(element);
  if (!flourishEl) return null;

  const dataSrc = flourishEl.getAttribute('data-src');
  if (!dataSrc) return null;

  const vizId = parseFlourishId(dataSrc);
  if (!vizId) return null;

  try {
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_FLOURISH_DATA',
      payload: { visualizationId: vizId },
    }) as { error?: string; data?: Record<string, unknown> } | null;

    if (!response || response.error) return null;

    const json = response.data;
    if (!json) return null;

    const result: Record<string, unknown> = { _library: 'Flourish', _template: json.template || null };

    if (json.state) {
      const state = json.state as Record<string, unknown>;
      result.title = state.layout_title || state.title || null;
      result.subtitle = state.layout_subtitle || state.subtitle || null;
    }
    if (json.data) {
      result.datasets = {};
      for (const [key, rows] of Object.entries(json.data as Record<string, unknown>)) {
        if (Array.isArray(rows) && rows.length > 0) {
          (result.datasets as Record<string, unknown>)[key] = rows;
        }
      }
    }
    if (json.bindings) result.bindings = json.bindings;
    if (json.metadata) {
      const meta = json.metadata as Record<string, unknown>;
      result.metadata = { author: meta.author || null, publishedAt: meta.published_at || null };
    }

    return result;
  } catch { /* expected: optional Flourish extraction */ }
  return null;
}
