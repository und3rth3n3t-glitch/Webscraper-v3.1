# SPEC-structured-output-v1.0

## Context

Scraped data currently exits the extension as flat rows with composite string keys
(`"England\nCountry.count": "56,490,048"`). This shape is brittle, untyped, and
unaddressable: there is no stable way for a downstream platform to reference
`outputs.sex_persons.rows.all_residents.cells.england_country_count` across runs.

This spec introduces a **3C (schema + cells, dictionary-style)** result shape emitted
entirely by the extension. The backend stores it as-is (no change to transport). A new
React OUTPUT tab in the prototype UI makes the structured data inspectable and
copy-referenceable via dot-path / Nunjucks expressions.

**Architecture rule**: the extension/worker owns all data shaping. The backend is a
passthrough. The React UI is a prototype test harness and is not portable.

**Hard-cut**: existing runs are wiped (staging app; no backwards compatibility required).

---

## Part A — Portable (Extension + Wire Protocol)

Implement in order. Every function must be complete — no pseudocode.

---

### A1. New: `src/utils/slugify.ts`

```typescript
const SYMBOL_MAP: Record<string, string> = {
  '%': 'pct', '£': 'gbp', '$': 'usd', '€': 'eur', '¥': 'jpy',
  '₹': 'inr', '#': 'num', '&': 'and', '+': 'plus',
};

export function slugify(input: string): string {
  let s = input.toLowerCase();
  for (const [sym, word] of Object.entries(SYMBOL_MAP)) {
    s = s.split(sym).join(`_${word}_`);
  }
  s = s
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'col';
  if (/^\d/.test(s)) s = '_' + s;
  return s.slice(0, 64);
}

export function disambiguate(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
```

---

### A2. New: `src/content/shaping/types.ts`

```typescript
export type ColumnType = 'text' | 'number' | 'percent' | 'currency' | 'date' | 'boolean';

export interface ColumnFormat {
  thousands?: string;
  decimal?: string;
  symbol?: string;
  unit?: 'percent';
  dayFirst?: boolean;
}

export interface WireColumn {
  id: string;
  headers: string[];
  displayName: string;
  type: ColumnType;
  format?: ColumnFormat;
  inferred: boolean;
}

export interface WireCell {
  value: string | number | boolean | null;
  raw: string;
}

export interface WireRow {
  id: string;
  key: string;
  cells: Record<string, WireCell>;
}

export interface WireTableSchema {
  columns: WireColumn[];
  rowKeyColumnId: string;
}

export interface WireTable {
  kind: 'table';
  label: string;
  schema: WireTableSchema;
  rows: WireRow[];
}

export interface WireChart {
  kind: 'chart';
  label: string;
  title: string | null;
  method: string;
  canExtract: boolean;
  data: unknown | null;
}

export interface WireRaw {
  kind: 'raw';
  data: unknown;
}

export type WireOutput = WireTable | WireChart | WireRaw;

export interface WireIteration {
  schemaVersion: 1;
  iterationKey: string;
  iterationLabel: string;
  searchTerm: string | null;
  status: 'success' | 'error' | 'skipped';
  error?: string;
  outputs: Record<string, WireOutput>;
  pageUrls?: string[];
}
```

---

### A3. New: `src/content/shaping/inferType.ts`

```typescript
import type { ColumnType, ColumnFormat } from './types';

const MAX_INFER_LENGTH = 1024;

const DENYLIST_HEADER = [/code$/i, /\bid\b/i, /postcode/i, /phone/i, /reference/i, /\bref$/i];

const ONS_CODE = /^[A-Z]\d{8}$/;
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;
const NULL_MARKERS = new Set(['c', ':', '..', '—', '-', 'n/a', 'na', 'null', 'nil', '']);

const NUMBER_THOUSANDS = /^-?\d{1,3}(,\d{3})*(\.\d+)?$/;
const NUMBER_PLAIN = /^-?\d+(\.\d+)?$/;
const PERCENT = /^-?\d+(\.\d+)?%$/;
const CURRENCY = /^[£$€¥₹][\d,]+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UK_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const BOOL_VALUES = new Set(['yes', 'no', 'true', 'false']);

function isIdLike(v: string): boolean {
  return ONS_CODE.test(v) || POSTCODE.test(v) || (v.startsWith('0') && v.length > 1 && /^\d+$/.test(v));
}

type InferResult = { type: ColumnType; format?: ColumnFormat };

export function inferType(cells: string[], headerPath?: string[]): InferResult {
  const lastHeader = headerPath?.[headerPath.length - 1] ?? '';
  if (DENYLIST_HEADER.some((re) => re.test(lastHeader))) return { type: 'text' };

  const nonNull = cells.filter((c) => !NULL_MARKERS.has(c.trim().toLowerCase()));
  if (nonNull.length === 0) return { type: 'text' };

  const usable = nonNull.filter((c) => c.length <= MAX_INFER_LENGTH);
  if (usable.length === 0) return { type: 'text' };

  if (usable.every((c) => isIdLike(c.trim()))) return { type: 'text' };

  const score = (re: RegExp) => usable.filter((c) => re.test(c.trim())).length / usable.length;

  if (score(PERCENT) >= 0.9) return { type: 'percent', format: { unit: 'percent' } };
  if (score(CURRENCY) >= 0.9) {
    const sym = usable[0].trim()[0];
    return { type: 'currency', format: { symbol: sym } };
  }
  if (usable.filter((c) => BOOL_VALUES.has(c.trim().toLowerCase())).length / usable.length >= 0.9) {
    return { type: 'boolean' };
  }
  if (score(ISO_DATE) >= 0.9) return { type: 'date' };
  if (score(UK_DATE) >= 0.9) return { type: 'date', format: { dayFirst: true } };
  if (score(NUMBER_THOUSANDS) >= 0.9) return { type: 'number', format: { thousands: ',', decimal: '.' } };
  if (score(NUMBER_PLAIN) >= 0.9) return { type: 'number' };

  return { type: 'text' };
}

export function parseValue(
  raw: string,
  type: ColumnType,
  format?: ColumnFormat,
): string | number | boolean | null {
  const t = raw.trim();
  if (NULL_MARKERS.has(t.toLowerCase())) return null;
  if (t.length > MAX_INFER_LENGTH) return t;

  switch (type) {
    case 'number': {
      const cleaned = format?.thousands ? t.replace(new RegExp(`\\${format.thousands}`, 'g'), '') : t;
      const n = Number(cleaned);
      return isNaN(n) ? null : n;
    }
    case 'percent': {
      const n = Number(t.replace('%', ''));
      return isNaN(n) ? null : n;
    }
    case 'currency': {
      const n = Number(t.replace(format?.symbol ?? '', '').replace(/,/g, ''));
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return t.toLowerCase() === 'yes' || t.toLowerCase() === 'true';
    default:
      return t;
  }
}
```

