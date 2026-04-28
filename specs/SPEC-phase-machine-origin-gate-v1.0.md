# SPEC-PR4 — Phase machine + same-origin gate + drain pause
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1 (`aff52ba`), PR1.5 (`63f902b`), PR2 (`226f480`), PR3 (`9d0408b`).

---

## Context

PR4 turns the foundation laid in PR2 (Scheduler Map) and PR3 (preflight quiet timer) into actual batched-parallel behaviour. After PR4:

- The scheduler runs a 3-state phase machine: `idle → preflight → drain → idle`.
- During **preflight**, only one task is preflighting at a time, foreground. preflightReady tasks pause in their content script and accumulate.
- Phase auto-transitions to **drain** when pending is empty and all active tasks are `preflightReady`.
- During **drain**, the scheduler broadcasts `RESUME_FOR_DRAIN` selectively, respecting the parallel cap and a same-origin gate.
- Same-origin gating: tasks whose origin matches an already-draining task wait until that task completes.
- The legacy `RESUME_AFTER_CLOUDFLARE` message-type alias from PR1 is dropped.

This is the first PR with **observable behaviour change**: queue-mode tasks now briefly pause at the preflight-ready point and wait for SW to say "go". For single-task runs the pause is microseconds (drain triggers immediately when pending is empty and the lone task is ready). For multi-task batches the pause is meaningful — the user can clear auth on one tab, walk to the next.

**Out of scope (deferred):**
- UI for batch settings or the BatchTaskList panel — PR5.
- Reading `batchParallelCap` from settings into the SW — PR5 (PR4 hardcodes the constant).
- Notifications — PR6.
- Manual "Start drain" / "Mark ready" buttons — PR5 (the `FORCE_PREFLIGHT_READY` message wired in PR3 already covers Mark ready functionally).
- Concurrent batches (block second batch start) — PR5/6.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Phase machine | `src/background/scheduler.ts` | Add `phase`, `preflightReady` + `drainResumed` per task, transition methods |
| Origin gating logic | `src/background/originGate.ts` (new) | Pure `canStartInDrain` predicate |
| Pending records carry origin | `src/background/scheduler.ts` | `enqueueTask(task, origin)` signature change |
| SW broadcast on transition | `src/entrypoints/background.ts` | `broadcastResumeForDrain` callback; resolve origin asynchronously at TASK_RECEIVED |
| Content script: pause for drain | `src/content/scraping/scrapingEngine.ts` | New `waitForResumeForDrain` helper + checkpoint at top of each search-term iteration |
| Drop legacy alias | `src/content/scraping/scrapingEngine.ts` | `waitForResumeSignal` no longer accepts `RESUME_AFTER_CLOUDFLARE` |
| Settings field | `src/sidepanel/stores/settingsStore.ts` | `batchParallelCap: number` (default 4) — UI surface deferred |
| Tests | `src/__tests__/originGate.test.ts` (new), `src/__tests__/scheduler.test.ts` (extended) | Origin gate predicate; phase transitions; drain cap; broadcast selection |

**Reuse:**
- `originOf` from PR2 (`src/background/originOf.ts`) — used by both originGate and the SW.
- `MessageType` constants (already has `RESUME_FOR_DRAIN`, `FORCE_PREFLIGHT_READY`, `FLOW_PREFLIGHT_READY` from PR3).
- `Scheduler` class structure from PR2 — extended in place.
- `swLog`, `relayHubInvocation`, etc.

**Maintainability principles:**
- Phase machine is one method (`recomputePhase`); transitions only flow through it.
- Same-origin gate is a pure function — fully unit-testable.
- Scheduler still owns all `active` map mutations; SW callbacks are thin glue.
- `drainParallelCap` lives in a constant + scheduler setter; settings UI deferred.
- No magic strings; all wire-protocol literals come from `MessageType`.

---

## Locked decisions (do not re-litigate)

