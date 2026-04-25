import { RunItemStatus, TERMINAL_STATUSES } from '../api/types';
import type { RunStatus } from '../api/types';

const STATUS_LABEL_MAP: Record<RunStatus, string> = {
  [RunItemStatus.Pending]:   'Pending',
  [RunItemStatus.Sent]:      'Sent to worker',
  [RunItemStatus.Running]:   'Running',
  [RunItemStatus.Paused]:    'Paused — solve the challenge in your browser',
  [RunItemStatus.Completed]: 'Done',
  [RunItemStatus.Failed]:    'Failed',
  [RunItemStatus.Cancelled]: 'Cancelled',
};

export function statusLabel(status: RunStatus): string {
  return STATUS_LABEL_MAP[status] ?? status;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function allTerminal(items: { status: RunStatus }[]): boolean {
  return items.every((i) => isTerminalStatus(i.status));
}
