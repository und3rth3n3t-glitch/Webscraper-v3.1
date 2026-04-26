import { describe, expect, it } from 'vitest';
import { discriminateIteration } from './cardDiscrimination';
import type { DataMapping, IterationResult } from '../types/extraction';
import wholepageFixture from './__fixtures__/wholepage-iteration.json';

const mappingFor = (...names: string[]): DataMapping => ({
  version: 1,
  columns: names.map((n, i) => ({
    id: `c${i}`, originalName: n, displayName: n, enabled: true, position: i, sourceType: 'scrapeElement',
  })),
});
const iter = (data: Record<string, unknown>[]): IterationResult => ({
  searchTerm: 't', data, status: 'success',
});

describe('discriminateIteration', () => {
  it('empty data → empty', () => {
    expect(discriminateIteration(iter([])).kind).toBe('empty');
  });

  it('flat scalar rows + matching mapping → table-iteration', () => {
    const r = discriminateIteration(iter([{ name: 'a', price: 1 }, { name: 'b', price: 2 }]), mappingFor('name', 'price'));
    expect(r.kind).toBe('table-iteration');
  });

  it('flat rows but no mapping → mixed (per-field text card)', () => {
    const r = discriminateIteration(iter([{ name: 'a', price: 1 }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('text');
  });

  it('chart record under a key → chart card', () => {
    const r = discriminateIteration(iter([{
      myChart: { data: [], title: 't', method: 'js_library', canExtract: true },
    }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('chart');
  });

  it('chart fallback shape (_canExtract:false) → chart card', () => {
    const r = discriminateIteration(iter([{ chart2: { _canExtract: false, _warning: 'no data' } }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('chart');
  });

  it('Array<Record> under a key → table-field card', () => {
    const r = discriminateIteration(iter([{ rows: [{ a: 1 }, { a: 2 }] }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('table-field');
  });

  it('PageContent shape under a key → pageblocks card', () => {
    const r = discriminateIteration(iter([{ wholePage: { pageTitle: 't', blocks: [], tables: [], charts: [] } }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('pageblocks');
  });

  it('row is itself PageContent (wholepage-flattened) → pageblocks card', () => {
    const r = discriminateIteration(iter([{ pageTitle: 't', blocks: [], tables: [], charts: [] }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('pageblocks');
    expect((r.perRow[0][0] as { kind: string; fieldName: string | null }).fieldName).toBeNull();
  });

  it('mixed row → per-field dispatch', () => {
    const r = discriminateIteration(iter([{
      name: 'A',
      chart: { data: [], method: 'aria', canExtract: true },
      rows: [{ x: 1 }],
    }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    const kinds = r.perRow[0].map((c) => c.kind).sort();
    expect(kinds).toEqual(['chart', 'table-field', 'text']);
  });

  it('all scalars → grouped text card (one per row)', () => {
    const r = discriminateIteration(iter([{ a: 1, b: 'x', c: true }]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0]).toHaveLength(1);
    expect(r.perRow[0][0].kind).toBe('text');
  });

  it('null row → raw card', () => {
    const r = discriminateIteration(iter([null as unknown as Record<string, unknown>]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('raw');
  });

  it('unknown shape → raw card', () => {
    const r = discriminateIteration(iter([{ thing: () => 1 } as unknown as Record<string, unknown>]));
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0][0].kind).toBe('raw');
  });

  it('real wholepage fixture (blocks/tables/charts top-level) → pageblocks card', () => {
    const r = discriminateIteration(wholepageFixture as unknown as IterationResult);
    expect(r.kind).toBe('mixed');
    if (r.kind !== 'mixed') return;
    expect(r.perRow[0]).toHaveLength(1);
    expect(r.perRow[0][0].kind).toBe('pageblocks');
    expect((r.perRow[0][0] as { kind: string; fieldName: string | null }).fieldName).toBeNull();
  });
});