| # | Decision | Choice |
|---|---|---|
| 1 | Phase model | `idle | preflight | drain` only (no per-task batch IDs in PR4) |
| 2 | Phase transition trigger | Auto: `idle→preflight` on first enqueue; `preflight→drain` when pending empty AND all active preflightReady; `drain→idle` when active empty |
| 3 | Preflight slot | At most 1 *preflighting* task at a time. preflightReady tasks accumulate in active map without consuming the slot |
| 4 | Drain cap | Hardcoded constant `DRAIN_PARALLEL_CAP = 4` in PR4. Settings field exists, wiring deferred to PR5 |
| 5 | Same-origin gating | Skip-not-block: when picking next task to resume, skip tasks whose origin matches an already-draining task. They stay paused; resume on next opportunity |
| 6 | Origin-unknown tasks | Treated as null origin → never gated by origin (cap still applies) |
| 7 | Resume selection on transition | Scheduler picks tasks to resume up to cap & origin gate; SW broadcasts to selected tabIds only |
| 8 | Re-enqueue during drain | Permitted; pending tasks wait until current drain completes (phase returns to idle, then preflight) |
| 9 | Single-task semantics | A queue-mode task with no peers reaches preflightReady → phase auto-transitions to drain immediately → broadcast fires within microseconds → engine resumes. Net delay: negligible |
| 10 | Sub-5s flow (timer never fires) | No pause, no preflightReady, no drain. Engine completes; endTask removes; phase returns to idle. Acceptable |
| 11 | Pause-for-drain location in engine | At top of each search-term iteration, AFTER `checkAbort()`. NOT mid-step. Setup runs to completion before any drain pause |
| 12 | Drop `RESUME_AFTER_CLOUDFLARE` legacy alias | Yes — PR1 introduced it for a one-release migration window; that window closed at PR3 |

---

## File 1 (NEW): `src/background/originGate.ts`

```typescript
// Same-origin gate for the drain phase. Pure functions only — all
// scheduler state passed in. Fully unit-testable without DOM/runtime.

export const DRAIN_PARALLEL_CAP = 4;

// Returns true if a task with the given origin can start (or resume into
// drain) right now, given the set of origins already running in drain
// and the running count vs cap.
//   - origin === null  → no origin gate (still subject to cap)
//   - cap === 0        → never startable
//   - runningCount >= cap → never startable
//   - origin in activeOrigins → blocked
export function canStartInDrain(
  origin: string | null,
  activeOrigins: ReadonlySet<string>,
  runningCount: number,
  cap: number,
): boolean {
  if (cap <= 0) return false;
  if (runningCount >= cap) return false;
  if (origin !== null && activeOrigins.has(origin)) return false;
  return true;
}
```

---

## File 2 (MODIFIED): `src/background/scheduler.ts`

### 2a — Add types and state

**Locate** the `// ── Types ──` block (lines 4–39). **Replace** the `ActiveRemoteTask` interface (currently lines 6–13) with:

```typescript
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
```

**Replace** the `PersistedActiveRecord` interface (currently lines 22–30):

```typescript
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
```

**Replace** the `SchedulerCallbacks` interface (currently lines 32–39):

```typescript
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
```

### 2b — Add a `PendingRecord` shape so origin travels with the queued task

**After** the `SchedulerCallbacks` interface, **insert**:

```typescript
interface PendingRecord {
  task: QueueTask;
  origin: string | null;
}
```

### 2c — Add new import; replace constants block

At the **top of the file**, alongside the existing `import type { QueueTask } from '../types/signalr';` etc. (currently lines 1–2), **insert**:

```typescript
import { canStartInDrain, DRAIN_PARALLEL_CAP } from './originGate';
```

Then **replace** the constants block (currently lines 43–44):

```typescript
export const RECENT_TASKS_CAP = 20;
export const DEFAULT_PARALLEL_CAP = 1;
```

with:

```typescript
export const RECENT_TASKS_CAP = 20;
```

(The `DEFAULT_PARALLEL_CAP` export is no longer needed — preflight is implicitly capped at 1 inside the scheduler. `DRAIN_PARALLEL_CAP` lives in `originGate.ts`.)

### 2d — Replace the Scheduler class

**Full replacement** of the `Scheduler` class (lines 48 to end of file). The previous private fields, public methods, and behaviour are preserved where possible; new methods and phase-aware logic are layered in.

