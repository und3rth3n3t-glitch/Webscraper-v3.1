# SPEC — wholePage scrape: hybrid blocks/tables/charts output (v1.0)

> Implementation spec for the staged plan at `~/.claude/plans/i-was-just-discussing-fuzzy-sparkle.md`. Stages A–E confirmed; this is Stage F. Implementer should follow exactly; deviations need plan owner approval.

---

## Context

The current `wholePage` scrape mode buckets the page into independent arrays — `{pageTitle, content: {headings, paragraphs, lists, tables, charts, links}}` — losing document order and any association between a heading and the paragraphs that follow it. The downstream PDF-builder consumes this JSON for drag-drop into report templates and chart blocks; the bucketed shape is unusable for that.

This change replaces the extractor with a **hybrid output**: a document-ordered narrative `blocks` array (lightweight typed entries with refs) plus directly-addressable `tables` and `charts` arrays carrying the full data. The PDF tool gets both views — render-in-order via blocks, dereferencing tables/charts by ref; or "show me all tables" via `data.tables` directly.

The new walker is extracted from `scrapingEngine.ts` into a new module `src/content/extraction/pageBlockExtractor.ts`, matching the per-element-type extractor convention already present (`tableExtractor`, `chartExtractor`).

---

## File 1 (NEW): `src/content/extraction/pageBlockExtractor.ts`

Create this file with **exactly** the following content:

```ts
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
  const items = Array.from(el.querySelectorAll(':scope > li'))
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
```

---

## File 2 (NEW): `src/content/extraction/pageBlockExtractor.test.ts`

Create this file with **exactly** the following content. Tests mock `tableExtractor`, `chartExtractor`, and a few `domUtils` helpers (the chart-detection heuristics depend on `getBoundingClientRect`, which jsdom returns as zeros, so the test stubs make detection deterministic).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tableExtractor', () => ({
  extractTable: vi.fn(),
}));
vi.mock('./chartExtractor', () => ({
  extractChartData: vi.fn(),
}));
vi.mock('./domUtils', async () => {
  const actual = await vi.importActual<typeof import('./domUtils')>('./domUtils');
  return {
    ...actual,
    detectElementType: vi.fn((el: Element | null) => {
      if (!el) return null;
      if (el.tagName === 'TABLE') return 'table';
      if ((el as HTMLElement).classList?.contains('test-chart')) return 'chart';
      return null;
    }),
    promoteToChartContainer: vi.fn((el: Element) => el),
    getElementLabel: vi.fn((el: Element | null) =>
      el ? `Mock label (${el.tagName.toLowerCase()})` : 'Mock label',
    ),
  };
});

import { extractPageBlocks, mergePages, type PageContent } from './pageBlockExtractor';
import { extractTable } from './tableExtractor';
import { extractChartData } from './chartExtractor';

const extractTableMock = extractTable as unknown as ReturnType<typeof vi.fn>;
const extractChartDataMock = extractChartData as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Test page';
  extractTableMock.mockReset();
  extractChartDataMock.mockReset();
});

