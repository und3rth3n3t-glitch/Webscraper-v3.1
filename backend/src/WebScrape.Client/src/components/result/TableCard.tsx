import { useState } from 'react';
import type { DataMapping } from '../../types/extraction';
import RawJsonCard from './RawJsonCard';

type Props = {
  rows: Record<string, unknown>[];
  mapping?: DataMapping;
  fieldName?: string;
};

export default function TableCard({ rows, mapping, fieldName }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const columns = mapping?.columns?.length
    ? mapping.columns.filter((c) => c.enabled).sort((a, b) => a.position - b.position)
    : unionKeys(rows).map((k, i) => ({ id: k, originalName: k, displayName: k, enabled: true, position: i, sourceType: 'scrapeElement' as const }));

  return (
    <section className="card">
      <div className="run-log-title">
        {fieldName ? `Table — ${fieldName}` : 'Table'} ({rows.length} row{rows.length === 1 ? '' : 's'})
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>{columns.map((c) => <th key={c.id}>{c.displayName || c.originalName}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.id} className="truncate" style={{ maxWidth: 320 }} title={cellTitle(r[c.originalName])}>
                    {renderCell(r[c.originalName])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName ?? null} value={rows} />}
    </section>
  );
}

function unionKeys(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!set.has(k)) { set.add(k); seen.push(k); }
  return seen;
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function cellTitle(v: unknown): string {
  return renderCell(v);
}
