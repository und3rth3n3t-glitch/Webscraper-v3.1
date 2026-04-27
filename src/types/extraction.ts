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
