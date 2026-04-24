const MAX_LABEL_LENGTH = 200;
const MAX_DATA_POINTS = 500;
const MAX_PATH_LENGTH = 20000;

function debugLog(context: string, error: unknown): void {
  console.debug(`[Blueberry] ${context}:`, error instanceof Error ? error.message : error);
}

export const HIGHCHARTS_LOCATOR = {
  xAxisLabels: '.highcharts-xaxis-labels text',
  yAxisLabels: '.highcharts-yaxis-labels text',
  yAxisAltLabels: '.highcharts-yaxis-alt-labels text',
  plotBackground: '.highcharts-plot-background',
  seriesItems: '.highcharts-series',
  barRects: '.highcharts-series rect',
  linePaths: '.highcharts-series path.highcharts-graph',
  piePaths: '.highcharts-series path',
  dataLabels: '.highcharts-data-labels text',
  legendItems: '.highcharts-legend-item text',
};

export const APEXCHARTS_LOCATOR = {
  xAxisLabels: '.apexcharts-xaxis-texts-g text, .apexcharts-xaxis text',
  yAxisLabels: '.apexcharts-yaxis-texts-g text, .apexcharts-yaxis text',
  yAxisAltLabels: null as string | null,
  plotBackground: '.apexcharts-plot-area',
  seriesItems: '.apexcharts-series',
  barRects: '.apexcharts-series rect',
  linePaths: '.apexcharts-series path.apexcharts-line',
  piePaths: '.apexcharts-series path',
  dataLabels: '.apexcharts-datalabels text',
  legendItems: '.apexcharts-legend-text',
};

export const HEURISTIC_LOCATOR = {
  xAxisLabels: null as string | null,
  yAxisLabels: null as string | null,
  yAxisAltLabels: null as string | null,
  plotBackground: null as string | null,
  seriesItems: null as string | null,
  barRects: 'rect',
  linePaths: 'path',
  piePaths: 'path',
  dataLabels: null as string | null,
  legendItems: null as string | null,
};

export type SvgLocator = {
  xAxisLabels: string | null;
  yAxisLabels: string | null;
  yAxisAltLabels: string | null;
  plotBackground: string | null;
  seriesItems: string | null;
  barRects: string;
  linePaths: string;
  piePaths: string;
  dataLabels: string | null;
  legendItems: string | null;
};

interface AxisTick {
  pos: number;
  val: number;
  isPercent: boolean;
}

interface CategoryLabel {
  pos: number;
  label: string;
}

interface DataPoint {
  label: string;
  value: number;
}

interface SeriesData {
  name: string | null;
  data: DataPoint[];
}

interface SvgExtractionResult {
  chartType: string;
  isHorizontal: boolean;
  series: SeriesData[];
  xAxisLabels: string[] | null;
  yAxisLabels: string[] | null;
  hasComputedValues: boolean;
}

