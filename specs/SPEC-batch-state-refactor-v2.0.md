# SPEC: Batch state refactor (PR2) — singleton → Map

**Slug:** `batch-state-refactor`
**Version:** 2.0
**Author:** Opus (planning) → Sonnet (implementation)
**Predecessor:** PR1.8 (resume-with-feedback) shipped 2026-04-27
**Successor:** PR3 (pre-flight quiet timer + `FLOW_PREFLIGHT_READY` event)

---

## 1. Context

Plan source: [`C:\Users\und3r\.claude\plans\ok-next-change-sharded-lightning.md`](C:\Users\und3r\.claude\plans\ok-next-change-sharded-lightning.md) — section "PR2 — State refactor: singleton → Map (FOUNDATION)" (lines 829-850).

Today, `background.ts` holds remote-queue state as four module-locals:

- `activeRemoteTask: ActiveRemoteTask | null` — single active task record
- `pendingRemoteTasks: QueueTask[]` — FIFO queue
- `recentRemoteTasks: QueueTask[]` — LRU history (cap 20)
- `isStartingTask: boolean` — single-flight gate while window-creation is mid-flight

The batched-parallel-scrape feature (PR3 onward) requires `N` concurrent active tasks. PR2 swaps the singleton for a `Map<string, ActiveRemoteTask>` owned by a new `Scheduler` class, and plumbs every site that today reads or writes `activeRemoteTask` through it. With `cap = 1` (default), behaviour is bit-for-bit identical to today: one task active at a time, others queue, FLOW events route to the same active record. PR3 adds the pre-flight quiet timer; PR4 raises the cap and adds the phase machine.

**This PR is pure refactor — no UX change, no new features.** Sidepanel-mode runs (without a `taskId` in the EXECUTE_FLOW path) bypass the scheduler entirely and still use the existing `activePauseState` global. Queue-mode (`TASK_RECEIVED`-driven) flows go through the scheduler.

---

## 2. Locked decisions (Stages A–E summary — do not re-litigate)

From the plan and the audit before this spec:

- **Scope:** scheduler is data + lifecycle ownership. SW (`background.ts`) provides `startTask` callback and continues to own all browser-API side effects (windows, tabs, offscreen, signalr, hub relay).
- **Origin:** computed via `originOf(url)` (pure helper, also new in this PR) at `recordStarted` time from the resolved config URL. Stored on the active record. **Not used in PR2** — plumbed for PR4's same-origin gate.
- **Per-task pause state: deferred to PR4.** PR2 keeps `activePauseState` as a thin singleton mirror for the existing UX (App.tsx `GET_PAUSE_STATE` handshake, `buildSnapshotActiveTask`, `tabs.onUpdated` continuation-hold check). Adding per-task pause now would force pause-UI restructuring (PR5 work) ahead of schedule.
- **`onTaskEvent` subscriber pattern: deferred to PR4.** No subscriber in PR2 — `background.ts` already knows about all flow events directly through its message router. Adding a no-op event bus now is dead code.
- **`abortTask` / `abortAll`: deferred to PR4.** Today's `CANCEL_TASK` handler dispatches `ABORT_FLOW` directly to the tab; FLOW_ERROR/COMPLETE then drains. Same behaviour preserved in PR2 — SW reads scheduler to find the record, sends ABORT_FLOW. PR4 adds proper `abortTask(taskId)` / `abortAll()` for the batch-cancel UI.
- **Persistence:** session-storage key changes from `activeRemoteTask` (object) to `activeRemoteTasks` (array of records). chrome.storage.session is wiped on browser restart, so no migration is needed — old key stale data is dropped on restore.
- **`pendingContinuations`** (Map keyed by tabId) **stays as-is.** Already per-tab; no collision possible across windows.
- **`flowRunning`** flag in content script **stays per-tab.** Each window has its own content-script context.
- **Cap default = 1.** Plumbed for PR4 to raise. Not configurable in PR2.
- **No content-script changes in PR2.** `scrapingEngine.ts` already accepts `taskId` end-to-end.
- **No UI changes in PR2.** Sidepanel still expects single `active` in `QueueSnapshot`; we serve `[...active].values().next().value` to preserve the wire shape.

---

## 3. File map

### New

