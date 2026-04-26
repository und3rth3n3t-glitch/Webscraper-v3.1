import { useState } from 'react';
import type { Block, ChartEntry, PageContent, TableEntry } from '../../types/extraction';
import { safeHref } from '../../utils/safeHref';
import TableCard from './TableCard';
import ChartCard from './ChartCard';
import RawJsonCard from './RawJsonCard';

export default function PageBlocksCard({ fieldName, value }: { fieldName: string | null; value: PageContent }) {
  const [showRaw, setShowRaw] = useState(false);
  const tablesById = new Map<string, TableEntry>(value.tables.map((t) => [t.id, t]));
  const chartsById = new Map<string, ChartEntry>(value.charts.map((c) => [c.id, c]));

  return (
    <section className="card">
      <div className="run-log-title">
        {fieldName ? `Page content — ${fieldName}` : 'Page content'}
      </div>
      {value.pageTitle && <h3 className="font-semibold" style={{ fontSize: 'var(--font-size-md)' }}>{value.pageTitle}</h3>}
      <div className="flex flex-col gap-sm">
        {value.blocks.map((b, i) => <BlockRender key={i} block={b} tables={tablesById} charts={chartsById} />)}
      </div>
      <div className="flex gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide raw' : 'View raw'}
        </button>
      </div>
      {showRaw && <RawJsonCard fieldName={fieldName} value={value} />}
    </section>
  );
}

function BlockRender({ block, tables, charts }: { block: Block; tables: Map<string, TableEntry>; charts: Map<string, ChartEntry> }) {
  switch (block.type) {
    case 'heading': {
      const level = block.level;
      const Tag = (`h${Math.min(Math.max(level + 1, 2), 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      return <Tag className="font-semibold">{block.text}</Tag>;
    }
    case 'paragraph': return <p className="text-sm">{block.text}</p>;
    case 'list': {
      const Tag = block.listType === 'ol' ? 'ol' : 'ul';
      return <Tag style={{ paddingLeft: 'var(--spacing-lg)' }}>{block.items.map((it, i) => <li key={i} className="text-sm">{it}</li>)}</Tag>;
    }
    case 'link': {
      const href = safeHref(block.href);
      if (!href) return <span className="text-sm">{block.text || block.href}</span>;
      return <a className="text-sm" href={href} target="_blank" rel="noopener noreferrer">{block.text || href}</a>;
    }
    case 'quote': return <blockquote className="text-sm text-light" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 'var(--spacing-sm)' }}>{block.text}</blockquote>;
    case 'code': return <pre className="json-preview">{block.text}</pre>;
    case 'table': {
      const t = tables.get(block.ref);
      if (!t) return <div className="text-sm text-light">Missing table {block.ref}</div>;
      return <TableCard rows={t.rows} fieldName={t.label} />;
    }
    case 'chart': {
      const c = charts.get(block.ref);
      if (!c) return <div className="text-sm text-light">Missing chart {block.ref}</div>;
      return <ChartCard fieldName={c.label} value={{
        data: c.data, title: c.title, method: c.method, canExtract: c.canExtract, _extractionNote: c._extractionNote,
      }} />;
    }
  }
}
