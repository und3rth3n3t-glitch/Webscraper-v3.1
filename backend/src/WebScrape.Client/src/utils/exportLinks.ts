export function runExportUrl(runId: string, format: 'json' | 'csv'): string {
  return `/api/runs/${encodeURIComponent(runId)}/export?format=${format}`;
}

export function batchExportUrl(batchId: string, format: 'json' | 'csv'): string {
  return `/api/run-batches/${encodeURIComponent(batchId)}/export?format=${format}`;
}
