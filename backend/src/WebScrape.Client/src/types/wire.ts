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