---

### A4. New: `src/content/shaping/shapeTable.ts`

```typescript
import { disambiguate, slugify } from '../../utils/slugify';
import { inferType, parseValue } from './inferType';
import type { WireColumn, WireRow, WireTable } from './types';
import type { ScrapeElementConfig } from '../../types/config';

export function shapeTable(
  rows: Record<string, unknown>[],
  headerPaths: { flatKey: string; path: string[] }[],
  elConfig: Pick<ScrapeElementConfig, 'columnOverrides'>,
): WireTable {
  const presentKeys = new Set(rows.flatMap((r) => Object.keys(r)));
  const active = headerPaths.filter((h) => presentKeys.has(h.flatKey) && h.flatKey !== '_group');

  const usedIds = new Set<string>();
  const columns: WireColumn[] = active.map((h, i) => {
    const override = elConfig.columnOverrides?.find((o) => o.flatKey === h.flatKey);
    const baseId = slugify(h.path.join('_')) || `col_${i}`;
    const id = disambiguate(baseId, usedIds);
    usedIds.add(id);

    const cellStrings = rows.map((r) => String(r[h.flatKey] ?? ''));
    const inferred = inferType(cellStrings, h.path);
    const type = override?.type ?? inferred.type;

    return {
      id,
      headers: h.path,
      displayName: h.path[h.path.length - 1] ?? h.flatKey,
      type,
      format: inferred.format,
      inferred: !override?.type,
    };
  });

  const usedRowIds = new Set<string>();
  const wireRows: WireRow[] = rows.map((r) => {
    const keyFlatKey = active[0]?.flatKey ?? '';
    const keyValue = String(r[keyFlatKey] ?? '');
    const baseRowId = slugify(keyValue) || 'row';
    const rowId = disambiguate(baseRowId, usedRowIds);
    usedRowIds.add(rowId);

    const cells: Record<string, { value: string | number | boolean | null; raw: string }> = {};
    columns.forEach((col, i) => {
      const raw = String(r[active[i]?.flatKey ?? ''] ?? '');
      cells[col.id] = { value: parseValue(raw, col.type, col.format), raw };
    });

    return { id: rowId, key: keyValue, cells };
  });

  return {
    kind: 'table',
    label: '',
    schema: { columns, rowKeyColumnId: columns[0]?.id ?? '' },
    rows: wireRows,
  };
}
```

---

### A5. New: `src/content/shaping/shapeChart.ts`

```typescript
import type { WireChart } from './types';

export function shapeChart(rawResult: unknown, label: string): WireChart {
  if (!rawResult || typeof rawResult !== 'object') {
    return { kind: 'chart', label, title: null, method: 'unknown', canExtract: false, data: null };
  }
  const r = rawResult as Record<string, unknown>;
  const failed = r._canExtract === false || (r.canExtract === false);
  return {
    kind: 'chart',
    label,
    title: (r.title as string | null) ?? null,
    method: (r.method as string) ?? 'unknown',
    canExtract: !failed,
    data: failed ? null : rawResult,
  };
}
```

---

### A6. New: `src/content/shaping/index.ts`

```typescript
export { shapeTable } from './shapeTable';
export { shapeChart } from './shapeChart';
export { inferType, parseValue } from './inferType';
export type * from './types';
```

---

### A7. Modify: `src/types/config.ts`

After the closing brace of `ScrapeElementConfig` (line 89), add before `ScrapeOptions`:

```typescript
export interface ColumnOverride {
  flatKey: string;
  type: import('./extraction').ColumnType;
}
```

Inside `ScrapeElementConfig` (after line 88, `paginationCount: number;`), add:

```typescript
  outputKey?: string;
  columnOverrides?: ColumnOverride[];
```

Final `ScrapeElementConfig` shape (lines 75-89 become):

```typescript
export interface ScrapeElementConfig {
  id: string;
  name: string;
  selector: SelectorDescriptor;
  detectedType: string;
  selectMode: 'single' | 'all';
  extra: Record<string, unknown>;
  tableFields: string[];
  excludedColumns: string[];
  dynamicHeaders: boolean;
  excludedColumnIndices: number[];
  paginate: boolean;
  paginationSelector: SelectorDescriptor | null;
  paginationCount: number;
  outputKey?: string;
  columnOverrides?: ColumnOverride[];
}
```

---

### A8. Modify: `src/types/extraction.ts`

Replace the entire file:

```typescript
import type { WireIteration } from '../content/shaping/types';

export type { WireIteration };
export type { ColumnType } from '../content/shaping/types';

export interface ScrapingResult {
  configId: string;
  configName: string;
  scrapedAt: string;
  sourceUrl: string;
  iterations: WireIteration[];
  totalTimeMs: number;
  aborted?: boolean;
  guardBlocked?: boolean;
}

export interface ApiCall {
  id: string;
  url: string;
  method: string;
  statusCode: number;
  responseBodyJson?: unknown;
  capturedAt: string;
}
```

---

### A9. Modify: `src/types/signalr.ts`

Line 1: change `import type { IterationResult } from './extraction';`
to `import type { WireIteration } from '../content/shaping/types';`

Line 60: change `iterations: IterationResult[];`
to `iterations: WireIteration[];`

Remove `IterationResult` from the `DataMapping` import if present (line 2 currently
imports `DataMapping, ScraperConfig` from `'./config'` — leave that unchanged).

---

### A10. Modify: `src/content/extraction/tableExtractor.ts`

**Add new export function** immediately after `extractTableHeaders` closes (after line 59).
Insert at line 60:

```typescript
export function extractTableHeadersWithPaths(table: Element): { flatKey: string; path: string[] }[] {
  const thead = table.querySelector('thead');
  const headerRows = thead ? Array.from(thead.querySelectorAll('tr')) : detectHeaderRows(table);
  if (headerRows.length === 0) return [];
  const totalCols = getTableColumnCount(table);
  if (totalCols === 0) return [];
  const matrix = buildHeaderMatrix(headerRows, totalCols);
  const result: { flatKey: string; path: string[] }[] = [];
  for (let col = 0; col < totalCols; col++) {
    const parts = matrix
      .map((row) => row[col] || '')
      .filter(Boolean)
      .filter((v, i, a) => v !== a[i - 1]);
    const path = parts.length > 0 ? parts : [`Column ${col + 1}`];
    const flatKey = parts.length > 0 ? parts.join('.') : `Column ${col + 1}`;
    result.push({ flatKey, path });
  }
  return result;
}
```

**Refactor `extractTableHeaders`** (lines 38-59) to delegate — replace with:

```typescript
export function extractTableHeaders(table: Element): string[] {
  return extractTableHeadersWithPaths(table).map((h) => h.flatKey);
}
```

All other functions in `tableExtractor.ts` remain exactly as-is.

---

### A11. Modify: `src/content/scraping/scrapingEngine.ts`

**Imports to add** at the top (after existing imports, around line 43):

```typescript
import { shapeTable, shapeChart } from '../shaping';
import type { WireOutput, WireIteration } from '../shaping';
import { slugify, disambiguate } from '../../utils/slugify';
import { extractTableHeadersWithPaths } from '../extraction/tableExtractor';
```

**Add new private function** `scrapeElementToWire` before `executeScrape` (before line 581):

```typescript
async function scrapeElementToWire(
  elConfig: ScrapeElementConfig,
  onProgress: OnProgress,
  afk: boolean,
  paginationDelayMs: number | undefined,
  usedKeys: Set<string>,
): Promise<{ outputKey: string; output: WireOutput }> {
  const baseKey = elConfig.outputKey?.trim()
    ? slugify(elConfig.outputKey.trim())
    : slugify(elConfig.name) || 'output';
  const outputKey = disambiguate(baseKey, usedKeys);

  const rawResult = await scrapeElement(elConfig, onProgress, afk, paginationDelayMs);

  if (elConfig.detectedType === 'table' && Array.isArray(rawResult)) {
    const { element: el } = resolveElement(elConfig.selector);
    const tableEl = el
      ? el.tagName === 'TABLE'
        ? el
        : el.querySelector('table')
      : null;
    const headerPaths = tableEl
      ? extractTableHeadersWithPaths(tableEl as Element)
      : (rawResult as Record<string, unknown>[]).length > 0
        ? Object.keys((rawResult as Record<string, unknown>[])[0])
            .filter((k) => k !== '_group')
            .map((k) => ({ flatKey: k, path: [k] }))
        : [];

    const wireTable = shapeTable(rawResult as Record<string, unknown>[], headerPaths, elConfig);
    wireTable.label = outputKey;
    return { outputKey, output: wireTable };
  }

  if (elConfig.detectedType === 'chart') {
    return { outputKey, output: shapeChart(rawResult, outputKey) };
  }

  return { outputKey, output: { kind: 'raw', data: rawResult } };
}
```

**Replace `executeScrape`** (lines 581-605) entirely:

```typescript
async function executeScrape(
  step: ScrapeStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, WireOutput>> {
  const opts = step.options;
  const outputs: Record<string, WireOutput> = {};
  swLog('[executeScrape] enter | mode:', opts.mode, '| elements:', opts.elements?.length ?? 0, '| url:', window.location.href);

  if (opts.mode === 'wholePage') {
    onProgress?.('Scraping whole page...');
    const pageData = await scrapeWholePage(opts, onProgress, afk);
    outputs['page'] = { kind: 'raw', data: pageData };
  } else {
    const usedKeys = new Set<string>();
    for (const elConfig of opts.elements || []) {
      onProgress?.(`Scraping "${elConfig.name}"...`);
      const { outputKey, output } = await scrapeElementToWire(elConfig, onProgress, afk, opts.paginationDelayMs, usedKeys);
      usedKeys.add(outputKey);
      outputs[outputKey] = output;
    }
  }

  swLog('[executeScrape] exit | keys:', Object.keys(outputs));
  return outputs;
}
```

**In `executeFlow`** (lines 90-302), make these targeted changes:

1. **Line 87** — change `previousIterations?: IterationResult[]` to `previousIterations?: WireIteration[]`

2. **Line 123** — change `iterations: [...previousIterations]` — type is now `WireIteration[]`, no other change

3. **After line 153** (`const terms = searchTerms.length > 0 ? searchTerms : [null];`), add:
   ```typescript
   const usedIterKeys = new Set<string>(previousIterations.map((it) => it.iterationKey));
   ```

4. **Line 162** — replace `const iterData: Record<string, unknown>[] = [];` with:
   ```typescript
   const iterOutputs: Record<string, WireOutput> = {};
   ```

5. **Lines 234-248** — replace the entire `if (stepData !== null && step.type === 'scrape')` block with:
   ```typescript
   if (stepData !== null && step.type === 'scrape') {
     Object.assign(iterOutputs, stepData as Record<string, WireOutput>);
     swLog('[executeFlow] scrape merged into iterOutputs | taskId:', taskId, '| stepIndex:', si, '| outputKeys:', Object.keys(iterOutputs));
   }
   ```

6. **Lines 257-262** (aborted push) — replace `data: iterData` with `outputs: iterOutputs` and add iteration key fields:
   ```typescript
   result.iterations.push({
     schemaVersion: 1,
     iterationKey: disambiguate(slugify(term ?? '') || 'default', usedIterKeys),
     iterationLabel: term ?? '',
     searchTerm: term,
     outputs: iterOutputs,
     status: 'error',
     error: 'Aborted by user',
   });
   ```

7. **Lines 277-282** (normal iteration push) — replace entirely with:
   ```typescript
   const iterKey = disambiguate(slugify(term ?? '') || 'default', usedIterKeys);
   usedIterKeys.add(iterKey);
   result.iterations.push({
     schemaVersion: 1,
     iterationKey: iterKey,
     iterationLabel: term ?? '',
     searchTerm: term,
     outputs: iterOutputs,
     status: iterStatus,
     error: iterError,
   });
   ```

**In `executeSelectEach`** (lines 607-647): the call to `executeScrape` at line 638 now returns `Record<string, WireOutput>`. Update the `Object.assign(optionData, subData)` line — `optionData` type becomes `Record<string, Record<string, WireOutput>>`:

```typescript
// Line 634 - change type annotation
const optionData: Record<string, Record<string, WireOutput>> = {};
// Line 638 - subData is now Record<string, WireOutput>
const subData = await executeScrape(subStep, onProgress, afk);
Object.assign(optionData, subData);
```