| File | Purpose |
|---|---|
| [src/background/scheduler.ts](src/background/scheduler.ts) | `Scheduler` class — owns `Map<taskId, ActiveRemoteTask>`, pending queue, recent history, single-flight `starting` gate |
| [src/background/originOf.ts](src/background/originOf.ts) | Pure `originOf(url)` helper — used by SW to stamp origin on active record |
| [src/__tests__/scheduler.test.ts](src/__tests__/scheduler.test.ts) | Vitest for scheduler — enqueue, start gate, end-of-task drain, recent dedup, snapshots |
| [src/__tests__/originOf.test.ts](src/__tests__/originOf.test.ts) | Vitest for `originOf` |

### Modified

| File | Concern |
|---|---|
| [src/entrypoints/background.ts](src/entrypoints/background.ts) | Replace four module-locals + helpers with scheduler instance; rewrite `startRemoteTask` / `drainNextRemoteTask` / `handleRemoteFlowEvent` to use scheduler API; update TASK_RECEIVED, RESUME_TASK, CANCEL_TASK, GET_QUEUE_SNAPSHOT, tabs.onRemoved, and chrome.storage.session restore |

### Deleted

None.

---

## 4. Detailed changes

### 4.1 — NEW: `src/background/originOf.ts`

Create with this content:

```typescript
// Pure helper — extracts the origin (scheme + host + port) from a URL string.
// Returns null on null/undefined input or invalid URLs. Used to stamp `origin`
// on active task records for PR4's same-origin gate.

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
```

---

### 4.2 — NEW: `src/background/scheduler.ts`

Create with this content:

```typescript
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
```

---

### 4.3 — Modified: `src/entrypoints/background.ts`

The whole file at HEAD is 712 lines. Below are exact replacements organised by concern. Apply in order.

#### 4.3.1 — Imports

**Locate lines 1-11:**

```typescript
import { dbg, ensureDebugInit } from '../utils/debugLog';
import { mergeProgress } from '../utils/queueProgress';
import type { QueueTask } from '../types/signalr';
import type { DataMapping } from '../types/config';
import { getAllConfigs, saveConfig, PREFS_KEY } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from '../background/flowEventToHubPayload';
```

**Replace with:**

```typescript
import { dbg, ensureDebugInit } from '../utils/debugLog';
import { mergeProgress } from '../utils/queueProgress';
import type { QueueTask } from '../types/signalr';
import { getAllConfigs, saveConfig, PREFS_KEY } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from '../background/flowEventToHubPayload';
import { Scheduler, type PersistedActiveRecord } from '../background/scheduler';
import { originOf } from '../background/originOf';
```

(Removed: `DataMapping` — no longer referenced once the inline `activeRemoteTask` type is gone. Added: `Scheduler`, `PersistedActiveRecord`, `originOf`.)

#### 4.3.2 — Replace local state and helpers (lines 28-49)

**Locate lines 28-49** (the `// ── Remote queue state ──` block through the chrome.storage.session restore):

```typescript
  // ── Remote queue state ──

  const RECENT_TASKS_CAP = 20;
  let activeRemoteTask: { task: QueueTask; tabId: number; windowId: number; resolvedDataMapping?: DataMapping; lastProgress?: { stepLabel: string; termIndex?: number } } | null = null;
  let recentRemoteTasks: QueueTask[] = [];
  let isStartingTask = false;
  const pendingRemoteTasks: QueueTask[] = [];
  let activePauseState: {
    reason: 'cloudflare' | 'awaitUserAction';
    message?: string;
    trigger?: import('../types/messages').DetectionTrigger;
    domain?: string;
  } | null = null;
  type SignalRConfig = { serverUrl: string; token: string; clientId: string; version: string };
  let signalrConfig: SignalRConfig | null = null;

  // Restore state from session storage on SW restart (state is lost when SW is killed by Chrome).
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTask', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (data.activeRemoteTask) activeRemoteTask = data.activeRemoteTask as typeof activeRemoteTask;
    if (data.recentRemoteTasks) recentRemoteTasks = data.recentRemoteTasks as QueueTask[];
  }).catch(() => {});
```

**Replace with:**