describe('extractPageBlocks — walker', () => {
  it('returns empty arrays for an empty body', async () => {
    const r = await extractPageBlocks();
    expect(r.blocks).toEqual([]);
    expect(r.tables).toEqual([]);
    expect(r.charts).toEqual([]);
    expect(r.pageTitle).toBe('Test page');
  });

  it('preserves document order for heading + paragraph + heading', async () => {
    document.body.innerHTML = `
      <h2>First</h2>
      <p>${'a'.repeat(30)}</p>
      <h2>Second</h2>
    `;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, text: 'First' });
    expect(blocks[1]).toMatchObject({ type: 'paragraph' });
    expect(blocks[2]).toMatchObject({ type: 'heading', level: 2, text: 'Second' });
  });

  it('drops paragraphs at length 20, keeps at length 21', async () => {
    document.body.innerHTML = `
      <p>${'a'.repeat(20)}</p>
      <p>${'b'.repeat(21)}</p>
    `;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text.length).toBe(21);
  });

  it('drops a list with no direct :scope > li and flattens nested li text into outer items', async () => {
    document.body.innerHTML = `
      <ul>
        <li>Outer one
          <ul><li>Nested one</li></ul>
        </li>
      </ul>
    `;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as { type: 'list'; items: string[] };
    expect(list.type).toBe('list');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toContain('Outer one');
    expect(list.items[0]).toContain('Nested one');
  });

  it('emits a table block + entry for a native <table>', async () => {
    extractTableMock.mockReturnValue([{ Col: 'val' }]);
    document.body.innerHTML = `<table><tbody><tr><td>x</td></tr></tbody></table>`;
    const { blocks, tables } = await extractPageBlocks();
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ id: 'table_0', rows: [{ Col: 'val' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'table', ref: 'table_0' });
  });

  it('emits a chart block + entry for a chart element', async () => {
    extractChartDataMock.mockResolvedValue({
      title: 'My Chart', data: { values: [1, 2] }, method: 'svg',
      canExtract: true, message: '', _extractionNote: '',
    });
    document.body.innerHTML = `<div class="test-chart"></div>`;
    const { blocks, charts } = await extractPageBlocks();
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ id: 'chart_0', canExtract: true, title: 'My Chart' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'chart', ref: 'chart_0' });
  });

  it('skips a heading that is inside a chart wrapper (consumed-ancestor rule)', async () => {
    extractChartDataMock.mockResolvedValue({
      title: null, data: null, method: null, canExtract: true, message: '', _extractionNote: '',
    });
    document.body.innerHTML = `
      <div class="test-chart"><h2>Chart heading inside</h2></div>
      <h2>Outer heading</h2>
    `;
    const { blocks, charts } = await extractPageBlocks();
    expect(charts).toHaveLength(1);
    const headings = blocks.filter((b) => b.type === 'heading');
    expect(headings).toHaveLength(1);
    expect((headings[0] as { text: string }).text).toBe('Outer heading');
  });

  it('does not emit a link block for an anchor inside a paragraph', async () => {
    document.body.innerHTML = `
      <p>${'x'.repeat(25)} <a href="https://a.test">linked</a> tail</p>
    `;
    const { blocks } = await extractPageBlocks();
    expect(blocks.filter((b) => b.type === 'link')).toHaveLength(0);
    expect(blocks.filter((b) => b.type === 'paragraph')).toHaveLength(1);
  });

  it('emits a link block for a top-level orphan anchor', async () => {
    document.body.innerHTML = `<a href="https://a.test">Click me</a>`;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'link', text: 'Click me', href: 'https://a.test/' });
  });

  it('preserves mixed-order: heading, table, paragraph, chart, paragraph', async () => {
    extractTableMock.mockReturnValue([{ a: 1 }]);
    extractChartDataMock.mockResolvedValue({
      title: 't', data: [], method: 'm', canExtract: true, message: '', _extractionNote: '',
    });
    document.body.innerHTML = `
      <h2>H</h2>
      <table><tbody><tr><td>x</td></tr></tbody></table>
      <p>${'p'.repeat(30)}</p>
      <div class="test-chart"></div>
      <p>${'q'.repeat(30)}</p>
    `;
    const { blocks } = await extractPageBlocks();
    expect(blocks.map((b) => b.type)).toEqual([
      'heading', 'table', 'paragraph', 'chart', 'paragraph',
    ]);
    const tableBlock = blocks[1] as { ref: string };
    const chartBlock = blocks[3] as { ref: string };
    expect(tableBlock.ref).toBe('table_0');
    expect(chartBlock.ref).toBe('chart_0');
  });

  it('skips a chart block when extractChartData rejects', async () => {
    extractChartDataMock.mockRejectedValue(new Error('boom'));
    document.body.innerHTML = `<div class="test-chart"></div>`;
    const { blocks, charts } = await extractPageBlocks();
    expect(charts).toEqual([]);
    expect(blocks.filter((b) => b.type === 'chart')).toEqual([]);
  });

  it('skips a table block when extractTable returns []', async () => {
    extractTableMock.mockReturnValue([]);
    document.body.innerHTML = `<table></table>`;
    const { blocks, tables } = await extractPageBlocks();
    expect(tables).toEqual([]);
    expect(blocks.filter((b) => b.type === 'table')).toEqual([]);
  });

  it('emits a chart block with _extractionNote when canExtract is false', async () => {
    extractChartDataMock.mockResolvedValue({
      title: null, data: null, method: null, canExtract: false, message: '',
      _extractionNote: 'Could not read this chart',
    });
    document.body.innerHTML = `<div class="test-chart"></div>`;
    const { charts } = await extractPageBlocks();
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ canExtract: false, _extractionNote: 'Could not read this chart' });
  });

  it('emits a quote block from <blockquote>', async () => {
    document.body.innerHTML = `<blockquote>To be or not to be</blockquote>`;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'quote', text: 'To be or not to be' });
  });

  it('emits a code block from <pre> with language from class', async () => {
    document.body.innerHTML = `<pre><code class="language-ts">const x = 1;</code></pre>`;
    const { blocks } = await extractPageBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'code', text: 'const x = 1;', language: 'ts' });
  });
});