```typescript
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
```

**Note on removed exports:**
- `DEFAULT_PARALLEL_CAP` was unused outside scheduler — its only callers were tests (which the new test file replaces) and the scheduler itself. Drop the export.
- `StartInfo` is unchanged from PR2 — keep its export.

---

## File 3 (MODIFIED): `src/entrypoints/background.ts`

### 3a — Resolve origin asynchronously at TASK_RECEIVED

**Locate** the `TASK_RECEIVED` handler (currently around line 446):

```typescript
    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      scheduler.enqueueTask(task);
      return;
    }
```

**Replace** with an async resolver. The origin comes from inlineConfig.url if present, else from a stored config lookup:

```typescript
    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      // Resolve origin async so the same-origin gate has data to work with
      // during drain. Tasks without a resolvable URL get null origin and
      // are treated as ungated.
      void (async () => {
        let origin: string | null = null;
        try {
          if (task.inlineConfig?.url) {
            origin = originOf(task.inlineConfig.url);
          } else {
            const localConfigs = await getAllConfigs();
            const cfg = localConfigs.find((c) => c.id === task.configId);
            if (cfg?.url) origin = originOf(cfg.url);
          }
        } catch {
          // resolution failure → null origin, no gate
        }
        scheduler.enqueueTask(task, origin);
      })();
      return;
    }
```

### 3b — Wire `broadcastResumeForDrain` callback into the Scheduler constructor

**Locate** the Scheduler construction (currently lines 37–45):

```typescript
  const scheduler = new Scheduler({
    startTask: (task) => {
      startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
    },
  });
```

**Replace** with:

```typescript
  const scheduler = new Scheduler({
    startTask: (task) => {
      startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
    },
    broadcastResumeForDrain: (records) => {
      for (const r of records) {
        console.warn('[SW] RESUME_FOR_DRAIN | taskId:', r.task.id, '| tabId:', r.tabId, '| origin:', r.origin);
        chrome.tabs.sendMessage(r.tabId, {
          type: 'RESUME_FOR_DRAIN',
          payload: { taskId: r.task.id },
        }).catch((err: Error) => {
          console.error('[SW] RESUME_FOR_DRAIN send failed | taskId:', r.task.id, '| err:', err.message);
        });
      }
    },
  });
```

### 3c — Wire `FLOW_PREFLIGHT_READY` into `markPreflightReady`

**Locate** the existing log-only branch added in PR3 (currently around lines 607–614):

```typescript
      if (type === 'FLOW_PREFLIGHT_READY') {
        const p = (message.payload ?? {}) as { taskId?: string };
        const record = p.taskId ? scheduler.getActiveTask(p.taskId) : undefined;
        console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| recordKnown:', !!record);
        // PR4 will transition the task in the scheduler here. PR3 just logs
        // and falls through to the relay — sidepanel can already subscribe
        // (PR5) without further wiring.
      }
```

**Replace** with:

```typescript
      if (type === 'FLOW_PREFLIGHT_READY') {
        const p = (message.payload ?? {}) as { taskId?: string };
        if (p.taskId) {
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseBefore:', scheduler.getPhase());
          scheduler.markPreflightReady(p.taskId);
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseAfter:', scheduler.getPhase());
        } else {
          console.warn('[SW] FLOW_PREFLIGHT_READY ignored — no taskId');
        }
      }
```

### 3d — Drop `RESUME_AFTER_CLOUDFLARE` from the resume-intercept conditional

**Locate** the resume interceptor (currently around lines 472–519). The current first line:

```typescript
    if (type === 'RESUME_AFTER_PAUSE' || type === 'RESUME_AFTER_CLOUDFLARE') {
```

**Replace** with:

```typescript
    if (type === 'RESUME_AFTER_PAUSE') {
```

The legacy alias was kept for one release after PR1 (commit `aff52ba`); that release window has now passed.

### 3e — Remove `RESUME_AFTER_CLOUDFLARE` from the `sidepanelToContent` relay list

**Locate** the `sidepanelToContent` array (currently around lines 636–641):