```typescript
  // ── Remote queue state ──
  //
  // Scheduler owns the per-task records (active Map, pending queue, recent
  // history, single-flight `starting` gate). `activePauseState` is kept as a
  // thin singleton mirror for the App.tsx GET_PAUSE_STATE handshake, the
  // continuation-hold check in tabs.onUpdated, and sidepanel-only-mode runs
  // (which bypass the scheduler). PR4 will move pause state per-task.

  const scheduler = new Scheduler({
    startTask: (task) => {
      // startRemoteTask handles its own resolver/window-create failures via
      // scheduler.recordStartFailed. The .catch here is a backstop for
      // unforeseen rejections from chrome APIs that escape those handlers —
      // matches HEAD's defensive logging pattern.
      startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
    },
  });

  let activePauseState: {
    reason: 'cloudflare' | 'awaitUserAction';
    message?: string;
    trigger?: import('../types/messages').DetectionTrigger;
    domain?: string;
  } | null = null;
  type SignalRConfig = { serverUrl: string; token: string; clientId: string; version: string };
  let signalrConfig: SignalRConfig | null = null;

  function persistActive(): void {
    chrome.storage.session.set({ activeRemoteTasks: scheduler.serializeActive() }).catch(() => {});
  }

  function persistRecent(): void {
    chrome.storage.session.set({ recentRemoteTasks: scheduler.getRecent() }).catch(() => {});
  }

  // Restore state from session storage on SW restart (state is lost when SW is killed by Chrome).
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTasks', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (Array.isArray(data.activeRemoteTasks)) {
      scheduler.restoreActive(data.activeRemoteTasks as PersistedActiveRecord[]);
    }
    if (Array.isArray(data.recentRemoteTasks)) {
      scheduler.setRecent(data.recentRemoteTasks as QueueTask[]);
    }
  }).catch(() => {});

  // One-shot cleanup of the pre-PR2 singular key. chrome.storage.session is
  // wiped on browser restart, so this only matters for an in-place extension
  // reload during the upgrade window. Safe to remove this line in PR3+.
  chrome.storage.session.remove('activeRemoteTask').catch(() => {});
```

#### 4.3.3 — `buildSnapshotActiveTask` (lines 172-180)

**Locate:**

```typescript
  function buildSnapshotActiveTask(): QueueTask | null {
    if (!activeRemoteTask) return null;
    return {
      ...activeRemoteTask.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
      progress: activeRemoteTask.lastProgress,
    };
  }
```

**Replace with:**

```typescript
  function buildSnapshotActiveTask(): QueueTask | null {
    const r = scheduler.getFirstActive();
    if (!r) return null;
    return {
      ...r.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
      progress: r.lastProgress,
    };
  }
```

#### 4.3.4 — `startRemoteTask` (lines 182-247)

**Locate the entire function:**

```typescript
  async function startRemoteTask(task: QueueTask): Promise<void> {
    let resolved;
    try {
      const localConfigs = await getAllConfigs();
      resolved = resolveQueueTask(task, localConfigs);

      // Persist inline config if it isn't local yet — first-run cache.
      if (task.inlineConfig && !localConfigs.some((c) => c.id === task.configId)) {
        await saveConfig(task.inlineConfig);
      }
    } catch (err) {
      const message = err instanceof ConfigNotFoundError ? err.message : (err as Error).message;
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: message,
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
      return;
    }

    const win = await browser.windows.create({ url: resolved.config.url, focused: true, state: 'maximized' });
    const tab = win?.tabs?.[0];
    if (!tab?.id || !win?.id) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: "Couldn't open a window for the task",
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
      return;
    }

    activeRemoteTask = {
      task: { ...task, status: 'running' },
      tabId: tab.id,
      windowId: win.id,
      resolvedDataMapping: resolved.config.dataMapping,
    };
    isStartingTask = false;
    chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
    lastFocusedTabId = tab.id;

    await waitForTabComplete(tab.id);

    console.warn('[SW] Sending initial EXECUTE_FLOW | taskId:', resolved.taskId, '| searchTerms:', resolved.searchTerms);
    browser.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_FLOW',
      payload: {
        config: resolved.config,
        searchTerms: resolved.searchTerms,
        taskId: resolved.taskId,
      },
    }).catch((err: Error) => {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: resolved.taskId,
        configId: resolved.configId,
        error: `Couldn't dispatch task to page: ${err.message}`,
        failedAt: new Date().toISOString(),
      });
      activeRemoteTask = null;
      drainNextRemoteTask();
    });
  }
