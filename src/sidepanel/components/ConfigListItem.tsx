import { useState } from 'react';
import { Copy, Pencil, Trash2, List, Calendar, Play, Wifi, WifiOff } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import ConfigSyncStatus from './ConfigSyncStatus';
import ConfigConflictDiffModal from './ConfigConflictDiffModal';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSyncStore } from '../stores/syncStore';
import { deleteConfig, saveConfig } from '../utils/storage';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
  onEdit: () => void;
  onRun: () => void;
  onDuplicate: () => void;
  onDeleted: (id: string) => void;
  onUpdated: () => void;
}

export default function ConfigListItem({ config, onEdit, onRun, onDuplicate, onDeleted, onUpdated }: Props) {
  const { showToast } = useUiStore();
  const [confirming, setConfirming] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);

  const conflicts = useSyncStore((s) => s.conflicts);
  const pushIfDirty = useSyncStore((s) => s.pushIfDirty);
  const pushingIds = useSyncStore((s) => s.pushingIds);
  const { serverUrl, jwtToken, connectionStatus } = useSettingsStore();

  const inConflict = !!conflicts[config.id];
  const isPushing = pushingIds.has(config.id);

  const stepCount = config.steps?.length || 0;
  const date = config.updatedAt
    ? new Date(config.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '';

  const handleDelete = async () => {
    try {
      await deleteConfig(config.id);
      onDeleted(config.id);
      showToast('Config deleted.', 'success');
    } catch {
      showToast('Failed to delete config.', 'error');
    }
    setConfirming(false);
  };

  const handleToggleShare = async () => {
    const nowShared = !config.shared;
    const updated = { ...config, shared: nowShared, dirty: nowShared ? true : false };
    await saveConfig(updated);
    onUpdated();
    if (nowShared && connectionStatus === 'connected') {
      await pushIfDirty(serverUrl, jwtToken, config.id);
    } else if (nowShared) {
      showToast('Sync turned on. Will push when you reconnect.', 'success');
    } else {
      showToast('Sync turned off. The backend keeps its copy.', 'success');
    }
  };

  return (
    <>
      <div className="list-card config-card">
        <div className="config-card-header">
          <div className="config-card-name">{config.name}</div>
          <div className="config-card-icons">
            <button
              className="btn btn-icon btn-icon-subtle"
              onClick={onDuplicate}
              title="Duplicate"
              aria-label="Duplicate config"
            >
              <Copy size={14} />
            </button>
            <button
              className="btn btn-icon btn-icon-edit"
              onClick={onEdit}
              title="Edit"
              aria-label="Edit config"
            >
              <Pencil size={14} />
            </button>
            <button
              className={`btn btn-icon ${config.shared ? 'btn-icon-edit' : 'btn-icon-subtle'}`}
              onClick={handleToggleShare}
              disabled={isPushing || inConflict}
              title={
                isPushing
                  ? 'Syncing…'
                  : inConflict
                  ? 'Resolve the conflict first'
                  : config.shared
                  ? 'Stop syncing (your backend keeps a copy)'
                  : 'Sync this config with your backend'
              }
              aria-label={config.shared ? 'Stop syncing' : 'Sync config'}
            >
              {config.shared ? <Wifi size={14} /> : <WifiOff size={14} />}
            </button>
            <button
              className="btn btn-icon btn-icon-delete"
              onClick={() => setConfirming(true)}
              title="Delete"
              aria-label="Delete config"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {config.domain && (
          <div className="config-card-body">
            <div className="config-card-meta">
              {config.domainLocked
                ? <span className="domain-badge">{config.domain}</span>
                : <span className="meta-badge">{config.domain}</span>
              }
            </div>
          </div>
        )}

        {config.shared && !inConflict && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <ConfigSyncStatus config={config} />
          </div>
        )}

        {config.shared && inConflict && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <div className="detection-banner detection-banner--error">
              <div className="detection-banner-body">
                <strong>Backend has newer changes</strong>
                <p>You edited this here, but it was also edited on the backend. Pick which version to keep.</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setConflictOpen(true)}>
                Resolve
              </button>
            </div>
          </div>
        )}

        <div className="config-card-footer">
          <div className="config-card-meta">
            <span className="meta-badge">
              <List size={12} />
              {stepCount} step{stepCount !== 1 ? 's' : ''}
            </span>
            {date && (
              <span className="meta-badge">
                <Calendar size={12} />
                {date}
              </span>
            )}
          </div>
          <button className="btn btn-primary btn-sm" onClick={onRun}>
            <Play size={11} /> Run
          </button>
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Delete Config"
          message={`Delete "${config.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirming(false)}
        />
      )}

      {conflictOpen && (
        <ConfigConflictDiffModal
          configId={config.id}
          onClose={() => setConflictOpen(false)}
        />
      )}
    </>
  );
}
