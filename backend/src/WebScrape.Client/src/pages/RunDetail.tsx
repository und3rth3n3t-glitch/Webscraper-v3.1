import { useParams, Link } from 'react-router-dom';
import { useRun } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunStatus } from '../api/types';
import { statusLabel } from '../utils/runStatus';
import ResultViewer from '../components/result/ResultViewer';
import RawJsonCard from '../components/result/RawJsonCard';
import { runExportUrl } from '../utils/exportLinks';
import type { DataMapping, IterationResult } from '../types/extraction';

const BANNER_CLASS: Partial<Record<RunStatus, string>> = {
  [RunItemStatus.Completed]: 'run-banner-success',
  [RunItemStatus.Failed]:    'run-banner-error',
  [RunItemStatus.Cancelled]: 'run-banner-error',
  [RunItemStatus.Paused]:    'run-banner-warning',
};

function isWholepageResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const iters = (result as { iterations?: unknown }).iterations;
  if (!Array.isArray(iters)) return false;
  return iters.some((it) => Array.isArray((it as { data?: unknown[] }).data) &&
    (it as { data: unknown[] }).data.some((row) =>
      row != null && typeof row === 'object'
      && Array.isArray((row as Record<string, unknown>).blocks)
      && Array.isArray((row as Record<string, unknown>).tables)
      && Array.isArray((row as Record<string, unknown>).charts)));
}

export default function RunDetail() {
  const { id } = useParams();
  const { data: run, isPending, error } = useRun(id);

  if (isPending) {
    return <div className="view"><div className="loading-state">Loading…</div></div>;
  }
  if (error || !run) {
    return <div className="view"><div className="danger-banner">Couldn't load this run. It may not exist.</div></div>;
  }

  const bannerClass = BANNER_CLASS[run.status];
  const pct = run.progressPercent ?? 0;
  const result = run.result as { iterations?: IterationResult[]; dataMapping?: DataMapping } | null;
  const iterations = result?.iterations ?? [];
  const dataMapping = result?.dataMapping;
  const isComplete = run.status === RunItemStatus.Completed;
  const csvDisabled = !isComplete || isWholepageResult(run.result);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back">←</Link>
          <h2 className="view-title">Run</h2>
          {run.batchId && (
            <Link to={`/run-batches/${run.batchId}`} className="text-sm">Back to batch</Link>
          )}
        </div>
        <div className="flex gap-sm">
          <a
            className={`btn btn-secondary btn-sm${isComplete ? '' : ' disabled'}`}
            href={isComplete ? runExportUrl(run.id, 'json') : undefined}
            aria-disabled={!isComplete}
            target="_blank"
            rel="noreferrer"
            title={isComplete ? '' : 'Run is not yet complete'}
            style={isComplete ? {} : { pointerEvents: 'none', opacity: 0.5 }}
          >
            Export JSON
          </a>
          <a
            className={`btn btn-secondary btn-sm${csvDisabled ? ' disabled' : ''}`}
            href={!csvDisabled ? runExportUrl(run.id, 'csv') : undefined}
            aria-disabled={csvDisabled}
            target="_blank"
            rel="noreferrer"
            title={csvDisabled ? "CSV isn't available for full-page results — use Export JSON" : ''}
            style={csvDisabled ? { pointerEvents: 'none', opacity: 0.5 } : {}}
          >
            Export CSV
          </a>
        </div>
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

      {iterations.length > 0 ? (
        <ResultViewer iterations={iterations} dataMapping={dataMapping} />
      ) : run.result != null ? (
        <RawJsonCard fieldName={null} value={run.result} />
      ) : null}
    </div>
  );
}