```

**Replace with:**

```typescript
  async function startRemoteTask(task: QueueTask): Promise<void> {
    let resolved;
    try {
      const localConfigs = await getAllConfigs();
      resolved = resolveQueueTask(task, localConfigs);

      // Persist inline config if it isn't local yet — first-run cache.
      if (task.inlineConfig && !localConfigs.some((c) => c.id === task.configId)) {
        await saveConfig(task.inlineConfig);
      }
    } catch (err) {
      const message = err instanceof ConfigNotFoundError ? err.message : (err as Error).message;
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: message,
        failedAt: new Date().toISOString(),
      });
      scheduler.recordStartFailed(task.id);
      return;
    }

    const win = await browser.windows.create({ url: resolved.config.url, focused: true, state: 'maximized' });
    const tab = win?.tabs?.[0];
    if (!tab?.id || !win?.id) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: "Couldn't open a window for the task",
        failedAt: new Date().toISOString(),
      });
      scheduler.recordStartFailed(task.id);
      return;
    }

    // Register early so tabs.onRemoved during page load can identify the task.
    scheduler.recordStarted(task.id, task, {
      tabId: tab.id,
      windowId: win.id,
      origin: originOf(resolved.config.url),
      resolvedDataMapping: resolved.config.dataMapping,
    });
    persistActive();
    lastFocusedTabId = tab.id;

    await waitForTabComplete(tab.id);

    console.warn('[SW] Sending initial EXECUTE_FLOW | taskId:', resolved.taskId, '| searchTerms:', resolved.searchTerms);
    browser.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_FLOW',
      payload: {
        config: resolved.config,
        searchTerms: resolved.searchTerms,
        taskId: resolved.taskId,
      },
    }).catch((err: Error) => {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: resolved.taskId,
        configId: resolved.configId,
        error: `Couldn't dispatch task to page: ${err.message}`,
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask(resolved.taskId, 'failed');
    });
  }
```

#### 4.3.5 — `drainNextRemoteTask` (lines 249-277)

**Locate:**

```typescript
  function drainNextRemoteTask(completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closingWindowId = activeRemoteTask?.windowId;
    const closingTaskId = activeRemoteTask?.task.id;
    if (activeRemoteTask) {
      pushToRecent({ ...activeRemoteTask.task, status: completedStatus, pausedReason: undefined });
    }
    activeRemoteTask = null;
    isStartingTask = false;
    chrome.storage.session.remove('activeRemoteTask').catch(() => {});

    if (closingWindowId) {
      isDebugMode().then((debug) => {
        if (debug) {
          console.warn('[SW] DEBUG mode — leaving task window open | windowId:', closingWindowId, '| taskId:', closingTaskId);
        } else {
          browser.windows.remove(closingWindowId).catch(() => {});
        }
      }).catch(() => {
        browser.windows.remove(closingWindowId).catch(() => {});
      });
    }

    const next = pendingRemoteTasks.shift();
    if (next) {
      isStartingTask = true;
      startRemoteTask(next).catch((err) => console.error('[SW] Failed to start queued task:', err));
    }
  }
```

**Replace with:**

```typescript
  // PR2: now requires the taskId — we no longer have a hidden singleton to drain.
  // Callers that previously called drainNextRemoteTask() with no args (catastrophic
  // failures during start) now use scheduler.recordStartFailed instead, since at
  // start-time there is no scheduler record yet to remove.
  function drainNextRemoteTask(taskId: string, completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closing = scheduler.endTask(taskId);
    if (!closing) {
      // No record — nothing to clean up. tryStartNext is already a no-op when
      // active < cap and pending is empty, so we don't need to call it here.
      return;
    }
    scheduler.pushRecent({ ...closing.task, status: completedStatus, pausedReason: undefined });
    persistActive();
    persistRecent();

    const closingWindowId = closing.windowId;
    const closingTaskId = closing.task.id;
    isDebugMode().then((debug) => {
      if (debug) {
        console.warn('[SW] DEBUG mode — leaving task window open | windowId:', closingWindowId, '| taskId:', closingTaskId);
      } else {
        browser.windows.remove(closingWindowId).catch(() => {});
      }
    }).catch(() => {
      browser.windows.remove(closingWindowId).catch(() => {});
    });
  }
