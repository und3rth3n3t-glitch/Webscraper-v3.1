import type { ActiveRemoteTask } from './scheduler';

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
}

// Stable prefix lets the click-router know which kind of notification fired
// without keeping a side-table.
const TASK_PREFIX = 'bb-task-';
const BATCH_PREFIX = 'bb-batch-';

export function taskNotificationId(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

export function batchNotificationId(timestamp = Date.now()): string {
  return `${BATCH_PREFIX}${timestamp}`;
}

export function isTaskNotification(id: string): boolean {
  return id.startsWith(TASK_PREFIX);
}

export function isBatchNotification(id: string): boolean {
  return id.startsWith(BATCH_PREFIX);
}

export function taskIdFromNotificationId(id: string): string | null {
  return id.startsWith(TASK_PREFIX) ? id.slice(TASK_PREFIX.length) : null;
}

export function formatBatchSummary(s: BatchSummary): string {
  // "Batch finished. 3 done, 1 needs attention." — pluralisation handled.
  const donePart = `${s.succeeded} done`;
  const failPart = s.failed === 0
    ? null
    : s.failed === 1
      ? '1 needs attention'
      : `${s.failed} need attention`;
  return failPart ? `Batch finished. ${donePart}, ${failPart}.` : `Batch finished. ${donePart}.`;
}

// Fires a task-pause notification. Caller is expected to gate on:
// - phase === 'drain'
// - last-focused window ≠ task.windowId
// - notifyOnPause toggle === true
// This module is only responsible for the API call.
export function notifyTaskPaused(task: ActiveRemoteTask, message: string): void {
  try {
    chrome.notifications.create(taskNotificationId(task.task.id), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${task.task.configName} needs your attention.`,
      message,
      priority: 1,
    }, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[notifications] task-paused create failed:', err.message);
    });
  } catch (err) {
    console.warn('[notifications] task-paused threw:', (err as Error).message);
  }
}

// Fires a batch-complete notification.
export function notifyBatchComplete(summary: BatchSummary): void {
  try {
    chrome.notifications.create(batchNotificationId(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Blueberry — batch finished',
      message: formatBatchSummary(summary),
      priority: 1,
    }, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[notifications] batch-complete create failed:', err.message);
    });
  } catch (err) {
    console.warn('[notifications] batch-complete threw:', (err as Error).message);
  }
}