export function extractValuesFromSvg(
  svg: SVGSVGElement,
  locator: SvgLocator,
  chartType?: string,
): SvgExtractionResult | null {
  try {
    const svgRect = svg.getBoundingClientRect();
    if (!svgRect || svgRect.width < 10 || svgRect.height < 10) return null;

    const type = chartType || detectSvgChartTypeLocal(svg);

    if (type === 'pie_or_donut') {
      const slices = extractPieData(svg, locator, svgRect);
      if (!slices || slices.length < 2) return null;
      return {
        chartType: 'pie',
        isHorizontal: false,
        series: [{ name: null, data: slices }],
        xAxisLabels: null,
        yAxisLabels: null,
        hasComputedValues: true,
      };
    }

    const yTicks = extractAxisTicks(svg, locator.yAxisLabels, 'y', svgRect);
    const xTicks = extractAxisTicks(svg, locator.xAxisLabels, 'x', svgRect);

    const hasYValues = yTicks.length >= 2;
    const hasXValues = xTicks.length >= 2;

    if (!hasYValues && !hasXValues) return null;

    const isHorizontal = !hasYValues && hasXValues;

    const xCategories = hasXValues ? [] : extractCategoryLabels(svg, locator.xAxisLabels, 'x', svgRect);
    const yCategories = hasYValues ? [] : extractCategoryLabels(svg, locator.yAxisLabels, 'y', svgRect);

    const yScale = hasYValues ? buildScale(yTicks) : null;
    const xScale = hasXValues ? buildScale(xTicks) : null;

    if (!yScale && !xScale) return null;

    let seriesData: SeriesData[] | null = null;

    if (type === 'bar') {
      seriesData = extractBarDataBySeries(svg, locator, yScale, xScale, isHorizontal, svgRect, xCategories, yCategories);
    } else if (type === 'line_or_area') {
      seriesData = extractLineDataAllSeries(svg, locator, yScale, svgRect, isHorizontal ? yCategories : xCategories);
    } else {
      seriesData =
        extractBarDataBySeries(svg, locator, yScale, xScale, isHorizontal, svgRect, xCategories, yCategories) ||
        extractLineDataAllSeries(svg, locator, yScale, svgRect, isHorizontal ? yCategories : xCategories);
    }

    if (!seriesData || seriesData.length === 0) return null;

    return {
      chartType: type,
      isHorizontal,
      series: seriesData,
      xAxisLabels: xCategories.length > 0 ? xCategories.map((c) => c.label) : xTicks.map((t) => String(t.val)),
      yAxisLabels: yCategories.length > 0 ? yCategories.map((c) => c.label) : yTicks.map((t) => String(t.val)),
      hasComputedValues: true,
    };
  } catch (e) {
    debugLog('highcharts SVG extraction', e);
  }
  return null;
}

export function parseAxisLabel(text: string): { value: number; isPercent: boolean } | null {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim().slice(0, MAX_LABEL_LENGTH);
  if (!raw) return null;

  let s = raw.replace(/^[$£€¥₹₩\s]+/, '').replace(/[,\s]+$/, '').replace(/,/g, '');

  let isPercent = false;
  if (s.endsWith('%')) {
    isPercent = true;
    s = s.slice(0, -1).trimEnd();
  }

  const match = s.match(/^([+-]?[\d.]+)\s*([kmbtKMBT]?)$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;

  const suffix = (match[2] || '').toLowerCase();
  let multiplier = 1;
  if (suffix === 'k') multiplier = 1_000;
  else if (suffix === 'm') multiplier = 1_000_000;
  else if (suffix === 'b' || suffix === 't') multiplier = 1_000_000_000;

  return { value: num * multiplier, isPercent };
}

function extractAxisTicks(
  svg: SVGSVGElement,
  selector: string | null,
  axis: 'x' | 'y',
  svgRect: DOMRect,
): AxisTick[] {
  if (!selector) return [];
  let els: NodeListOf<Element>;
  try {
    els = svg.querySelectorAll(selector);
  } catch (e) {
    debugLog('x-axis label extraction', e);
    return [];
  }

  const ticks: AxisTick[] = [];
  for (const el of els) {
    const text = el.textContent?.trim() || '';
    const parsed = parseAxisLabel(text);
    if (!parsed) continue;
    const center = getSvgRelativeCenter(el as Element, svgRect);
    ticks.push({ pos: axis === 'y' ? center.y : center.x, val: parsed.value, isPercent: parsed.isPercent });
  }

  return ticks.sort((a, b) => a.pos - b.pos);
}

function extractCategoryLabels(
  svg: SVGSVGElement,
  selector: string | null,
  axis: 'x' | 'y',
  svgRect: DOMRect,
): CategoryLabel[] {
  if (!selector) return [];
  let els: NodeListOf<Element>;
  try {
    els = svg.querySelectorAll(selector);
  } catch (e) {
    debugLog('y-axis label extraction', e);
    return [];
  }

  const labels: CategoryLabel[] = [];
  for (const el of els) {
    const text = el.textContent?.trim() || '';
    if (!text) continue;
    const center = getSvgRelativeCenter(el as Element, svgRect);
    labels.push({ pos: axis === 'x' ? center.x : center.y, label: text });
  }

  return labels.sort((a, b) => a.pos - b.pos);
}

function buildScale(ticks: AxisTick[]): ((pos: number) => number) | null {
  if (ticks.length < 2) return null;

  if (isLogScale(ticks)) {
    const lv1 = Math.log(ticks[0].val);
    const lv2 = Math.log(ticks[1].val);
    const p1 = ticks[0].pos;
    const p2 = ticks[1].pos;
    if (p2 === p1) return null;
    const a = (lv2 - lv1) / (p2 - p1);
    const b = lv1 - a * p1;
    return (pos) => Math.exp(a * pos + b);
  }

  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  if (t1.pos === t0.pos) return null;
  const a = (t1.val - t0.val) / (t1.pos - t0.pos);
  const b = t0.val - a * t0.pos;
  return (pos) => a * pos + b;
}

function isLogScale(ticks: AxisTick[]): boolean {
  const positiveVals = ticks.map((t) => t.val).filter((v) => v > 0);
  if (positiveVals.length < 3) return false;
  const ratios: number[] = [];
  for (let i = 1; i < positiveVals.length; i++) {
    ratios.push(positiveVals[i] / positiveVals[i - 1]);
  }
  const first = ratios[0];
  if (first <= 0) return false;
  return ratios.every((r) => Math.abs(r - first) / first < 0.05);
}

function getSvgRelativeCenter(el: Element, svgRect: DOMRect): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - svgRect.left,
    y: rect.top + rect.height / 2 - svgRect.top,
  };
}