describe('mergePages', () => {
  function mkPage(overrides: Partial<PageContent>): PageContent {
    return {
      pageTitle: '', blocks: [], tables: [], charts: [], ...overrides,
    };
  }

  it('renumbers ids globally across two pages with one table + one chart each', () => {
    const p1 = mkPage({
      blocks: [
        { type: 'table', ref: 'table_0', label: 't1' },
        { type: 'chart', ref: 'chart_0', label: 'c1' },
      ],
      tables: [{ id: 'table_0', label: 't1', rows: [{ a: 1 }] }],
      charts: [{ id: 'chart_0', label: 'c1', title: null, data: null, method: null, canExtract: true }],
    });
    const p2 = mkPage({
      blocks: [
        { type: 'table', ref: 'table_0', label: 't2' },
        { type: 'chart', ref: 'chart_0', label: 'c2' },
      ],
      tables: [{ id: 'table_0', label: 't2', rows: [{ a: 2 }] }],
      charts: [{ id: 'chart_0', label: 'c2', title: null, data: null, method: null, canExtract: true }],
    });

    const merged = mergePages([p1, p2]);
    expect(merged.tables.map((t) => t.id)).toEqual(['table_0', 'table_1']);
    expect(merged.charts.map((c) => c.id)).toEqual(['chart_0', 'chart_1']);
    const tableRefs = merged.blocks.filter((b) => b.type === 'table').map((b) => (b as { ref: string }).ref);
    const chartRefs = merged.blocks.filter((b) => b.type === 'chart').map((b) => (b as { ref: string }).ref);
    expect(tableRefs).toEqual(['table_0', 'table_1']);
    expect(chartRefs).toEqual(['chart_0', 'chart_1']);
  });

  it('tolerates an empty page in the middle', () => {
    const p1 = mkPage({ blocks: [{ type: 'heading', level: 1, text: 'A' }] });
    const empty = mkPage({});
    const p3 = mkPage({ blocks: [{ type: 'heading', level: 1, text: 'B' }] });
    const merged = mergePages([p1, empty, p3]);
    expect(merged.blocks.map((b) => (b as { text: string }).text)).toEqual(['A', 'B']);
    expect(merged.tables).toEqual([]);
    expect(merged.charts).toEqual([]);
  });

  it('is identity on a single page (no renumber side-effects)', () => {
    const p = mkPage({
      blocks: [{ type: 'table', ref: 'table_0', label: 't' }],
      tables: [{ id: 'table_0', label: 't', rows: [{ a: 1 }] }],
    });
    const merged = mergePages([p]);
    expect(merged.tables[0].id).toBe('table_0');
    expect((merged.blocks[0] as { ref: string }).ref).toBe('table_0');
  });
});
```

---

## File 3 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### Imports

Locate the existing import block at the top of the file. Find the line that begins:

```ts
import { resolveElement } from './elementResolution';
```

Add **immediately after** this line:

```ts
import { extractPageBlocks, mergePages, type PageContent } from '../extraction/pageBlockExtractor';
```

### Rewrite `scrapeWholePage`

Replace the function body at lines 564–601. The new function:

```ts
async function scrapeWholePage(
  opts: ScrapeStep['options'],
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  if (opts.scrollToBottom) {
    onProgress?.('Scrolling to load all content...');
    await scrollToBottom((scrollY, totalHeight) =>
      onProgress?.(`Scrolling... ${Math.round((scrollY / totalHeight) * 100)}%`),
    );
  }

  if (opts.expandHidden) {
    onProgress?.('Expanding hidden sections...');
    await expandHiddenElements();
  }

  const pages: PageContent[] = [];

  if (opts.paginate && opts.paginationSelector) {
    pages.push(await extractPageBlocks());

    const pagesScraped = await paginatePages({
      paginationSelector: opts.paginationSelector,
      pageCount: opts.pageCount || 0,
      onPage: async () => {
        if (opts.scrollToBottom) await scrollToBottom();
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

The `_ = afk` parameter remains in the signature (unused — the engine wires it in for symmetry with other extractors; do not remove).

### Delete dead code

Delete the **entire** functions `extractPageContent` (lines 603–678) and `mergePageData` (lines 680–695). Total deletion ≈ 95 lines.

After deletion, the next function in the file is `findPaginationContainer` (currently line 699). Verify this becomes immediately adjacent to the new `scrapeWholePage`'s closing brace; remove only stray blank lines if needed.

### Verify nothing else broke

After the edits, run:

```bash
grep -n "extractPageContent\|mergePageData\|content\.headings\|content\.paragraphs\|content\.lists\|content\.links" src/
```

Expected output: **zero matches**. If any match remains, the cutover is incomplete.

---

## Iteration push compatibility

The engine's iteration push at `scrapingEngine.ts:194-203` walks each top-level key of the scrape return value:

```ts
for (const [, value] of Object.entries(scraped)) {
  if (Array.isArray(value)) iterData.push(...(value as Record<string, unknown>[]));
  else if (value !== null && typeof value === 'object') iterData.push(value as Record<string, unknown>);
}
```

By wrapping the extractor output in `{ content: PageContent, pagesScraped: N }`:
- `content` (object) → pushed once → `iterData = [{ pageTitle, blocks, tables, charts }]` ✓
- `pagesScraped` (number) → skipped (not array, not object)

Single-row-per-page semantic is preserved. **Do not return `PageContent` directly** — the spread logic would flatten `blocks/tables/charts` into separate rows.

---

## Verification

### Automated

Run all five from the repo root:

```bash
npm run lint
npm run deps:check
npm run type-check
npm run test
npm run build
```

All must pass with zero new errors. The pre-existing type-check failures from `.wxt/types`, `@types/chrome`, `vite`, and `unimport` are out of `src/` and remain ignored.

### Manual

1. **Wiktionary "Bill" flow** — load the saved config that produced the broken JSON before this change. Run with terms `Bob, Bill, Ben`. After completion:
   - `iter.data[0]` should be exactly `{ pageTitle, blocks, tables, charts }`.
   - `blocks` is document-ordered: expect headings, paragraphs, lists, links, table refs, chart refs interleaved by their position on the page.
   - For each `{ type: 'table', ref }` block, find the matching `tables[i].id` and confirm `rows` is populated.
   - For each `{ type: 'chart', ref }` block, find the matching `charts[i].id`.

2. **Dedup confirmation** — pick a page where a list contains anchors. Verify each anchor's text appears in the parent list's `items` array, and **not** as a separate `link` block. The same applies for anchors inside paragraphs and tables.

3. **Paginated wholePage** — run a config with the `paginate` option enabled on a multi-page site. Confirm:
   - `tables[].id` values are globally unique across all merged pages (`table_0` … `table_N` with no duplicates).
   - Every `block.ref` for `table` and `chart` blocks resolves to an entry in the corresponding `tables` or `charts` array.

4. **Block coverage** — pick a page exercising `<blockquote>` and `<pre>` (Wikipedia article with a quoted passage; any tech doc with a code sample). Confirm `quote` and `code` blocks appear with the correct shape; `code.language` is populated when a `language-XXX` class is present, `null` otherwise.

---

## Out of scope (do not add in v1)

The following were considered and explicitly deferred during planning. Resist scope-creep:

- `<img>` / `<figure>` blocks — no concrete PDF-template use case demonstrated.
- Inline anchor `href`s preserved inside paragraphs/lists/quotes — text retained, URL dropped.
- Nested-list tree shape (items as `(string | List)[]` recursively) — flatten chosen.
- Section / landmark grouping — blocks stay flat, no tree.
- Shadow DOM traversal — none of the existing extractors do it.
- Streaming / incremental output.
- Configurable paragraph-length filter (hardcoded at 20).
- Hoisting types to `src/types/extraction.ts`.
- TreeWalker rewrite of the candidate sort (only if profiling demands it).

---

## Rollback

If a regression is found post-merge, revert with:

```bash
git revert <commit-sha>
```

The change is self-contained in three files. No data migration was performed; existing saved configs are untouched (output shape change only affects new scrape runs).
