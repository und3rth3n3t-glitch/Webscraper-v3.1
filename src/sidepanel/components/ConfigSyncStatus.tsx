import { useSyncStore } from '../stores/syncStore';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
}

export default function ConfigSyncStatus({ config }: Props) {
  const { syncing, conflicts, pushingIds } = useSyncStore();

  if (!config.shared) return null;

  const inConflict = !!conflicts[config.id];
  // Conflict UX is owned by ConfigListItem's banner — this component renders nothing in that state.
  if (inConflict) return null;

  const isPending = config.dirty;
  const isPushing = pushingIds.has(config.id);
  const isSyncing = isPushing || (syncing && isPending);

  let dot: string;
  let label: string;

  if (isSyncing) {
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
      {isPending ? 'Pending' : 'Synced'}
    </span>
  );
}