Note: `executeSelectEach` results still do not merge into `iterOutputs` (condition `step.type === 'scrape'` is unchanged). This is acceptable for v1.

---

### A12. New: Test files

#### `src/utils/slugify.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { disambiguate, slugify } from './slugify';

describe('slugify', () => {
  it('lowercases and replaces spaces', () => expect(slugify('Sex Persons')).toBe('sex_persons'));
  it('handles newline dot composite headers', () => expect(slugify('England\nCountry.count')).toBe('england_country_count'));
  it('replaces % with pct', () => expect(slugify('England\nCountry.%')).toBe('england_country_pct'));
  it('strips Nunjucks metacharacters', () => expect(slugify('}}{{evil}}')).toBe('evil'));
  it('strips HTML tags', () => expect(slugify('<script>alert(1)</script>')).toBe('scriptalert_1_script'));
  it('returns col for empty input', () => expect(slugify('')).toBe('col'));
  it('returns col for whitespace-only', () => expect(slugify('   ')).toBe('col'));
  it('prefixes digit-starting slugs', () => expect(slugify('123abc')).toMatch(/^_/));
  it('truncates to 64 chars', () => expect(slugify('a'.repeat(200))).toHaveLength(64));
  it('leaves ONS codes safe', () => expect(slugify('E12000004')).toBe('e12000004'));
  it('replaces currency symbols', () => expect(slugify('£1234')).toBe('_gbp_1234'));
});

describe('disambiguate', () => {
  it('returns base when not in set', () => expect(disambiguate('foo', new Set())).toBe('foo'));
  it('appends _2 on first collision', () => expect(disambiguate('foo', new Set(['foo']))).toBe('foo_2'));
  it('increments until clear', () => expect(disambiguate('foo', new Set(['foo', 'foo_2', 'foo_3']))).toBe('foo_4'));
});
```

#### `src/content/shaping/inferType.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { inferType, parseValue } from './inferType';

describe('inferType', () => {
  it('infers number from plain decimals', () => expect(inferType(['100.0', '56.2']).type).toBe('number'));
  it('infers number with thousands', () => {
    const r = inferType(['56,490,048', '4,880,054']);
    expect(r.type).toBe('number');
    expect(r.format?.thousands).toBe(',');
  });
  it('infers percent', () => expect(inferType(['45.2%', '100.0%']).type).toBe('percent'));
  it('infers currency', () => {
    const r = inferType(['£1,234', '£5,678']);
    expect(r.type).toBe('currency');
    expect(r.format?.symbol).toBe('£');
  });
  it('infers boolean', () => expect(inferType(['Yes', 'No', 'Yes']).type).toBe('boolean'));
  it('infers ISO date', () => expect(inferType(['2024-01-15', '2023-06-01']).type).toBe('date'));
  it('returns text for ONS geography codes', () => expect(inferType(['E12000004', 'E12000005']).type).toBe('text'));
  it('returns text for leading-zero values', () => expect(inferType(['01234', '00789']).type).toBe('text'));
  it('returns text for header denylist match', () => expect(inferType(['123', '456'], ['area_code']).type).toBe('text'));
  it('stays numeric when ONS suppression markers mixed in', () => expect(inferType(['100.0', 'c', '56.2', ':']).type).toBe('number'));
  it('returns text for all-null markers', () => expect(inferType(['N/A', '—', '']).type).toBe('text'));
  it('skips inference for over-length cells', () => expect(inferType(['a'.repeat(1025)]).type).toBe('text'));
  it('ties (50/50) go to text', () => {
    const half = Array(5).fill('123').concat(Array(5).fill('abc'));
    expect(inferType(half).type).toBe('text');
  });
});

describe('parseValue', () => {
  it('parses number with thousands', () => expect(parseValue('56,490,048', 'number', { thousands: ',' })).toBe(56490048));
  it('parses percent', () => expect(parseValue('45.2%', 'percent')).toBe(45.2));
  it('returns null for ONS suppression markers', () => expect(parseValue('c', 'number')).toBeNull());
  it('parses boolean yes', () => expect(parseValue('Yes', 'boolean')).toBe(true));
  it('parses boolean no', () => expect(parseValue('No', 'boolean')).toBe(false));
  it('returns string for text type', () => expect(parseValue('hello', 'text')).toBe('hello'));
});
```

#### `src/content/shaping/shapeTable.test.ts`

```typescript
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
```

---

### A13. New: `specs/WIRE-PROTOCOL.md`

```markdown
# WebScrape Wire Protocol — v1

This document is the portable contract between the extension/worker and any backend
that hosts it. A future production .NET backend implements the same SignalR hub method
signatures and accepts/returns the JSON shapes described here.

## Transport

SignalR WebSockets. Hub path: `/scraper-hub` (configurable in appsettings).

## Down-channel (Backend → Extension)

### ReceiveTask

```json
{
  "id": "task-uuid",
  "configId": "config-uuid",
  "configName": "ONS Census",
  "searchTerms": ["East Midlands", "Yorkshire"],
  "iterationLabel": "region",
  "iterationAssignments": {},
  "priority": 0,
  "createdAt": "2026-04-27T12:00:00Z",
  "status": "pending",
  "inlineConfig": { /* ScraperConfig — full JSON */ }
}
```

`inlineConfig` is the complete `ScraperConfig` object. The extension uses
`inlineConfig.steps[].options.elements[].outputKey` (optional, string) and
`inlineConfig.steps[].options.elements[].columnOverrides` (optional array) when
shaping results. If absent, keys and types are auto-derived.

`columnOverrides` shape per element:
```json
[{ "flatKey": "England.Country.count", "type": "text" }]
```

Valid `type` values: `text | number | percent | currency | date | boolean`.

### CancelTask / ResumeAfterPause / ResumeAfterCloudflare

String taskId payload only. No shape changes.

## Up-channel (Extension → Backend)

### TaskComplete

```json
{
  "taskId": "task-uuid",
  "configId": "config-uuid",
  "configName": "ONS Census",
  "status": "success",
  "iterations": [ /* WireIteration[] — see below */ ],
  "totalTimeMs": 4500,
  "timestamp": "2026-04-27T12:00:04Z"
}
```

### TaskProgress, TaskError, TaskPaused

Unchanged from prior protocol — see `HubPayloadDtos.cs`.

## `WireIteration` shape (schemaVersion: 1)