function svgPointToRelScreen(
  svgX: number,
  svgY: number,
  el: SVGGraphicsElement,
  svgRect: DOMRect,
): { x: number; y: number } | null {
  try {
    const svgRoot = el.ownerSVGElement || (el as unknown as SVGSVGElement);
    const pt = svgRoot.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const ctm = el.getScreenCTM();
    if (!ctm) return null;
    const screenPt = pt.matrixTransform(ctm);
    return { x: screenPt.x - svgRect.left, y: screenPt.y - svgRect.top };
  } catch (e) {
    debugLog('SVG coordinate transform', e);
    return null;
  }
}

function extractBarDataBySeries(
  svg: SVGSVGElement,
  locator: SvgLocator,
  yScale: ((p: number) => number) | null,
  xScale: ((p: number) => number) | null,
  isHorizontal: boolean,
  svgRect: DOMRect,
  xCategories: CategoryLabel[],
  yCategories: CategoryLabel[],
): SeriesData[] | null {
  const categories = isHorizontal ? yCategories : xCategories;
  const seriesEls = locator.seriesItems ? Array.from(svg.querySelectorAll(locator.seriesItems)) : [];

  if (seriesEls.length > 0) {
    const seriesData: SeriesData[] = [];
    for (const seriesEl of seriesEls) {
      const rects = filterDataRects(Array.from(seriesEl.querySelectorAll('rect')));
      if (rects.length === 0) continue;
      const name = extractSeriesName(seriesEl as Element, locator, svg);
      const data = rects
        .slice(0, MAX_DATA_POINTS)
        .map((rect, i) => barRectToPoint(rect as HTMLElement, svgRect, yScale, xScale, isHorizontal, categories, i))
        .filter((p): p is DataPoint => p !== null);
      if (data.length > 0) seriesData.push({ name, data });
    }
    if (seriesData.length > 0) return seriesData;
  }

  let allRects: NodeListOf<Element>;
  try {
    allRects = svg.querySelectorAll(locator.barRects);
  } catch {
    return null;
  }
  const dataRects = filterDataRects(Array.from(allRects)).slice(0, MAX_DATA_POINTS);
  if (dataRects.length === 0) return null;

  const data = dataRects
    .map((rect, i) => barRectToPoint(rect as HTMLElement, svgRect, yScale, xScale, isHorizontal, categories, i))
    .filter((p): p is DataPoint => p !== null);
  return data.length > 0 ? [{ name: null, data }] : null;
}

