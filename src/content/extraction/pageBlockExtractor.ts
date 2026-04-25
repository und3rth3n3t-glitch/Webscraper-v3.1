import {
  TABLE_FRAMEWORK_SELECTORS,
  CHART_SELECTORS,
  promoteToChartContainer,
  deduplicateNested,
  detectElementType,
  getElementLabel,
} from './domUtils';
import { extractTable } from './tableExtractor';
import { extractChartData } from './chartExtractor';

// ── Public types ──────────────────────────────────────────────────────────────

export type Block =
  | { type: 'heading';    level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph';  text: string }
  | { type: 'list';       listType: 'ul' | 'ol'; items: string[] }
  | { type: 'link';       text: string; href: string }
  | { type: 'quote';      text: string }
  | { type: 'code';       text: string; language: string | null }
  | { type: 'table';      ref: string; label: string }
  | { type: 'chart';      ref: string; label: string };

export interface TableEntry {
  id: string;
  label: string;
  rows: Record<string, unknown>[];
}

export interface ChartEntry {
  id: string;
  label: string;
  title: string | null;
  data: unknown;
  method: string | null;
  canExtract: boolean;
  _extractionNote?: string;
}

export interface PageContent {
  pageTitle: string;
  blocks: Block[];
  tables: TableEntry[];
  charts: ChartEntry[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_PARAGRAPH_LENGTH = 21; // strictly greater than 20 (matches old behaviour)
const BASE_BLOCK_SELECTORS = 'h1,h2,h3,h4,h5,h6,p,ul,ol,a[href],blockquote,pre';

// Internal-only data shape — chart data without an id (id assigned at walk time).
type PreExtractedChart = Omit<ChartEntry, 'id' | 'label'>;

// ── Public API ────────────────────────────────────────────────────────────────

export async function extractPageBlocks(
  root: Document | HTMLElement = document,
): Promise<PageContent> {
  const docRoot = root instanceof Document ? root : root.ownerDocument!;
  const searchRoot: ParentNode = root instanceof Document ? root.body : root;
  const pageTitle = docRoot.title;

  // Phase 1 — identify chart and table elements (framework-aware).
  const chartEls = identifyCharts(searchRoot);
  const tableEls = identifyTables(searchRoot);

  // Phase 2 — extract chart data concurrently. Document order is enforced in
  // the walk (Phase 4), not here. IDs are assigned in Phase 4 by encounter order.
  const chartList = [...chartEls];
  const chartDataResults = await Promise.all(chartList.map(preExtractChart));
  const chartDataByEl = new WeakMap<Element, PreExtractedChart>();
  chartList.forEach((el, i) => {
    const data = chartDataResults[i];
    if (data) chartDataByEl.set(el, data);
  });

  // Phase 3 — build candidate set, sort document-order.
  const candidateSet = new Set<Element>(searchRoot.querySelectorAll(BASE_BLOCK_SELECTORS));
  for (const el of chartEls) candidateSet.add(el);
  for (const el of tableEls) candidateSet.add(el);

  const candidates = [...candidateSet].sort((a, b) => {
    const cmp = a.compareDocumentPosition(b);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // Phase 4 — walk in document order. Skip anything inside an already-consumed
  // ancestor; otherwise dispatch by tag/membership and emit a block.
  const consumed = new WeakSet<Element>();
  const blocks: Block[] = [];
  const tables: TableEntry[] = [];
  const charts: ChartEntry[] = [];

  for (const el of candidates) {
    if (isInsideConsumed(el, consumed)) continue;

    if (chartEls.has(el)) {
      const data = chartDataByEl.get(el);
      if (data) {
        const out = emitChart(el, charts.length, data);
        blocks.push(out.block);
        charts.push(out.entry);
      }
      consumed.add(el);
      continue;
    }

    if (tableEls.has(el)) {
      const out = emitTable(el, tables.length);
      if (out) {
        blocks.push(out.block);
        tables.push(out.entry);
      }
      consumed.add(el);
      continue;
    }

    const tag = el.tagName;

    if (/^H[1-6]$/.test(tag)) {
      const block = emitHeading(el as HTMLElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }

    if (tag === 'P') {
      const block = emitParagraph(el as HTMLElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }

    if (tag === 'UL' || tag === 'OL') {
      const block = emitList(el as HTMLElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      const block = emitQuote(el as HTMLElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }

    if (tag === 'PRE') {
      const block = emitCode(el as HTMLElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }

    if (tag === 'A') {
      const block = emitLink(el as HTMLAnchorElement);
      if (block) blocks.push(block);
      consumed.add(el);
      continue;
    }
  }

  return { pageTitle, blocks, tables, charts };
}

export function mergePages(pages: PageContent[]): PageContent {
  if (pages.length === 0) {
    return { pageTitle: '', blocks: [], tables: [], charts: [] };
  }

  let tableCounter = 0;
  let chartCounter = 0;
  const blocks: Block[] = [];
  const tables: TableEntry[] = [];
  const charts: ChartEntry[] = [];

  for (const page of pages) {
    const tMap = new Map<string, string>();
    for (const t of page.tables) {
      const newId = `table_${tableCounter++}`;
      tMap.set(t.id, newId);
      tables.push({ ...t, id: newId });
    }

    const cMap = new Map<string, string>();
    for (const c of page.charts) {
      const newId = `chart_${chartCounter++}`;
      cMap.set(c.id, newId);
      charts.push({ ...c, id: newId });
    }

    for (const block of page.blocks) {
      if (block.type === 'table') {
        const newRef = tMap.get(block.ref);
        if (newRef) blocks.push({ ...block, ref: newRef });
      } else if (block.type === 'chart') {
        const newRef = cMap.get(block.ref);
        if (newRef) blocks.push({ ...block, ref: newRef });
      } else {
        blocks.push(block);
      }
    }
  }

  const pageTitle = pages.find((p) => p.pageTitle)?.pageTitle ?? '';
  return { pageTitle, blocks, tables, charts };
}

// ── Identifiers ───────────────────────────────────────────────────────────────

function identifyCharts(root: ParentNode): Set<Element> {
  const set = new Set<Element>();
  for (const sel of CHART_SELECTORS) {
    let nodeList: NodeListOf<Element>;
    try {
      nodeList = root.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodeList) {
      try {
        if (set.has(el)) continue;
        const chartEl = promoteToChartContainer(el);
        if (!set.has(chartEl) && detectElementType(chartEl) === 'chart') {
          set.add(chartEl);
        }
      } catch { /* expected */ }
    }
  }
  deduplicateNested(set);
  return set;
}

function identifyTables(root: ParentNode): Set<Element> {
  const set = new Set<Element>();
  for (const el of root.querySelectorAll(TABLE_FRAMEWORK_SELECTORS)) {
    try {
      if (detectElementType(el) === 'table') set.add(el);
    } catch { /* expected */ }
  }
  deduplicateNested(set);
  return set;
}

// ── Per-block-type emitters ───────────────────────────────────────────────────

function emitHeading(el: HTMLElement): Block | null {
  const text = (el.textContent ?? '').trim();
  if (!text) return null;
  const level = Number(el.tagName[1]) as 1 | 2 | 3 | 4 | 5 | 6;
  return { type: 'heading', level, text };
}

function emitParagraph(el: HTMLElement): Block | null {
  const text = (el.textContent ?? '').trim();
  if (text.length < MIN_PARAGRAPH_LENGTH) return null;
  return { type: 'paragraph', text };
}

function emitList(el: HTMLElement): Block | null {
  const tag = el.tagName.toLowerCase() as 'ul' | 'ol';
  const items = Array.from(el.children)
    .filter((c) => c.tagName === 'LI')
    .map((li) => (li.textContent ?? '').trim())
    .filter((t) => t.length > 0);
  if (items.length === 0) return null;
  return { type: 'list', listType: tag, items };
}

function emitLink(el: HTMLAnchorElement): Block | null {
  const text = (el.textContent ?? '').trim();
  const href = el.href;
  if (!text || !href) return null;
  return { type: 'link', text, href };
}

function emitQuote(el: HTMLElement): Block | null {
  const text = (el.textContent ?? '').trim();
  if (!text) return null;
  return { type: 'quote', text };
}

function emitCode(el: HTMLElement): Block | null {
  const text = el.textContent ?? '';
  if (text.length === 0) return null;
  const language = detectCodeLanguage(el);
  return { type: 'code', text, language };
}

function emitTable(el: Element, idx: number): { block: Block; entry: TableEntry } | null {
  let rows: Record<string, unknown>[];
  try {
    rows = extractTable(el);
  } catch {
    return null;
  }
  if (!rows || rows.length === 0) return null;
  const id = `table_${idx}`;
  const label = getElementLabel(el);
  return {
    block: { type: 'table', ref: id, label },
    entry: { id, label, rows },
  };
}

function emitChart(
  el: Element,
  idx: number,
  data: PreExtractedChart,
): { block: Block; entry: ChartEntry } {
  const id = `chart_${idx}`;
  const label = getElementLabel(el);
  return {
    block: { type: 'chart', ref: id, label },
    entry: { id, label, ...data },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function preExtractChart(el: Element): Promise<PreExtractedChart | null> {
  try {
    const result = await extractChartData(el);
    const base: PreExtractedChart = {
      title: result.title,
      data: result.data,
      method: result.method,
      canExtract: result.canExtract,
    };
    if (!result.canExtract && result._extractionNote) {
      base._extractionNote = result._extractionNote;
    }
    return base;
  } catch {
    return null;
  }
}

function detectCodeLanguage(el: HTMLElement): string | null {
  const candidates: HTMLElement[] = [el];
  const inner = el.querySelector('code');
  if (inner) candidates.push(inner as HTMLElement);
  for (const c of candidates) {
    for (const cls of c.classList) {
      const m = cls.match(/^language-(.+)$/);
      if (m) return m[1];
    }
  }
  return null;
}

function isInsideConsumed(el: Element, consumed: WeakSet<Element>): boolean {
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (consumed.has(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}
