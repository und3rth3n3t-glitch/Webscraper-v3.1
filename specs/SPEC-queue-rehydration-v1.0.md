# SPEC-queue-rehydration-v1.0

**Status**: Implementation-ready.

---

## Context

The Blueberry v3 browser extension uses a service worker (SW) to run remote
scraping tasks dispatched from a backend SignalR hub. The sidepanel shows a
"Task Queue" view backed by an in-memory Zustand store (`queueStore`).

**Bug**: if the sidepanel is closed when a task starts, the queue store never
receives the `TASK_RECEIVED` message. Opening the panel mid-task shows
"No tasks yet" even though a task is actively running.

**Root cause**: `queueStore` is populated exclusively by live messages. There
is no snapshot path: the store is initialised empty every time the sidepanel
mounts.

**Fix**: make the SW the authoritative source of truth for queue state. The SW
maintains an in-memory `recentRemoteTasks` ring (cap 20), persists
`activeRemoteTask` and `recentRemoteTasks` to `chrome.storage.session`, and
exposes a `GET_QUEUE_SNAPSHOT` request/response handler. The sidepanel pulls a
snapshot on mount and seeds the store.

### What this spec does NOT do

- Change `QueueView.tsx`
- Fix the pre-existing `runStore.isRunning` bug in `QueueView`
- Persist `recentRemoteTasks` to `chrome.storage.local` (session-only is
  intentional — recent tasks are ephemeral UI convenience, not durable history)
- Add a server-push path from SW to panel beyond the existing live event
  listeners

---

## File 1 — `src/types/signalr.ts`

Add the following at the end of the file (after the existing `TaskResult`
interface):

```ts
export interface QueueSnapshot {
  active: QueueTask | null;
  pending: QueueTask[];
  recent: QueueTask[];
}
```

No other changes to this file.

---

## File 2 — `src/entrypoints/background.ts`

### 2a. Imports — add `DataMapping`

Add after the existing imports:

```ts
import type { DataMapping } from '../types/config';
```

Keep `type ActiveTaskContext` in the `flowEventToHubPayload` import — it is
still used as the type of the local `ctx` variable inside
`handleRemoteFlowEvent`.

The full import block when done:

```ts
import { dbg, ensureDebugInit } from '../utils/debugLog';
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

### 2b. Constants — add `RECENT_TASKS_CAP`

Add before the remote queue state block (before `let activeRemoteTask`):

```ts
const RECENT_TASKS_CAP = 20;
```

### 2c. `activeRemoteTask` type — restructure

Replace the existing declaration:

```ts
// Before:
let activeRemoteTask: (ActiveTaskContext & { tabId: number; windowId: number }) | null = null;

// After:
let activeRemoteTask: { task: QueueTask; tabId: number; windowId: number; resolvedDataMapping?: DataMapping } | null = null;
```

### 2d. New state variable — `recentRemoteTasks`

Add immediately after the `activeRemoteTask` declaration:

```ts
let recentRemoteTasks: QueueTask[] = [];
```

### 2e. Session storage restore — add `recentRemoteTasks`

Replace the existing session restore block:

```ts
// Before:
chrome.storage.session.get(['signalrConfig', 'activeRemoteTask']).then((data: Record<string, unknown>) => {
  if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
  if (data.activeRemoteTask) activeRemoteTask = data.activeRemoteTask as typeof activeRemoteTask;
}).catch(() => {});

// After:
chrome.storage.session.get(['signalrConfig', 'activeRemoteTask', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
  if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
  if (data.activeRemoteTask) activeRemoteTask = data.activeRemoteTask as typeof activeRemoteTask;
  if (data.recentRemoteTasks) recentRemoteTasks = data.recentRemoteTasks as QueueTask[];
}).catch(() => {});
```

### 2f. New helpers — `pushToRecent` and `buildSnapshotActiveTask`

Add both functions immediately after the `relayHubInvocation` function:

```ts
function pushToRecent(task: QueueTask): void {
  const idx = recentRemoteTasks.findIndex((t) => t.id === task.id);
  if (idx !== -1) recentRemoteTasks.splice(idx, 1);
  recentRemoteTasks.unshift(task);
  if (recentRemoteTasks.length > RECENT_TASKS_CAP) recentRemoteTasks.length = RECENT_TASKS_CAP;
  chrome.storage.session.set({ recentRemoteTasks }).catch(() => {});
}

