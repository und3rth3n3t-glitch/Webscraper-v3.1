import { useState } from 'react';
import brand from '@/themes';
import { Play, Plus, X } from 'lucide-react';
import BackButton from './BackButton';
import { useRunStore } from '../stores/runStore';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { generateId } from '../utils/uuid';

type Row = { _id: string; [key: string]: string };

export default function SearchVarInput() {
  const { showToast } = useUiStore();
  const { inputSlots } = useConfigStore();
  const [termsText, setTermsText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [starting, setStarting] = useState(false);

  const isMultiColumn = inputSlots.length > 0;
  const terms = termsText.split('\n').map(t => t.trim()).filter(Boolean);

  const addRow = () => {
    const empty: Row = { _id: generateId() };
    for (const slot of inputSlots) empty[slot.key] = '';
    setRows(r => [...r, empty]);
  };

  const removeRow = (id: string) => setRows(r => r.filter(row => row._id !== id));

  const updateCell = (id: string, key: string, value: string) => {
    setRows(r => r.map(row => row._id === id ? { ...row, [key]: value } : row));
  };

  const handleStart = async () => {
    if (isMultiColumn) {
      if (rows.length === 0) {
        showToast('Add at least one row.', 'error');
        return;
      }
      setStarting(true);
      try {
        const inputRows = rows.map(({ _id, ...rest }) => rest as Record<string, string>);
        await useRunStore.getState().executeRun([], inputRows);
      } catch {
        setStarting(false);
      }
    } else {
      if (terms.length === 0) {
        showToast('Enter at least one search term.', 'error');
        return;
      }
      setStarting(true);
      try {
        await useRunStore.getState().executeRun(terms);
      } catch {
        setStarting(false);
      }
    }
  };

  if (isMultiColumn) {
    return (
      <div className="view">
        <div className="view-header">
          <BackButton />
          <h2 className="view-title">Patient Data</h2>
        </div>

        <p className="view-subtitle">
          Enter one row per patient. Each column is typed into a different field.
        </p>

        <div className="form-group" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {inputSlots.map(slot => (
                  <th key={slot.id} style={{ textAlign: 'left', padding: '4px 6px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', fontWeight: 600, borderBottom: '1px solid var(--border-color)' }}>
                    {slot.label}
                  </th>
                ))}
                <th style={{ width: 32, borderBottom: '1px solid var(--border-color)' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._id}>
                  {inputSlots.map(slot => (
                    <td key={slot.id} style={{ padding: '3px 4px' }}>
                      <input
                        className="form-input"
                        style={{ fontSize: 'var(--font-size-sm)' }}
                        value={row[slot.key] ?? ''}
                        onChange={e => updateCell(row._id, slot.key, e.target.value)}
                        placeholder={slot.label}
                      />
                    </td>
                  ))}
                  <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeRow(row._id)} title="Remove row">
                      <X size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <p className="form-hint" style={{ marginTop: 'var(--spacing-sm)' }}>No rows yet. Add one below.</p>
          )}

          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--spacing-sm)' }}
            onClick={addRow}
          >
            <Plus size={12} /> Add row
          </button>

          {rows.length > 0 && (
            <p className="form-hint">{rows.length} row{rows.length !== 1 ? 's' : ''} entered</p>
          )}
        </div>

        <div className="form-actions">
          <button
            className="btn btn-primary btn-full btn-lg"
            onClick={handleStart}
            disabled={starting || rows.length === 0}
          >
            {starting
              ? 'Starting...'
              : <><Play size={12} /> Run Scraper ({rows.length} row{rows.length !== 1 ? 's' : ''})</>
            }
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Search Terms</h2>
      </div>

      <p className="view-subtitle">
        Enter one search term per line. The scraper will run once for each term.
      </p>

      <div className="form-group">
        <label className="form-label">Search terms</label>
        <textarea
          className="form-textarea"
          value={termsText}
          onChange={e => setTermsText(e.target.value)}
          placeholder={brand.searchVarPlaceholder ?? ''}
          rows={8}
          autoFocus
        />
        {terms.length > 0 && (
          <p className="form-hint">{terms.length} term{terms.length !== 1 ? 's' : ''} entered</p>
        )}
      </div>

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full btn-lg"
          onClick={handleStart}
          disabled={starting || terms.length === 0}
        >
          {starting
            ? 'Starting...'
            : <><Play size={12} /> Run Scraper ({terms.length} term{terms.length !== 1 ? 's' : ''})</>
          }
        </button>
      </div>
    </div>
  );
}
