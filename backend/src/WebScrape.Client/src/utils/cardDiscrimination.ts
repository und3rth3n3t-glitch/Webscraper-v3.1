import type { DataMapping, IterationResult, PageContent, ChartResult } from '../types/extraction';

export type CardKind =
  | { kind: 'empty' }
  | { kind: 'table-iteration'; rows: Record<string, unknown>[]; mapping: DataMapping }
  | { kind: 'mixed'; perRow: FieldCard[][] };

export type FieldCard =
  | { kind: 'chart'; fieldName: string | null; value: ChartResult }
  | { kind: 'table-field'; fieldName: string; rows: Record<string, unknown>[] }
  | { kind: 'pageblocks'; fieldName: string | null; value: PageContent }
  | { kind: 'text'; fields: Record<string, string | number | boolean | null> }
  | { kind: 'raw'; fieldName: string | null; value: unknown };

export function discriminateIteration(iter: IterationResult, mapping?: DataMapping): CardKind {
  const rows = Array.isArray(iter.data) ? iter.data : [];
  if (rows.length === 0) return { kind: 'empty' };

  // Fast path: every row is all-scalars, every key is a known mapping originalName.
  if (mapping?.columns?.length) {
    const allowed = new Set(mapping.columns.map((c) => c.originalName));
    const allTabular = rows.every(
      (r) =>
        r != null &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Object.entries(r as Record<string, unknown>).every(
          ([k, v]) =>
            allowed.has(k) &&
            (v === null || ['string', 'number', 'boolean'].includes(typeof v)),
        ),
    );
    if (allTabular) return { kind: 'table-iteration', rows, mapping };
  }

  const perRow: FieldCard[][] = rows.map((row) => discriminateRow(row));
  return { kind: 'mixed', perRow };
}

function discriminateRow(row: unknown): FieldCard[] {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return [{ kind: 'raw', fieldName: null, value: row }];
  }
  // Whole-row PageContent (wholepage-flattened): the row itself IS the PageContent.
  if (isPageContent(row)) {
    return [{ kind: 'pageblocks', fieldName: null, value: row as unknown as PageContent }];
  }
  const cards: FieldCard[] = [];
  const scalars: Record<string, string | number | boolean | null> = {};
  for (const [fieldName, value] of Object.entries(row as Record<string, unknown>)) {
    if (isChart(value)) {
      cards.push({ kind: 'chart', fieldName, value: value as ChartResult });
    } else if (isPageContent(value)) {
      cards.push({ kind: 'pageblocks', fieldName, value: value as PageContent });
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => v != null && typeof v === 'object' && !Array.isArray(v))
    ) {
      cards.push({ kind: 'table-field', fieldName, rows: value as Record<string, unknown>[] });
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      scalars[fieldName] = value as string | number | boolean | null;
    } else {
      cards.push({ kind: 'raw', fieldName, value });
    }
  }
  if (Object.keys(scalars).length > 0) cards.push({ kind: 'text', fields: scalars });
  return cards;
}

function isChart(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.canExtract === 'boolean' && 'method' in o) return true;
  if (o._canExtract === false || '_warning' in o) return true;
  return false;
}

function isPageContent(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.blocks) && Array.isArray(o.tables) && Array.isArray(o.charts);
}