function buildSnapshotActiveTask(): QueueTask | null {
  if (!activeRemoteTask) return null;
  return {
    ...activeRemoteTask.task,
    status: activePauseState ? 'paused' : 'running',
    pausedReason: activePauseState?.reason,
  };
}
```

### 2g. `startRemoteTask` — restructure `activeRemoteTask` assignment

Replace the `activeRemoteTask = { ... }` assignment block (after window/tab
creation, before `chrome.storage.session.set`):

```ts
// Before:
activeRemoteTask = {
  tabId: tab.id,
  windowId: win.id,
  taskId: resolved.taskId,
  configId: resolved.configId,
  configName: resolved.configName,
  searchTerms: resolved.searchTerms,
  dataMapping: resolved.config.dataMapping,
};
isStartingTask = false;
chrome.storage.session.set({ activeRemoteTask }).catch(() => {});

// After:
activeRemoteTask = {
  task: { ...task, status: 'running' },
  tabId: tab.id,
  windowId: win.id,
  resolvedDataMapping: resolved.config.dataMapping,
};
isStartingTask = false;
chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
```

### 2h. `drainNextRemoteTask` — add `completedStatus` and `pushToRecent`

Replace the entire function:

```ts
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

### 2i. `handleRemoteFlowEvent` — full replacement

Replace the entire function. Key changes:
- All `activeRemoteTask.taskId` → `activeRemoteTask.task.id`
- `mapFlow*` receive a local `ctx: ActiveTaskContext` extracted from `activeRemoteTask.task`
- `FLOW_COMPLETE` calls `drainNextRemoteTask('completed')`

```ts
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
      const flowPayload = payload as { reason?: string; message?: string };
      console.warn('[SW] FLOW_PAUSED | taskId:', activeRemoteTask.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message);
      if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
      activePauseState = {
        reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
        message: flowPayload.message,
      };
      const hubPayload = mapFlowPaused(ctx, payload as unknown as FlowPausedPayload);
      relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
      return;
    }
  }
}
```

### 2j. Mechanical reference updates — remaining `activeRemoteTask.*` usages

After the replacements above, grep for any remaining old-shape references:

| Old | New |
|---|---|
| `activeRemoteTask?.taskId` | `activeRemoteTask?.task.id` |
| `activeRemoteTask.taskId` | `activeRemoteTask.task.id` |
| `activeRemoteTask.configId` | `activeRemoteTask.task.configId` |
| `activeRemoteTask.tabId` | unchanged (top-level field) |
| `activeRemoteTask.windowId` | unchanged (top-level field) |

Specific sites to update:

- **`FLOW_RESUMED` relay log** (in `contentToSidepanel` block):
  `activeRemoteTask?.taskId` → `activeRemoteTask?.task.id`
- **`RESUME_TASK` handler**:
  `activeRemoteTask.taskId` → `activeRemoteTask.task.id`
- **`CANCEL_TASK` handler**:
  `activeRemoteTask.taskId` → `activeRemoteTask.task.id`
- **`tabs.onRemoved` listener**:
  `activeRemoteTask.taskId` → `activeRemoteTask.task.id`,
  `activeRemoteTask.configId` → `activeRemoteTask.task.configId`

The `tabs.onRemoved` listener already calls `drainNextRemoteTask()` (default
`'failed'`) — correct, leave as-is.

### 2k. `GET_QUEUE_SNAPSHOT` handler

Add immediately after the `GET_PAUSE_STATE` handler:

```ts
if (type === 'GET_QUEUE_SNAPSHOT') {
  sendResponse({
    active: buildSnapshotActiveTask(),
    pending: [...pendingRemoteTasks],
    recent: [...recentRemoteTasks],
  });
  return true;
}
```

`return true` keeps the response channel open (consistent with neighbours; also
prevents a Chrome runtime warning).

---

## File 3 — `src/sidepanel/stores/queueStore.ts`

### 3a. Extend `QueueState` interface

Add `seedFromSnapshot` to the interface:

```ts
interface QueueState {
  tasks: QueueTask[];
  currentTaskId: string | null;
  stats: QueueStats;

  addTask: (task: QueueTask) => void;
  setCurrentTask: (taskId: string | null) => void;
  updateTaskStatus: (taskId: string, status: QueueTask['status']) => void;
  completeTask: (taskId: string, result: TaskResult) => void;
  failTask: (taskId: string, error: string) => void;
  pauseTask: (taskId: string, reason: QueueTask['pausedReason']) => void;
  resumeTask: (taskId: string) => void;
  clearCompleted: () => void;
  clearPending: () => void;
  removeTask: (taskId: string) => void;
  seedFromSnapshot: (snapshot: { active: QueueTask | null; pending: QueueTask[]; recent: QueueTask[] }) => void;
}
```

### 3b. Add `seedFromSnapshot` implementation

Add after the `removeTask` implementation, before the closing `}))`:

```ts
  seedFromSnapshot: (snapshot) =>
    set((s) => {
      const existingIds = new Set(s.tasks.map((t) => t.id));
      const toAdd = [
        ...(snapshot.active ? [snapshot.active] : []),
        ...snapshot.pending,
        ...snapshot.recent,
      ].filter((t) => !existingIds.has(t.id));
      if (toAdd.length === 0) return s;
      const tasks = [...s.tasks, ...toAdd];
      const activeIsNew = snapshot.active !== null && !existingIds.has(snapshot.active.id);
      return {
        tasks,
        stats: recompute(tasks),
        currentTaskId: s.currentTaskId ?? (activeIsNew ? snapshot.active!.id : null),
      };
    }),
```

Semantics:
- Deduplicates by `id` — if the live `TASK_RECEIVED` arrived before the
  snapshot response, the task is already in the store and is skipped.
- Only sets `currentTaskId` if it is currently `null` and the active task from
  the snapshot is newly added. This prevents clobbering an already-focused task.
- `recent` tasks are appended but never set `currentTaskId`.

No new imports needed; `QueueTask` and `TaskResult` are already imported.

---

## File 4 — `src/sidepanel/utils/queueDispatcher.ts`

### 4a. Add import

At the top of the file, add:

```ts
import type { QueueSnapshot } from '../../types/signalr';
```

### 4b. Snapshot fetch on mount

Add the following block immediately after
`chrome.runtime.onMessage.addListener(rawListener)`:

```ts
  browser.runtime.sendMessage({ type: 'GET_QUEUE_SNAPSHOT' })
    .then((resp: unknown) => {
      const snapshot = resp as QueueSnapshot | null;
      if (snapshot) useQueueStore.getState().seedFromSnapshot(snapshot);
    })
    .catch(() => { /* SW may not be running yet — no-op */ });
```

The complete updated `startQueueDispatcher` for reference:

```ts
export function startQueueDispatcher(): () => void {
  const rawListener = (message: unknown) => {
    const msg = message as { type?: string; payload?: unknown };
    if (msg.type !== 'TASK_RECEIVED') return;
    const task = msg.payload as QueueTask;
    const store = useQueueStore.getState();
    store.addTask(task);
    store.setCurrentTask(task.id);
  };
  chrome.runtime.onMessage.addListener(rawListener);

  browser.runtime.sendMessage({ type: 'GET_QUEUE_SNAPSHOT' })
    .then((resp: unknown) => {
      const snapshot = resp as QueueSnapshot | null;
      if (snapshot) useQueueStore.getState().seedFromSnapshot(snapshot);
    })
    .catch(() => { /* SW may not be running yet — no-op */ });

  const offProgress = onMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as { taskId?: string };
    if (!p.taskId) return;
    useQueueStore.getState().updateTaskStatus(p.taskId, 'running');
  });

  const offComplete = onMessage('FLOW_COMPLETE', (payload) => {
    const p = payload as { taskId?: string; result: ScrapingResult };
    if (!p.taskId) return;
    const result: TaskResult = {
      taskId: p.taskId,
      configId: p.result.configId,
      configName: p.result.configName,
      status: 'success',
      iterations: p.result.iterations,
      totalTimeMs: p.result.totalTimeMs,
      timestamp: p.result.scrapedAt,
    };
    useQueueStore.getState().completeTask(p.taskId, result);
  });

  const offError = onMessage('FLOW_ERROR', (payload) => {
    const p = payload as { taskId?: string; error: string };
    if (!p.taskId) return;
    useQueueStore.getState().failTask(p.taskId, p.error);
  });

  const offPaused = onMessage('FLOW_PAUSED', (payload) => {
    const p = payload as { taskId?: string; reason?: 'cloudflare' | 'awaitUserAction'; message?: string };
    if (!p.taskId || (p.reason !== 'cloudflare' && p.reason !== 'awaitUserAction')) return;
    useQueueStore.getState().pauseTask(p.taskId, p.reason);
    if (p.reason === 'cloudflare') {
      useUiStore.getState().setCloudflarePaused(true);
    } else {
      useUiStore.getState().setAwaitActionPaused({ message: p.message ?? 'Action needed in your browser.' });
    }
  });

  const offResumed = onMessage('FLOW_RESUMED', () => {
    useUiStore.getState().setCloudflarePaused(false);
    useUiStore.getState().setAwaitActionPaused(null);
  });

  return () => {
    chrome.runtime.onMessage.removeListener(rawListener);
    offProgress();
    offComplete();
    offError();
    offPaused();
    offResumed();
  };
}
```

---

## Verification

### Type-check and build

```bash
npx tsc --noEmit
npx wxt build
```

Both must pass with zero errors.

### Manual test cases

| # | Scenario | Expected |
|---|---|---|
| 1 | Start batch from backend with panel **closed** → open panel | Active task card appears (status: running) |
| 2 | Start two batches quickly → open panel | 1 active + 1 pending visible |
| 3 | Let task **complete** with panel closed → open panel | Task in Completed section, Done: 1 |
| 4 | Panel **open** when task starts → close → reopen | Task still shown as active |
| 5 | Task paused for **Cloudflare** with panel closed → open panel | Paused card + Resume button |
| 6 | Local (non-queue) scrape | Queue tab shows "No tasks yet" |

### Regression check

- Sidepanel closed → task runs to completion (backend shows Completed)
- `RESUME_TASK` from hub resumes the scrape without panel interaction
- `CANCEL_TASK` from hub aborts the scrape without panel interaction

---

## Architecture notes

**Why session storage for `recentRemoteTasks`?**
`chrome.storage.session` is cleared on browser close, matching the expectation
that the queue list is ephemeral. `chrome.storage.local` would persist stale
"completed" cards across restarts. `activeRemoteTask` is already session-stored
for the same reason.

**Why a pull model rather than a SW push?**
A push would require the SW to detect panel mount — either a `PANEL_READY`
message or `chrome.runtime.connect` lifecycle. Both add complexity. The pull
model is simpler: panel asks once on mount, SW answers synchronously from
in-memory state. Live events keep the store current after that.

**`seedFromSnapshot` deduplication rationale**
The raw `TASK_RECEIVED` listener and the snapshot response both arrive in the
same microtask queue on panel mount. `seedFromSnapshot` guards with an
`existingIds` set so no task is duplicated regardless of ordering.

**Known follow-up (out of scope)**
`runStore.isRunning` in `QueueView.tsx:75` tracks panel-driven runs only — the
"— running…" suffix never shows for remote tasks. Pre-existing bug, not
introduced here.
