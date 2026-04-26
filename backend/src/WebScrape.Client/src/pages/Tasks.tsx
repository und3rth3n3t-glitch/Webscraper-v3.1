import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useScraperConfigs, useTasks } from '../api/queries';
import { useDeleteTask } from '../api/mutations';
import Modal from '../components/Modal';
import PopulatePreviewModal from '../components/PopulatePreviewModal';
import RecentRunsPanel from '../components/RecentRunsPanel';
import type { TaskDto } from '../api/types';
import { configNameFor } from '../utils/configLookup';

export default function Tasks() {
  const { data: tasks, isPending } = useTasks();
  const { data: configs } = useScraperConfigs();
  const remove = useDeleteTask();
  const nav = useNavigate();

  const [confirmDelete, setConfirmDelete] = useState<TaskDto | null>(null);
  const [runTask, setRunTask] = useState<TaskDto | null>(null);

  const doDelete = async () => {
    if (!confirmDelete) return;
    await remove.mutateAsync(confirmDelete.id);
    setConfirmDelete(null);
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Tasks</h2>
        <button className="btn btn-primary" onClick={() => nav('/tasks/new')}>
          + New task
        </button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && tasks && tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No tasks yet</div>
          <div className="empty-state-desc">
            Create one to start scraping. A task is one loop of values feeding one scraper config.
          </div>
        </div>
      )}

      {!isPending && tasks && tasks.length > 0 && (
        <div className="config-list">
          {tasks.map((t) => {
            const configName = configNameFor(t, configs);
            return (
              <div key={t.id} className="card list-card config-card">
                <div className="config-card-header">
                  <div className="config-card-name">{t.name}</div>
                  <div style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
                    <Link to={`/tasks/${t.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmDelete(t)}
                    >
                      Delete
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setRunTask(t)}
                    >
                      Run batch…
                    </button>
                  </div>
                </div>
                <div className="config-card-meta">
                  {configName ? (
                    <span className="domain-badge">{configName}</span>
                  ) : (
                    <span className="meta-badge">No config</span>
                  )}
                  <span className="meta-badge">
                    {t.searchTerms.length} value{t.searchTerms.length === 1 ? '' : 's'}
                  </span>
                </div>
                <RecentRunsPanel taskId={t.id} />
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this task?"
      >
        <div className="modal-body">
          Delete <strong>{confirmDelete?.name}</strong>? This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>

      {runTask && (
        <PopulatePreviewModal
          task={runTask}
          onClose={() => setRunTask(null)}
        />
      )}
    </div>
  );
}
