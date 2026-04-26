import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartResult } from '../../types/extraction';
import { chartPalette, colourFor } from '../../utils/chartPalette';
import RawJsonCard from './RawJsonCard';

export default function ChartCard({ fieldName, value }: { fieldName: string | null; value: ChartResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const headerLabel = fieldName ? `Chart — ${fieldName}` : 'Chart';
  const titleLine = value.title ? <div className="text-sm text-light">{value.title}</div> : null;

  if (!value.canExtract) {
    return (
      <section className="card">
        <div className="run-log-title">{headerLabel}</div>
        {titleLine}
        <div className="run-banner run-banner-warning" style={{ marginTop: 'var(--spacing-sm)' }}>
          We could see this chart but couldn't read its data.
        </div>
        {value._extractionNote && <div className="text-sm text-light">{value._extractionNote}</div>}
        <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? 'Hide raw' : 'View raw'}
          </button>
        </div>
        {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
      </section>
    );
  }

  const series = pickSeries(value.data);
  if (!series) {
    return (
      <section className="card">
        <div className="run-log-title">{headerLabel}</div>
        {titleLine}
        <div className="text-sm text-light">Data extracted but couldn't be plotted.</div>
        <RawJsonCard fieldName={fieldName} value={value.data} />
      </section>
    );
  }

  const numericX = series.rows.length > 0 && typeof series.rows[0][series.xKey] === 'number';

  return (
    <section className="card">
      <div className="run-log-title">{headerLabel}</div>
      {titleLine}
      <div style={{ width: '100%', height: 280, marginTop: 'var(--spacing-sm)' }}>
        <ResponsiveContainer width="100%" height="100%">
          {numericX ? (
            <LineChart data={series.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartPalette.border} />
              <XAxis dataKey={series.xKey} stroke={chartPalette.textLight} />
              <YAxis stroke={chartPalette.textLight} />
              <Tooltip />
              <Legend />
              {series.yKeys.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k} stroke={colourFor(i)} dot={false} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={series.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartPalette.border} />
              <XAxis dataKey={series.xKey} stroke={chartPalette.textLight} />
              <YAxis stroke={chartPalette.textLight} />
              <Tooltip />
              <Legend />
              {series.yKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={colourFor(i)} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      <div className="flex gap-sm">
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
    </section>
  );
}

function pickSeries(data: unknown): { rows: Record<string, unknown>[]; xKey: string; yKeys: string[] } | null {
  if (data === null || typeof data !== 'object') return null;

  if (Array.isArray(data)) return rowsFromArray(data);

  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.rows)) return rowsFromArray(obj.rows as unknown[]);

  if (Array.isArray(obj.categories) && Array.isArray(obj.series)) {
    const cats = obj.categories as unknown[];
    const seriesArr = obj.series as Array<{ name?: unknown; data?: unknown }>;
    const yKeys: string[] = [];
    const rows: Record<string, unknown>[] = cats.map((c, i) => {
      const row: Record<string, unknown> = { x: typeof c === 'string' || typeof c === 'number' ? c : String(c) };
      seriesArr.forEach((s, sIdx) => {
        const name = typeof s.name === 'string' && s.name ? s.name : `series${sIdx}`;
        if (i === 0) yKeys.push(name);
        if (Array.isArray(s.data) && s.data[i] != null && typeof s.data[i] !== 'object') {
          row[name] = s.data[i];
        }
      });
      return row;
    });
    return rows.length > 0 ? { rows, xKey: 'x', yKeys } : null;
  }

  return null;
}

function rowsFromArray(arr: unknown[]): { rows: Record<string, unknown>[]; xKey: string; yKeys: string[] } | null {
  const rows = arr.filter((r): r is Record<string, unknown> => r != null && typeof r === 'object' && !Array.isArray(r));
  if (rows.length === 0) return null;
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  if (keys.length < 2) return null;
  const xKey = keys[0];
  const yKeys = keys.slice(1).filter((k) => rows.some((r) => typeof r[k] === 'number'));
  if (yKeys.length === 0) return null;
  return { rows, xKey, yKeys };
}