```

(Note: `scheduler.endTask` already calls `tryStartNext` internally — the explicit `pendingRemoteTasks.shift()` block is gone.)

#### 4.3.6 — `pushToRecent` (lines 164-170)

**Locate:**

```typescript
  function pushToRecent(task: QueueTask): void {
    const idx = recentRemoteTasks.findIndex((t) => t.id === task.id);
    if (idx !== -1) recentRemoteTasks.splice(idx, 1);
    recentRemoteTasks.unshift(task);
    if (recentRemoteTasks.length > RECENT_TASKS_CAP) recentRemoteTasks.length = RECENT_TASKS_CAP;
    chrome.storage.session.set({ recentRemoteTasks }).catch(() => {});
  }
```

**Delete entirely.** Replaced by `scheduler.pushRecent()` + `persistRecent()`. The only caller (drainNextRemoteTask) is updated above; verify no other call sites with grep before deletion.

#### 4.3.7 — `handleRemoteFlowEvent` (lines 279-342)

**Locate:**

```typescript
  function handleRemoteFlowEvent(type: string, payload: Record<string, unknown>): void {
    if (!activeRemoteTask) {
      console.warn('[SW] handleRemoteFlowEvent: no activeRemoteTask, dropping', type);
      return;
    }
    if (payload?.taskId !== activeRemoteTask.task.id) {
      console.warn('[SW] handleRemoteFlowEvent: taskId mismatch — got', payload?.taskId, 'expected', activeRemoteTask.task.id, 'dropping', type);
      return;
    }

    const ctx: ActiveTaskContext = {
      taskId: activeRemoteTask.task.id,
      configId: activeRemoteTask.task.configId,
      configName: activeRemoteTask.task.configName,
      searchTerms: activeRemoteTask.task.searchTerms,
      dataMapping: activeRemoteTask.resolvedDataMapping,
    };

    switch (type) {
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        const merged = mergeProgress(activeRemoteTask.lastProgress ?? null, {
          stepLabel: (payload as Record<string, unknown>).stepLabel,
          termIndex: (payload as Record<string, unknown>).termIndex,
        });
        if (merged) {
          activeRemoteTask.lastProgress = merged;
          chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
        }
        return;
      }
      case 'FLOW_COMPLETE': {
        const fp = payload as unknown as FlowCompletePayload;
        console.warn('[SW] FLOW_COMPLETE | taskId:', activeRemoteTask.task.id, '| aborted:', fp.result?.aborted, '| iterations:', fp.result?.iterations?.length, '| totalTimeMs:', fp.result?.totalTimeMs);
        const hubPayload = mapFlowComplete(ctx, fp);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNextRemoteTask('completed');
        return;
      }
      case 'FLOW_ERROR': {
        const fe = payload as unknown as FlowErrorPayload;
        console.warn('[SW] FLOW_ERROR | taskId:', activeRemoteTask.task.id, '| error:', fe.error);
        const hubPayload = mapFlowError(ctx, fe);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNextRemoteTask();
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        console.warn('[SW] FLOW_PAUSED | taskId:', activeRemoteTask.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message, '| trigger:', flowPayload.trigger, '| domain:', flowPayload.domain);
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        activePauseState = {
          reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
          message: flowPayload.message,
          trigger: flowPayload.trigger,
          domain: flowPayload.domain,
        };
        const hubPayload = mapFlowPaused(ctx, payload as unknown as FlowPausedPayload);
        relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
        return;
      }
    }
  }
