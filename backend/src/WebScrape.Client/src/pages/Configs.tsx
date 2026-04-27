import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useScraperConfigs } from '../api/queries';
import { useDeleteScraperConfig } from '../api/mutations';
import Modal from '../components/Modal';
import type { DeleteConfigConflictDto, ScraperConfigDto } from '../api/types';
import { fmtDate } from '../utils/formatDate';

export default function Configs() {
  const { data: configs, isPending } = useScraperConfigs();
  const remove = useDeleteScraperConfig();
  const nav = useNavigate();

  const [confirmDelete, setConfirmDelete] = useState<ScraperConfigDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(confirmDelete.id);
      setConfirmDelete(null);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        const data = e.response.data as DeleteConfigConflictDto;
        setDeleteError(data.error);
      } else {
        setDeleteError('Could not delete this config. Try again.');
      }
    }
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Configs</h2>
        <button className="btn btn-primary" onClick={() => nav('/configs/new')}>
          + New config
        </button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && configs && configs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No configs yet</div>
          <div className="empty-state-desc">
            A config describes how to scrape a site. Create one before authoring tasks.
          </div>
        </div>
      )}

      {!isPending && configs && configs.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Schema</th>
              <th>Updated</th>
              <th>Sync</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.id}>
                <td>
                  <div>{c.name}</div>
                  {c.originWorkerName && (
                    <div className="form-hint" style={{ marginTop: 2 }}>
                      Imported from {c.originWorkerName}
                    </div>
                  )}
                </td>
                <td><span className="domain-badge">{c.domain}</span></td>
                <td>{c.schemaVersion}</td>
                <td>{fmtDate(c.updatedAt)}</td>
                <td>
                  {c.shared && <span className="meta-badge">Synced</span>}
                </td>
                <td style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end' }}>
                  <Link to={`/configs/${c.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirmDelete(c); setDeleteError(null); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this config?"
      >
        {deleteError && <div className="danger-banner">{deleteError}</div>}
        <div className="modal-body">
          {confirmDelete && (
            <>Delete <strong>{confirmDelete.name}</strong>? This can't be undone.</>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
