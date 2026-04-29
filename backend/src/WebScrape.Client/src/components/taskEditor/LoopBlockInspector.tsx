import type React from 'react';
import { Plus, X } from 'lucide-react';
import type { LoopEditorBlock, BlocksAction } from '../../utils/taskTree';

type Props = {
  block: LoopEditorBlock;
  dispatch: React.Dispatch<BlocksAction>;
};

export default function LoopBlockInspector({ block, dispatch }: Props) {
  const isMultiColumn = block.columns.length > 0;

  const addColumn = () => {
    const label = `Column ${block.columns.length + 1}`;
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: [...block.columns, label] } });
  };

  const removeColumn = (idx: number) => {
    const cols = block.columns.filter((_, i) => i !== idx);
    const rows = block.rows.map(r => r.filter((_, i) => i !== idx));
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: cols, rows } });
  };

  const renameColumn = (idx: number, name: string) => {
    const cols = block.columns.map((c, i) => i === idx ? name : c);
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: cols } });
  };

  const addRow = () => {
    const newRow = block.columns.map(() => '');
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows: [...block.rows, newRow] } });
  };

  const removeRow = (rowIdx: number) => {
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows: block.rows.filter((_, i) => i !== rowIdx) } });
  };

  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    const rows = block.rows.map((r, ri) =>
      ri === rowIdx ? r.map((c, ci) => ci === colIdx ? value : c) : r,
    );
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { rows } });
  };

  const revertToSingleColumn = () => {
    dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { columns: [], rows: [] } });
  };

  return (
    <div className="card">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Loop
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="loop-name">Name</label>
        <input
          id="loop-name"
          className="form-input"
          value={block.name}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { name: e.target.value } })
          }
          placeholder="e.g. loop1"
        />
        <div className="form-hint">Used to reference this loop's current value in bindings.</div>
      </div>

      {!isMultiColumn ? (
        <div className="form-group">
          <label className="form-label" htmlFor="loop-values">Values</label>
          <textarea
            id="loop-values"
            className="form-textarea"
            rows={8}
            value={block.values.join('\n')}
            onChange={(e) => {
              dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: e.target.value.split('\n') } });
            }}
            onBlur={(e) => {
              const vals = e.target.value.split('\n').map((v) => v.trimEnd());
              dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: vals } });
            }}
            placeholder="One value per line. Each value runs the loop once."
          />
          <div className="form-hint">One value per line. Each value runs the loop once.</div>
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addColumn}
          >
            <Plus size={12} /> Add column
          </button>
        </div>
      ) : (
        <div className="form-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
            <label className="form-label" style={{ margin: 0 }}>Columns &amp; rows</label>
            <button className="btn btn-ghost btn-sm" onClick={revertToSingleColumn} title="Remove all columns">
              <X size={12} /> Remove columns
            </button>
          </div>
          <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>One column per field. Each row is one patient.</div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
              <thead>
                <tr>
                  {block.columns.map((col, ci) => (
                    <th key={ci} style={{ padding: '4px' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          className="form-input"
                          style={{ fontSize: 'var(--font-size-sm)', minWidth: 80 }}
                          value={col}
                          onChange={e => renameColumn(ci, e.target.value)}
                          placeholder={`Column ${ci + 1}`}
                        />
                        <button className="btn btn-ghost btn-sm" onClick={() => removeColumn(ci)} title="Remove column">
                          <X size={10} />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th style={{ width: 32 }}>
                    <button className="btn btn-ghost btn-sm" onClick={addColumn} title="Add column">
                      <Plus size={10} />
                    </button>
                  </th>
                  <th style={{ width: 32 }} />
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri}>
                    {block.columns.map((_, ci) => (
                      <td key={ci} style={{ padding: '3px 4px' }}>
                        <input
                          className="form-input"
                          style={{ fontSize: 'var(--font-size-sm)' }}
                          value={row[ci] ?? ''}
                          onChange={e => updateCell(ri, ci, e.target.value)}
                          placeholder={block.columns[ci] ?? ''}
                        />
                      </td>
                    ))}
                    <td />
                    <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeRow(ri)} title="Remove row">
                        <X size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addRow}
          >
            <Plus size={12} /> Add row
          </button>
        </div>
      )}
    </div>
  );
}