```

**Replace with:**

```typescript
  function handleRemoteFlowEvent(type: string, payload: Record<string, unknown>): void {
    const taskId = payload?.taskId as string | undefined;
    if (!taskId) {
      // Sidepanel-mode runs (no taskId) — handled elsewhere or not relevant
      // to the queue path. Silently ignore.
      return;
    }
    const record = scheduler.getActiveTask(taskId);
    if (!record) {
      console.warn('[SW] handleRemoteFlowEvent: no record for taskId', taskId, 'dropping', type);
      return;
    }

    const ctx: ActiveTaskContext = {
      taskId: record.task.id,
      configId: record.task.configId,
      configName: record.task.configName,
      searchTerms: record.task.searchTerms,
      dataMapping: record.resolvedDataMapping,
    };

    switch (type) {
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        const merged = mergeProgress(record.lastProgress ?? null, {
          stepLabel: (payload as Record<string, unknown>).stepLabel,
          termIndex: (payload as Record<string, unknown>).termIndex,
        });
        if (merged) {
          scheduler.setProgress(taskId, merged);
          persistActive();
        }
        return;
      }
      case 'FLOW_COMPLETE': {
        const fp = payload as unknown as FlowCompletePayload;
        console.warn('[SW] FLOW_COMPLETE | taskId:', record.task.id, '| aborted:', fp.result?.aborted, '| iterations:', fp.result?.iterations?.length, '| totalTimeMs:', fp.result?.totalTimeMs);
        const hubPayload = mapFlowComplete(ctx, fp);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNextRemoteTask(taskId, 'completed');
        return;
      }
      case 'FLOW_ERROR': {
        const fe = payload as unknown as FlowErrorPayload;
        console.warn('[SW] FLOW_ERROR | taskId:', record.task.id, '| error:', fe.error);
        const hubPayload = mapFlowError(ctx, fe);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNextRemoteTask(taskId, 'failed');
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        console.warn('[SW] FLOW_PAUSED | taskId:', record.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message, '| trigger:', flowPayload.trigger, '| domain:', flowPayload.domain);
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        activePauseState = {
          reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
          message: flowPayload.message,
          trigger: flowPayload.trigger,
          domain: flowPayload.domain,
        };
        const hubPayload = mapFlowPaused(ctx, payload as unknown as FlowPausedPayload);
        relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
        return;
      }
    }
  }
```

#### 4.3.8 — `TASK_RECEIVED` handler (lines 423-432)

**Locate:**

```typescript
    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      if (activeRemoteTask || isStartingTask) {
        pendingRemoteTasks.push(task);
      } else {
        isStartingTask = true;
        startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
      }
      return;
    }
```

**Replace with:**

```typescript
    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      scheduler.enqueueTask(task);
      return;
    }
```

(`enqueueTask` calls `tryStartNext` internally, which under cap=1 and an empty active map dispatches the `startTask` callback that wraps `startRemoteTask`. Identical behaviour.)

#### 4.3.9 — `RESUME_TASK` handler (lines 436-444)

**Locate:**

```typescript
    if (type === 'RESUME_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.task.id)) {
        browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'RESUME_AFTER_CLOUDFLARE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_CLOUDFLARE failed:', err));
        activePauseState = null;
      }
      return;
    }
```

**Replace with:**

```typescript
    if (type === 'RESUME_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_CLOUDFLARE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_CLOUDFLARE failed:', err));
        activePauseState = null;
      }
      return;
    }
```

#### 4.3.10 — `CANCEL_TASK` handler (lines 502-509)

**Locate:**

```typescript
    if (type === 'CANCEL_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.task.id)) {
        browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      }
      return;
    }
```

**Replace with:**

```typescript
    if (type === 'CANCEL_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      } else if (taskId) {
        // May still be in pending — drop it without starting.
        scheduler.cancelPending(taskId);
      }
      return;
    }
```

#### 4.3.11 — `GET_QUEUE_SNAPSHOT` (lines 526-533)

**Locate:**

```typescript
    if (type === 'GET_QUEUE_SNAPSHOT') {
      sendResponse({
        active: buildSnapshotActiveTask(),
        pending: [...pendingRemoteTasks],
        recent: [...recentRemoteTasks],
      });
      return true;
    }
```

**Replace with:**

```typescript
    if (type === 'GET_QUEUE_SNAPSHOT') {
      sendResponse({
        active: buildSnapshotActiveTask(),
        pending: [...scheduler.getPendingTasks()],
        recent: [...scheduler.getRecent()],
      });
      return true;
    }
```

#### 4.3.12 — `tabs.onRemoved` (lines 657-669)

**Locate:**

```typescript
  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    if (activeRemoteTask && activeRemoteTask.tabId === tabId) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: activeRemoteTask.task.id,
        configId: activeRemoteTask.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
    }
  });
```

**Replace with:**

```typescript
  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    const orphaned = scheduler.findByTabId(tabId);
    if (orphaned) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: orphaned.task.id,
        configId: orphaned.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask(orphaned.task.id, 'failed');
    }
  });
