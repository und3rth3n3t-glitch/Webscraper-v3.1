import { useState } from 'react';
import axios from 'axios';
import { useApiKeys } from '../api/queries';
import { useCreateApiKey, useRevokeApiKey } from '../api/mutations';
import Modal from '../components/Modal';
import type { CreateApiKeyResponseDto } from '../api/types';

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

export default function ApiKeys() {
  const { data: keys, isPending } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<CreateApiKeyResponseDto | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);

  const createErrMsg = (() => {
    const e = create.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Failed to create key.';
    }
    return 'Failed to create key.';
  })();

  const submit = async () => {
    if (!name.trim()) return;
    const result = await create.mutateAsync({ name: name.trim() });
    setName('');
    setCreateOpen(false);
    setRevealed(result);
  };

  const doRevoke = async () => {
    if (!confirmRevoke) return;
    await revoke.mutateAsync(confirmRevoke.id);
    setConfirmRevoke(null);
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">API Keys</h2>
        <button className="btn btn-primary" onClick={() => { setCreateOpen(true); create.reset(); }}>
          + Create key
        </button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && keys && keys.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No API keys yet</div>
          <div className="empty-state-desc">
            Create one to connect a browser extension as a worker.
          </div>
        </div>
      )}

      {!isPending && keys && keys.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>{fmtDate(k.createdAt)}</td>
                <td>{fmtDate(k.lastUsedAt)}</td>
                <td>
                  {k.revokedAt ? (
                    <span className="text-danger">Revoked</span>
                  ) : (
                    <span className="text-success">Active</span>
                  )}
                </td>
                <td>
                  {!k.revokedAt && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmRevoke({ id: k.id, name: k.name })}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key">
        {createErrMsg && <div className="danger-banner">{createErrMsg}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="key-name">
            Name
          </label>
          <input
            id="key-name"
            className="form-input"
            placeholder="e.g. Office laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          <div className="form-hint">Pick something memorable so you can find this key later.</div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </Modal>

      <Modal
        open={!!revealed}
        onClose={() => setRevealed(null)}
        title={`Key created: ${revealed?.name ?? ''}`}
      >
        <div className="danger-banner">
          Copy this token now — it won't be shown again. If you lose it, revoke it and create a new one.
        </div>
        <div className="token-reveal">{revealed?.token}</div>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            onClick={() => { if (revealed) navigator.clipboard.writeText(revealed.token); }}
          >
            Copy
          </button>
          <button className="btn btn-primary" onClick={() => setRevealed(null)}>
            I've copied it
          </button>
        </div>
      </Modal>

      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke this key?"
      >
        <div className="modal-body">
          Any extension still using <strong>{confirmRevoke?.name}</strong> will be disconnected on
          its next reconnect. This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmRevoke(null)}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={doRevoke} disabled={revoke.isPending}>
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
