import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

export default function Toast() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => {
        const Icon = ICONS[t.type] || Info;
        return (
          <div key={t.id} className={`toast ${t.type}`} role="alert">
            <Icon size={14} />
            <span style={{ flex: 1 }}>{t.message}</span>
            <button className="toast-dismiss" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
