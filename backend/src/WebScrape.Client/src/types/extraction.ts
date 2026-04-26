// Frozen contract — mirrored from src/content/extraction/pageBlockExtractor.ts
// and src/content/extraction/chartExtractor.ts.
// Update only when extension's wire shape changes; cardDiscrimination tests catch drift.

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; listType: 'ul' | 'ol'; items: string[] }
  | { type: 'link'; text: string; href: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language: string | null }
  | { type: 'table'; ref: string; label: string }
  | { type: 'chart'; ref: string; label: string };

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

export interface IterationResult {
  searchTerm: string | null;
  data: Record<string, unknown>[];
  status: 'success' | 'error' | 'skipped';
  error?: string;
  pageUrls?: string[];
}

export interface ChartResult {
  data: unknown;
  title: string | null;
  method: string | null;
  canExtract: boolean;
  message?: string;
  _extractionNote?: string;
}

// dataMapping is part of the scrape config, not extraction output — but the result viewer reads it.
export interface MappingColumn {
  id: string;
  originalName: string;
  displayName: string;
  enabled: boolean;
  position: number;
  sourceType: 'scrapeElement' | 'apiCall' | 'computed';
  apiCallId?: string;
}

export interface DataMapping {
  version: 1;
  columns: MappingColumn[];
}