```json
{
  "schemaVersion": 1,
  "iterationKey": "east_midlands",
  "iterationLabel": "East Midlands",
  "searchTerm": "East Midlands",
  "status": "success",
  "outputs": {
    "sex_persons": {
      "kind": "table",
      "label": "sex_persons",
      "schema": {
        "rowKeyColumnId": "column_1",
        "columns": [
          {
            "id": "column_1",
            "headers": ["Column 1"],
            "displayName": "Column 1",
            "type": "text",
            "inferred": true
          },
          {
            "id": "england_country_count",
            "headers": ["England\nCountry", "count"],
            "displayName": "count",
            "type": "number",
            "format": { "thousands": "," },
            "inferred": true
          }
        ]
      },
      "rows": [
        {
          "id": "all_usual_residents",
          "key": "All usual residents",
          "cells": {
            "column_1": { "value": "All usual residents", "raw": "All usual residents" },
            "england_country_count": { "value": 56490048, "raw": "56,490,048" }
          }
        }
      ]
    }
  }
}
```

### `kind: "chart"` shape

```json
{
  "kind": "chart",
  "label": "population_pyramid",
  "title": "Population by age and sex",
  "method": "flourish-api",
  "canExtract": true,
  "data": { /* chart data object */ }
}
```

### `kind: "raw"` shape (wholePage and untyped outputs)

```json
{
  "kind": "raw",
  "data": { /* arbitrary PageContent or other result */ }
}
```

## Iteration key derivation

`iterationKey = slugify(searchTerm)` where `slugify` lowercases, maps known symbols
(`%`→`pct`, `£`→`gbp`, etc.), strips non-alphanumeric, collapses underscores,
truncates to 64 chars. If the result is empty, `"default"` is used. Duplicates within
a run are disambiguated with `_2`, `_3` suffix.

## Column id derivation

`column.id = slugify(headers.join('_'))` using the same slugify function. Headers is
the raw path array from the HTML table matrix. Duplicates within one table disambiguated
with `_2`, `_3`. User can override via `columnOverrides[].flatKey` → the `flatKey` is
the original composite key as produced by `extractTableHeaders` (`parts.join('.')`).

## schemaVersion evolution

`schemaVersion: 1` is stamped by the extension on every iteration. Future breaking shape
changes bump the version. Backend stores the raw JSON; readers branch on `schemaVersion`.
```

---

## Part B — Prototype (React UI)

Install dependency first:
```bash
cd backend/src/WebScrape.Client
npm install @textea/json-viewer@3
```

Pin exact version in `package.json` (no `^`). Run `npm audit` and fix any
criticals/highs before proceeding.

---

### B1. New: `backend/src/WebScrape.Client/src/types/wire.ts`

Mirrors the extension's shaping types for React. Must stay in sync manually.

```typescript
export type ColumnType = 'text' | 'number' | 'percent' | 'currency' | 'date' | 'boolean';

export interface ColumnFormat {
  thousands?: string;
  decimal?: string;
  symbol?: string;
  unit?: 'percent';
  dayFirst?: boolean;
}

export interface WireColumn {
  id: string;
  headers: string[];
  displayName: string;
  type: ColumnType;
  format?: ColumnFormat;
  inferred: boolean;
}

export interface WireCell {
  value: string | number | boolean | null;
  raw: string;
}

export interface WireRow {
  id: string;
  key: string;
  cells: Record<string, WireCell>;
}

export interface WireTable {
  kind: 'table';
  label: string;
  schema: { columns: WireColumn[]; rowKeyColumnId: string };
  rows: WireRow[];
}

export interface WireChart {
  kind: 'chart';
  label: string;
  title: string | null;
  method: string;
  canExtract: boolean;
  data: unknown | null;
}

export interface WireRaw {
  kind: 'raw';
  data: unknown;
}

export type WireOutput = WireTable | WireChart | WireRaw;

export interface WireIteration {
  schemaVersion: 1;
  iterationKey: string;
  iterationLabel: string;
  searchTerm: string | null;
  status: 'success' | 'error' | 'skipped';
  error?: string;
  outputs: Record<string, WireOutput>;
  pageUrls?: string[];
}
```

---

### B2. New: `backend/src/WebScrape.Client/src/utils/dotPath.ts`

```typescript
export function dotPath(...segments: string[]): string {
  return segments.join('.');
}

export function toNunjucks(path: string): string {
  return `{{ runs.latest.${path} }}`;
}

export function buildNodePath(parents: string[], key: string | number): string {
  return [...parents, String(key)].join('.');
}
```

---

### B3. New: `backend/src/WebScrape.Client/src/components/result/TableGridView.tsx`

```tsx
import { useState } from 'react';
import type { WireTable } from '../../types/wire';
import { dotPath, toNunjucks } from '../../utils/dotPath';

const TYPE_GLYPH: Record<string, string> = {
  text: 'Aa', number: '123', percent: '%', currency: '£', date: '📅', boolean: '✓',
};

type Props = {
  table: WireTable;
  basePath: string;
  onCopy: (text: string) => void;
};

