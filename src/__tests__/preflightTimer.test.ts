import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PreflightTimer } from '../content/scraping/preflightTimer';
import { MessageType } from '../types/messages';

describe('PreflightTimer', () => {
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    emit = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(taskId = 'task-1', durationMs = 5000): PreflightTimer {
    return new PreflightTimer({ taskId, durationMs, emit });
  }

  it('does not emit before durationMs elapses', () => {
    const t = make();
    t.arm();
    vi.advanceTimersByTime(4999);
    expect(emit).not.toHaveBeenCalled();
    expect(t.isReady()).toBe(false);
    expect(t.isPending()).toBe(true);
  });

  it('emits FLOW_PREFLIGHT_READY exactly at durationMs', () => {
    const t = make('task-1', 5000);
    t.arm();
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: MessageType.FLOW_PREFLIGHT_READY,
      payload: { taskId: 'task-1' },
    });
    expect(t.isReady()).toBe(true);
    expect(t.isPending()).toBe(false);
  });

  it('cancel() prevents emission and is idempotent', () => {
    const t = make();
    t.arm();
    vi.advanceTimersByTime(2000);
    t.cancel();
    t.cancel(); // idempotent
    vi.advanceTimersByTime(10000);
    expect(emit).not.toHaveBeenCalled();
    expect(t.isReady()).toBe(false);
    expect(t.isPending()).toBe(false);
  });

  it('arm() after cancel() restarts the full quiet window', () => {
    const t = make('task-1', 5000);
    t.arm();
    vi.advanceTimersByTime(3000);
    t.cancel();
    t.arm();
    vi.advanceTimersByTime(4999);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('multiple arm() calls cancel the prior pending timer', () => {
    const t = make('task-1', 5000);
    t.arm();
    vi.advanceTimersByTime(2000);
    t.arm(); // restart
    vi.advanceTimersByTime(4999);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('force() emits immediately and is one-shot', () => {
    const t = make('task-7');
    t.arm();
    t.force();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: MessageType.FLOW_PREFLIGHT_READY,
      payload: { taskId: 'task-7' },
    });
    expect(t.isReady()).toBe(true);

    t.force();   // already emitted → no-op
    t.arm();     // already emitted → no-op
    vi.advanceTimersByTime(60000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('force() before arm() still emits once', () => {
    const t = make();
    t.force();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(t.isReady()).toBe(true);
  });

  it('arm() after emission is a no-op', () => {
    const t = make();
    t.arm();
    vi.advanceTimersByTime(5000);
    emit.mockClear();
    t.arm();
    vi.advanceTimersByTime(60000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('exposes taskId via getter for the listener correlation in scrapingEngine', () => {
    const t = make('correlate-me');
    expect(t.taskId).toBe('correlate-me');
  });
});
