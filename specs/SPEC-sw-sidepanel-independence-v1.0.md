# SPEC-sw-sidepanel-independence-v1.0

## Context

Remote queue scrapes required the sidepanel to be open for two reasons:

1. **Server-initiated control** (`RESUME_TASK`, `CANCEL_TASK` from hub) was relayed through
   the sidepanel as a dumb pass-through, even though the SW already has `activeRemoteTask.tabId`
   and can send directly to the content script.

2. **User-initiated pause recovery** (Cloudflare / `awaitUserAction`) stored no state in the SW,
   so a sidepanel opened after a pause had no way to know what to show.

Goal: scrapes run to completion with the sidepanel fully closed. Pauses still require the user to
open the sidepanel (auto-open requires a user-gesture context we don't have), but the sidepanel
correctly hydrates pause state on open so the user can act immediately.

## File changes

### 1. `src/entrypoints/background.ts`

#### 1a. Add `activePauseState` at line 28 (after `pendingRemoteTasks`)

```typescript
// After:
const pendingRemoteTasks: QueueTask[] = [];

// Add:
let activePauseState: { reason: 'cloudflare' | 'awaitUserAction'; message?: string } | null = null;
```

#### 1b. Clear `activePauseState` in `drainNextRemoteTask` (line 185)

```typescript
function drainNextRemoteTask(): void {
  activePauseState = null;   // ← add this line
  activeRemoteTask = null;
  const next = pendingRemoteTasks.shift();
  if (next) {
    startRemoteTask(next).catch((err) => console.error('[SW] Failed to start queued task:', err));
  }
}
```

#### 1c. Store pause state in `handleRemoteFlowEvent` FLOW_PAUSED case (line 214)

```typescript
case 'FLOW_PAUSED': {
  const flowPayload = payload as { reason?: string; message?: string };
  if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
  activePauseState = {
    reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
    message: flowPayload.message,
  };
  const hubPayload = mapFlowPaused(activeRemoteTask, payload as unknown as FlowPausedPayload);
  relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
  return;
}
```

#### 1d. Handle `RESUME_TASK` and `CANCEL_TASK` directly in SW message router

Insert before the `offscreenToSidepanel` block (currently line 297):

```typescript
// ── Server-initiated task control (handled directly — no sidepanel required) ──

if (type === 'RESUME_TASK') {
  const { taskId } = (message.payload ?? {}) as { taskId?: string };
  if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.taskId)) {
    browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'RESUME_AFTER_CLOUDFLARE' })
      .catch((err) => console.error('[SW] RESUME_AFTER_CLOUDFLARE failed:', err));
    activePauseState = null;
  }
  return;
}

if (type === 'CANCEL_TASK') {
  const { taskId } = (message.payload ?? {}) as { taskId?: string };
  if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.taskId)) {
    browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'ABORT_FLOW' })
      .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
  }
  return;
}
```

Note: `CANCEL_TASK` does not call `drainNextRemoteTask` directly. The content script responds
to `ABORT_FLOW` with `FLOW_ERROR`, which triggers `handleRemoteFlowEvent` → `drainNextRemoteTask`.
If the tab is already gone, `tabs.onRemoved` handles cleanup.

#### 1e. Remove `RESUME_TASK` and `CANCEL_TASK` from `offscreenToSidepanel`

```typescript
// Before:
const offscreenToSidepanel = [
  'RESUME_TASK', 'CANCEL_TASK', 'CONNECTION_READY', 'CONNECTION_LOST',
  'CONNECTION_STATUS',
];

// After:
const offscreenToSidepanel = [
  'CONNECTION_READY', 'CONNECTION_LOST', 'CONNECTION_STATUS',
];
```

#### 1f. Add `GET_PAUSE_STATE` handler after the `offscreenToSidepanel` block

```typescript
if (type === 'GET_PAUSE_STATE') {
  sendResponse({ pauseState: activePauseState });
  return;
}
```

### 2. `src/sidepanel/App.tsx`

Extend the existing mount `useEffect` (lines 28–52) to also query pause state and apply it
to `uiStore` after the connection status is resolved:

```typescript
useEffect(() => {
  const { serverUrl, mode, workerName } = useSettingsStore.getState();
  browser.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' })
    .then(async (res: unknown) => {
      const r = res as { status?: ConnectionStatus };
      const status = r?.status ?? 'idle';
      useSettingsStore.getState().setConnectionStatus(status);

      // Hydrate any active pause state so alerts show immediately on open
      const pauseRes = await browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' }).catch(() => null);
      const ps = (pauseRes as { pauseState?: { reason: string; message?: string } } | null)?.pauseState;
      if (ps?.reason === 'cloudflare') {
        useUiStore.getState().setCloudflarePaused(true);
      } else if (ps?.reason === 'awaitUserAction') {
        useUiStore.getState().setAwaitActionPaused({ message: ps.message ?? 'Action needed in your browser.' });
      }

      if (status === 'idle' && mode === 'queue' && serverUrl) {
        const token = await getApiToken().catch(() => null);
        if (token) {
          await browser.runtime.sendMessage({
            type: 'INIT_SIGNALR',
            payload: {
              serverUrl,
              token,
              clientId: workerName || 'My Browser',
              version: chrome.runtime.getManifest().version,
            },
          });
        }
      }
    })
    .catch(() => {});
}, []);
```

No new imports needed — `useUiStore` is already imported in App.tsx.

## What is deleted

- `'RESUME_TASK'` and `'CANCEL_TASK'` entries removed from the `offscreenToSidepanel` array.
  These were relayed to the sidepanel where nothing consumed them for `CANCEL_TASK`, and
  `RESUME_TASK` triggered a manual sidepanel button action that is now bypassed.

## Verification

```
wxt build   # type-check passes, no build errors
```

Manual:
1. Queue mode connected, sidepanel closed → trigger a run → verify it completes (backend shows Completed)
2. Mid-run, open sidepanel → verify queue state and connection status show correctly
3. Trigger a pause (Cloudflare or awaitUserAction) with sidepanel closed → open sidepanel → verify alert renders immediately
4. Click Resume in sidepanel → verify scrape continues
5. Backend sends CancelTask → verify content script stops and run ends