export default function TableGridView({ table, basePath, onCopy }: Props) {
  const [viewMode, setViewMode] = useState<'grid' | 'tree'>('grid');
  const { columns, rowKeyColumnId } = table.schema;

  if (viewMode === 'tree') {
    return (
      <div>
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-sm)' }}>
          <span className="text-xs text-light">Tree view</span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setViewMode('grid')}>
            View as grid
          </button>
        </div>
        <pre className="json-preview" style={{ maxHeight: 400 }}>
          {JSON.stringify(table, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <span className="text-xs text-light">{table.rows.length} row{table.rows.length === 1 ? '' : 's'}</span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setViewMode('tree')}>
          View as tree
        </button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table data-table--sticky">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.id}
                  draggable
                  onDragStart={(e) => {
                    const p = dotPath(basePath, 'rows', '*', 'cells', col.id);
                    e.dataTransfer.setData('text/plain', toNunjucks(p));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={`Drag to copy column reference\n${dotPath(basePath, 'rows', '*', 'cells', col.id)}`}
                  style={{ cursor: 'grab' }}
                >
                  <span>{col.displayName}</span>
                  <span className="meta-badge" style={{ marginLeft: 4, fontSize: 'var(--font-size-xs)' }}>
                    {TYPE_GLYPH[col.type] ?? col.type}
                    {col.inferred && <span style={{ opacity: 0.5, marginLeft: 2 }}>auto</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.id}>
                {columns.map((col) => {
                  const cell = row.cells[col.id];
                  const cellPath = dotPath(basePath, 'rows', row.id, 'cells', col.id);
                  return (
                    <td
                      key={col.id}
                      className="truncate"
                      style={{ maxWidth: 260 }}
                      title={cell?.raw ?? ''}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', toNunjucks(cellPath));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => onCopy(cellPath)}
                    >
                      {cell?.raw ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length === 0 && (
        <div className="empty-state" style={{ minHeight: 80 }}>
          <div className="empty-state-desc">This table came back empty.</div>
        </div>
      )}
    </div>
  );
}
```

---

### B4. New: `backend/src/WebScrape.Client/src/components/result/SelectedNodePanel.tsx`

```tsx
import { useState } from 'react';
import { toNunjucks } from '../../utils/dotPath';

type Props = {
  path: string | null;
  value: unknown;
};

export default function SelectedNodePanel({ path, value }: Props) {
  const [copied, setCopied] = useState<'path' | 'template' | null>(null);

  const copy = (text: string, which: 'path' | 'template') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    });
  };

  if (!path) {
    return (
      <div className="card" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <div className="empty-state" style={{ minHeight: 60 }}>
          <div className="empty-state-desc">Click any value to see its path and copy a reference.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 'var(--spacing-sm)' }}>
      <div className="flex flex-col gap-sm">
        <div>
          <div className="form-label" style={{ marginBottom: 2 }}>Path</div>
          <pre className="json-preview" style={{ maxHeight: 60, padding: 'var(--spacing-xs) var(--spacing-sm)' }}>
            {path}
          </pre>
        </div>
        <div>
          <div className="form-label" style={{ marginBottom: 2 }}>Value</div>
          <pre className="json-preview" style={{ maxHeight: 80, padding: 'var(--spacing-xs) var(--spacing-sm)' }}>
            {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')}
          </pre>
        </div>
        <div className="flex gap-sm">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => copy(path, 'path')}
          >
            {copied === 'path' ? 'Copied' : 'Copy path'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            title="Copies a Nunjucks template expression you can paste into the wider platform."
            onClick={() => copy(toNunjucks(path), 'template')}
          >
            {copied === 'template' ? 'Copied' : 'Copy as template'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

### B5. New: `backend/src/WebScrape.Client/src/components/result/OutputTab.tsx`

**Verify before using** `@textea/json-viewer` that string values render via React text
nodes (not `innerHTML`/`dangerouslySetInnerHTML`). If the library uses innerHTML for
values, replace it with a different library (e.g. `react-json-tree`) that does not.

```tsx
import { useState } from 'react';
import { JsonViewer } from '@textea/json-viewer';
import type { WireIteration, WireTable } from '../../types/wire';
import TableGridView from './TableGridView';
import SelectedNodePanel from './SelectedNodePanel';
import { toNunjucks } from '../../utils/dotPath';

type Props = {
  iter: WireIteration;
};

export default function OutputTab({ iter }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  const handleSelect = (path: string, value: unknown) => {
    setSelectedPath(path);
    setSelectedValue(value);
  };

  const handleCopy = (path: string) => {
    navigator.clipboard.writeText(toNunjucks(path)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (!iter.outputs || Object.keys(iter.outputs).length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No data yet</div>
        <div className="empty-state-desc">Run something — your data will appear here.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-sm">
      <SelectedNodePanel path={selectedPath} value={selectedValue} />

      <div className="card">
        <div className="flex items-center gap-sm" style={{ marginBottom: 'var(--spacing-sm)' }}>
          <input
            className="form-input"
            placeholder="Search keys or values..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1 }}
          />
          {copied && <span className="meta-badge">Copied</span>}
        </div>

        {Object.entries(iter.outputs).map(([outputKey, output]) => (
          <div key={outputKey} style={{ marginBottom: 'var(--spacing-md)' }}>
            <div className="run-log-title" style={{ marginBottom: 'var(--spacing-sm)' }}>
              {outputKey}
              <span className="meta-badge" style={{ marginLeft: 6 }}>{output.kind}</span>
            </div>

            {output.kind === 'table' ? (
              <TableGridView
                table={output as WireTable}
                basePath={`outputs.${outputKey}`}
                onCopy={handleCopy}
              />
            ) : (
              <JsonViewer
                value={output}
                theme={{
                  base00: 'var(--bg-white)',
                  base01: 'var(--bg-light)',
                  base02: 'var(--border)',
                  base03: 'var(--text-light)',
                  base04: 'var(--text-light)',
                  base05: 'var(--text-dark)',
                  base06: 'var(--text-dark)',
                  base07: 'var(--text-dark)',
                  base08: 'var(--danger)',
                  base09: 'var(--magenta-secondary)',
                  base0A: 'var(--warning)',
                  base0B: 'var(--success)',
                  base0C: 'var(--purple-light)',
                  base0D: 'var(--purple-primary)',
                  base0E: 'var(--magenta-secondary)',
                  base0F: 'var(--text-light)',
                }}
                displayDataTypes={false}
                quotesOnKeys={false}
                style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}
                onSelect={(path, value) => {
                  const pathStr = `outputs.${outputKey}.${Array.isArray(path) ? path.join('.') : path}`;
                  handleSelect(pathStr, value);
                }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### B6. Modify: `backend/src/WebScrape.Client/src/components/result/ResultViewer.tsx`

Replace the entire file:

```tsx
import { useState } from 'react';
import type { WireIteration } from '../../types/wire';
import RawJsonCard from './RawJsonCard';
import OutputTab from './OutputTab';

type Props = {
  iterations: WireIteration[];
};

const STATUS_DOT: Record<WireIteration['status'], string> = {
  success: 'success',
  error: 'error',
  skipped: 'pending',
};

export default function ResultViewer({ iterations }: Props) {
  if (!iterations || iterations.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No iterations yet</div>
        <div className="empty-state-desc">Result will appear when this run finishes.</div>
      </div>
    );
  }

  return (
    <div className="config-list">
      {iterations.map((iter) => (
        <IterationAccordion key={iter.iterationKey} iter={iter} />
      ))}
    </div>
  );
}

function IterationAccordion({ iter }: { iter: WireIteration }) {
  const [open, setOpen] = useState(iter.status !== 'success');
  const [tab, setTab] = useState<'output' | 'raw'>('output');

  return (
    <div className="card list-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-sm w-full"
        style={{ background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
      >
        <span className={`status-dot ${STATUS_DOT[iter.status]}`} />
        <span className="font-medium">{iter.iterationLabel || iter.iterationKey}</span>
        <span className="text-sm text-light">({iter.status})</span>
        {iter.error && (
          <span className="text-sm text-danger truncate" title={iter.error}>· {iter.error}</span>
        )}
        <span className="sidebar-spacer" />
        <span className="text-light">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 'var(--spacing-sm)' }}>
          <div className="tab-bar" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <button
              className={`tab${tab === 'output' ? ' tab--active' : ''}`}
              type="button"
              onClick={() => setTab('output')}
            >
              Output
            </button>
            <button
              className={`tab${tab === 'raw' ? ' tab--active' : ''}`}
              type="button"
              onClick={() => setTab('raw')}
            >
              Raw
            </button>
          </div>

          {tab === 'output' ? (
            <OutputTab iter={iter} />
          ) : (
            <RawJsonCard fieldName={null} value={iter} />
          )}
        </div>
      )}
    </div>
  );
}
```

**Update any caller of `ResultViewer`** that passes `dataMapping` — remove that prop.
Locate `RunDetail.tsx` and update the `<ResultViewer>` call to remove `dataMapping`.
Update the `result` cast to use `WireIteration[]`:

```tsx
// In RunDetail.tsx — find where result is unpacked and update:
const iterations = (run.result as { iterations: WireIteration[] } | null)?.iterations ?? [];
// Pass to ResultViewer:
<ResultViewer iterations={iterations} />
```

Import `WireIteration` from `'../types/wire'` in `RunDetail.tsx`.

---

### B7. Modify: `backend/src/WebScrape.Client/src/index.css`

Append to the end of the file:

```css
/* ===== Tab bar ===== */
.tab-bar {
  display: flex;
  gap: var(--spacing-xs);
}

.tab {
  padding: 5px var(--spacing-md);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-light);
  font-family: var(--font-family);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition), color var(--transition), border-color var(--transition);
}

.tab:hover { background: var(--bg-hover); color: var(--text-dark); }

.tab--active {
  background: var(--purple-bg);
  color: var(--purple-primary);
  border-color: var(--purple-primary);
}

/* ===== Drag handle ===== */
.drag-handle {
  cursor: grab;
  opacity: 0.35;
  transition: opacity var(--transition);
  user-select: none;
}
.drag-handle:hover { opacity: 0.8; }

/* ===== Sticky table header ===== */
.data-table--sticky thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-light);
}
```

---

### B8. Delete dead files

Delete these files entirely — they are replaced by the new OUTPUT tab:

- `backend/src/WebScrape.Client/src/components/result/IterationCards.tsx`
- `backend/src/WebScrape.Client/src/components/result/TableCard.tsx`
- `backend/src/WebScrape.Client/src/components/result/ChartCard.tsx`
- `backend/src/WebScrape.Client/src/components/result/TextCard.tsx`
- `backend/src/WebScrape.Client/src/components/result/PageBlocksCard.tsx`
- `backend/src/WebScrape.Client/src/utils/cardDiscrimination.ts`

After deleting, fix any TypeScript errors caused by removed imports (check
`ResultViewer.tsx` — the new version has no imports of these files).

---

### B9. Modify: `ConfigEditor.tsx` — output override UI

Read `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx` in full before implementing.

For each scrape element config in the editor's element list, add a collapsible
**Outputs** section below existing element settings. Use the existing form patterns
(`.form-group`, `.form-input`, `.form-select`, `.form-label`, `.form-hint`).

The section contains:

**Output name field** (per element):
```tsx
<div className="form-group">
  <label className="form-label">Output name</label>
  <input
    className="form-input"
    placeholder={`auto: ${slugPreview}`}
    value={el.outputKey ?? ''}
    onChange={(e) => updateElement(el.id, { outputKey: e.target.value || undefined })}
  />
  <span className="form-hint">Leave blank to auto-name from the table heading.</span>