```

#### 4.3.13 — Untouched

The following blocks need **no changes** (their reads of `activePauseState` are still valid, and they don't reference `activeRemoteTask` / `pendingRemoteTasks` / `recentRemoteTasks` / `isStartingTask`):

- `RESUME_AFTER_PAUSE` / `RESUME_AFTER_CLOUDFLARE` interceptor (lines 453-500) — reads/clears `activePauseState`, dispatches via active-tab query
- `contentToSidepanel` relay block (lines 576-609) — sets/clears `activePauseState` mirror for sidepanel-only-mode runs
- `tabs.onUpdated` continuation hold (lines 671-711) — reads `activePauseState`
- `OFFSCREEN_READY`, `__SW_LOG__`, `REGISTER_CONTINUATION`, `CANCEL_CONTINUATION`, `FETCH_FLOURISH_DATA`, `FRAME_REGISTER`, `GET_PAUSE_STATE`, `sidepanelToOffscreen`, `sidepanelToContent`, `OnInstalled`, `action.onClicked`, `tabs.onActivated`, `waitForTabComplete`, `relayHubInvocation`, `ensureOffscreen`, `isDebugMode` — unchanged

---

### 4.4 — Tests

#### 4.4.1 — NEW: `src/__tests__/scheduler.test.ts`

Create with this content:

```typescript
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
```

#### 4.4.2 — NEW: `src/__tests__/originOf.test.ts`

Create with this content:

```typescript
import { describe, it, expect } from 'vitest';
import { originOf } from '../background/originOf';

