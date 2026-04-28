import { describe, it, expect } from 'vitest';
import {
  taskNotificationId,
  batchNotificationId,
  isTaskNotification,
  isBatchNotification,
  taskIdFromNotificationId,
  formatBatchSummary,
} from '../background/notifications';

describe('notifications — id helpers', () => {
  it('taskNotificationId is deterministic and prefixed', () => {
    expect(taskNotificationId('abc-123')).toBe('bb-task-abc-123');
  });

  it('batchNotificationId includes the timestamp', () => {
    expect(batchNotificationId(1700000000)).toBe('bb-batch-1700000000');
  });

  it('isTaskNotification matches task ids only', () => {
    expect(isTaskNotification('bb-task-foo')).toBe(true);
    expect(isTaskNotification('bb-batch-123')).toBe(false);
    expect(isTaskNotification('foo')).toBe(false);
  });

  it('isBatchNotification matches batch ids only', () => {
    expect(isBatchNotification('bb-batch-1')).toBe(true);
    expect(isBatchNotification('bb-task-1')).toBe(false);
  });

  it('taskIdFromNotificationId extracts the inner taskId', () => {
    expect(taskIdFromNotificationId('bb-task-uuid-with-dashes')).toBe('uuid-with-dashes');
    expect(taskIdFromNotificationId('bb-batch-123')).toBeNull();
  });
});

describe('notifications — formatBatchSummary', () => {
  it('all succeeded — singular when 1 done', () => {
    expect(formatBatchSummary({ total: 1, succeeded: 1, failed: 0 })).toBe('Batch finished. 1 done.');
  });

  it('all succeeded — plural when many', () => {
    expect(formatBatchSummary({ total: 4, succeeded: 4, failed: 0 })).toBe('Batch finished. 4 done.');
  });

  it('one failure', () => {
    expect(formatBatchSummary({ total: 4, succeeded: 3, failed: 1 })).toBe('Batch finished. 3 done, 1 needs attention.');
  });

  it('multiple failures', () => {
    expect(formatBatchSummary({ total: 5, succeeded: 2, failed: 3 })).toBe('Batch finished. 2 done, 3 need attention.');
  });

  it('all failed', () => {
    expect(formatBatchSummary({ total: 2, succeeded: 0, failed: 2 })).toBe('Batch finished. 0 done, 2 need attention.');
  });
});
