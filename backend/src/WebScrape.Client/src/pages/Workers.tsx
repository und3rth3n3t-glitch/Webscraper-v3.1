import { useWorkers } from '../api/queries';

function fmtRelative(s: string | null): string {
  if (!s) return 'never';
  const ms = Date.now() - new Date(s).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(s).toLocaleDateString();
}

export default function Workers() {
  const { data: workers, isPending } = useWorkers();

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
            {workers.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className={`status-dot ${w.online ? 'success' : 'pending'}`} />
                    {w.online ? 'Online' : 'Offline'}
                  </span>
                </td>
                <td>{w.extensionVersion ?? '—'}</td>
                <td>{fmtRelative(w.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