describe('originOf', () => {
  it('returns origin for a normal https URL', () => {
    expect(originOf('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('returns origin including explicit port', () => {
    expect(originOf('http://localhost:5082/api')).toBe('http://localhost:5082');
  });

  it('returns null for null / undefined / empty', () => {
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('://broken')).toBeNull();
  });
});
```

---

## 5. Verification

### Automated

Run **in this order**, fix everything in current step before moving on:

```sh
npm run build       # vite + tsc — must pass
npm test            # all existing + the two new test files must pass
npm run lint        # eslint — clean
```

Existing tests that must still pass (PR1.6/1.7/1.8 work):
- `src/__tests__/runDetectorWatchdog.test.ts`
- `src/__tests__/cookieBannerDetector.test.ts`
- `src/__tests__/detectionMemory.test.ts`
- `src/__tests__/flowEventToHubPayload.test.ts`
- `src/__tests__/remoteTaskHandler.test.ts`

### Manual smoke (before claiming done)

Build, load extension, then:

1. **Single queue task — happy path.**
   In the backend (or via mock SignalR push if available), dispatch a single `TASK_RECEIVED`. A new window opens, scrape runs, FLOW_PROGRESS / FLOW_COMPLETE relay to the hub. Window closes (unless DEBUG mode). Recent list in `GET_QUEUE_SNAPSHOT` includes the completed task. **No regression vs HEAD.**

2. **Two queue tasks back-to-back.**
   Dispatch two `TASK_RECEIVED` in rapid succession. First one starts (window opens). Second one sits in `pending`. After first completes, second starts. Verify in side panel that only one is "running" at a time.

3. **Cloudflare pause — queue mode.**
   Dispatch a task whose target site triggers cloudflare. `FLOW_PAUSED` arrives, sidepanel shows the cloudflare alert, click Continue, scrape resumes. Verify the alert clears.

4. **Await-action pause — queue mode.**
   Dispatch a task whose target site triggers a login/cookie wall. `FLOW_PAUSED` arrives with trigger + domain, sidepanel shows the await-action alert with "Skip next time on this site" button. Click Continue (without Skip) — scrape resumes. Verify `markAsFalseAlarm` was NOT recorded (PR1.8 detection memory unchanged).

5. **Await-action pause — Skip next time still works.**
   Same as (4) but click "Skip next time on this site". Verify the trigger appears in `LEARNED_DETECTION` view (PR1.8 panel).

6. **Sidepanel-mode run.**
   Open side panel → Config tab → Run. (No `taskId`, no scheduler entry.) Verify a normal run completes with no errors. The scheduler state is empty during the run.

7. **SW kill mid-run.**
   Trigger a scrape, then in `chrome://extensions` → service worker → "stop" / wait for natural eviction. Re-open side panel. The scrape continues to dispatch `FLOW_PROGRESS` and the SW relays them to the hub correctly. `GET_QUEUE_SNAPSHOT` shows the task as still active. Verify by completing the scrape — `FLOW_COMPLETE` is relayed and the task moves to recent.

8. **Cancel running task via `CANCEL_TASK`.**
   Backend sends `CANCEL_TASK { taskId: <running id> }`. The tab gets `ABORT_FLOW`, `FLOW_COMPLETE` (with `aborted: true`) fires, `SEND_TASK_COMPLETE` relays, task drains, next pending starts.

9. **Tab closed mid-run.**
   Manually close the task window during a scrape. `tabs.onRemoved` handler relays `SEND_TASK_ERROR("Task tab was closed")` and drains. Pending task starts.

10. **DEBUG mode keeps window open.**
    Set `prefs.debug = true` in chrome.storage.local. Run a queue task. After `FLOW_COMPLETE`, the window stays open; logs show "DEBUG mode — leaving task window open".

### Edge cases — covered

- **Duplicate TASK_RECEIVED for same id** — `enqueueTask` rejects (test).
- **CANCEL_TASK for a pending (not-yet-started) task** — handler now calls `scheduler.cancelPending` (NEW behavior; HEAD silently dropped on the floor because `activeRemoteTask.tabId === tabId` was false).
- **CANCEL_TASK with no taskId** — same as HEAD: targets the only active task via `getFirstActive()`.
- **EXECUTE_FLOW dispatch failure** — `drainNextRemoteTask(taskId, 'failed')` cleans up correctly. Previously called `drainNextRemoteTask()` which referenced the global; now explicit.
- **Resolve config failure / window-create failure during start** — calls `scheduler.recordStartFailed(task.id)` instead of `drainNextRemoteTask()`. Equivalent: gate releases, next pending starts. No active record was created, so no record to clean up.

### Edge cases — ignored (with version)

- **Multiple sidepanel-mode runs simultaneously** — Ignored (v2). Sidepanel mode bypasses the scheduler entirely and uses singleton state in `runStore`. Out of scope.
- **Per-task pause state** — Ignored (PR4). PR2 keeps the singleton `activePauseState` mirror; under cap=1 there's only one active task so there's no ambiguity.
- **`onTaskEvent` subscribers** — Ignored (PR4). No subscribers in PR2; the SW already routes events directly via its message router.
- **Same-origin sequencing** — Ignored (PR4). `origin` is stamped on the record but not used for gating.
- **Persistence atomicity** — `persistActive()` is fire-and-forget. If the SW dies between `recordStarted` and the persist resolving, the next SW restart won't see the task. Acceptable v2 — chrome.storage.session is best-effort already.

---

## 6. Non-goals

- Does **not** raise the parallel cap above 1.
- Does **not** introduce a phase machine or any preflight/drain state transitions.
- Does **not** introduce per-task pause state.
- Does **not** modify content-script (`scrapingEngine.ts`, `detectionRules.ts`, etc.).
- Does **not** modify any sidepanel component or store.
- Does **not** modify wire-protocol types (`types/signalr.ts`).
- Does **not** add new messages, settings, or storage keys (apart from rename: `activeRemoteTask` → `activeRemoteTasks` in chrome.storage.session, which is auto-wiped on browser restart).

---

## 7. Implementation order for Sonnet

Implement in this order. Run `npm run build` after each step to keep the tree compiling.

1. Create `src/background/originOf.ts` and `src/__tests__/originOf.test.ts`. Run `npm test originOf` — must pass.
2. Create `src/background/scheduler.ts` and `src/__tests__/scheduler.test.ts`. Run `npm test scheduler` — must pass.
3. Edit `src/entrypoints/background.ts` per §4.3.1–§4.3.12 in numbered order. Run `npm run build` after the imports change, then incrementally after each block. Use grep to verify no stale references to `activeRemoteTask`, `pendingRemoteTasks`, `recentRemoteTasks`, `isStartingTask`, `pushToRecent`, or `RECENT_TASKS_CAP` remain (all should now live in scheduler).
4. Run full `npm run build && npm test && npm run lint`. All must pass.
5. **Do not commit.** Hand back to the user for manual smoke (§5).