function barRectToPoint(
  rect: HTMLElement,
  svgRect: DOMRect,
  yScale: ((p: number) => number) | null,
  xScale: ((p: number) => number) | null,
  isHorizontal: boolean,
  categories: CategoryLabel[],
  index: number,
): DataPoint | null {
  const bbox = rect.getBoundingClientRect();
  const catPos = isHorizontal
    ? bbox.top + bbox.height / 2 - svgRect.top
    : bbox.left + bbox.width / 2 - svgRect.left;

  let value: number | null = null;
  if (isHorizontal) {
    const rightX = bbox.right - svgRect.left;
    value = xScale ? xScale(rightX) : null;
  } else {
    const topY = bbox.top - svgRect.top;
    value = yScale ? yScale(topY) : null;
  }

  if (value === null || !Number.isFinite(value)) return null;

  const label = findNearestCategory(catPos, categories) || `Item ${index + 1}`;
  return { label, value: Math.round(value * 100) / 100 };
}

function filterDataRects(rects: Element[]): Element[] {
  return rects.filter((rect) => {
    const fill = (rect.getAttribute('fill') || (rect as HTMLElement).style?.fill || '').toLowerCase().trim();
    if (fill === 'none') return false;
    if (fill === '#ffffff' || fill === 'white' || fill === 'rgb(255, 255, 255)') return false;
    const bbox = rect.getBoundingClientRect();
    if (bbox.width < 2 || bbox.height < 2) return false;
    return true;
  });
}

function extractLineDataAllSeries(
  svg: SVGSVGElement,
  locator: SvgLocator,
  yScale: ((p: number) => number) | null,
  svgRect: DOMRect,
  categories: CategoryLabel[],
): SeriesData[] | null {
  if (!yScale) return null;

  const seriesEls = locator.seriesItems ? Array.from(svg.querySelectorAll(locator.seriesItems)) : [];
  const seriesData: SeriesData[] = [];

  if (seriesEls.length > 0) {
    for (const seriesEl of seriesEls) {
      const paths = Array.from(seriesEl.querySelectorAll('path'));
      const name = extractSeriesName(seriesEl as Element, locator, svg);
      for (const path of paths) {
        const d = path.getAttribute('d') || '';
        if (!d.includes('L') && !d.includes('l')) continue;
        const points = parseLinePathPoints(path as SVGPathElement, svgRect, yScale, categories);
        if (points.length >= 2) {
          seriesData.push({ name, data: points });
          break;
        }
      }
    }
    if (seriesData.length > 0) return seriesData;
  }

  const paths = Array.from(svg.querySelectorAll('path'));
  for (const path of paths) {
    const d = path.getAttribute('d') || '';
    if (!d.includes('L')) continue;
    const points = parseLinePathPoints(path as SVGPathElement, svgRect, yScale, categories);
    if (points.length >= 2) {
      seriesData.push({ name: null, data: points });
    }
    if (seriesData.length >= 10) break;
  }

  return seriesData.length > 0 ? seriesData : null;
}

