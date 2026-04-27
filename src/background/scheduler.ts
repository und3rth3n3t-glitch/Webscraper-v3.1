import type { QueueTask } from '../types/signalr';
import type { DataMapping } from '../types/config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActiveRemoteTask {
  task: QueueTask;
  tabId: number;
  windowId: number;
  origin: string | null;
  resolvedDataMapping?: DataMapping;
  lastProgress?: { stepLabel: string; termIndex?: number };
}

export interface StartInfo {
  tabId: number;
  windowId: number;
  origin: string | null;
  resolvedDataMapping?: DataMapping;
}

export interface PersistedActiveRecord {
  taskId: string;
  task: QueueTask;
  tabId: number;
  windowId: number;
  origin: string | null;
  resolvedDataMapping?: DataMapping;
  lastProgress?: { stepLabel: string; termIndex?: number };
}

export interface SchedulerCallbacks {
  // Invoked by tryStartNext() when a task has been picked off the pending
  // queue and the starting-flight slot has been claimed. The callback owns
  // the full async start sequence: window creation, content-script dispatch,
  // and (on success) calling recordStarted; on any failure it must call
  // recordStartFailed so the gate releases.
  startTask: (task: QueueTask) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const RECENT_TASKS_CAP = 20;
export const DEFAULT_PARALLEL_CAP = 1;

// ── Scheduler ────────────────────────────────────────────────────────────────

export class Scheduler {
  private active = new Map<string, ActiveRemoteTask>();
  private pending: QueueTask[] = [];
  private recent: QueueTask[] = [];
  private starting = false;
  private cap = DEFAULT_PARALLEL_CAP;

  constructor(private cb: SchedulerCallbacks) {}

  // ── Pending queue ──

  enqueueTask(task: QueueTask): void {
    if (this.active.has(task.id)) return;
    if (this.pending.some((t) => t.id === task.id)) return;
    this.pending.push(task);
    this.tryStartNext();
  }

  cancelPending(taskId: string): boolean {
    const idx = this.pending.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    this.pending.splice(idx, 1);
    return true;
  }

  // ── Start gate ──

  tryStartNext(): void {
    if (this.starting) return;
    if (this.active.size >= this.cap) return;
    if (this.pending.length === 0) return;
    const next = this.pending.shift()!;
    this.starting = true;
    // Defer the cb to a microtask so an exception in startTask doesn't
    // unwind the synchronous caller (e.g. enqueueTask / endTask). The
    // cb itself is responsible for calling recordStarted or recordStartFailed.
    queueMicrotask(() => {
      try {
        this.cb.startTask(next);
      } catch (err) {
        console.error('[Scheduler] startTask threw synchronously:', err);
        this.recordStartFailed(next.id);
      }
    });
  }

  recordStarted(taskId: string, task: QueueTask, info: StartInfo): void {
    if (this.active.has(taskId)) return;
    this.active.set(taskId, {
      task: { ...task, status: 'running' },
      tabId: info.tabId,
      windowId: info.windowId,
      origin: info.origin,
      resolvedDataMapping: info.resolvedDataMapping,
    });
    this.starting = false;
    // Don't auto-drain here — cap == 1 in PR2 means the active slot is full.
    // PR4 will raise cap and tryStartNext will fire again here.
    if (this.active.size < this.cap) this.tryStartNext();
  }

  recordStartFailed(_taskId: string): void {
    this.starting = false;
    this.tryStartNext();
  }

  // ── Active task mutators ──

  setProgress(taskId: string, progress: { stepLabel: string; termIndex?: number }): void {
    const r = this.active.get(taskId);
    if (!r) return;
    r.lastProgress = progress;
  }

  // Removes the record from the active map. Returns the record so the SW
  // can run side-effects (window close, hub relay, session-storage update).
  // Automatically tries to start the next pending task.
  endTask(taskId: string): ActiveRemoteTask | undefined {
    const r = this.active.get(taskId);
    if (!r) return undefined;
    this.active.delete(taskId);
    this.tryStartNext();
    return r;
  }

  // ── Recent history ──

  pushRecent(task: QueueTask): void {
    const idx = this.recent.findIndex((t) => t.id === task.id);
    if (idx !== -1) this.recent.splice(idx, 1);
    this.recent.unshift(task);
    if (this.recent.length > RECENT_TASKS_CAP) this.recent.length = RECENT_TASKS_CAP;
  }

  setRecent(tasks: QueueTask[]): void {
    this.recent = tasks.slice(0, RECENT_TASKS_CAP);
  }

  getRecent(): readonly QueueTask[] {
    return this.recent;
  }

  // ── Persistence ──

  // Hydrate from chrome.storage.session on SW restart. Bypasses the start
  // gate — these tasks already have live windows and tabs.
  restoreActive(records: readonly PersistedActiveRecord[]): void {
    for (const r of records) {
      if (this.active.has(r.taskId)) continue;
      this.active.set(r.taskId, {
        task: r.task,
        tabId: r.tabId,
        windowId: r.windowId,
        origin: r.origin,
        resolvedDataMapping: r.resolvedDataMapping,
        lastProgress: r.lastProgress,
      });
    }
  }

  serializeActive(): PersistedActiveRecord[] {
    return [...this.active.entries()].map(([taskId, r]) => ({
      taskId,
      task: r.task,
      tabId: r.tabId,
      windowId: r.windowId,
      origin: r.origin,
      resolvedDataMapping: r.resolvedDataMapping,
      lastProgress: r.lastProgress,
    }));
  }

  // ── Snapshots ──

  getActiveTask(taskId: string): ActiveRemoteTask | undefined {
    return this.active.get(taskId);
  }

  getActiveTasks(): ReadonlyMap<string, ActiveRemoteTask> {
    return this.active;
  }

  // PR2 returns the (only) active task. PR5 will retire callers in favour
  // of getActiveTasks().
  getFirstActive(): ActiveRemoteTask | undefined {
    const it = this.active.values().next();
    return it.done ? undefined : it.value;
  }

  findByTabId(tabId: number): ActiveRemoteTask | undefined {
    for (const r of this.active.values()) if (r.tabId === tabId) return r;
    return undefined;
  }

  getPendingTasks(): readonly QueueTask[] {
    return this.pending;
  }

  hasCapacity(): boolean {
    return !this.starting && this.active.size < this.cap;
  }

  isStarting(): boolean {
    return this.starting;
  }

  getActiveCount(): number {
    return this.active.size;
  }

  getPendingCount(): number {
    return this.pending.length;
  }
}
