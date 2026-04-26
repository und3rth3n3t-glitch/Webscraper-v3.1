import { useState } from 'react';
import type { DataMapping, IterationResult } from '../../types/extraction';
import { discriminateIteration } from '../../utils/cardDiscrimination';
import IterationCards from './IterationCards';

type Props = {
  iterations: IterationResult[];
  dataMapping?: DataMapping;
};

const STATUS_DOT: Record<IterationResult['status'], string> = {
  success: 'success',
  error: 'error',
  skipped: 'pending',
};

export default function ResultViewer({ iterations, dataMapping }: Props) {
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
      {iterations.map((iter, i) => (
        <IterationAccordion key={i} index={i} iter={iter} mapping={dataMapping} />
      ))}
    </div>
  );
}

function IterationAccordion({ index, iter, mapping }: { index: number; iter: IterationResult; mapping?: DataMapping }) {
  const [open, setOpen] = useState(iter.status !== 'success');
  const card = discriminateIteration(iter, mapping);
  return (
    <div className="card list-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-sm w-full"
        style={{ background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
      >
        <span className={`status-dot ${STATUS_DOT[iter.status]}`} />
        <span className="font-medium">
          {index + 1}. {iter.searchTerm ?? '—'}
        </span>
        <span className="text-sm text-light">({iter.status})</span>
        {iter.error && <span className="text-sm text-danger truncate" title={iter.error}>· {iter.error}</span>}
        <span className="sidebar-spacer" />
        <span className="text-light">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-sm" style={{ marginTop: 'var(--spacing-sm)' }}>
          <IterationCards card={card} />
        </div>
      )}
    </div>
  );
}