```typescript
    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_CLOUDFLARE', 'RESUME_AFTER_PAUSE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
```

**Replace** with (drop `'RESUME_AFTER_CLOUDFLARE'`):

```typescript
    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_PAUSE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
```

### 3f — Update the inline `RESUME_TASK` server-initiated handler

**Locate** the `RESUME_TASK` handler (currently around lines 454–463). It currently sends `RESUME_AFTER_CLOUDFLARE`. Replace with `RESUME_AFTER_PAUSE`:

```typescript
    if (type === 'RESUME_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_PAUSE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_PAUSE failed:', err));
        activePauseState = null;
      }
      return;
    }
```

---

## File 4 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### 4a — Add module-scope drain-resumed flag

**After** the `let activePreflightTimer: PreflightTimer | null = null;` declaration (added in PR3, around line 60), **insert**:

```typescript
// PR4 — set true once SW has dispatched RESUME_FOR_DRAIN for the current
// flow's taskId. Cleared at flow start. Module-scope so the drain pause
// checkpoint can short-circuit subsequent iterations.
let drainResumed = false;
```

### 4b — Reset `drainResumed` at flow start

**Inside** `executeFlow`, in the same block as the timer construction (the block starting `if (taskId) {` around line 153), **append** after `activePreflightTimer.arm();`:

```typescript
    drainResumed = false;
```

The block now looks like:

```typescript
  if (taskId) {
    activePreflightTimer = new PreflightTimer({...});
    activePreflightTimer.arm();
    swLog('[preflightTimer] armed | taskId:', taskId, '| durationMs:', PREFLIGHT_QUIET_MS);
    drainResumed = false;
  }
```

### 4c — Add `waitForResumeForDrain` and `maybePauseForDrain` helpers

