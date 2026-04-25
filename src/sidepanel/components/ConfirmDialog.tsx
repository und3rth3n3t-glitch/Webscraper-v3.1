import { X } from 'lucide-react';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'danger' | 'secondary';
  secondaryLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onSecondary?: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  secondaryLabel,
  onConfirm,
  onCancel,
  onSecondary,
}: Props) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-box">
        <div className="modal-box-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="modal-body">{message}</p>
        <div className="modal-actions">
          {secondaryLabel && onSecondary && (
            <button className="btn btn-secondary" onClick={onSecondary}>
              {secondaryLabel}
            </button>
          )}
          <button className={`btn btn-${confirmVariant}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