</div>
```

Where `slugPreview` is computed client-side (import and call `slugify` from a small
inline utility in the React app — or just show the element `name` lowercased as an
approximation, since the real slugify runs in the extension).

**Column overrides table** (per element, if `el.detectedType === 'table'`):

Show a simple `<table>` with column `name` (text, from `el.tableFields` or a placeholder)
and a `<select>` per column for type override. Since the React editor does not know the
actual column headers at edit time (those come from scraping), this section shows a
freeform input for the `flatKey` and a type dropdown:

```tsx
<div className="form-group">
  <div className="form-label">Column type overrides</div>
  <span className="form-hint">Names and types are guessed automatically. Override here if needed.</span>
  {(el.columnOverrides ?? []).map((override, i) => (
    <div key={i} className="flex gap-sm" style={{ marginBottom: 'var(--spacing-xs)' }}>
      <input
        className="form-input"
        placeholder="Column key (e.g. England.Country.count)"
        value={override.flatKey}
        onChange={(e) => updateColumnOverride(el.id, i, { flatKey: e.target.value })}
        style={{ flex: 2 }}
      />
      <select
        className="form-select"
        value={override.type}
        onChange={(e) => updateColumnOverride(el.id, i, { type: e.target.value as ColumnType })}
        style={{ flex: 1 }}
      >
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="percent">Percent</option>
        <option value="currency">Currency</option>
        <option value="date">Date</option>
        <option value="boolean">Yes/No</option>
      </select>
      <button className="btn btn-ghost btn-sm" type="button"
        onClick={() => removeColumnOverride(el.id, i)}>×</button>
    </div>
  ))}
  <button className="btn btn-ghost btn-sm" type="button"
    onClick={() => addColumnOverride(el.id)}>+ Add override</button>
</div>
```

`updateColumnOverride`, `removeColumnOverride`, `addColumnOverride` are small helpers
that update the element's `columnOverrides` array via the existing config mutation pattern
(follow whatever pattern `ConfigEditor.tsx` uses for `excludedColumns` or similar list
fields). Import `ColumnType` from `'../types/wire'`.

---

## Part C — Backend: CSV Exporter Update

### C1. Modify: `backend/src/WebScrape.Services/Implementations/RunCsvExporter.cs`

The exporter currently reads `iter["data"]` (flat rows). Update to read the new shape.

The key change is in the method that iterates result JSON (locate it — it will be around
`ReadIterations` or similar). Replace the body that reads `data` with logic that reads
`outputs`:

For each iteration `iter`:
1. Read `iter["outputs"]` as a `JsonElement` object. If absent or null, skip.
2. For each property in `outputs`: if `output["kind"].GetString() == "table"`:
   a. `schema = output["schema"]`; `columns = schema["columns"]` array.
   b. `rows = output["rows"]` array.
   c. Write a section header row: `# {outputKey}` (one CSV cell, empty others).
   d. Write the column header row: `columns[i]["displayName"].GetString()` per column.
   e. For each row: for each column, write `row["cells"][colId]["raw"].GetString()` (use `raw`
      not `value` for CSV — preserves original formatting).
   f. Write a blank separator row between outputs.
