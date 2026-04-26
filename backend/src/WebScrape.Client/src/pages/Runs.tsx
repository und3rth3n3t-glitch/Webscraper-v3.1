import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useRunsList, useTasks } from '../api/queries';
import { RunItemStatus } from '../api/types';
import type { RunListQuery, RunStatus } from '../api/types';
import { statusLabel } from '../utils/runStatus';

const STATUS_OPTIONS: Array<{ value: '' | RunStatus; label: string }> = [
  { value: '',                          label: 'All statuses' },
  { value: RunItemStatus.Pending,       label: 'Pending' },
  { value: RunItemStatus.Sent,          label: 'Sent' },
  { value: RunItemStatus.Running,       label: 'Running' },
  { value: RunItemStatus.Paused,        label: 'Paused' },
  { value: RunItemStatus.Completed,     label: 'Completed' },
  { value: RunItemStatus.Failed,        label: 'Failed' },
  { value: RunItemStatus.Cancelled,     label: 'Cancelled' },
];

const DOT_FOR: Record<RunStatus, string> = {
  pending: 'pending', sent: 'pending', running: 'running', paused: 'pending',
  completed: 'success', failed: 'error', cancelled: 'error',
};

export default function Runs() {
  const [sp, setSp] = useSearchParams();
  const { data: tasks } = useTasks();

  const query: RunListQuery = useMemo(() => ({
    taskId:   sp.get('taskId') ?? undefined,
    status:   (sp.get('status') as RunStatus | null) ?? undefined,
    from:     sp.get('from') ?? undefined,
    to:       sp.get('to') ?? undefined,
    page:     Number(sp.get('page') ?? '1') || 1,
    pageSize: Number(sp.get('pageSize') ?? '25') || 25,
  }), [sp]);

  const { data, isPending } = useRunsList(query);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v); else next.delete(k);
    if (k !== 'page') next.delete('page');
    setSp(next);
  };
  const clearAll = () => setSp(new URLSearchParams());

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Run History</h2>
      </div>
      <div className="view-subtitle">Browse and export every run across your tasks.</div>

      <div className="flex gap-sm items-center" style={{ flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 200 }}>
          <label className="form-label">Task</label>
          <select className="form-select" value={query.taskId ?? ''} onChange={(e) => setParam('taskId', e.target.value)}>
            <option value="">All tasks</option>
            {tasks?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
          <label className="form-label">Status</label>
          <select className="form-select" value={query.status ?? ''} onChange={(e) => setParam('status', e.target.value)}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">From</label>
          <input type="datetime-local" className="form-input" value={query.from ?? ''} onChange={(e) => setParam('from', e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">To</label>
          <input type="datetime-local" className="form-input" value={query.to ?? ''} onChange={(e) => setParam('to', e.target.value)} />
        </div>
        <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear</button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}
      {!isPending && data && data.items.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">{sp.toString() ? 'No matches' : 'No runs yet'}</div>
          <div className="empty-state-desc">{sp.toString() ? 'Try clearing some filters.' : 'Queue a batch from a task to get started.'}</div>
          {sp.toString() && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
        </div>
      )}

      {!isPending && data && data.items.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Task</th>
                <th>Iteration</th>
                <th>Worker</th>
                <th>Requested</th>
                <th>Completed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td><span className={`status-dot ${DOT_FOR[r.status]}`} /> <span className="text-sm">{statusLabel(r.status)}</span></td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={r.taskName}>{r.taskName}</td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={r.iterationLabel ?? ''}>{r.iterationLabel ?? '—'}</td>
                  <td>{r.workerName}</td>
                  <td className="text-sm text-light">{new Date(r.requestedAt).toLocaleString()}</td>
                  <td className="text-sm text-light">{r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}</td>
                  <td><Link to={`/runs/${r.id}`} className="btn btn-secondary btn-sm">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={data.total} page={data.page} pageSize={data.pageSize} setPage={(p) => setParam('page', String(p))} />
        </>
      )}
    </div>
  );
}

function Pagination({ total, page, pageSize, setPage }: { total: number; page: number; pageSize: number; setPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages === 1) return null;
  return (
    <div className="flex items-center justify-between gap-sm" style={{ marginTop: 'var(--spacing-md)' }}>
      <span className="text-sm text-light">Page {page} of {totalPages} · {total} total</span>
      <div className="flex gap-sm">
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
