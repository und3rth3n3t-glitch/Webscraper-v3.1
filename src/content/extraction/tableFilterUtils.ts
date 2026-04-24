export function filterByExcludedIndices(
  rows: Record<string, unknown>[],
  excludedColumnIndices: number[],
): Record<string, unknown>[] {
  if (!excludedColumnIndices.length || !rows.length) return rows;
  const allKeys = Object.keys(rows[0]);
  const includedKeys = allKeys.filter((_, i) => !excludedColumnIndices.includes(i));
  if (includedKeys.length === allKeys.length) return rows;
  return rows.map((row) => {
    const filtered: Record<string, unknown> = {};
    includedKeys.forEach((k) => { filtered[k] = row[k]; });
    return filtered;
  });
}
