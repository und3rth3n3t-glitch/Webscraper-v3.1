import { useWorkers } from '../api/queries';
import { fmtRelative } from '../utils/formatDate';
import type { WorkerDto } from '../api/types';

const STALE_MS = 30_000;

function presence(w: WorkerDto, now: number): { dot: 'success' | 'warning' | 'pending'; label: string } {
  if (!w.online) return { dot: 'pending', label: 'Offline' };
  if (!w.lastSeenAt) return { dot: 'success', label: 'Online' };
  const ageMs = now - new Date(w.lastSeenAt).getTime();
  if (ageMs > STALE_MS) {
    const s = Math.round(ageMs / 1000);
    return { dot: 'warning', label: `Idle (${s}s since last activity)` };
  }
  return { dot: 'success', label: 'Online' };
}

export default function Workers() {
  const { data: workers, isPending } = useWorkers();
  const now = Date.now();

  return (
    <div className="view">
      <h2 className="view-title">Workers</h2>
      <div className="view-subtitle">Browser extensions connected to this backend. Refreshes every 5s.</div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && workers && workers.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No workers yet</div>
          <div className="empty-state-desc">
            Open the extension, paste an API key, set the worker name, and switch mode to Queue.
          </div>
        </div>
      )}

      {!isPending && workers && workers.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => {
              const p = presence(w, now);
              return (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className={`status-dot ${p.dot}`} />
                      {p.label}
                    </span>
                  </td>
                  <td>{w.extensionVersion ?? '—'}</td>
                  <td>{fmtRelative(w.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
