import { X } from 'lucide-react';
import { useSyncStore } from '../stores/syncStore';
import { useSettingsStore } from '../stores/settingsStore';

interface Props {
  configId: string;
  onClose: () => void;
}

export default function ConfigConflictDiffModal({ configId, onClose }: Props) {
  const { conflicts, resolveConflict, syncing } = useSyncStore();
  const { serverUrl, jwtToken } = useSettingsStore();

  const cs = conflicts[configId];
  if (!cs) return null;

  const local = JSON.stringify(cs.localConfig, null, 2);
  const server = JSON.stringify(cs.serverConfig.configJson, null, 2);

  const handlePick = async (choice: 'mine' | 'theirs') => {
    await resolveConflict(choice, serverUrl, jwtToken, configId);
    onClose();
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-box" style={{ maxWidth: 720, width: '100%' }}>
        <div className="modal-box-header">
          <span className="modal-title">Config has changed on the backend</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="modal-body">
          You and the backend both edited <strong>{cs.localConfig.name}</strong>. Pick which version to keep.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
          <div>
            <div className="form-label" style={{ marginBottom: 4 }}>Your version</div>
            <pre
              style={{
                background: 'var(--bg-light)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--spacing-sm)',
                fontSize: 11,
                overflowY: 'auto',
                maxHeight: 320,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {local}
            </pre>
          </div>
          <div>
            <div className="form-label" style={{ marginBottom: 4 }}>Backend version</div>
            <pre
              style={{
                background: 'var(--bg-light)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--spacing-sm)',
                fontSize: 11,
                overflowY: 'auto',
                maxHeight: 320,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {server}
            </pre>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={syncing}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => handlePick('theirs')}
            disabled={syncing}
          >
            Keep backend version
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handlePick('mine')}
            disabled={syncing}
          >
            {syncing ? 'Saving…' : 'Keep my version'}
          </button>
        </div>
      </div>
    </div>
  );
}

