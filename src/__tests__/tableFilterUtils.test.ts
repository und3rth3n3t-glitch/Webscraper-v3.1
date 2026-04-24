import { describe, it, expect } from 'vitest';
import { filterByExcludedIndices } from '../content/extraction/tableFilterUtils';

const rows = [
  { a: '1', b: '2', c: '3' },
  { a: '4', b: '5', c: '6' },
];

describe('filterByExcludedIndices', () => {
  it('returns original rows when no indices excluded', () => {
    expect(filterByExcludedIndices(rows, [])).toBe(rows);
  });

  it('returns original rows when no rows', () => {
    expect(filterByExcludedIndices([], [0])).toEqual([]);
  });

  it('excludes columns at specified indices', () => {
    const result = filterByExcludedIndices(rows, [1]); // exclude 'b'
    expect(result[0]).toEqual({ a: '1', c: '3' });
    expect(result[1]).toEqual({ a: '4', c: '6' });
  });

  it('excludes multiple columns', () => {
    const result = filterByExcludedIndices(rows, [0, 2]); // exclude 'a' and 'c'
    expect(result[0]).toEqual({ b: '2' });
  });

  it('returns original when no column is actually excluded', () => {
    const result = filterByExcludedIndices(rows, [5]); // out of range
    expect(result).toBe(rows);
  });
});
