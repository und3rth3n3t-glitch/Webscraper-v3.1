import { describe, expect, it } from 'vitest';
import { shapeTable } from './shapeTable';

const HEADERS = [
  { flatKey: 'Column 1', path: ['Column 1'] },
  { flatKey: 'England.Country.count', path: ['England', 'Country', 'count'] },
  { flatKey: 'England.Country.pct', path: ['England', 'Country', '%'] },
];

const ROWS = [
  { 'Column 1': 'All usual residents', 'England.Country.count': '56,490,048', 'England.Country.pct': '100.0%' },
  { 'Column 1': 'Female', 'England.Country.count': '28,897,673', 'England.Country.pct': '51.2%' },
];

describe('shapeTable', () => {
  it('produces stable column ids', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    expect(t.schema.columns[0].id).toBe('column_1');
    expect(t.schema.columns[1].id).toBe('england_country_count');
    expect(t.schema.columns[2].id).toBe('england_country_pct');
  });

  it('infers number type for count column', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    expect(t.schema.columns[1].type).toBe('number');
  });

  it('infers percent type for pct column', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    expect(t.schema.columns[2].type).toBe('percent');
  });

  it('sets inferred=true when no override', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    expect(t.schema.columns[1].inferred).toBe(true);
  });

  it('applies type override', () => {
    const t = shapeTable(ROWS, HEADERS, {
      columnOverrides: [{ flatKey: 'England.Country.count', type: 'text' }],
    });
    expect(t.schema.columns[1].type).toBe('text');
    expect(t.schema.columns[1].inferred).toBe(false);
  });

  it('builds row ids from key column', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    expect(t.rows[0].id).toBe('all_usual_residents');
    expect(t.rows[1].id).toBe('female');
  });

  it('disambiguates duplicate row keys', () => {
    const dupeRows = [
      { 'Column 1': 'All', 'England.Country.count': '100' },
      { 'Column 1': 'All', 'England.Country.count': '200' },
    ];
    const t = shapeTable(dupeRows, HEADERS.slice(0, 2), {});
    expect(t.rows[0].id).toBe('all');
    expect(t.rows[1].id).toBe('all_2');
  });

  it('preserves raw alongside parsed value', () => {
    const t = shapeTable(ROWS, HEADERS, {});
    const cell = t.rows[0].cells['england_country_count'];
    expect(cell.raw).toBe('56,490,048');
    expect(cell.value).toBe(56490048);
  });

  it('filters columns absent from rows', () => {
    const partialRows = [{ 'Column 1': 'test' }];
    const t = shapeTable(partialRows, HEADERS, {});
    expect(t.schema.columns).toHaveLength(1);
  });

  it('returns empty rows array for no data', () => {
    const t = shapeTable([], HEADERS, {});
    expect(t.rows).toHaveLength(0);
  });
});
