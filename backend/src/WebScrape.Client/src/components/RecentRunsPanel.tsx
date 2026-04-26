import { Link } from 'react-router-dom';
import { useRecentRunsForTask } from '../api/queries';
import { statusLabel } from '../utils/runStatus';
import type { RunStatus } from '../api/types';

const DOT_FOR: Record<RunStatus, string> = {
  pending: 'pending', sent: 'pending', running: 'running', paused: 'pending',
  completed: 'success', failed: 'error', cancelled: 'error',
};

export default function RecentRunsPanel({ taskId, limit = 5 }: { taskId: string; limit?: number }) {
  const { data, isPending } = useRecentRunsForTask(taskId, limit);
  if (isPending || !data || data.length === 0) return null;

  return (
    <div className="flex items-center gap-sm text-sm text-light" style={{ flexWrap: 'wrap' }}>
      <span className="text-xs">Recent:</span>
      {data.map((r) => (
        <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-xs">
          <span className={`status-dot ${DOT_FOR[r.status]}`} />
          <span className="truncate" style={{ maxWidth: 120 }}>{statusLabel(r.status)}</span>
        </Link>
      ))}
      <Link to={`/runs?taskId=${encodeURIComponent(taskId)}`} className="text-sm">See all</Link>
    </div>
  );
}