function parseLinePathPoints(
  pathEl: SVGPathElement,
  svgRect: DOMRect,
  yScale: (p: number) => number,
  categories: CategoryLabel[],
): DataPoint[] {
  const d = pathEl.getAttribute('d') || '';
  if (d.length > MAX_PATH_LENGTH) return [];

  const tokens = d
    .replace(/,/g, ' ')
    .replace(/([MLZmlz])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const points: DataPoint[] = [];
  let i = 0;
  while (i < tokens.length && points.length < MAX_DATA_POINTS) {
    const cmd = tokens[i];
    if (cmd === 'M' || cmd === 'L') {
      const x = parseFloat(tokens[i + 1]);
      const y = parseFloat(tokens[i + 2]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const screenPt = svgPointToRelScreen(x, y, pathEl as unknown as SVGGraphicsElement, svgRect);
        if (screenPt) {
          const value = yScale(screenPt.y);
          if (Number.isFinite(value)) {
            const label = findNearestCategory(screenPt.x, categories) || `Point ${points.length + 1}`;
            points.push({ label, value: Math.round(value * 100) / 100 });
          }
        }
      }
      i += 3;
    } else {
      i++;
    }
  }

  return points;
}

function extractPieData(
  svg: SVGSVGElement,
  locator: SvgLocator,
  _svgRect: DOMRect,
): DataPoint[] | null {
  let paths: NodeListOf<Element>;
  try {
    paths = svg.querySelectorAll(locator.piePaths);
  } catch {
    return null;
  }

  const slices: Array<{ angle: number; path: Element }> = [];
  for (const path of paths) {
    const d = path.getAttribute('d') || '';
    if (!d.includes('A') && !d.includes('a')) continue;
    const angle = computeArcSweepAngle(d);
    if (angle === null || angle < 0.5) continue;
    slices.push({ angle, path });
  }

  if (slices.length < 2) return null;

  const totalAngle = slices.reduce((sum, s) => sum + s.angle, 0);
  if (totalAngle < 90 || totalAngle > 400) return null;

  const labels = extractLegendLabels(svg, locator);

  return slices.map((s, i) => ({
    label: labels[i] || `Slice ${i + 1}`,
    value: Math.round((s.angle / totalAngle) * 10000) / 100,
  }));
}

export function computeArcSweepAngle(d: string): number | null {
  if (!d || d.length > MAX_PATH_LENGTH) return null;

  const tokens = d
    .replace(/,/g, ' ')
    .replace(/([A-Za-z])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  let cx: number | undefined, cy: number | undefined;
  let sx: number | undefined, sy: number | undefined;
  let ex: number | undefined, ey: number | undefined;
  let largeArc: number | undefined;
  let i = 0;

  while (i < tokens.length) {
    const cmd = tokens[i];
    if (cmd === 'M') {
      cx = parseFloat(tokens[i + 1]);
      cy = parseFloat(tokens[i + 2]);
      i += 3;
    } else if (cmd === 'L') {
      sx = parseFloat(tokens[i + 1]);
      sy = parseFloat(tokens[i + 2]);
      i += 3;
    } else if (cmd === 'A') {
      largeArc = parseInt(tokens[i + 4], 10);
      ex = parseFloat(tokens[i + 6]);
      ey = parseFloat(tokens[i + 7]);
      i += 8;
    } else {
      i++;
    }
  }

  if (
    !Number.isFinite(cx) || !Number.isFinite(cy) ||
    !Number.isFinite(sx) || !Number.isFinite(sy) ||
    !Number.isFinite(ex) || !Number.isFinite(ey)
  ) return null;

  const startAngle = Math.atan2(sy! - cy!, sx! - cx!);
  const endAngle = Math.atan2(ey! - cy!, ex! - cx!);
  let sweep = endAngle - startAngle;
  if (sweep < 0) sweep += 2 * Math.PI;

  if (largeArc === 1 && sweep < Math.PI) sweep = 2 * Math.PI - sweep;
  if (largeArc === 0 && sweep > Math.PI) sweep = 2 * Math.PI - sweep;

  return sweep * 180 / Math.PI;
}

function findNearestCategory(pos: number, categories: CategoryLabel[]): string | null {
  if (!categories || categories.length === 0) return null;
  const closest = categories.reduce(
    (best, cat) => {
      const dist = Math.abs(cat.pos - pos);
      return dist < best.dist ? { dist, label: cat.label } : best;
    },
    { dist: Infinity, label: null as string | null },
  );
  return closest.dist < 150 ? closest.label : null;
}

function extractSeriesName(seriesEl: Element, locator: SvgLocator, svg: SVGSVGElement): string | null {
  const dataName = seriesEl.getAttribute('data-series-name') || seriesEl.getAttribute('name');
  if (dataName) return dataName;

  const classMatch = seriesEl.getAttribute('class')?.match(/(?:highcharts|apexcharts)-series-(\d+)/);
  const idx = classMatch ? parseInt(classMatch[1], 10) : null;

  if (idx !== null && locator.legendItems) {
    try {
      const legendItems = svg.querySelectorAll(locator.legendItems);
      const text = legendItems[idx]?.textContent?.trim();
      if (text) return text;
    } catch { /* expected */ }
  }

  return idx !== null ? `Series ${idx + 1}` : null;
}

function extractLegendLabels(svg: SVGSVGElement, locator: SvgLocator): string[] {
  if (!locator.legendItems) return [];
  try {
    return Array.from(svg.querySelectorAll(locator.legendItems))
      .map((el) => el.textContent?.trim())
      .filter((t): t is string => Boolean(t));
  } catch { /* expected */ }
  return [];
}

function detectSvgChartTypeLocal(svg: SVGSVGElement): string {
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
