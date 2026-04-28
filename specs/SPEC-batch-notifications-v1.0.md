# SPEC-PR6 — Batch notifications + manifest permission
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1 (`aff52ba`), PR1.5 (`63f902b`), PR2 (`226f480`), PR3 (`9d0408b`), PR4 (`6906f65`), PR5 (`7c290b1`).

---

## Context

PR6 closes out the batched-parallel-scraping initiative with **Chrome notifications** so the user can walk away from a batch and still know when:

1. A drain-phase task **auto-pauses** for re-auth (session expired mid-scrape, etc.) — only fired when the user's attention is elsewhere (browser focus on a different window than the task's scrape window).
2. A **batch completes** (drain → idle transition, or preflight-only batch finishing) — shows a summary count.

Both notifications are **togglable** via two new checkboxes in APISettingsView. Defaults are on. Settings propagate to the SW via the existing `SET_BATCH_SETTINGS` message (extended in PR5) — payload now carries the toggle booleans too.

**Click behaviour:** clicking a task-pause notification focuses the task's scrape window. Clicking a batch-complete notification clears it (no specific window to focus).

**Out of scope:** in-page badge/count UI, sound, OS-native action buttons. Pure Chrome notification API.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Notification helpers | `src/background/notifications.ts` (new) | `notifyTaskPaused`, `notifyBatchComplete`, `taskNotificationId`, `batchNotificationId`, `BatchSummary` type |
| Manifest permission | `wxt.config.ts` | Add `'notifications'` to `permissions` |
| SW: gate + invoke notifications | `src/entrypoints/background.ts` | FLOW_PAUSED handler fires task notification (drain phase + window unfocused); endTask path fires batch-complete notification on phase→idle |
| SW: click routing | `src/entrypoints/background.ts` | `chrome.notifications.onClicked` listener |
| Settings field | `src/sidepanel/stores/settingsStore.ts` | `notifyOnPause: boolean`, `notifyOnBatchComplete: boolean` (defaults true) |
| Settings UI | `src/sidepanel/components/APISettingsView.tsx` | Two checkboxes in Batch section |
| Settings propagation | `src/sidepanel/components/APISettingsView.tsx` + `src/entrypoints/background.ts` | `SET_BATCH_SETTINGS` payload extended; SW caches the toggles in module scope, persists to `chrome.storage.local` |
| Tests | `src/__tests__/notifications.test.ts` (new) | Pure tests for `taskNotificationId`, `batchNotificationId`, summary formatter |

**Reuse:**
- `chrome.notifications` API directly (MV3 standard).
- Existing `SET_BATCH_SETTINGS` message handler from PR5 — extended with two new optional fields.
- Existing settings-UI patterns (`form-group + form-check`).
- `ActiveRemoteTask` type from `scheduler.ts`.

**Maintainability:**
- Notification creation isolated in one module.
- Notification IDs are deterministic prefixes — click routing parses them, no separate state map.
- Toggles default-on; user can disable per type.
- No magic strings — IDs come from `taskNotificationId` / `batchNotificationId` helpers.

---

## Locked decisions (do not re-litigate)

| # | Decision | Choice |
|---|---|---|
| 1 | When to fire pause notification | `phase === 'drain'` AND focused window ≠ task's window. Not fired during preflight (user is actively engaged). |
| 2 | "Manager unfocused" detection | `chrome.windows.getLastFocused()` ≠ `task.windowId`. Simple, covers browser-blurred and other-window cases. |
| 3 | When to fire batch-complete notification | After every endTask, if `scheduler.getPhase() === 'idle'` and `batchStats.total > 0`. Covers both drain-completing and preflight-only batches. Then reset stats. |
| 4 | Batch summary copy | `"Batch finished. {n} done, {m} need attention."` — `n = succeeded`, `m = failed`. Singular vs plural handled by template. |
| 5 | Pause notification copy | `"{configName} needs your attention."` as title; `pause.message ?? "Action needed in your browser."` as body. |
| 6 | Notification IDs | `bb-task-{taskId}` and `bb-batch-{timestamp}`. Click routing parses by prefix. |
| 7 | Click on task notification | `chrome.windows.update(task.windowId, { focused: true, state: 'normal' })`. Then clear the notification. |
| 8 | Click on batch notification | Just clear. No window to focus. |
| 9 | Toggles default | Both default to `true` (notifications on). User opts out. |
| 10 | Toggles propagation | Sidepanel sends extended `SET_BATCH_SETTINGS` payload on Save; SW caches in module scope and `chrome.storage.local`. |
| 11 | Cross-browser | `chrome.notifications` exists in Firefox MV3. Wrap calls in try/catch defensively; log on failure. |
| 12 | Quiet failure | If `chrome.notifications` throws (permission missing, OS notification disabled), log warn + swallow. Do not block scheduler. |