3. If `output["kind"].GetString() == "raw"` or `"chart"`, skip (CSV does not support these).

The `ResolveColumns` / `UnionOfKeys` path is no longer needed for the new shape — the
schema contains the explicit column list. Remove the `dataMapping` lookup path as dead
code (it referred to the old `dataMapping` field which no longer exists in results).

Preserve the existing `IsWholepageResult` check — `kind: "raw"` outputs will fail this
automatically since they contain nested objects, not scalar rows.

---

## Manual Step: Hard-cut existing runs

Truncate the `RunItems` table before testing the new shape. In your Postgres shell:

```sql
TRUNCATE TABLE "RunItems" RESTART IDENTITY CASCADE;
```

If `RunBatches` or `Runs` tables reference `RunItems` via FK, truncate in dependency
order or use `CASCADE`.

---

## Verification

### Automated

```bash
# Extension unit tests
cd c:\Users\und3r\blueberry-v3
npm test

# TypeScript check (extension)
npm run type-check

# React client tests
cd backend/src/WebScrape.Client
npx vitest run

# Lint (both)
npm run lint
cd backend/src/WebScrape.Client && npx eslint src
```

### Manual test sequence

Run these in order in the staging app. Each one depends on the previous passing.

1. **Build + load**: Extension builds without TS errors. Load unpacked in Chrome.
   Expected: no console errors on extension load.

2. **Scrape a table**: Run a config that scrapes a single HTML table from an ONS page.
   Open the run result → **Output** tab.
   Expected: table renders as grid with column headers, type chips visible, correct row count.

3. **Dot-path copy**: Hover a cell in the grid.
   Expected: cell is draggable. Click cell → `SelectedNodePanel` shows path and value.
   Click **Copy path** → paste into Notepad → correct dot-path (no `{{ }}`).
   Click **Copy as template** → paste → `{{ runs.latest.outputs... }}`.

4. **RAW tab**: Click Raw tab.
   Expected: raw JSON with `schemaVersion: 1`, `outputs` object, no `data` array.
   Toggle back to Output — state preserved.

5. **Loop run**: Run a config with a loop (3+ search terms).
   Expected: 3 iteration accordions, each showing `iterationLabel` (not index).
   Open each — distinct `iterationKey` in RAW tab.

6. **Type override**: In ConfigEditor, add a column override for a numeric column → type: Text.
   Re-run. Open Output tab.
   Expected: that column's type chip shows no `auto`, value is a string in RAW.

7. **Output name override**: Set `outputKey` on a scrape element. Re-run.
   Expected: output appears under the override key in the Output tree.

8. **Security — XSS**: Scrape a page with `<img src=x onerror="alert(1)">` in a table cell.
   Expected: cell renders as literal text. No alert. Verify with browser DevTools.

9. **Security — Nunjucks injection**: Scrape a page with `}}{{foo}}` as a column header.
   Expected: column id is something safe like `foo`. Copy as template → valid `{{ runs.latest... }}` expression.

10. **Sticky header**: Scrape a table with 20+ rows. Open Output tab grid view.
    Expected: sticky header stays visible while scrolling rows.

---

## File change summary

| File | Action |
|------|--------|
| `src/utils/slugify.ts` | New |
| `src/content/shaping/types.ts` | New |
| `src/content/shaping/inferType.ts` | New |
| `src/content/shaping/shapeTable.ts` | New |
| `src/content/shaping/shapeChart.ts` | New |
| `src/content/shaping/index.ts` | New |
| `src/utils/slugify.test.ts` | New |
| `src/content/shaping/inferType.test.ts` | New |
| `src/content/shaping/shapeTable.test.ts` | New |
| `src/types/config.ts` | Modify — add `outputKey?`, `columnOverrides?`, `ColumnOverride` |
| `src/types/extraction.ts` | Modify — replace `IterationResult` with `WireIteration` re-export |
| `src/types/signalr.ts` | Modify — `TaskResult.iterations` type |
| `src/content/extraction/tableExtractor.ts` | Modify — add `extractTableHeadersWithPaths`, refactor `extractTableHeaders` |
| `src/content/scraping/scrapingEngine.ts` | Modify — `scrapeElementToWire`, `executeScrape`, `executeFlow` |
| `specs/WIRE-PROTOCOL.md` | New |
| `backend/src/WebScrape.Client/src/types/wire.ts` | New |
| `backend/src/WebScrape.Client/src/utils/dotPath.ts` | New |
| `backend/src/WebScrape.Client/src/components/result/OutputTab.tsx` | New |
| `backend/src/WebScrape.Client/src/components/result/TableGridView.tsx` | New |
| `backend/src/WebScrape.Client/src/components/result/SelectedNodePanel.tsx` | New |
| `backend/src/WebScrape.Client/src/components/result/ResultViewer.tsx` | Modify — replace with tabs |
| `backend/src/WebScrape.Client/src/index.css` | Modify — append 3 new rule sets |
| `backend/src/WebScrape.Client/package.json` | Modify — add @textea/json-viewer@3 (exact version) |
| `backend/src/WebScrape.Client/src/components/result/IterationCards.tsx` | Delete |
| `backend/src/WebScrape.Client/src/components/result/TableCard.tsx` | Delete |
| `backend/src/WebScrape.Client/src/components/result/ChartCard.tsx` | Delete |
| `backend/src/WebScrape.Client/src/components/result/TextCard.tsx` | Delete |
| `backend/src/WebScrape.Client/src/components/result/PageBlocksCard.tsx` | Delete |
| `backend/src/WebScrape.Client/src/utils/cardDiscrimination.ts` | Delete |
| `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx` | Modify — output override UI (read file first) |
| `backend/src/WebScrape.Services/Implementations/RunCsvExporter.cs` | Modify — read new shape |
