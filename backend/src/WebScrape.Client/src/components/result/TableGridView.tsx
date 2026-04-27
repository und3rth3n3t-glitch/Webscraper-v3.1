import { useState } from 'react';
import type { WireTable } from '../../types/wire';
import { dotPath, toNunjucks } from '../../utils/dotPath';

const TYPE_GLYPH: Record<string, string> = {
  text: 'Aa', number: '123', percent: '%', currency: '£', date: '📅', boolean: '✓',
};

type Props = {
  table: WireTable;
  basePath: string;
  onCopy: (text: string) => void;
};

export default function TableGridView({ table, basePath, onCopy }: Props) {
  const [viewMode, setViewMode] = useState<'grid' | 'tree'>('grid');
  const { columns } = table.schema;

  if (viewMode === 'tree') {
    return (
      <div>
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-sm)' }}>
          <span className="text-xs text-light">Tree view</span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setViewMode('grid')}>
            View as grid
          </button>
        </div>
        <pre className="json-preview" style={{ maxHeight: 400 }}>
          {JSON.stringify(table, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <span className="text-xs text-light">{table.rows.length} row{table.rows.length === 1 ? '' : 's'}</span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setViewMode('tree')}>
          View as tree
        </button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table data-table--sticky">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.id}
                  draggable
                  onDragStart={(e) => {
                    const p = dotPath(basePath, 'rows', '*', 'cells', col.id);
                    e.dataTransfer.setData('text/plain', toNunjucks(p));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={`Drag to copy column reference\n${dotPath(basePath, 'rows', '*', 'cells', col.id)}`}
                  style={{ cursor: 'grab' }}
                >
                  <span>{col.displayName}</span>
                  <span className="meta-badge" style={{ marginLeft: 4, fontSize: 'var(--font-size-xs)' }}>
                    {TYPE_GLYPH[col.type] ?? col.type}
                    {col.inferred && <span style={{ opacity: 0.5, marginLeft: 2 }}>auto</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.id}>
                {columns.map((col) => {
                  const cell = row.cells[col.id];
                  const cellPath = dotPath(basePath, 'rows', row.id, 'cells', col.id);
                  return (
                    <td
                      key={col.id}
                      className="truncate"
                      style={{ maxWidth: 260 }}
                      title={cell?.raw ?? ''}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', toNunjucks(cellPath));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => onCopy(cellPath)}
                    >
                      {cell?.raw ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length === 0 && (
        <div className="empty-state" style={{ minHeight: 80 }}>
          <div className="empty-state-desc">This table came back empty.</div>
        </div>
      )}
    </div>
  );
}
