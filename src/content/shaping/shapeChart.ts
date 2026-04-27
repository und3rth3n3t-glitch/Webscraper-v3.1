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
