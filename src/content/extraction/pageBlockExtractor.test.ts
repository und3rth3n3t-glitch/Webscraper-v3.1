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
