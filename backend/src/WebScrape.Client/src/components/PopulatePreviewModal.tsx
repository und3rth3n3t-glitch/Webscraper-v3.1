import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useWorkers } from '../api/queries';
import { useCreateBatch, usePopulateTask } from '../api/mutations';
import Modal from './Modal';
import type { ExpansionPreviewDto, TaskDto } from '../api/types';
import { axiosErrorMessage } from '../utils/errorMessages';

type Props = {
  task: TaskDto;
  onClose: () => void;
};

function warningCopy(code: string, stepId?: string | null): string {
  switch (code) {
    case 'STEP_NO_LONGER_EXISTS':
      return `Binding for step '${stepId ?? '?'}' references a step that no longer exists. It will be ignored.`;
    case 'NEW_STEP_UNBOUND':
      return `Step '${stepId ?? '?'}' has no binding — input will be empty for this run.`;
    case 'BINDING_UNBOUND':
      return `Step '${stepId ?? '?'}' is unbound — input will be empty.`;
    case 'CONFIG_NOT_FOUND_AT_POPULATE':
      return 'Config for a scrape block was deleted; this iteration will be skipped.';
    default:
      return `Warning: ${code}`;
  }
}

export default function PopulatePreviewModal({ task, onClose }: Props) {
  const nav = useNavigate();
  const { data: workers } = useWorkers();
  const populate = usePopulateTask();
  const createBatch = useCreateBatch();

  const [preview, setPreview] = useState<ExpansionPreviewDto | null>(null);
  const [populateError, setPopulateError] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string>('');
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const onlineWorkers = (workers ?? []).filter((w) => w.online);

  useEffect(() => {
    setPreview(null);
    setPopulateError(null);
    setDispatchError(null);
    populate.mutate(task.id, {
      onSuccess: (data) => setPreview(data),
      onError: (e) => {
        if (axios.isAxiosError(e) && e.response?.status === 422) {
          const data = e.response.data as { code: string; count?: number; cap?: number; error: string };
          if (data.code === 'BATCH_TOO_LARGE') {
            setPopulateError(`Too many iterations: ${data.count} (max ${data.cap}). Reduce loop values.`);
          } else {
            setPopulateError('This task expands to zero iterations. Add at least one loop value.');
          }
        } else {
          setPopulateError('Could not preview this task. Try again.');
        }
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    if (onlineWorkers.length > 0 && !workerId) {
      setWorkerId(onlineWorkers[0].id);
    }
  }, [onlineWorkers, workerId]);

  const runBatch = async () => {
    if (!workerId) return;
    setDispatchError(null);
    try {
      const result = await createBatch.mutateAsync({ taskId: task.id, workerId });
      onClose();
      nav(`/run-batches/${result.batchId}`);
    } catch (e) {
      setDispatchError(axiosErrorMessage(e, 'Could not start the batch. Try again.'));
    }
  };

  return (
    <Modal open onClose={onClose} title={`Run "${task.name}"`}>
      {populate.isPending && <div className="loading-state">Expanding iterations…</div>}

      {populateError && <div className="danger-banner">{populateError}</div>}

      {preview && preview.warnings.length > 0 && (
        <div className="run-banner run-banner-warning">
          <ul style={{ paddingLeft: 'var(--spacing-md)', margin: 0 }}>
            {preview.warnings.map((w, i) => (
              <li key={i}>{warningCopy(w.code, w.stepId)}</li>
            ))}
          </ul>
        </div>
      )}

      {preview && !populateError && (
        <table className="data-table" style={{ marginBottom: 'var(--spacing-md)' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Iteration</th>
              <th>Inputs</th>
            </tr>
          </thead>
          <tbody>
            {preview.items.map((item, i) => (
              <tr key={`${item.scrapeBlockId}-${i}`}>
                <td>{i + 1}</td>
                <td>{item.iterationLabel}</td>
                <td>
                  {Object.entries(item.assignments).map(([k, v]) => (
                    <span key={k} className="meta-badge" style={{ marginRight: 'var(--spacing-xs)' }}>
                      {v}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="form-group">
        {onlineWorkers.length === 0 ? (
          <div className="form-hint text-danger">
            No workers are online right now. Connect a browser extension first.
          </div>
        ) : (
          <select
            className="form-select"
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
          >
            {onlineWorkers.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
      </div>

      {dispatchError && <div className="danger-banner">{dispatchError}</div>}

      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={runBatch}
          disabled={!preview || !!populateError || !workerId || createBatch.isPending}
        >
          {createBatch.isPending ? 'Starting…' : 'Run batch'}
        </button>
      </div>
    </Modal>
  );
}
