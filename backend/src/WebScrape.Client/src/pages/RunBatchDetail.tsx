import { Link, useParams } from 'react-router-dom';
import { useRunBatch } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunItemDto } from '../api/types';
import { allTerminal, statusLabel } from '../utils/runStatus';

function batchBannerClass(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  if (!allTerminal(items)) return 'run-banner run-banner-warning';
  return items.some((r) => r.status === RunItemStatus.Failed)
    ? 'run-banner run-banner-error'
    : 'run-banner run-banner-success';
}

function batchBannerText(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  if (!allTerminal(items)) return 'Batch in progress…';
  const failed = items.filter((r) => r.status === RunItemStatus.Failed).length;
  return failed === 0 ? 'All done.' : `${failed} iteration${failed === 1 ? '' : 's'} failed.`;
}

export default function RunBatchDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isPending } = useRunBatch(id);

  if (isPending) return <div className="loading-state">Loading…</div>;
  if (!batch) return <div className="view"><div className="danger-banner">Batch not found.</div></div>;

  const bannerClass = batchBannerClass(batch.runItems);
  const bannerText = batchBannerText(batch.runItems);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back to tasks">←</Link>
          <h2 className="view-title">{batch.taskName}</h2>
        </div>
        <span className="meta-badge">{batch.workerName}</span>
      </div>

      {bannerClass && <div className={bannerClass}>{bannerText}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Iteration</th>
            <th>Status</th>
            <th>Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {batch.runItems.map((item, i) => (
            <tr key={item.id}>
              <td>{i + 1}</td>
              <td>{item.iterationLabel ?? item.currentTerm ?? '—'}</td>
              <td>{statusLabel(item.status)}</td>
              <td>{item.progressPercent != null ? `${item.progressPercent}%` : '—'}</td>
              <td>
                <Link to={`/runs/${item.id}`} className="btn btn-secondary btn-sm">View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