---

## File 1 (NEW): `src/background/notifications.ts`

```typescript
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
```

---

## File 2 (MODIFIED): `wxt.config.ts`

**Replace** the `permissions` line (currently line 15):

```typescript
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen'],
```

with:

```typescript
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen', 'notifications'],
```

This is the only change needed — WXT regenerates the manifest on `npm run build`.

---

## File 3 (MODIFIED): `src/entrypoints/background.ts`

### 3a — Add imports

**After** the existing `import { originOf } from '../background/originOf';` line (currently line 12), **insert**:

```typescript
import {
  notifyTaskPaused,
  notifyBatchComplete,
  isTaskNotification,
  isBatchNotification,
  taskIdFromNotificationId,
} from '../background/notifications';
```

### 3b — Add module-scope state for toggles + batch stats

**After** the existing `let activePauseState: ... = null;` block (currently around lines 47–52), **insert**:

```typescript
  // PR6 — notification toggles. Hydrated from chrome.storage.local on SW
  // start; updated via SET_BATCH_SETTINGS messages from sidepanel.
  let notifyOnPause = true;
  let notifyOnBatchComplete = true;

  // PR6 — accumulated stats for the current batch. Reset on transition to
  // idle (after firing the batch-complete notification). Counts FLOW_COMPLETE
  // as succeeded; FLOW_ERROR and tab-closed-mid-task as failed.
  const batchStats = { total: 0, succeeded: 0, failed: 0 };

  // PR6 — track scheduler phase to detect drain→idle transitions for the
  // batch-complete notification. Updated after every endTask call.
  let prevSchedulerPhase: import('../background/scheduler').BatchPhase = 'idle';
```

### 3c — Hydrate toggles on SW start

**Find** the existing storage-restore block (currently around line 65):

```typescript
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTasks', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (Array.isArray(data.activeRemoteTasks)) {
      scheduler.restoreActive(data.activeRemoteTasks as PersistedActiveRecord[]);
    }
    if (Array.isArray(data.recentRemoteTasks)) {
      scheduler.setRecent(data.recentRemoteTasks as QueueTask[]);
    }
  }).catch(() => {});
```

**Append** an additional storage hydration block immediately after that one:

```typescript
  // PR6 — hydrate notification toggles from chrome.storage.local. Defaults
  // (true/true) apply if storage is empty.
  chrome.storage.local.get(['notifyOnPause', 'notifyOnBatchComplete']).then((data: Record<string, unknown>) => {
    if (typeof data.notifyOnPause === 'boolean') notifyOnPause = data.notifyOnPause;
    if (typeof data.notifyOnBatchComplete === 'boolean') notifyOnBatchComplete = data.notifyOnBatchComplete;
  }).catch(() => {});
```

### 3d — Extend SET_BATCH_SETTINGS to carry the toggles

PR5 added the `SET_BATCH_SETTINGS` handler. **Locate** that block (search for `'SET_BATCH_SETTINGS'`) and **replace** the body with:

```typescript
    if (type === 'SET_BATCH_SETTINGS') {
      const p = (message.payload ?? {}) as {
        drainParallelCap?: number;
        preflightQuietMs?: number;
        notifyOnPause?: boolean;
        notifyOnBatchComplete?: boolean;
      };
      if (typeof p.drainParallelCap === 'number') {
        scheduler.setDrainParallelCap(p.drainParallelCap);
        console.warn('[SW] batch settings | drainParallelCap:', p.drainParallelCap);
      }
      if (typeof p.preflightQuietMs === 'number') {
        chrome.storage.local.set({ batchPreflightQuietMs: p.preflightQuietMs }).catch(() => {});
      }
      if (typeof p.notifyOnPause === 'boolean') {
        notifyOnPause = p.notifyOnPause;
        chrome.storage.local.set({ notifyOnPause }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnPause:', notifyOnPause);
      }
      if (typeof p.notifyOnBatchComplete === 'boolean') {
        notifyOnBatchComplete = p.notifyOnBatchComplete;
        chrome.storage.local.set({ notifyOnBatchComplete }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnBatchComplete:', notifyOnBatchComplete);
      }
      return;
    }
```

