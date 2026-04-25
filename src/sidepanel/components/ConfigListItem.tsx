import { useState } from 'react';
import { Copy, Pencil, Trash2, List, Calendar, Play } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { useUiStore } from '../stores/uiStore';
import { deleteConfig } from '../utils/storage';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
  onEdit: () => void;
  onRun: () => void;
  onDuplicate: () => void;
  onDeleted: (id: string) => void;
}

export default function ConfigListItem({ config, onEdit, onRun, onDuplicate, onDeleted }: Props) {
  const { showToast } = useUiStore();
  const [confirming, setConfirming] = useState(false);

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
    </>
  );
}
