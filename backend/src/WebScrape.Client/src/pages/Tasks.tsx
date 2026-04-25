import { useState } from 'react';
import axios from 'axios';
import { useTasks, useWorkers } from '../api/queries';
import { useStartRun } from '../api/mutations';
import Modal from '../components/Modal';
import type { TaskDto } from '../api/types';

export default function Tasks() {
  const { data: tasks, isPending } = useTasks();
  const { data: workers } = useWorkers();
  const startRun = useStartRun();

  const [picking, setPicking] = useState<TaskDto | null>(null);
  const [workerId, setWorkerId] = useState<string>('');

  const onlineWorkers = (workers ?? []).filter((w) => w.online);

  const openPicker = (t: TaskDto) => {
    setPicking(t);
    setWorkerId(onlineWorkers[0]?.id ?? '');
    startRun.reset();
  };

  const submit = async () => {
    if (!picking || !workerId) return;
    await startRun.mutateAsync({ taskId: picking.id, workerId });
    setPicking(null);
  };

  const errMsg = (() => {
    const e = startRun.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Could not start the run.';
    }
    return 'Could not start the run.';
  })();

  return (
    <div className="view">
      <h2 className="view-title">Tasks</h2>
      <div className="view-subtitle">Pick a task and send it to an online worker.</div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && tasks && tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No tasks yet</div>
          <div className="empty-state-desc">
            Tasks come from the seeded data or the task editor (coming in M2).
          </div>
        </div>
      )}

      {!isPending && tasks && tasks.length > 0 && (
        <div className="config-list">
          {tasks.map((t) => (
            <div key={t.id} className="card list-card config-card">
              <div className="config-card-header">
                <div className="config-card-name">{t.name}</div>
                <button className="btn btn-primary btn-sm" onClick={() => openPicker(t)}>
                  Run on…
                </button>
              </div>
              <div className="config-card-meta">
                <span className="domain-badge">{t.scraperConfigName}</span>
                <span className="meta-badge">
                  {t.searchTerms.length} term{t.searchTerms.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!picking}
        onClose={() => setPicking(null)}
        title={`Run "${picking?.name ?? ''}"`}
      >
        {errMsg && <div className="danger-banner">{errMsg}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="worker-pick">
            Worker
          </label>
          {onlineWorkers.length === 0 ? (
            <div className="form-hint text-danger">
              No workers are online right now. Connect a browser extension first.
            </div>
          ) : (
            <select
              id="worker-pick"
              className="form-select"
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
            >
              {onlineWorkers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setPicking(null)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={startRun.isPending || !workerId}
          >
            {startRun.isPending ? 'Starting…' : 'Run'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
