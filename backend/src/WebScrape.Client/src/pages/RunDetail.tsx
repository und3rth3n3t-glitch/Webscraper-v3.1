import { useParams, Link } from 'react-router-dom';
import { useRun } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunStatus } from '../api/types';
import { statusLabel } from '../utils/runStatus';

const BANNER_CLASS: Partial<Record<RunStatus, string>> = {
  [RunItemStatus.Completed]: 'run-banner-success',
  [RunItemStatus.Failed]:    'run-banner-error',
  [RunItemStatus.Cancelled]: 'run-banner-error',
  [RunItemStatus.Paused]:    'run-banner-warning',
};

export default function RunDetail() {
  const { id } = useParams();
  const { data: run, isPending, error } = useRun(id);

  if (isPending) {
    return (
      <div className="view">
        <div className="loading-state">Loading…</div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="view">
        <div className="danger-banner">Couldn't load this run. It may not exist.</div>
      </div>
    );
  }

  const bannerClass = BANNER_CLASS[run.status];
  const pct = run.progressPercent ?? 0;

  return (
    <div className="view">
      <div className="view-header-row">
        <Link to="/tasks" className="back-btn" aria-label="Back to tasks">
          ←
        </Link>
        <h2 className="view-title">Run</h2>
      </div>

      {bannerClass ? (
        <div className={`run-banner ${bannerClass}`}>
          {statusLabel(run.status)}
          {run.errorMessage ? ` — ${run.errorMessage}` : ''}
        </div>
      ) : (
        <div className="view-subtitle">{statusLabel(run.status)}</div>
      )}

      <div className="run-progress-bar-wrap">
        <div className="run-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="run-progress-label">
        {pct}%
        {run.currentTerm ? ` · ${run.currentTerm}` : ''}
        {run.currentStep ? ` · ${run.currentStep}` : ''}
      </div>

      {run.result != null && (
        <div className="run-log-section">
          <div className="run-log-title">Result</div>
          <pre className="json-preview" style={{ maxHeight: 'none' }}>
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
