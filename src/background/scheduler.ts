import type { QueueTask } from '../types/signalr';
import type { DataMapping } from '../types/config';
import { canStartInDrain, DRAIN_PARALLEL_CAP } from './originGate';

// ── Types ────────────────────────────────────────────────────────────────────

export type BatchPhase = 'idle' | 'preflight' | 'drain';

export interface ActiveRemoteTask {
  task: QueueTask;
  tabId: number;
  windowId: number;
  origin: string | null;
  resolvedDataMapping?: DataMapping;
  lastProgress?: { stepLabel: string; termIndex?: number };
  // PR4 additions
  preflightReady: boolean;   // true once FLOW_PREFLIGHT_READY arrived for this task
  drainResumed: boolean;     // true once SW has dispatched RESUME_FOR_DRAIN
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
  preflightReady?: boolean;  // optional for back-compat with pre-PR4 sessions
  drainResumed?: boolean;
}

export interface SchedulerCallbacks {
  // Invoked when the scheduler picks a pending task off the queue.
  // The callback owns window creation + content-script dispatch and
  // must call recordStarted on success or recordStartFailed on any
  // failure, so the start-gate releases.
  startTask: (task: QueueTask) => void;

  // PR4 — broadcast RESUME_FOR_DRAIN to a selection of paused tasks.
  // Called by the scheduler on phase transition into drain and on
  // each endTask while in drain (origin slots free up). Records given
  // are the *new* tasks to resume; their drainResumed flag is already set.
  broadcastResumeForDrain: (records: readonly ActiveRemoteTask[]) => void;
}

interface PendingRecord {
  task: QueueTask;
  origin: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const RECENT_TASKS_CAP = 20;

// ── Scheduler ────────────────────────────────────────────────────────────────

export class Scheduler {
  private active = new Map<string, ActiveRemoteTask>();
  private pending: PendingRecord[] = [];
  private recent: QueueTask[] = [];
  private starting = false;
  private phase: BatchPhase = 'idle';
  private drainCap = DRAIN_PARALLEL_CAP;

  constructor(private cb: SchedulerCallbacks) {}

  // ── Phase introspection ──

  getPhase(): BatchPhase {
    return this.phase;
  }

  setDrainParallelCap(cap: number): void {
    if (!Number.isFinite(cap) || cap < 1) return;
    this.drainCap = Math.floor(cap);
    // If we're already in drain, see if we can resume more.
    if (this.phase === 'drain') {
      const next = this.pickResumable();
      if (next.length > 0) this.cb.broadcastResumeForDrain(next);
    }
  }

  // ── Pending queue ──

  enqueueTask(task: QueueTask, origin: string | null): void {
    if (this.active.has(task.id)) return;
    if (this.pending.some((p) => p.task.id === task.id)) return;
    this.pending.push({ task, origin });
    if (this.phase === 'idle') this.phase = 'preflight';
    this.tryStartNext();
  }

  cancelPending(taskId: string): boolean {
    const idx = this.pending.findIndex((p) => p.task.id === taskId);
    if (idx === -1) return false;
    this.pending.splice(idx, 1);
    this.recomputePhase();
    return true;
  }

  // ── Start gate ──

