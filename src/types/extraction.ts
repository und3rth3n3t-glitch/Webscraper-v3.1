export interface ScrapingResult {
  configId: string;
  configName: string;
  scrapedAt: string;
  sourceUrl: string;
  iterations: IterationResult[];
  totalTimeMs: number;
  aborted?: boolean;
}

export interface IterationResult {
  searchTerm: string | null;
  data: Record<string, unknown>[];
  status: 'success' | 'error' | 'skipped';
  error?: string;
  pageUrls?: string[];
}

export interface ApiCall {
  id: string;
  url: string;
  method: string;
  statusCode: number;
  responseBodyJson?: unknown;
  capturedAt: string;
}
