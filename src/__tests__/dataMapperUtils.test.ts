import { describe, it, expect } from 'vitest';
import { detectColumns, applyMapping, buildDefaultMapping } from '../sidepanel/utils/dataMapperUtils';

const rows = [
  { name: 'Apple', price: '100', sector: 'Tech' },
  { name: 'Google', price: '200', sector: 'Tech' },
  { name: 'Ford', price: '15' },
];

describe('detectColumns', () => {
  it('returns empty array for empty data', () => {
    expect(detectColumns([])).toEqual([]);
  });

  it('detects columns sorted by frequency', () => {
    const cols = detectColumns(rows);
    const names = cols.map((c) => c.originalName);
    // name and price appear 3x, sector 2x
    expect(names[0]).toBe('name');
    expect(names[1]).toBe('price');
    expect(names).toContain('sector');
  });

  it('all columns enabled by default', () => {
    const cols = detectColumns(rows);
    expect(cols.every((c) => c.enabled)).toBe(true);
  });

  it('assigns ascending positions', () => {
    const cols = detectColumns(rows);
    const positions = cols.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('applyMapping', () => {
  it('filters to enabled columns only', () => {
    const mapping = buildDefaultMapping(rows);
    mapping.columns[0].enabled = false;
    const result = applyMapping(rows.slice(0, 1), mapping);
    expect(Object.keys(result[0])).not.toContain(mapping.columns[0].originalName);
  });

  it('renames columns per displayName', () => {
    const mapping = buildDefaultMapping(rows);
    mapping.columns[0].displayName = 'Company';
    const result = applyMapping([rows[0]], mapping);
    expect(result[0]).toHaveProperty('Company');
  });

  it('respects position ordering', () => {
    const mapping = buildDefaultMapping(rows);
    const cols = [...mapping.columns].sort((a, b) => a.position - b.position);
    const result = applyMapping([rows[0]], mapping);
    const resultKeys = Object.keys(result[0]);
    const expectedKeys = cols.filter((c) => c.enabled && c.originalName in rows[0]).map((c) => c.displayName);
    expect(resultKeys).toEqual(expectedKeys);
  });
});

describe('buildDefaultMapping', () => {
  it('creates version 1 mapping', () => {
    const mapping = buildDefaultMapping(rows);
    expect(mapping.version).toBe(1);
  });

  it('generates unique IDs for each column', () => {
    const mapping = buildDefaultMapping(rows);
    const ids = mapping.columns.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
