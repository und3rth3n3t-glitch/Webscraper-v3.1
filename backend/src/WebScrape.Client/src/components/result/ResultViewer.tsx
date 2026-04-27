import { useState } from 'react';
import type { WireIteration } from '../../types/wire';
import RawJsonCard from './RawJsonCard';
import OutputTab from './OutputTab';

type Props = {
  iterations: WireIteration[];
};

const STATUS_DOT: Record<WireIteration['status'], string> = {
  success: 'success',
  error: 'error',
  skipped: 'pending',
};

export default function ResultViewer({ iterations }: Props) {
  if (!iterations || iterations.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No iterations yet</div>
        <div className="empty-state-desc">Result will appear when this run finishes.</div>
      </div>
    );
  }

  return (
    <div className="config-list">
      {iterations.map((iter) => (
        <IterationAccordion key={iter.iterationKey} iter={iter} />
      ))}
    </div>
  );
}

function IterationAccordion({ iter }: { iter: WireIteration }) {
  const [open, setOpen] = useState(iter.status !== 'success');
  const [tab, setTab] = useState<'output' | 'raw'>('output');

  return (
    <div className="card list-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-sm w-full"
        style={{ background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
      >
        <span className={`status-dot ${STATUS_DOT[iter.status]}`} />
        <span className="font-medium">{iter.iterationLabel || iter.iterationKey}</span>
        <span className="text-sm text-light">({iter.status})</span>
        {iter.error && (
          <span className="text-sm text-danger truncate" title={iter.error}>· {iter.error}</span>
        )}
        <span className="sidebar-spacer" />
        <span className="text-light">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 'var(--spacing-sm)' }}>
          <div className="tab-bar" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <button
              className={`tab${tab === 'output' ? ' tab--active' : ''}`}
              type="button"
              onClick={() => setTab('output')}
            >
              Output
            </button>
            <button
              className={`tab${tab === 'raw' ? ' tab--active' : ''}`}
              type="button"
              onClick={() => setTab('raw')}
            >
              Raw
            </button>
          </div>

          {tab === 'output' ? (
            <OutputTab iter={iter} />
          ) : (
            <RawJsonCard fieldName={null} value={iter} />
          )}
        </div>
      )}
    </div>
  );
}
