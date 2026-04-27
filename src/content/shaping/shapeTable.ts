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
