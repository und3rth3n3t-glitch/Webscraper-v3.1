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
  let broadcastResumeForDrain: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    broadcastResumeForDrain = vi.fn();
    s = new Scheduler({ startTask, broadcastResumeForDrain });
  });

  it('starts the first enqueued task immediately', async () => {
    const t = makeTask('t1');
    s.enqueueTask(t, null);
    await Promise.resolve(); // flush queueMicrotask
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith(t);
    expect(s.isStarting()).toBe(true);
  });

  it('queues a second task while the first is starting', async () => {
    s.enqueueTask(makeTask('t1'), null);
    s.enqueueTask(makeTask('t2'), null);
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(s.getPendingCount()).toBe(1);
    expect(s.getPendingTasks()[0].id).toBe('t2');
  });

  it('queues a second task while the first is active', async () => {
    s.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: null });
    s.enqueueTask(makeTask('t2'), null);
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(s.getPendingCount()).toBe(1);
  });

  it('rejects duplicate enqueues by taskId (active)', async () => {
    s.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    s.enqueueTask(makeTask('t1'), null);
    expect(s.getPendingCount()).toBe(0);
  });

  it('rejects duplicate enqueues by taskId (pending)', async () => {
    s.enqueueTask(makeTask('t1'), null);
    s.enqueueTask(makeTask('t2'), null);
    s.enqueueTask(makeTask('t2'), null);
    await Promise.resolve();
    expect(s.getPendingCount()).toBe(1);
  });

  it('cancelPending removes a pending task', async () => {
    s.enqueueTask(makeTask('t1'), null);
    s.enqueueTask(makeTask('t2'), null);
    s.enqueueTask(makeTask('t3'), null);
    expect(s.cancelPending('t2')).toBe(true);
    expect(s.getPendingTasks().map((t) => t.id)).toEqual(['t3']);
    expect(s.cancelPending('nope')).toBe(false);
  });

  it('recordStartFailed releases the gate and starts the next pending', async () => {
    s.enqueueTask(makeTask('t1'), null);
    s.enqueueTask(makeTask('t2'), null);
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
  let broadcastResumeForDrain: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    broadcastResumeForDrain = vi.fn();
    s = new Scheduler({ startTask, broadcastResumeForDrain });
  });

  it('recordStarted promotes to active and clears starting', async () => {
    s.enqueueTask(makeTask('t1'), null);
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
    s.enqueueTask(makeTask('t1'), null);
    s.enqueueTask(makeTask('t2'), null);
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
    s.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    s.setProgress('t1', { stepLabel: 'step a', termIndex: 0 });
    expect(s.getActiveTask('t1')?.lastProgress).toEqual({ stepLabel: 'step a', termIndex: 0 });
  });

  it('findByTabId returns the matching record', async () => {
    s.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 42, windowId: 100, origin: null });
    expect(s.findByTabId(42)?.task.id).toBe('t1');
    expect(s.findByTabId(99)).toBeUndefined();
  });

  it('getFirstActive returns the only active record under cap=1', async () => {
    expect(s.getFirstActive()).toBeUndefined();
    s.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), STD_INFO);
    expect(s.getFirstActive()?.task.id).toBe('t1');
  });
});

describe('Scheduler — recent history', () => {
  it('dedupes by taskId on push', () => {
    const s = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    s.pushRecent(makeTask('t1', { status: 'completed' }));
    s.pushRecent(makeTask('t1', { status: 'failed' }));
    expect(s.getRecent().length).toBe(1);
    expect(s.getRecent()[0].status).toBe('failed');
  });

  it('caps at RECENT_TASKS_CAP', () => {
    const s = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    for (let i = 0; i < RECENT_TASKS_CAP + 5; i++) {
      s.pushRecent(makeTask('t' + i, { status: 'completed' }));
    }
    expect(s.getRecent().length).toBe(RECENT_TASKS_CAP);
    expect(s.getRecent()[0].id).toBe('t' + (RECENT_TASKS_CAP + 4));
  });

  it('setRecent replaces and respects cap', () => {
    const s = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    const tasks = Array.from({ length: RECENT_TASKS_CAP + 3 }, (_, i) => makeTask('t' + i));
    s.setRecent(tasks);
    expect(s.getRecent().length).toBe(RECENT_TASKS_CAP);
  });
});

describe('Scheduler — persistence', () => {
  it('serialize then restore round-trips', async () => {
    const s1 = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    s1.enqueueTask(makeTask('t1'), null);
    await Promise.resolve();
    s1.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    s1.setProgress('t1', { stepLabel: 'X', termIndex: 2 });

    const serialized = s1.serializeActive();
    const s2 = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    s2.restoreActive(serialized);

    const r = s2.getActiveTask('t1');
    expect(r?.tabId).toBe(1);
    expect(r?.windowId).toBe(10);
    expect(r?.origin).toBe('https://a.test');
    expect(r?.lastProgress).toEqual({ stepLabel: 'X', termIndex: 2 });
  });

  it('restoreActive does not bypass start-gate semantics', () => {
    // After restore there is no "starting" state — the tasks are already live.
    const s = new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() });
    s.restoreActive([{
      taskId: 't1', task: makeTask('t1'), tabId: 1, windowId: 10, origin: null,
    }]);
    expect(s.isStarting()).toBe(false);
    expect(s.hasCapacity()).toBe(false); // cap=1, full
  });
});

