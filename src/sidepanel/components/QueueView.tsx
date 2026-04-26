import { useQueueStore } from '../stores/queueStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useRunStore } from '../stores/runStore';
import { sendToContent } from '../utils/messaging';
import type { QueueTask } from '../../types/signalr';

function statusDot(status: QueueTask['status']): string {
  switch (status) {
    case 'running':   return 'status-dot status-dot-running';
    case 'completed': return 'status-dot status-dot-success';
    case 'failed':    return 'status-dot status-dot-error';
    case 'paused':    return 'status-dot status-dot--paused';
    default:          return 'status-dot';
  }
}

export default function QueueView() {
  const { tasks, currentTaskId, stats, clearCompleted, clearPending, removeTask, resumeTask } = useQueueStore();
  const { connected, serverUrl, lastConnectionError } = useSettingsStore();
  const { isRunning } = useRunStore();

  const currentTask = tasks.find(t => t.id === currentTaskId);
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed');

  // Show connected if the store says so, or if tasks are present (tasks prove the connection works)
  const isEffectivelyConnected = connected || tasks.length > 0;

  const taskLabel = (task: { iterationLabel?: string; searchTerms: string[] }) =>
    task.iterationLabel ?? (task.searchTerms.length > 0
      ? `${task.searchTerms.length} term${task.searchTerms.length !== 1 ? 's' : ''}`
      : null);

  const handleResumePaused = async (task: QueueTask) => {
    try {
      await sendToContent('RESUME_AFTER_CLOUDFLARE');
      resumeTask(task.id);
    } catch {
      // auto-resume will handle it
    }
  };

  return (
    <div className="view queue-view">
      <div className="view-header-row">
        <h2 className="view-title">Task Queue</h2>
      </div>

      <div className="queue-connection-row">
        <span className={isEffectivelyConnected ? 'status-dot status-dot-success' : 'status-dot status-dot-error'} />
        <span className="queue-connection-label">
          {isEffectivelyConnected
            ? `Connected to ${serverUrl || 'backend'}`
            : lastConnectionError
            ? `Disconnected — ${lastConnectionError}`
            : 'Not connected. Set up a backend in Settings.'}
        </span>
      </div>

      {currentTask && (
        <div className="card card--active">
          <div className="card-header">
            <span className={statusDot(currentTask.status)} />
            <span className="card-title">{currentTask.configName}</span>
            {currentTask.status === 'paused' && (
              <button className="btn btn-ghost btn-sm" onClick={() => handleResumePaused(currentTask)}>
                Resume
              </button>
            )}
          </div>
          <div className="card-body">
            <p className="text-sm text-light">
              {taskLabel(currentTask) ?? 'Batch task'}
              {currentTask.status === 'paused' && ' — waiting for Cloudflare challenge'}
              {isRunning && currentTask.status === 'running' && ' — running...'}
            </p>
          </div>
        </div>
      )}

      {pendingTasks.length > 0 && (
        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label">Pending ({pendingTasks.length})</label>
            <button className="btn btn-ghost btn-sm" onClick={clearPending}>Clear all</button>
          </div>
          {pendingTasks.map(task => (
            <div key={task.id} className="list-card">
              <span className={statusDot(task.status)} />
              <div className="list-card-body">
                <div className="list-card-title">{task.configName}</div>
                <div className="list-card-meta">{taskLabel(task) ?? 'Batch task'}</div>
              </div>
              <button className="list-card-dismiss" onClick={() => removeTask(task.id)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}

      {completedTasks.length > 0 && (
        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label">Completed ({completedTasks.length})</label>
            <button className="btn btn-ghost btn-sm" onClick={clearCompleted}>Clear</button>
          </div>
          {completedTasks.map(task => (
            <div key={task.id} className="list-card">
              <span className={statusDot(task.status)} />
              <div className="list-card-body">
                <div className="list-card-title">{task.configName}</div>
                <div className="list-card-meta">
                  {task.status === 'failed' ? `Failed — ${task.error || 'unknown error'}` : 'Completed'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tasks.length === 0 && !currentTask && (
        <div className="empty-state">
          <h3 className="empty-state-title">No tasks yet</h3>
          <p className="empty-state-desc">
            {isEffectivelyConnected
              ? 'Waiting for tasks from the queue server.'
              : 'Connect to a backend in Settings to start receiving tasks.'}
          </p>
        </div>
      )}

      <div className="queue-stats-row">
        <span className="meta-badge">Total: {stats.total}</span>
        <span className="meta-badge">Pending: {stats.pending}</span>
        <span className="meta-badge">Done: {stats.completed}</span>
        {stats.failed > 0 && <span className="meta-badge meta-badge-error">Failed: {stats.failed}</span>}
      </div>
    </div>
  );
}