**After** the existing `waitForResumeSignal` function (in PR3 era around line 390, plus PR3's added timer code may have shifted line numbers — anchor on the `waitForResumeSignal` function definition), **append**:

```typescript
function waitForResumeForDrain(taskId: string): Promise<void> {
  swLog('[waitForResumeForDrain] arming | taskId:', taskId);
  return new Promise((resolve) => {
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; payload?: { taskId?: string } } | null;
      if (m?.type !== MessageType.RESUME_FOR_DRAIN) return;
      if (m.payload?.taskId !== taskId) return;
      swLog('[waitForResumeForDrain] resumed | taskId:', taskId);
      browser.runtime.onMessage.removeListener(handler);
      resolve();
    };
    browser.runtime.onMessage.addListener(handler);
  });
}

// Pause-for-drain checkpoint. No-op for sidepanel-only flows (no taskId),
// for flows whose preflight timer hasn't fired yet, and for flows that
// have already resumed once. Called at the top of every search-term
// iteration in batch mode — not mid-step.
async function maybePauseForDrain(taskId: string | undefined): Promise<void> {
  if (!taskId) return;
  if (drainResumed) return;
  if (!activePreflightTimer?.isReady()) return;
  swLog('[maybePauseForDrain] awaiting RESUME_FOR_DRAIN | taskId:', taskId);
  await waitForResumeForDrain(taskId);
  drainResumed = true;
}
```

### 4d — Drop `RESUME_AFTER_CLOUDFLARE` legacy alias from `waitForResumeSignal`

**Locate** the existing `waitForResumeSignal` function. The current handler accepts both names:

```typescript
      if (t === MessageType.RESUME_AFTER_PAUSE || t === 'RESUME_AFTER_CLOUDFLARE') {
```

**Replace** with:

```typescript
      if (t === MessageType.RESUME_AFTER_PAUSE) {
```

### 4e — Add the drain-pause checkpoint at top of each term iteration

**Locate** the term loop (currently starts around line 179):

```typescript
    for (let i = startTermIndex; i < terms.length; i++) {
      const term = terms[i];
      checkAbort();

      sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'running', taskId });
```

**Insert** the checkpoint between `checkAbort();` and `sendProgress(...)`:

```typescript
    for (let i = startTermIndex; i < terms.length; i++) {
      const term = terms[i];
      checkAbort();

      // PR4 — pause for drain (batch-mode only; no-op otherwise). Placed
      // at top of iteration so setup runs to completion first; pause is
      // bounded by at most one in-flight iteration.
      await maybePauseForDrain(taskId);

      sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'running', taskId });
```

---

## File 5 (MODIFIED): `src/sidepanel/stores/settingsStore.ts`

### 5a — Add `batchParallelCap` field

**Replace** the `SettingsState` interface (currently in PR3 era — anchor on the existing interface block):

Add the new field next to `batchPreflightQuietMs`:

```typescript
  // PR3
  batchPreflightQuietMs: number;
  // PR4 — drain-phase parallel cap (max concurrent drain windows). Surfaced
  // in settings UI in PR5. Default mirrors DRAIN_PARALLEL_CAP in
  // src/background/originGate.ts. SW reads via message in PR5; PR4 is
  // hardcoded to the default in the scheduler.
  batchParallelCap: number;
```

And the setter:

```typescript
  setBatchPreflightQuietMs: (ms: number) => void;
  setBatchParallelCap: (cap: number) => void;
```

### 5b — Default + setter + partialize

In the store body, add the initial value and setter alongside the PR3 ones:

```typescript
      batchPreflightQuietMs: 5000,
      batchParallelCap: 4,

      // ...other setters unchanged...

      setBatchPreflightQuietMs: (batchPreflightQuietMs) =>
        set({ batchPreflightQuietMs }),
      setBatchParallelCap: (batchParallelCap) =>
        set({ batchParallelCap }),
```

In the `partialize` config, add the new key:

```typescript
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        pauseOnCloudflare: s.pauseOnCloudflare,
        mode: s.mode,
        workerName: s.workerName,
        batchPreflightQuietMs: s.batchPreflightQuietMs,
        batchParallelCap: s.batchParallelCap,
      }),
```

---

## File 6 (NEW): `src/__tests__/originGate.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { canStartInDrain, DRAIN_PARALLEL_CAP } from '../background/originGate';

describe('canStartInDrain', () => {
  it('exports a positive default cap', () => {
    expect(DRAIN_PARALLEL_CAP).toBeGreaterThanOrEqual(1);
  });

  it('blocks when running count meets cap', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://b.test']), 4, 4)).toBe(false);
  });

  it('blocks when origin already running', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://a.test']), 1, 4)).toBe(false);
  });

  it('allows when origin not running and under cap', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://b.test']), 2, 4)).toBe(true);
  });

  it('null origin is never gated by origin (cap still applies)', () => {
    expect(canStartInDrain(null, new Set(['https://a.test']), 1, 4)).toBe(true);
    expect(canStartInDrain(null, new Set(), 4, 4)).toBe(false);
  });

  it('cap of zero blocks everything', () => {
    expect(canStartInDrain('https://a.test', new Set(), 0, 0)).toBe(false);
  });

  it('cap of one allows exactly one task', () => {
    expect(canStartInDrain('https://a.test', new Set(), 0, 1)).toBe(true);
    expect(canStartInDrain('https://a.test', new Set(), 1, 1)).toBe(false);
  });
});
```

---

## File 7 (MODIFIED): `src/__tests__/scheduler.test.ts`

### 7a — Update the existing `enqueueTask` calls to pass an origin

The existing test file calls `s.enqueueTask(makeTask('t1'))` (single-arg). After PR4 the signature is `enqueueTask(task, origin)`. **Find every call site and update** — search for `s.enqueueTask(`. For each call site, pass `null` as the second argument unless an origin-specific test requires otherwise. Example transformation:

Before:
```typescript
s.enqueueTask(makeTask('t1'));
```

After:
```typescript
s.enqueueTask(makeTask('t1'), null);
```

### 7b — Update the test setup to satisfy the new callback shape

The existing test constructs the Scheduler as:

```typescript
s = new Scheduler({ startTask });
```

After PR4 the callback shape requires `broadcastResumeForDrain`. Update the `beforeEach` blocks to include a stub:

```typescript
let startTask: ReturnType<typeof vi.fn>;
let broadcastResumeForDrain: ReturnType<typeof vi.fn>;
let s: Scheduler;

beforeEach(() => {
  startTask = vi.fn();
  broadcastResumeForDrain = vi.fn();
  s = new Scheduler({ startTask, broadcastResumeForDrain });
});
```

Apply this update to **all** `beforeEach` blocks in the file. Standalone `new Scheduler({ startTask: vi.fn() })` constructions should also be updated to `new Scheduler({ startTask: vi.fn(), broadcastResumeForDrain: vi.fn() })`.

### 7c — Update existing assertions that depend on the new shape

Two existing assertions need adjustment:

1. **`recordStarted` test**: the active record now has `preflightReady: false`, `drainResumed: false` defaults. Existing tests that match record fields should work as-is (they `expect(r?.tabId).toBe(1)` etc., which still hold). No change needed unless a test snapshots the whole record.

2. **`hasCapacity` test** (in `restoreActive does not bypass start-gate semantics`): currently asserts `s.hasCapacity() === false` after restoring 1 record. After PR4 the cap depends on phase. With 1 restored task that has `preflightReady: false` → phase = preflight → `preflightingCount() === 1` → `hasCapacity() === false`. Still holds. ✓

3. **The `enqueueTask` tests now take an origin** — see 7a. Specifically the tests that check duplicate-rejection should pass the same origin or null consistently:

```typescript
it('rejects duplicate enqueues by taskId (active)', async () => {
  s.enqueueTask(makeTask('t1'), null);
  await Promise.resolve();
  s.recordStarted('t1', makeTask('t1'), STD_INFO);
  s.enqueueTask(makeTask('t1'), null);
  expect(s.getPendingCount()).toBe(0);
});
```

### 7d — Add new describe blocks

**Append** the following describe blocks at the end of the file:

```typescript
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
```

**Place the `type ActiveRemoteTaskShape = …;` line at the very bottom of the file**, outside any `describe` block.

---

## What is deleted

| What | Where |
|---|---|
| `DEFAULT_PARALLEL_CAP` export | `src/background/scheduler.ts` (replaced by phase-aware `drainCap`; preflight cap is implicit at 1) |
| `RESUME_AFTER_CLOUDFLARE` legacy alias acceptance in `waitForResumeSignal` | `src/content/scraping/scrapingEngine.ts` |
| `RESUME_AFTER_CLOUDFLARE` from `sidepanelToContent` and `RESUME_TASK` handlers | `src/entrypoints/background.ts` |

---

## Verification

### Automated

```bash
# From repo root.
npm test -- src/__tests__/originGate.test.ts
npm test -- src/__tests__/scheduler.test.ts
npm test                              # full suite
npm run type-check                    # output must equal pre-PR4 baseline
npm run lint -- src/background/originGate.ts src/background/scheduler.ts src/entrypoints/background.ts src/content/scraping/scrapingEngine.ts src/sidepanel/stores/settingsStore.ts
npm run build
```

**Pre-existing typecheck noise (do NOT fix in this PR):**
- `src/__tests__/runDetectorWatchdog.test.ts` — `CloudflareChallenge` mock missing `type`
- `src/entrypoints/background.ts` and `src/offscreen/messageHandler.ts` — `OnMessageListener` `true | undefined` strictness
- `src/entrypoints/content.ts` — `ScraperConfig`-to-`Record<string, unknown>` cast
- `src/sidepanel/components/DataMappingView.tsx`, `ResultsView.tsx`, `src/types/index.ts` — pre-existing

These existed on commit `9d0408b`. After PR4, the type-check output **must be identical** to that baseline. If new errors appear, stop and report.

### Manual smoke (5 cases)

Build with `npm run build`. Load `.output/chrome-mv3` unpacked. Open SW DevTools console + the active scrape window's content console.

1. **Single-task batch** — enqueue one queue-mode task. Expect SW console:
   - `[SW] FLOW_PREFLIGHT_READY | taskId: <id> | phaseBefore: preflight`
   - `[SW] FLOW_PREFLIGHT_READY | taskId: <id> | phaseAfter: drain`
   - `[SW] RESUME_FOR_DRAIN | taskId: <id> | tabId: …`
   Content console:
   - `[waitForResumeForDrain] arming`
   - `[waitForResumeForDrain] resumed`
   Total user-visible delay ≤ 100 ms. Task completes normally.

2. **Two-task batch, different origins** — enqueue T1 (a.example.com) and T2 (b.example.com). Expect:
   - T1 starts foreground, you clear auth, watchdog quiets for 5s.
   - SW console: `phaseAfter: preflight` (T2 still pending).
   - T2 starts foreground (T1 is paused awaiting RESUME_FOR_DRAIN, T1's window minimised? No — PR4 doesn't minimise; PR5 will).
   - You clear T2's auth. After T2 quiets: phase = drain. Both resume.

3. **Two-task batch, same origin** — both on a.example.com. Same as case 2 except after phase=drain: SW broadcasts RESUME_FOR_DRAIN to ONE task. The other stays paused. When the running task completes, the paused one resumes (verify via `[SW] RESUME_FOR_DRAIN`).

4. **Sub-5s flow back-compat** — enqueue a config that completes in <5s (no awaits, simple page). Expect:
   - No `[preflightTimer] elapsed` log (timer cancelled in finally before it fires).
   - No `[waitForResumeForDrain]` logs.
   - FLOW_COMPLETE arrives normally.

5. **Sidepanel-only run** — run a config from sidepanel local mode (no taskId). Expect zero `[preflightTimer]` and zero `[waitForResumeForDrain]` logs. Same end-to-end behaviour as before.

### Edge cases — covered

| Case | How |
|---|---|
| Origin unknown (config not in store, no inlineConfig) | Resolved to null at TASK_RECEIVED → not origin-gated |
| Same-origin task starts during drain | Stays paused; resumes on next endTask |
| Drain task fails (ABORT, error) | endTask still fires → origin slot freed → next paused task resumes |
| Force ready via FORCE_PREFLIGHT_READY (PR3) during preflight | Timer fires immediately → markPreflightReady → next pending starts or transition to drain |
| SW restart mid-batch | restoreActive rebuilds active map with preserved preflightReady/drainResumed flags; recomputes phase once |
| Re-enqueue after drain → idle | Next enqueue triggers preflight phase fresh — handled by `if (this.phase === 'idle') this.phase = 'preflight';` in enqueueTask |
| All tasks complete during preflight (sub-5s flows) | Phase transitions back to idle without entering drain — accepted |

### Edge cases — ignored (v1)

| Case | Why |
|---|---|
| Concurrent batch starts | Defer to PR5/6 — not blocking dogfood |
| Pending tasks added during drain | Permitted; they'll preflight after current drain completes |
| Same-origin token bucket (rate per second) | Same-origin sequencing is sufficient anti-ban for v1 |
| Resume from browser restart | chrome.storage.session is wiped; restart cancels batch |

---

## Maintainability checklist

- [x] No magic strings — all wire literals via `MessageType.*`
- [x] Phase machine has one entry point (`recomputePhase`)
- [x] Origin gate is a pure function — fully unit-testable with no DOM/runtime
- [x] No redundant state — `preflightReady` and `drainResumed` derive task state; no parallel maps
- [x] `drainCap` configurable via setter; default lives in one constants module
- [x] Reuse — `originOf` from PR2; `MessageType` from PR3
- [x] One responsibility per module — scheduler owns lifecycle; originGate owns gate predicate; SW does I/O glue; content script owns engine sequencing
- [x] Backward compat — existing scheduler tests updated minimally; persisted state hydrates with optional fields; sidepanel-only flows unaffected

---

## Stuck-loop escalation reminder

If two consecutive attempts to make a check green fail, STOP. Common failure modes in this area: (a) phase transition firing twice — verify `recomputePhase` is the single transition site; (b) broadcast called with empty array on transition — verify `pickResumable` runs after phase mutation; (c) test brittleness around microtask ordering — `await Promise.resolve()` after every `enqueueTask`. Escalate to Opus if a stuck-loop hits 2 failed attempts on the same hypothesis.