describe('Scheduler — phase machine', () => {
  let startTask: ReturnType<typeof vi.fn>;
  let broadcastResumeForDrain: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    broadcastResumeForDrain = vi.fn();
    s = new Scheduler({ startTask, broadcastResumeForDrain });
  });

  it('starts at idle', () => {
    expect(s.getPhase()).toBe('idle');
  });

  it('transitions to preflight on first enqueue', async () => {
    s.enqueueTask(makeTask('t1'), null);
    expect(s.getPhase()).toBe('preflight');
  });

  it('stays in preflight while a task is preflighting', async () => {
    s.enqueueTask(makeTask('t1'), 'https://a.test');
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    expect(s.getPhase()).toBe('preflight');
  });

  it('transitions to drain when sole active task is preflightReady', async () => {
    s.enqueueTask(makeTask('t1'), 'https://a.test');
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    s.markPreflightReady('t1');
    expect(s.getPhase()).toBe('drain');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const recs = broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[];
    expect(recs).toHaveLength(1);
    expect(recs[0].task.id).toBe('t1');
  });

  it('preflight slot frees on markPreflightReady — next pending starts', async () => {
    s.enqueueTask(makeTask('t1'), 'https://a.test');
    s.enqueueTask(makeTask('t2'), 'https://b.test');
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(1);  // only t1 started
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    s.markPreflightReady('t1');                  // frees slot, t1 paused
    await Promise.resolve();
    expect(startTask).toHaveBeenCalledTimes(2);  // t2 now starts
    expect(startTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 't2' }));
    expect(s.getPhase()).toBe('preflight');      // still preflight — t2 not yet ready
    expect(broadcastResumeForDrain).not.toHaveBeenCalled();
  });

  it('transitions drain → idle after final task ends', async () => {
    s.enqueueTask(makeTask('t1'), 'https://a.test');
    await Promise.resolve();
    s.recordStarted('t1', makeTask('t1'), { tabId: 1, windowId: 10, origin: 'https://a.test' });
    s.markPreflightReady('t1');
    expect(s.getPhase()).toBe('drain');
    s.endTask('t1');
    expect(s.getPhase()).toBe('idle');
  });
});

describe('Scheduler — drain origin gate', () => {
  let startTask: ReturnType<typeof vi.fn>;
  let broadcastResumeForDrain: ReturnType<typeof vi.fn>;
  let s: Scheduler;

  beforeEach(() => {
    startTask = vi.fn();
    broadcastResumeForDrain = vi.fn();
    s = new Scheduler({ startTask, broadcastResumeForDrain });
  });

  // Helper: enqueues a batch of tasks, then walks each one through the
  // record-started → mark-ready sequence in order. By the time the LAST
  // task is marked ready, pending is empty and recomputePhase fires the
  // drain transition (single broadcast). This mirrors how the SW would
  // drive the scheduler in real flow with stub startTask/broadcast cbs.
  async function preflightAll(
    s: Scheduler,
    tasks: Array<{ id: string; origin: string | null; tabId: number; windowId: number }>,
  ): Promise<void> {
    for (const t of tasks) {
      s.enqueueTask(makeTask(t.id), t.origin);
    }
    await Promise.resolve();
    for (const t of tasks) {
      s.recordStarted(t.id, makeTask(t.id), { tabId: t.tabId, windowId: t.windowId, origin: t.origin });
      s.markPreflightReady(t.id);
      await Promise.resolve();
    }
  }

  it('different-origin tasks all resume when transition fires', async () => {
    await preflightAll(s, [
      { id: 't1', origin: 'https://a.test', tabId: 1, windowId: 10 },
      { id: 't2', origin: 'https://b.test', tabId: 2, windowId: 20 },
      { id: 't3', origin: 'https://c.test', tabId: 3, windowId: 30 },
    ]);
    expect(s.getPhase()).toBe('drain');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const resumed = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(new Set(resumed)).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('same-origin tasks serialise — only one resumes per transition', async () => {
    await preflightAll(s, [
      { id: 't1', origin: 'https://a.test', tabId: 1, windowId: 10 },
      { id: 't2', origin: 'https://a.test', tabId: 2, windowId: 20 },
    ]);
    expect(s.getPhase()).toBe('drain');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const firstBroadcast = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(firstBroadcast).toEqual(['t1']);  // Map iteration order is insertion order

    broadcastResumeForDrain.mockClear();
    s.endTask('t1');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const second = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(second).toEqual(['t2']);
  });

  it('drain cap of 4 holds 5+ different-origin tasks', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i + 1}`,
      origin: `https://${i + 1}.test`,
      tabId: i + 1,
      windowId: (i + 1) * 10,
    }));
    await preflightAll(s, tasks);
    expect(s.getPhase()).toBe('drain');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const firstBatch = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(firstBatch).toEqual(['t1', 't2', 't3', 't4']);  // capped at 4 by iteration order

    broadcastResumeForDrain.mockClear();
    s.endTask('t1');
    expect(broadcastResumeForDrain).toHaveBeenCalledTimes(1);
    const second = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(second).toEqual(['t5']);  // next pending-paused in order
  });

  it('null-origin tasks are not gated by origin', async () => {
    await preflightAll(s, [
      { id: 't1', origin: null, tabId: 1, windowId: 10 },
      { id: 't2', origin: null, tabId: 2, windowId: 20 },
    ]);
    expect(s.getPhase()).toBe('drain');
    const resumed = (broadcastResumeForDrain.mock.calls[0][0] as ActiveRemoteTaskShape[])
      .map((r) => r.task.id);
    expect(new Set(resumed)).toEqual(new Set(['t1', 't2']));
  });
});

// Local type alias: the test only needs this thin shape.
type ActiveRemoteTaskShape = { task: { id: string } };
