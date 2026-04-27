import { useSyncStore } from '../stores/syncStore';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
}

export default function ConfigSyncStatus({ config }: Props) {
  const { syncing, conflicts, pushingIds } = useSyncStore();

  if (!config.shared) return null;

  const inConflict = !!conflicts[config.id];
  const isPending = config.dirty && !inConflict;
  const isPushing = pushingIds.has(config.id);
  const isSyncing = isPushing || (syncing && isPending);

  let dot: string;
  let label: string;

  if (inConflict) {
    dot = 'error';
    label = 'Server has newer changes — click to resolve';
  } else if (isSyncing) {
    dot = 'running';
    label = 'Syncing…';
  } else if (isPending) {
    dot = 'pending';
    label = 'Pending sync';
  } else {
    dot = 'success';
    label = 'Synced with backend';
  }

  return (
    <span
      className="meta-badge"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={label}
    >
      <span className={`status-dot ${dot}`} />
      {inConflict ? 'Conflict' : isPending ? 'Pending' : 'Synced'}
    </span>
  );
}
