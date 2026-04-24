import type { DataMapping, MappingColumn } from '../../types/config';

export function detectColumns(data: Record<string, unknown>[]): MappingColumn[] {
  if (data.length === 0) return [];

  const nameCounts = new Map<string, number>();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
  }

  const names = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  const seen = new Map<string, number>();
  return names.map((name, i) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const displayName = count > 1 ? `${name}_${count}` : name;
    return {
      id: crypto.randomUUID(),
      originalName: name,
      displayName,
      enabled: true,
      position: i,
      sourceType: 'scrapeElement',
    } satisfies MappingColumn;
  });
}

export function applyMapping(
  data: Record<string, unknown>[],
  mapping: DataMapping,
): Record<string, unknown>[] {
  const active = [...mapping.columns]
    .filter((c) => c.enabled)
    .sort((a, b) => a.position - b.position);

  return data.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of active) {
      if (col.originalName in row) {
        out[col.displayName] = row[col.originalName];
      }
    }
    return out;
  });
}

export function buildDefaultMapping(data: Record<string, unknown>[]): DataMapping {
  return { version: 1, columns: detectColumns(data) };
}