### 3e — Fire pause notification in FLOW_PAUSED handler

**Locate** the `case 'FLOW_PAUSED':` block in `handleRemoteFlowEvent` (currently around line 350). After the existing `relayHubInvocation('SEND_TASK_PAUSED', hubPayload);` line, **insert** the notification gate:

```typescript
      case 'FLOW_PAUSED': {
        // ...existing payload normalisation, activePauseState mirror,
        // and relayHubInvocation calls...

        // PR6 — fire a Chrome notification only when:
        //   - notifyOnPause toggle is on
        //   - scheduler is in drain phase (mid-drain re-auth, not preflight)
        //   - the focused window is NOT this task's window
        if (notifyOnPause && scheduler.getPhase() === 'drain') {
          const target = record;
          chrome.windows.getLastFocused().then((focusedWindow) => {
            if (!focusedWindow || focusedWindow.id !== target.windowId) {
              const msg = flowPayload.message ?? 'Action needed in your browser.';
              notifyTaskPaused(target, msg);
            }
          }).catch(() => { /* getLastFocused failed — skip notification */ });
        }
        return;
      }
```

**Important:** the existing block has more code (activePauseState assignment, hub relay) — preserve all of it. Only add the new notification gate at the end before `return;`. Use the spec's snippet as a template; keep every existing line.

### 3f — Track batch stats on every endTask outcome

**Locate** the `drainNextRemoteTask` function (currently around lines 274–297). Wrap the existing body with stats tracking.

**Replace** the existing function:

```typescript
  function drainNextRemoteTask(taskId: string, completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closing = scheduler.endTask(taskId);
    if (!closing) {
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

with:

```typescript
  function drainNextRemoteTask(taskId: string, completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closing = scheduler.endTask(taskId);
    if (!closing) {
      return;
    }
    scheduler.pushRecent({ ...closing.task, status: completedStatus, pausedReason: undefined });
    persistActive();
    persistRecent();

    // PR6 — accumulate batch stats for the eventual batch-complete notification.
    batchStats.total++;
    if (completedStatus === 'completed') batchStats.succeeded++;
    else batchStats.failed++;

    // PR6 — detect batch-complete (transition to idle). Fire notification + reset.
    const phaseAfter = scheduler.getPhase();
    if (phaseAfter === 'idle' && prevSchedulerPhase !== 'idle' && batchStats.total > 0) {
      if (notifyOnBatchComplete) {
        notifyBatchComplete({ ...batchStats });
      }
      batchStats.total = 0;
      batchStats.succeeded = 0;
      batchStats.failed = 0;
    }
    prevSchedulerPhase = phaseAfter;

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

### 3g — Register notification click handler

**Insert** at the end of `defineBackground(() => { ... })` body, **after** the existing tab-lifecycle listeners (after the `browser.tabs.onUpdated.addListener(...)` block, around line 736), **before** the closing `});`:

```typescript
  // PR6 — notification click routing. Wrapped in try/catch because some
  // browsers may not have chrome.notifications even with the permission set.
  try {
    chrome.notifications.onClicked.addListener((id) => {
      if (isTaskNotification(id)) {
        const taskId = taskIdFromNotificationId(id);
        if (taskId) {
          const target = scheduler.getActiveTask(taskId);
          if (target) {
            chrome.windows.update(target.windowId, { focused: true, state: 'normal' })
              .catch((err: Error) => console.warn('[notifications] focus failed:', err.message));
          }
        }
        chrome.notifications.clear(id);
        return;
      }
      if (isBatchNotification(id)) {
        chrome.notifications.clear(id);
        return;
      }
    });
  } catch (err) {
    console.warn('[notifications] onClicked listener registration failed:', (err as Error).message);
  }
```

---

## File 4 (MODIFIED): `src/sidepanel/stores/settingsStore.ts`

### 4a — Add fields to SettingsState

**Find** the `batchParallelCap: number;` declaration (added in PR4) and **insert** the new fields immediately after it:

```typescript
  batchPreflightQuietMs: number;
  batchParallelCap: number;
  // PR6 — notification toggles. Defaults true.
  notifyOnPause: boolean;
  notifyOnBatchComplete: boolean;
```

**Find** the `setBatchParallelCap: (cap: number) => void;` setter and **insert** new setters after it:

```typescript
  setBatchPreflightQuietMs: (ms: number) => void;
  setBatchParallelCap: (cap: number) => void;
  setNotifyOnPause: (v: boolean) => void;
  setNotifyOnBatchComplete: (v: boolean) => void;
```

### 4b — Default values + setters in store body

**Find** the `batchParallelCap: 4,` initial value and **insert** the new defaults after it:

```typescript
      batchPreflightQuietMs: 5000,
      batchParallelCap: 4,
      notifyOnPause: true,
      notifyOnBatchComplete: true,
```

**Find** the existing `setBatchParallelCap` setter and **insert** the new setters after it:

```typescript
      setBatchParallelCap: (batchParallelCap) =>
        set({ batchParallelCap }),
      setNotifyOnPause: (notifyOnPause) =>
        set({ notifyOnPause }),
      setNotifyOnBatchComplete: (notifyOnBatchComplete) =>
        set({ notifyOnBatchComplete }),
```

### 4c — Persist the new fields

**Find** the `partialize` config and **add** the two new keys:

```typescript
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        pauseOnCloudflare: s.pauseOnCloudflare,
        mode: s.mode,
        workerName: s.workerName,
        batchPreflightQuietMs: s.batchPreflightQuietMs,
        batchParallelCap: s.batchParallelCap,
        notifyOnPause: s.notifyOnPause,
        notifyOnBatchComplete: s.notifyOnBatchComplete,
      }),
```

---

## File 5 (MODIFIED): `src/sidepanel/components/APISettingsView.tsx`

### 5a — Read the new toggle state

**After** the existing `setBatchParallelCap` line in the component body (added in PR5), **add**:

```typescript
  const notifyOnPause = useSettingsStore((s) => s.notifyOnPause);
  const notifyOnBatchComplete = useSettingsStore((s) => s.notifyOnBatchComplete);
  const setNotifyOnPause = useSettingsStore((s) => s.setNotifyOnPause);
  const setNotifyOnBatchComplete = useSettingsStore((s) => s.setNotifyOnBatchComplete);
```

### 5b — Toggle handlers

**After** the existing `toggleClearVisible` function in the component body, **add**:

```typescript
  const toggleNotifyOnPause = (next: boolean): void => {
    setNotifyOnPause(next);
    browser.runtime.sendMessage({
      type: 'SET_BATCH_SETTINGS',
      payload: { notifyOnPause: next },
    }).catch(() => { /* SW asleep — best effort */ });
  };

  const toggleNotifyOnBatchComplete = (next: boolean): void => {
    setNotifyOnBatchComplete(next);
    browser.runtime.sendMessage({
      type: 'SET_BATCH_SETTINGS',
      payload: { notifyOnBatchComplete: next },
    }).catch(() => { /* SW asleep — best effort */ });
  };
```

### 5c — Render the toggles in JSX

**Insert** the two toggles **immediately after** the existing "Wait for page to settle" form-group (PR5's last batch settings block), **before** the "Show debug info in scrape output" form-group.

```typescript
      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={notifyOnPause}
            onChange={(e) => toggleNotifyOnPause(e.target.checked)}
          />
          Notify when a scrape pauses for action
        </label>
        <p className="form-hint">Shows a Chrome notification when a draining task needs your attention and you’re not on its window.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={notifyOnBatchComplete}
            onChange={(e) => toggleNotifyOnBatchComplete(e.target.checked)}
          />
          Notify when a batch finishes
        </label>
        <p className="form-hint">Shows a Chrome notification with the result count when a batch ends.</p>
      </div>
```

### 5d — Optional: also propagate toggles in `handleSave`

The two toggles fire `SET_BATCH_SETTINGS` immediately when toggled, so `handleSave` doesn't need to do it. The existing `handleSave` block from PR5 still propagates `drainParallelCap` and `preflightQuietMs` only — leave it alone.

---

## File 6 (NEW): `src/__tests__/notifications.test.ts`

```typescript
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
```

---

## What is changed (no deletions)

PR6 is purely additive. No file deletions.

---

## Verification

### Automated

```bash
npm test -- src/__tests__/notifications.test.ts
npm test
npm run type-check       # output must equal pre-PR6 baseline
npm run lint -- src/background/notifications.ts src/entrypoints/background.ts src/sidepanel/components/APISettingsView.tsx src/sidepanel/stores/settingsStore.ts
npm run build
```

**Pre-existing typecheck noise (do NOT fix):** same set as the prior PRs. After PR6 the type-check output must be identical to the baseline (commit `7c290b1`). If new errors appear, stop and report.

**Build verification:** after `npm run build`, confirm the generated `.output/chrome-mv3/manifest.json` includes `"notifications"` in the `permissions` array.

### Manual smoke (5 cases)

Build with `npm run build`. Load `.output/chrome-mv3` unpacked. Open SW DevTools console.

1. **Pause notification fires when manager unfocused** — start a 2-task batch. Walk through preflight for both tasks. After drain begins, switch focus to a different chrome window or another app. Force a session expiry on one of the draining tasks. Expected: a Chrome notification appears with the task's configName and the pause message. SW console: `[notifications] task-paused create failed:` should NOT appear.

2. **Pause notification suppressed when window focused** — same as case 1, but stay on the task's scrape window when session expires. Expected: PauseAlert appears in the sidepanel; **no** Chrome notification.

3. **Pause notification suppressed when toggle off** — open Settings, uncheck "Notify when a scrape pauses for action", Save. Repeat case 1. Expected: no notification fired (only the in-app PauseAlert).

4. **Batch-complete notification fires** — start a 2-task batch with simple configs that finish quickly. Wait for both tasks to complete. Expected: a Chrome notification appears with body `"Batch finished. 2 done."`.

5. **Click routing works** — let a notification appear (case 1 or 4). Click it. For case 1: the task's scrape window should focus. For case 4: notification clears, no window action.

### Edge cases

| Case | How handled |
|---|---|
| `chrome.notifications` missing or throws | Wrapped in try/catch in `notifyTaskPaused` and `notifyBatchComplete`; click listener registration also wrapped. Logs warn + continues. |
| Notification permission denied at OS level | `chrome.notifications.create` callback receives an error in `chrome.runtime.lastError`; logged + swallowed. |
| Click on a notification whose task is no longer active (window closed) | `scheduler.getActiveTask` returns `undefined`; the `if (target)` check skips the focus call. Notification still cleared. |
| Batch ends with stats.total = 0 (e.g., scheduler reset for some reason) | The `batchStats.total > 0` guard skips the notification. |
| Multiple SW restarts during a batch | `batchStats` is module-scope and resets on SW restart. The first restart loses its accumulated stats — sub-optimal but acceptable for v1; SW restarts mid-batch are rare. |
| Two consecutive pauses on the same task in drain | Two notifications fire (different IDs by timestamp? No — task notifications use the taskId, so they share an ID). The second `chrome.notifications.create` REPLACES the first (Chrome's behaviour for same ID). Acceptable. |

### Edge cases — ignored (v1)

| Case | Why |
|---|---|
| Manager-window concept (multi-window batches with sidepanel binding) | Out of scope; PR4–PR5 already simplified to "task window != focused window". |
| Notification badges or counts | Pure Chrome notifications API only. |
| OS-native notification action buttons | `chrome.notifications.buttons` is supported but adds complexity; defer. |
| Sound | OS-default. |

---

## Maintainability checklist

- [x] No magic strings — IDs via `taskNotificationId` / `batchNotificationId` helpers
- [x] Notification module owns the chrome.notifications surface; nothing else touches it
- [x] One responsibility per module — notifications.ts is creation-only; click routing in background.ts; gating logic also in background.ts
- [x] Configurable knobs — both notifications are togglable, settings persist
- [x] Reuse — existing SET_BATCH_SETTINGS message + existing settings UI patterns
- [x] Pure tests — id helpers and formatter tested with no DOM/runtime
- [x] Backward compat — toggles default-on, no behaviour change for existing settings; manifest permission addition prompts user on extension reload (Chrome standard)
- [x] Cross-browser — chrome.notifications wrapped in try/catch; Firefox MV3 supports it but defensive
- [x] Stage C compliance — all UI uses existing classes (`form-group`, `form-check`, `form-hint`); no new tokens

---

## Stuck-loop escalation reminder

If two consecutive attempts to make a check green fail, STOP and report. Common gotchas: (a) `chrome.notifications` typing issues — `chrome` is typed via `@types/chrome` which should be present; if not, use `(chrome as any).notifications` with a TODO comment; (b) the `BatchPhase` type-only import — verify `import type { BatchPhase } from '../background/scheduler';` works (it should, scheduler.ts exports the type); (c) ESLint rule against `console.warn` — existing background.ts already uses `console.warn` widely, so you should be safe. Escalate to Opus if a stuck-loop hits 2 failed attempts on the same hypothesis.