  // Pulls the next pending task into preflight. No-op outside the
  // preflight phase (drain phase resumes are handled by pickResumable).
  tryStartNext(): void {
    if (this.starting) return;
    if (this.phase !== 'preflight') return;
    if (this.preflightingCount() >= 1) return;
    if (this.pending.length === 0) {
      // Nothing to preflight — see if we can transition to drain.
      this.recomputePhase();
      return;
    }
    const next = this.pending.shift()!;
    this.starting = true;
    queueMicrotask(() => {
      try {
        this.cb.startTask(next.task);
      } catch (err) {
        console.error('[Scheduler] startTask threw synchronously:', err);
        this.recordStartFailed(next.task.id);
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
      preflightReady: false,
      drainResumed: false,
    });
    this.starting = false;
    // Preflight slot just filled; nothing to drain (drain transitions are
    // gated on preflightReady). No further start attempts here.
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

  // PR4 — called by SW when a content script emits FLOW_PREFLIGHT_READY.
  // Idempotent. Frees the preflight slot so the next pending task can
  // start; if pending is empty and all active are ready, transitions
  // to drain and broadcasts.
  markPreflightReady(taskId: string): void {
    const r = this.active.get(taskId);
    if (!r) return;
    if (r.preflightReady) return;
    r.preflightReady = true;
    // Preflight slot freed. Try to start the next pending task.
    this.tryStartNext();
    // If pending was already empty and all active ready, transition.
    this.recomputePhase();
  }

  // PR4 — removes an active record. In drain, frees the origin slot
  // and tries to resume more. In all phases, recomputes phase.
  // Returns the record so SW can run side-effects (window close, etc.).
  endTask(taskId: string): ActiveRemoteTask | undefined {
    const r = this.active.get(taskId);
    if (!r) return undefined;
    this.active.delete(taskId);

    if (this.phase === 'drain') {
      const next = this.pickResumable();
      if (next.length > 0) this.cb.broadcastResumeForDrain(next);
    }

    this.recomputePhase();
    // tryStartNext only does work in preflight; safe regardless.
    this.tryStartNext();
    return r;
  }

  // ── Phase transitions ──

  // Single source of truth for phase changes. Called from every
  // state mutator. Transitions only happen here.
  private recomputePhase(): void {
    // While a task is mid-start (cb.startTask in flight, recordStarted not
    // yet called), pending has been shifted but active hasn't been updated.
    // Bail; the next mutator after recordStarted will recompute correctly.
    if (this.starting) return;

    if (this.active.size === 0 && this.pending.length === 0) {
      this.phase = 'idle';
      return;
    }
    if (this.phase === 'idle') {
      // Active or pending exists → preflight.
      this.phase = 'preflight';
    }
    if (this.phase === 'preflight') {
      if (this.pending.length === 0 && this.active.size > 0 && this.allActiveReady()) {
        this.phase = 'drain';
        const next = this.pickResumable();
        if (next.length > 0) this.cb.broadcastResumeForDrain(next);
      }
    }
    if (this.phase === 'drain' && this.active.size === 0) {
      // All draining tasks finished; if pending exists, return to preflight.
      this.phase = this.pending.length > 0 ? 'preflight' : 'idle';
    }
  }

  // Picks tasks to resume in drain phase. Marks them as drainResumed
  // (mutates state). Returns the records so SW can broadcast.
  private pickResumable(): ActiveRemoteTask[] {
    if (this.phase !== 'drain') return [];

    const origins = new Set<string>();
    let runningCount = 0;
    for (const r of this.active.values()) {
      if (r.drainResumed) {
        runningCount++;
        if (r.origin) origins.add(r.origin);
      }
    }

    const out: ActiveRemoteTask[] = [];
    for (const r of this.active.values()) {
      if (r.drainResumed) continue;
      if (!r.preflightReady) continue;
      if (!canStartInDrain(r.origin, origins, runningCount, this.drainCap)) continue;
      r.drainResumed = true;
      runningCount++;
      if (r.origin) origins.add(r.origin);
      out.push(r);
    }
    return out;
  }

  private preflightingCount(): number {
    let n = 0;
    for (const r of this.active.values()) if (!r.preflightReady) n++;
    return n;
  }

  private allActiveReady(): boolean {
    for (const r of this.active.values()) if (!r.preflightReady) return false;
    return true;
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
        preflightReady: r.preflightReady ?? false,
        drainResumed: r.drainResumed ?? false,
      });
    }
    // Recompute the phase from the restored set so subsequent enqueues
    // pick up correctly. Restored tasks with preflightReady && drainResumed
    // count as drain-running; without preflightReady they count as preflighting.
    if (this.active.size > 0) {
      const allReady = this.allActiveReady();
      const anyDrainResumed = [...this.active.values()].some((r) => r.drainResumed);
      this.phase = allReady && anyDrainResumed ? 'drain' : 'preflight';
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
      preflightReady: r.preflightReady,
      drainResumed: r.drainResumed,
    }));
  }

  // ── Snapshots ──

  getActiveTask(taskId: string): ActiveRemoteTask | undefined {
    return this.active.get(taskId);
  }

  getActiveTasks(): ReadonlyMap<string, ActiveRemoteTask> {
    return this.active;
  }

  getFirstActive(): ActiveRemoteTask | undefined {
    const it = this.active.values().next();
    return it.done ? undefined : it.value;
  }

  findByTabId(tabId: number): ActiveRemoteTask | undefined {
    for (const r of this.active.values()) if (r.tabId === tabId) return r;
    return undefined;
  }

  getPendingTasks(): readonly QueueTask[] {
    return this.pending.map((p) => p.task);
  }

  hasCapacity(): boolean {
    if (this.starting) return false;
    if (this.phase === 'preflight') return this.preflightingCount() < 1;
    if (this.phase === 'drain') return this.active.size < this.drainCap;
    return true;
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
