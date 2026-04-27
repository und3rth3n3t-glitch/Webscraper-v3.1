import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler, RECENT_TASKS_CAP, type StartInfo } from '../background/scheduler';
import type { QueueTask } from '../types/signalr';

function makeTask(id: string, overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    id,
    configId: 'cfg-' + id,
    configName: 'Cfg ' + id,
    searchTerms: ['a', 'b'],
    priority: 0,
    createdAt: new Date(0).toISOString(),
    status: 'pending',
    ...overrides,
  };
}

const STD_INFO: StartInfo = { tabId: 1, windowId: 10, origin: 'https://example.com' };

describe('Scheduler — enqueue and start gate', () => {
  let startTask: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    s = new Scheduler({ startTask });
  });

  it('starts the first enqueued task immediately', async () => {
    const t = makeTask('t1');
    s.enqueueTask(t);
    await Promise.resolve(); // flush queueMicrotask
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(t);
    expect(s.isStarting()).toBe(true);
  });

  it('queues a second task while the first is starting', async () => {
    s.enqueueTask(makeTask('t1'));
    s.enqueueTask(makeTask('t2'));
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(s.getPendingCount()).toBe(1);
    expect(s.getPendingTasks()[0].id).toBe('t2');
  });

  it('queues a second task while the first is active', async () => {
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: null });
    s.enqueueTask(makeTask('t2'));
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(s.getPendingCount()).toBe(1);
  });

  it('rejects duplicate enqueues by taskId (active)', async () => {
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    s.enqueueTask(makeTask('t1'));
    expect(s.getPendingCount()).toBe(0);
  });

  it('rejects duplicate enqueues by taskId (pending)', async () => {
    s.enqueueTask(makeTask('t1'));
    s.enqueueTask(makeTask('t2'));
    s.enqueueTask(makeTask('t2'));
    await Promise.resolve();
    expect(s.getPendingCount()).toBe(1);
  });

  it('cancelPending removes a pending task', async () => {
    s.enqueueTask(makeTask('t1'));
    s.enqueueTask(makeTask('t2'));
    s.enqueueTask(makeTask('t3'));
    expect(s.cancelPending('t2')).toBe(true);
    expect(s.getPendingTasks().map((t) => t.id)).toEqual(['t3']);
    expect(s.cancelPending('nope')).toBe(false);
  });

  it('recordStartFailed releases the gate and starts the next pending', async () => {
    s.enqueueTask(makeTask('t1'));
    s.enqueueTask(makeTask('t2'));
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);
    s.recordStartFailed('t1');
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(2);
    expect(startTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 't2' }));
  });
});

describe('Scheduler — active record lifecycle', () => {
  let startTask: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    s = new Scheduler({ startTask });
  });

  it('recordStarted promotes to active and clears starting', async () => {
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    expect(s.isStarting()).toBe(false);
    expect(s.getActiveCount()).toBe(1);
    const r = s.getActiveTask('t1');
    expect(r?.tabId).toBe(1);
    expect(r?.windowId).toBe(10);
    expect(r?.origin).toBe('https://example.com');
    expect(r?.task.status).toBe('running');
  });

  it('endTask removes the record and starts the next pending', async () => {
    s.enqueueTask(makeTask('t1'));
    s.enqueueTask(makeTask('t2'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    expect(startTask).toHaveBeenCalledTimes(1);
    const closed = s.endTask('t1');
    expect(closed?.task.id).toBe('t1');
    expect(s.getActiveCount()).toBe(0);
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(2);
    expect(startTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 't2' }));
  });

  it('endTask returns undefined for unknown taskId', () => {
    expect(s.endTask('nope')).toBeUndefined();
  });

  it('setProgress merges into the active record', async () => {
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    s.setProgress('t1', { stepLabel: 'step a', termIndex: 0 });
    expect(s.getActiveTask('t1')?.lastProgress).toEqual({ stepLabel: 'step a', termIndex: 0 });
  });

  it('findByTabId returns the matching record', async () => {
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 42, windowId: 100, origin: null });
    expect(s.findByTabId(42)?.task.id).toBe('t1');
    expect(s.findByTabId(99)).toBeUndefined();
  });

  it('getFirstActive returns the only active record under cap=1', async () => {
    expect(s.getFirstActive()).toBeUndefined();
    s.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    expect(s.getFirstActive()?.task.id).toBe('t1');
  });
});

describe('Scheduler — recent history', () => {
  it('dedupes by taskId on push', () => {
    const s = new Scheduler({ startTask: vi.fn() });
    s.pushRecent(makeTask('t1', { status: 'completed' }));
    s.pushRecent(makeTask('t1', { status: 'failed' }));
    expect(s.getRecent().length).toBe(1);
    expect(s.getRecent()[0].status).toBe('failed');
  });

  it('caps at RECENT_TASKS_CAP', () => {
    const s = new Scheduler({ startTask: vi.fn() });
    for (let i = 0; i < RECENT_TASKS_CAP + 5; i++) {
      s.pushRecent(makeTask('t' + i, { status: 'completed' }));
    }
    expect(s.getRecent().length).toBe(RECENT_TASKS_CAP);
    expect(s.getRecent()[0].id).toBe('t' + (RECENT_TASKS_CAP + 4));
  });

  it('setRecent replaces and respects cap', () => {
    const s = new Scheduler({ startTask: vi.fn() });
    const tasks = Array.from({ length: RECENT_TASKS_CAP + 3 }, (_, i) => makeTask('t' + i));
    s.setRecent(tasks);
    expect(s.getRecent().length).toBe(RECENT_TASKS_CAP);
  });
});

describe('Scheduler — persistence', () => {
  it('serialize then restore round-trips', async () => {
    const s1 = new Scheduler({ startTask: vi.fn() });
    s1.enqueueTask(makeTask('t1'));
    await Promise.resolve();
    s1.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    s1.setProgress('t1', { stepLabel: 'X', termIndex: 2 });

    const serialized = s1.serializeActive();
    const s2 = new Scheduler({ startTask: vi.fn() });
    s2.restoreActive(serialized);

    const r = s2.getActiveTask('t1');
    expect(r?.tabId).toBe(1);
    expect(r?.windowId).toBe(10);
    expect(r?.origin).toBe('https://a.test');
    expect(r?.lastProgress).toEqual({ stepLabel: 'X', termIndex: 2 });
  });

  it('restoreActive does not bypass start-gate semantics', () => {
    // After restore there is no "starting" state — the tasks are already live.
    const s = new Scheduler({ startTask: vi.fn() });
    s.restoreActive([{
      taskId: 't1', task: makeTask('t1'), tabId: 1, windowId: 10, origin: null,
    }]);
    expect(s.isStarting()).toBe(false);
    expect(s.hasCapacity()).toBe(false); // cap=1, full
  });
});
