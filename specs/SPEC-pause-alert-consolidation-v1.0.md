# SPEC-PR5 — Per-task PauseAlert + batch settings UI
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1 (`aff52ba`), PR1.5 (`63f902b`), PR2 (`226f480`), PR3 (`9d0408b`), PR4 (`6906f65`).

---

## Context

PR4 made batched scraping work end-to-end at the protocol level, but the sidepanel UI is still single-task: `uiStore.cloudfarePaused` and `uiStore.awaitActionPaused` each hold one slot, so a second pause overwrites the first. With cap=4 in drain, up to 4 tasks can pause for re-auth simultaneously and the user has no way to see or resume each one.

PR5 fixes that with the **smallest** UI surface that makes batch dogfooding usable:

1. The **queueStore** becomes the single source of truth for per-task pause state.
2. A new **PauseAlert** component renders **one banner per paused task**. Reused for both Cloudflare and the generic awaitUserAction path — same component, same Continue button, same Skip-trigger button when applicable.
3. App.tsx drops the two singleton alerts and instead renders `N` PauseAlerts (one per paused task in queueStore).
4. **APISettingsView** gains a small "Batch" section exposing `batchPreflightQuietMs` and `batchParallelCap`. The settings are propagated to the SW via a new `SET_BATCH_SETTINGS` message; SW pushes the cap to `scheduler.setDrainParallelCap`. The preflight-quiet override threading is deferred to a later PR (PR3's content-script default still applies).
5. The SW accepts a `taskId` in the `RESUME_AFTER_PAUSE` payload so the user can resume any specific paused task — not just the active tab. Falls back to current behaviour when `taskId` is absent.
6. The legacy `CloudflarePauseAlert.tsx` and `AwaitActionPauseAlert.tsx` files are deleted; their logic lives in PauseAlert.

**Out of scope** (deferred to PR6+):
- BatchControls (Cancel-whole-batch button).
- BatchTaskList (a dedicated batch panel — QueueView is good enough for v1).
- Notifications + notification toggles (PR6).
- Window minimise/un-minimise on phase transition.
- "Focus window" / "Mark ready" buttons in the task list.
- Override threading for `batchPreflightQuietMs` (content script still uses `PREFLIGHT_QUIET_MS` constant).
- Manual per-task abort button for running tasks.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Per-task pause state | `src/sidepanel/stores/queueStore.ts` | `pauseTask` extended; `getPausedTasks` selector |
| Pause data shape | `src/types/signalr.ts` | `QueueTask.pause` optional record (replaces `pausedReason`-only model) |
| Queue dispatcher routing | `src/sidepanel/utils/queueDispatcher.ts` | Pass full FLOW_PAUSED payload to queueStore; drop uiStore singleton sets |
| Pause UI | `src/sidepanel/components/PauseAlert.tsx` (new) | Per-task component (props: task) |
| Old alerts deleted | `src/sidepanel/components/CloudflarePauseAlert.tsx`, `AwaitActionPauseAlert.tsx` | Removed |
| App composition | `src/sidepanel/App.tsx` | Render N PauseAlerts; drop GET_PAUSE_STATE handshake |
| Singleton pause slots | `src/sidepanel/stores/uiStore.ts` | Drop `cloudfarePaused`, `awaitActionPaused`, setters |
| Per-task resume routing | `src/entrypoints/background.ts` | `RESUME_AFTER_PAUSE` honours payload.taskId |
| Batch settings UI | `src/sidepanel/components/APISettingsView.tsx` | New "Batch" section |
| Settings → SW propagation | `src/entrypoints/background.ts`, `src/sidepanel/components/APISettingsView.tsx` | `SET_BATCH_SETTINGS` message; scheduler.setDrainParallelCap |
| Tests | `src/__tests__/PauseAlert.test.tsx` (new) | RTL render-and-click tests |

**Reuse:** `detection-banner`, `detection-banner--warning`, `detection-banner-body`, `detection-banner-hint`, `detection-banner-actions`, `btn`, `btn-secondary`, `btn-sm`, `form-group`, `form-label`, `form-input`, `form-hint`. **No new CSS classes.**

---

## Stage C — UI checklist (per global CLAUDE.md)

| Requirement | How addressed |
|---|---|
| Use existing design tokens | All colours via existing `--warning-light`, `--warning`, `--text-light` etc. through reused class names. **No hex/rgb literals introduced.** |
| Component reuse | PauseAlert composes existing CSS classes. APISettingsView "Batch" section follows the same `.form-group + .form-label + .form-input + .form-hint` pattern as its sibling sections. |
| Palette enforcement | Verified — no inline `style={{ color: ... }}` or hardcoded colours. All visuals come from `detection-banner--warning` and other existing classes. |
| Rendering states | PauseAlert handles: cloudflare reason (no Skip button), awaitUserAction (Skip button when `trigger` and `domain` known, hidden otherwise). N>1 banners stack vertically with default flex layout — same as one banner repeated. |
| User-facing copy (informal, actionable) | Reuses existing copy verbatim: "Sign in to continue.", "Dismiss the cookie banner to continue.", "Solve the challenge to continue.", "Solve the captcha to continue.", "Action needed in your browser." Page-task name shown as a bold prefix per banner so the user knows which of N tasks needs attention. |

**Confirmation:** no new one-off classes. No new design tokens.

---

## Locked decisions (do not re-litigate)

| # | Decision | Choice |
|---|---|---|
| 1 | Pause UI placement | Top of `App.tsx`, above `app-content`. One banner per paused task, vertically stacked. |
| 2 | Banner identity | Each banner shows the task's `configName` as a bolded prefix — disambiguates which of N tasks needs attention. |
| 3 | Cloudflare vs awaitUserAction | Single component with conditional Skip button (hidden for cloudflare). Same banner style, same Continue button. |
| 4 | Per-task Resume routing | `RESUME_AFTER_PAUSE` accepts `payload.taskId`. SW looks up tabId via `scheduler.getActiveTask(taskId)` and sends to that specific tab. Falls through to active-tab routing when `taskId` absent (back-compat for sidepanel-mode runs). |
| 5 | Single-task back-compat | When zero or one task is paused, behaviour matches current single-slot UX (one banner, click Continue). |
| 6 | Batch settings location | Existing APISettingsView gains a "Batch" form-group block before "Show debug info". No new tab. |
| 7 | Batch settings propagation | Sidepanel sends `SET_BATCH_SETTINGS` to SW on Save. SW updates `scheduler.setDrainParallelCap`. preflightQuietMs is stored but **not** consumed in PR5. |
| 8 | Notification toggle UI | **Deferred** — PR6 will add the UI alongside the notifications module. |
| 9 | "+ N more" overflow | Not needed in v1 — drainCap=4, so at most 4 banners. Acceptable layout. |
| 10 | Removing old alert files | Hard-delete `CloudflarePauseAlert.tsx` and `AwaitActionPauseAlert.tsx`. Logic fully captured in PauseAlert. |

---

## File 1 (MODIFIED): `src/types/signalr.ts`

### 1a — Replace `QueueTask.pausedReason` with a richer `pause` record

The current type has `pausedReason?: 'cloudflare' | 'awaitUserAction';`. To carry message/trigger/domain per task, replace with a structured `pause` field. Keep both for one PR if any caller still reads `pausedReason`; otherwise straight replacement.

**Find** the `QueueTask` interface (currently lines 4–19):

```typescript
export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction';
  progress?: { stepLabel: string; termIndex?: number };
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}
```

**Replace** with:

```typescript
import type { DetectionTrigger } from './messages';

export interface TaskPauseInfo {
  reason: 'cloudflare' | 'awaitUserAction';
  message?: string;
  trigger?: DetectionTrigger;
  domain?: string;
}

export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction'; // kept for back-compat with persisted tasks; populated alongside `pause` for one release
  pause?: TaskPauseInfo;                            // PR5 — per-task pause detail
  progress?: { stepLabel: string; termIndex?: number };
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}
```

Note: `import type { DetectionTrigger } from './messages';` goes at the top alongside the existing imports. The cyclic dependency is fine — TypeScript's `import type` is erased at compile time.

---

## File 2 (MODIFIED): `src/sidepanel/stores/queueStore.ts`

### 2a — Extend `pauseTask` signature

**Replace** the `pauseTask` action signature in the `QueueState` interface (currently around line 22):

```typescript
  pauseTask: (taskId: string, reason: QueueTask['pausedReason']) => void;
```

with:

```typescript
  pauseTask: (taskId: string, info: import('../../types/signalr').TaskPauseInfo) => void;
```

### 2b — Update the implementation

**Replace** the `pauseTask` reducer (currently around lines 85–90):

```typescript
  pauseTask: (taskId, reason) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'paused' as const, pausedReason: reason } : t,
      ),
    })),
```

with:

```typescript
  pauseTask: (taskId, info) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'paused' as const, pausedReason: info.reason, pause: info }
          : t,
      ),
    })),
```

### 2c — Clear pause on resume

**Replace** the `resumeTask` reducer (currently around lines 92–97):

```typescript
  resumeTask: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'running' as const, pausedReason: undefined } : t,
      ),
    })),
```

with:

```typescript
  resumeTask: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'running' as const, pausedReason: undefined, pause: undefined }
          : t,
      ),
    })),
```

---

## File 3 (MODIFIED): `src/sidepanel/utils/queueDispatcher.ts`

### 3a — Pass full pause info to `queueStore.pauseTask`; drop uiStore singleton sets

**Replace** the `offPaused` handler (currently lines 63–72):

```typescript
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
```

with:

```typescript
  const offPaused = onMessage('FLOW_PAUSED', (payload) => {
    const p = payload as {
      taskId?: string;
      reason?: 'cloudflare' | 'awaitUserAction';
      message?: string;
      trigger?: import('../../types/messages').DetectionTrigger;
      domain?: string;
    };
    if (!p.taskId || (p.reason !== 'cloudflare' && p.reason !== 'awaitUserAction')) return;
    useQueueStore.getState().pauseTask(p.taskId, {
      reason: p.reason,
      message: p.message,
      trigger: p.trigger,
      domain: p.domain,
    });
  });
```

### 3b — Drop the `offResumed` uiStore singleton reset

**Replace** the `offResumed` handler (currently lines 74–77):

```typescript
  const offResumed = onMessage('FLOW_RESUMED', () => {
    useUiStore.getState().setCloudflarePaused(false);
    useUiStore.getState().setAwaitActionPaused(null);
  });
```

with:

```typescript
  // FLOW_RESUMED payload doesn't carry taskId in the current wire protocol;
  // resume is driven by the user clicking PauseAlert, which calls
  // queueStore.resumeTask(taskId) directly. This handler is now a no-op
  // but is left registered to preserve the dispatcher contract.
  const offResumed = onMessage('FLOW_RESUMED', () => { /* per-task resume done in PauseAlert */ });
```

### 3c — Drop the `useUiStore` import

The dispatcher no longer touches `useUiStore`. **Remove** the import (currently line 2):

```typescript
import { useUiStore } from '../stores/uiStore';
```

---

## File 4 (NEW): `src/sidepanel/components/PauseAlert.tsx`

```typescript
import { useQueueStore } from '../stores/queueStore';
import { sendToContent } from '../utils/messaging';
import { DetectionTrigger } from '../../types/messages';
import type { QueueTask } from '../../types/signalr';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'cookie banners',
  captcha: 'captchas',
  loginWall: 'sign-in prompts',
  customSelector: 'this',
  unconditional: 'this',
};

interface PauseAlertProps {
  task: QueueTask;
}

export default function PauseAlert({ task }: PauseAlertProps): JSX.Element | null {
  const resumeTask = useQueueStore((s) => s.resumeTask);
  const info = task.pause;
  if (!info) return null;

  const isCloudflare = info.reason === 'cloudflare';
  const trigger = info.trigger;
  const domain = info.domain;
  const showSkipButton = !isCloudflare && !!trigger && !!domain && trigger !== DetectionTrigger.CLOUDFLARE;
  const triggerLabel = trigger ? TRIGGER_LABEL[trigger] ?? 'this' : 'this';

  const sendResume = (markAsFalseAlarm: boolean): void => {
    // sendToContent emits the message into the runtime — the SW's
    // RESUME_AFTER_PAUSE interceptor (background.ts) routes per-task
    // when payload.taskId is present, falls back to active tab otherwise.
    sendToContent('RESUME_AFTER_PAUSE', { taskId: task.id, markAsFalseAlarm })
      .catch(() => { /* SW interceptor still drains continuations */ });
    resumeTask(task.id);
  };

  const title = isCloudflare ? 'Paused — security check' : 'Paused — action needed';
  const body = isCloudflare
    ? 'The site is showing a Cloudflare challenge. Complete it in the page (the scraper will wait) and click Continue when you’re through.'
    : (info.message ?? 'Action needed in your browser.');
  const hint = isCloudflare
    ? null
    : 'Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you’re ready.';

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>{task.configName}: {title}</strong>
        <p>{body}</p>
        {hint && <p className="detection-banner-hint">{hint}</p>}
      </div>
      <div className="detection-banner-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => sendResume(false)}>
          Continue
        </button>
        {showSkipButton && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => sendResume(true)}
            title={`Stop pausing for ${triggerLabel} on ${domain}`}
          >
            Skip {triggerLabel} on this site
          </button>
        )}
      </div>
    </div>
  );
}
```

**Note:** `sendToContent(type, payload)` is the project's existing helper at [src/sidepanel/utils/messaging.ts](src/sidepanel/utils/messaging.ts). It uses `chrome.runtime.sendMessage` under the hood — the SW intercepts `RESUME_AFTER_PAUSE` in its message router (per File 9a) BEFORE the message ever reaches content. The naming reflects the original sidepanel→content semantics; for resume specifically, the SW handles it. This matches the pattern used by the legacy `CloudflarePauseAlert` and `AwaitActionPauseAlert`.

---

## File 5 (DELETE): `src/sidepanel/components/CloudflarePauseAlert.tsx`

Delete the file entirely. All references in App.tsx are removed in File 7.

---

## File 6 (DELETE): `src/sidepanel/components/AwaitActionPauseAlert.tsx`

Delete the file entirely. All references in App.tsx are removed in File 7.

---

## File 7 (MODIFIED): `src/sidepanel/App.tsx`

### 7a — Remove the two old imports

**Find** (currently lines 13–14):

```typescript
import CloudflarePauseAlert from './components/CloudflarePauseAlert';
import AwaitActionPauseAlert from './components/AwaitActionPauseAlert';
```

**Replace** with:

```typescript
import PauseAlert from './components/PauseAlert';
import { useQueueStore } from './stores/queueStore';
```

### 7b — Drop the `GET_PAUSE_STATE` handshake

**Find** the `GET_PAUSE_STATE` block inside the first `useEffect` (currently lines 41–51):

```typescript
        const pauseRes = await browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' }).catch(() => null);
        const ps = (pauseRes as { pauseState?: { reason: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string } } | null)?.pauseState;
        if (ps?.reason === 'cloudflare') {
          useUiStore.getState().setCloudflarePaused(true);
        } else if (ps?.reason === 'awaitUserAction') {
          useUiStore.getState().setAwaitActionPaused({
            message: ps.message ?? 'Action needed in your browser.',
            trigger: ps.trigger,
            domain: ps.domain,
          });
        }
```

**Delete** this block. Per-task pause state is rehydrated via `GET_QUEUE_SNAPSHOT` in `startQueueDispatcher` — the snapshot's active task already includes `pausedReason`/status, and live FLOW_PAUSED messages flow through `queueDispatcher` to populate the `pause` field on subsequent pauses.

### 7c — Drop the `cloudfarePaused` selector

**Find** (currently line 115):

```typescript
  const cloudfarePaused = useUiStore((s) => s.cloudfarePaused);
```

**Replace** with:

```typescript
  const pausedTasks = useQueueStore((s) => s.tasks.filter((t) => t.status === 'paused' && !!t.pause));
```

### 7d — Render N PauseAlerts in JSX

**Find** the JSX (currently around lines 206–207):

```typescript
      {cloudfarePaused && <CloudflarePauseAlert />}
      <AwaitActionPauseAlert />
```

**Replace** with:

```typescript
      {pausedTasks.map((task) => (
        <PauseAlert key={task.id} task={task} />
      ))}
```

---

## File 8 (MODIFIED): `src/sidepanel/stores/uiStore.ts`

### 8a — Drop singleton pause slots

**Replace** the `UiState` interface declarations for the two slots (currently lines 26–27):

```typescript
  cloudfarePaused: boolean;
  awaitActionPaused: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null;
```

**Delete** these two lines.

### 8b — Drop the setter declarations

**Replace** the setter declarations (currently lines 40–41):

```typescript
  setCloudflarePaused: (v: boolean) => void;
  setAwaitActionPaused: (v: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null) => void;
```

**Delete** these two lines.

### 8c — Drop the initial values + setters in the store body

**Find** in the create body (around lines 56–57):

```typescript
  cloudfarePaused: false,
  awaitActionPaused: null,
```

**Delete** these two lines.

**Find** the setter implementations (around lines 108–109):

```typescript
  setCloudflarePaused: (v) => set({ cloudfarePaused: v }),
  setAwaitActionPaused: (v) => set({ awaitActionPaused: v }),
```

**Delete** these two lines.

---

## File 9 (MODIFIED): `src/entrypoints/background.ts`

### 9a — Per-task `RESUME_AFTER_PAUSE` routing

**Locate** the `RESUME_AFTER_PAUSE` interceptor (currently around lines 472–519). The current implementation captures false-alarm detection-memory then falls through to `sidepanelToContent` routing which uses the active tab. Augment to route by `payload.taskId` when present.

**Replace** the resume interceptor block. Keep all existing detection-memory capture logic; add the per-task routing **before** the fall-through:

```typescript
    if (type === 'RESUME_AFTER_PAUSE') {
      const wasPaused = activePauseState !== null;
      const resumePayload = (message.payload ?? {}) as { taskId?: string; markAsFalseAlarm?: boolean };

      // Capture false-alarm signal BEFORE clearing activePauseState.
      // Cloudflare cannot be marked as false alarm (UI doesn't expose the button).
      if (
        resumePayload.markAsFalseAlarm
        && activePauseState?.reason === 'awaitUserAction'
        && activePauseState?.trigger
        && activePauseState?.domain
      ) {
        const { domain, trigger } = activePauseState;
        // Async fire-and-forget; don't block the resume on storage write.
        import('../sidepanel/utils/detectionMemory').then(({ addIgnoredTrigger }) => {
          addIgnoredTrigger(domain, trigger).catch((err) => {
            console.error('[SW] addIgnoredTrigger failed:', err);
          });
          console.warn('[SW] markAsFalseAlarm recorded | domain:', domain, '| trigger:', trigger);
        });
      }

      activePauseState = null;
      console.warn('[SW] sidepanel resume | type:', type, '| taskId:', resumePayload.taskId, '| wasPaused:', wasPaused, '| markAsFalseAlarm:', resumePayload.markAsFalseAlarm);

      // PR5 — per-task routing. If a taskId is present, route to that task's
      // tab directly (bypasses active-tab assumption, supports multiple
      // simultaneously paused tasks). Falls through to active-tab routing
      // when taskId is absent (sidepanel-mode runs without a queue task).
      if (resumePayload.taskId) {
        const target = scheduler.getActiveTask(resumePayload.taskId);
        if (target) {
          browser.tabs.sendMessage(target.tabId, {
            type: 'RESUME_AFTER_PAUSE',
            payload: resumePayload,
          }).catch((err: Error) => console.warn('[SW] per-task resume sendMessage failed:', err.message));

          // Drain any held continuation for that specific tab (pause-driven nav).
          const continuation = pendingContinuations.get(target.tabId);
          if (continuation) {
            pendingContinuations.delete(target.tabId);
            console.warn('[SW] resume — draining held continuation | tabId:', target.tabId);
            setTimeout(() => {
              browser.tabs.sendMessage(target.tabId, { type: 'EXECUTE_FLOW', payload: continuation })
                .then(() => console.warn('[SW] held continuation delivered | tabId:', target.tabId))
                .catch((err: Error) => {
                  console.warn('[SW] held continuation delivery failed | tabId:', target.tabId, '— re-registering | err:', err.message);
                  pendingContinuations.set(target.tabId, continuation);
                });
            }, 300);
          }
          return; // handled — do not fall through to active-tab routing
        }
        console.warn('[SW] RESUME_AFTER_PAUSE — no active task for taskId:', resumePayload.taskId);
        // No matching task — fall through to active-tab routing as a fallback.
      }

      // Legacy / sidepanel-mode path: route to active tab.
      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = activeTab?.id;
        if (!tabId) return;
        const continuation = pendingContinuations.get(tabId);
        if (continuation) {
          pendingContinuations.delete(tabId);
          console.warn('[SW] resume — draining held continuation | tabId:', tabId);
          setTimeout(() => {
            browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
              .then(() => console.warn('[SW] held continuation delivered | tabId:', tabId))
              .catch((err: Error) => {
                console.warn('[SW] held continuation delivery failed | tabId:', tabId, '— re-registering | err:', err.message);
                pendingContinuations.set(tabId, continuation);
              });
          }, 300);
        }
      }).catch(() => { /* ignore */ });
      // Fall through to sidepanelToContent routing for the live content script.
    }
```

### 9b — Add `SET_BATCH_SETTINGS` handler

**Insert** a new handler **before** the `if (type === 'TASK_RECEIVED')` block (currently around line 446):

```typescript
    if (type === 'SET_BATCH_SETTINGS') {
      const p = (message.payload ?? {}) as { drainParallelCap?: number; preflightQuietMs?: number };
      if (typeof p.drainParallelCap === 'number') {
        scheduler.setDrainParallelCap(p.drainParallelCap);
        console.warn('[SW] batch settings | drainParallelCap:', p.drainParallelCap);
      }
      // preflightQuietMs is stored but not consumed in PR5 — content script
      // still uses the constant. Wiring deferred.
      if (typeof p.preflightQuietMs === 'number') {
        chrome.storage.local.set({ batchPreflightQuietMs: p.preflightQuietMs }).catch(() => {});
      }
      return;
    }
```

---

## File 10 (MODIFIED): `src/sidepanel/components/APISettingsView.tsx`

### 10a — Add Batch settings draft state + initial load

**Inside** the component, after the existing `useState` hooks (currently around lines 31–39), **add**:

```typescript
  const batchPreflightQuietMs = useSettingsStore((s) => s.batchPreflightQuietMs);
  const batchParallelCap = useSettingsStore((s) => s.batchParallelCap);
  const setBatchPreflightQuietMs = useSettingsStore((s) => s.setBatchPreflightQuietMs);
  const setBatchParallelCap = useSettingsStore((s) => s.setBatchParallelCap);

  const [preflightQuietDraft, setPreflightQuietDraft] = useState(String(batchPreflightQuietMs));
  const [parallelCapDraft, setParallelCapDraft] = useState(String(batchParallelCap));
```

### 10b — Wire saving into `handleSave`

The existing `handleSave` saves backend settings. We extend it to also persist batch settings and notify the SW.

**Locate** the existing `handleSave` (currently around lines 100–138). Just **before** the final `showToast('Settings saved.', 'success');`, **insert**:

```typescript
      const quietMs = Number.parseInt(preflightQuietDraft, 10);
      const cap = Number.parseInt(parallelCapDraft, 10);
      if (Number.isFinite(quietMs) && quietMs >= 1000) setBatchPreflightQuietMs(quietMs);
      if (Number.isFinite(cap) && cap >= 1 && cap <= 16) setBatchParallelCap(cap);

      browser.runtime.sendMessage({
        type: 'SET_BATCH_SETTINGS',
        payload: {
          drainParallelCap: Number.isFinite(cap) && cap >= 1 ? cap : batchParallelCap,
          preflightQuietMs: Number.isFinite(quietMs) && quietMs >= 1000 ? quietMs : batchPreflightQuietMs,
        },
      }).catch(() => { /* SW may not be ready yet — non-fatal */ });
```

### 10c — Render the Batch section in JSX

**Insert** the new section **just before** the existing `Show debug info in scrape output` form-group (currently around line 277). Use existing classes only.

```typescript
      <div className="form-group">
        <label className="form-label">Parallel scrape windows</label>
        <input
          className="form-input"
          type="number"
          min={1}
          max={16}
          value={parallelCapDraft}
          onChange={(e) => setParallelCapDraft(e.target.value)}
          placeholder="4"
        />
        <p className="form-hint">
          How many tasks run side-by-side once authentication is sorted. Bumping this above 4 can trip rate limits on busy sites.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label">Wait for page to settle</label>
        <input
          className="form-input"
          type="number"
          min={1000}
          step={500}
          value={preflightQuietDraft}
          onChange={(e) => setPreflightQuietDraft(e.target.value)}
          placeholder="5000"
        />
        <p className="form-hint">
          How long (in milliseconds) the scraper waits with no detection before marking a task ready. Default 5000ms is right for most sites.
        </p>
      </div>
```

### 10d — Reset drafts when persisted values change (optional)

If you want the inputs to reflect external changes (rare in practice), wrap the existing `useEffect` that loads `getApiToken` to also reset the batch drafts. This is a nice-to-have — skip if not trivial. The persisted-state-on-mount path already produces correct initial drafts because `useState(String(batchPreflightQuietMs))` reads the persisted Zustand state.

---

## File 10c (MODIFIED): `src/sidepanel/components/QueueView.tsx`

PR4 dropped `RESUME_AFTER_CLOUDFLARE` from the SW relay list, but `QueueView.handleResumePaused` still sends it (line 45) — that Resume button silently no-ops on master. PR5 makes paused-task UI live in `PauseAlert` at the top of the app, so the QueueView Resume button is now redundant.

**Find** (around lines 43–50):

```typescript
  const handleResumePaused = async (task: QueueTask) => {
    try {
      await sendToContent('RESUME_AFTER_CLOUDFLARE');
      resumeTask(task.id);
    } catch {
      // auto-resume will handle it
    }
  };
```

**Delete** the function. Then **find** the JSX usage (around lines 74–78):

```typescript
            {currentTask.status === 'paused' && (
              <button className="btn btn-ghost btn-sm" onClick={() => handleResumePaused(currentTask)}>
                Resume
              </button>
            )}
```

**Delete** that block. The pause indicator (status dot + meta text) stays — only the Resume button is removed; the user resumes via the PauseAlert banner instead. Also remove the now-unused `sendToContent` and `resumeTask` references from this file (the `useQueueStore` destructure should drop `resumeTask`; the `sendToContent` import should be removed if no other call site exists in `QueueView.tsx`).

The "waiting for Cloudflare challenge" inline string in the same card body (line 83) is now misleading because pauses can be other reasons too. **Replace** that fragment with a generic message:

```typescript
              {currentTask.status === 'paused' && ' — paused, action needed in browser'}
```

---

## File 10b (MODIFIED): `vitest.config.ts`

The current `include` pattern is `'src/**/__tests__/**/*.test.ts'` and the duplicate `'src/**/*.test.ts'` — neither matches `.tsx`. **Replace** the include line:

```typescript
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
```

with:

```typescript
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
```

This is the minimum change needed to pick up the new `.tsx` test file. The expanded pattern is harmless for existing tests (no `.test.tsx` files exist before this PR).

---

## File 11 (NEW): `src/__tests__/PauseAlert.test.tsx`

**Note on assertions:** the project does NOT have `@testing-library/jest-dom` installed. Use plain Vitest assertions (`expect(x).toBeTruthy()`, `expect(x).toBeNull()`) instead of `toBeInTheDocument`/etc.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PauseAlert from '../sidepanel/components/PauseAlert';
import { useQueueStore } from '../sidepanel/stores/queueStore';
import { DetectionTrigger } from '../types/messages';
import type { QueueTask } from '../types/signalr';

function makePausedTask(overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    id: 'task-1',
    configId: 'cfg-1',
    configName: 'Acme search',
    searchTerms: ['x'],
    priority: 0,
    createdAt: new Date(0).toISOString(),
    status: 'paused',
    pause: {
      reason: 'awaitUserAction',
      message: 'Sign in to continue.',
      trigger: DetectionTrigger.LOGIN_WALL,
      domain: 'acme.test',
    },
    ...overrides,
  };
}

describe('PauseAlert', () => {
  beforeEach(() => {
    useQueueStore.setState({
      tasks: [makePausedTask()],
      currentTaskId: 'task-1',
      stats: { total: 1, pending: 0, completed: 0, failed: 0 },
    });
    // Stub chrome.runtime.sendMessage so the sendToContent helper resolves cleanly.
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: (_msg: unknown, cb?: (resp: unknown) => void) => { cb?.(undefined); },
        lastError: undefined,
      },
    };
  });

  it('renders configName as title prefix', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByText(/Acme search:/)).toBeTruthy();
  });

  it('renders the pause message verbatim for awaitUserAction', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByText('Sign in to continue.')).toBeTruthy();
  });

  it('shows Skip button for awaitUserAction with trigger + domain', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByRole('button', { name: /Skip sign-in prompts on this site/ })).toBeTruthy();
  });

  it('hides Skip button for cloudflare reason', () => {
    const task = makePausedTask({ pause: { reason: 'cloudflare' } });
    useQueueStore.setState({ tasks: [task] });
    render(<PauseAlert task={task} />);
    expect(screen.queryByRole('button', { name: /^Skip/ })).toBeNull();
  });

  it('Continue click resumes task in store', () => {
    const task = useQueueStore.getState().tasks[0];
    render(<PauseAlert task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useQueueStore.getState().tasks[0].status).toBe('running');
    expect(useQueueStore.getState().tasks[0].pause).toBeUndefined();
  });

  it('returns null when task has no pause info', () => {
    const task = makePausedTask({ pause: undefined });
    const { container } = render(<PauseAlert task={task} />);
    expect(container.firstChild).toBeNull();
  });
});
```

**Setup note:** `@testing-library/react@^16.0.0` is already installed; jsdom environment is already configured. No new devDependencies are added by this PR.

---

## What is deleted

| What | Where |
|---|---|
| `CloudflarePauseAlert.tsx` | Deleted |
| `AwaitActionPauseAlert.tsx` | Deleted |
| `cloudfarePaused`, `awaitActionPaused` slots + setters | `uiStore.ts` |
| `GET_PAUSE_STATE` handshake on app mount | `App.tsx` |
| `useUiStore.setCloudflarePaused` and `setAwaitActionPaused` calls | `queueDispatcher.ts`, `App.tsx` |

The SW's `GET_PAUSE_STATE` handler **stays** — it's still useful for the SW's internal `activePauseState` mirror and for debugging. Remove if no callers remain after PR5; otherwise leave for PR6 cleanup.

---

## Verification

### Automated

```bash
npm test -- src/__tests__/PauseAlert.test.tsx
npm test
npm run type-check                    # output must equal pre-PR5 baseline
npm run lint -- src/sidepanel/components/PauseAlert.tsx src/sidepanel/components/APISettingsView.tsx src/sidepanel/App.tsx src/sidepanel/stores/uiStore.ts src/sidepanel/stores/queueStore.ts src/sidepanel/utils/queueDispatcher.ts src/entrypoints/background.ts src/types/signalr.ts
npm run build
```

**Pre-existing typecheck noise (do NOT fix in this PR)** — same set as the prior PRs. After PR5, output **must be identical** to the pre-PR5 baseline (commit `6906f65`). If new errors appear, stop and report.

### Manual smoke (5 cases)

1. **Single-task pause** — run a queue-mode task that hits a login wall. Banner appears at top with `<configName>: Paused — action needed` heading. Click Continue → banner disappears, scrape resumes.

2. **Two simultaneously paused tasks (different origins, same auth gate)** — start a 2-task batch, both hit cookie banners during preflight. Walk through preflight T1 → close cookies (Continue resolves it). Walk through preflight T2 → close cookies. (Note: in PR4, only one task preflights at a time; the second pause is sequential. To get true simultaneous pauses, you'd need post-drain re-auth — see case 4.)

3. **Skip-trigger button** — same as case 1, but click "Skip sign-in prompts on this site". Banner disappears; scrape resumes; on the next run for that domain, the trigger is auto-skipped (PR1 behaviour preserved).

4. **Mid-drain re-auth** — start a 4-task batch. After all preflight, drain begins. Force a session expiry on one task (sign out in its window). Watchdog should auto-pause that one task. Banner appears with that task's name. Other 3 keep running. Click Continue → only that task resumes.

5. **Batch settings** — open Settings, set "Parallel scrape windows" to 2 and "Wait for page to settle" to 8000. Save. Run a 4-task batch — only 2 windows should drain in parallel. Verify SW console: `[SW] batch settings | drainParallelCap: 2`.

### Edge cases

| Case | Decision |
|---|---|
| Resume sent for a task whose tab has died | **Cover** — SW logs warning; falls through to active-tab routing as fallback |
| User clicks Continue twice rapidly on the same banner | **Cover** — second click is a no-op (`task.pause` already cleared by `resumeTask`, so banner disappeared after first click; second click can't fire) |
| Banner shows for a task that completes before user clicks | **Cover** — `task.status` becomes `completed`, `pausedTasks` filter removes it; banner disappears |
| `pause.message` is missing | **Cover** — falls back to `'Action needed in your browser.'` |
| User saves invalid batch settings (e.g. cap=0 or NaN) | **Cover** — input validation: only persist if `cap >= 1 && cap <= 16` and `quietMs >= 1000` |
| Old persisted task in queue store has `pausedReason` but no `pause` field | **Cover** — `pausedTasks` filter requires `!!t.pause`, so old paused tasks just don't render; once a fresh FLOW_PAUSED arrives, `pause` is populated |
| Concurrent paused tasks > 4 | **Ignore (v1)** — drainCap is 4 so this is the practical max anyway |

---

## Maintainability checklist

- [x] No magic strings — all message types via existing string literals (consistent with project style); design tokens via existing class names
- [x] Component reuse — PauseAlert composes existing CSS only; settings section follows the existing form-group pattern
- [x] Single responsibility — PauseAlert is purely presentational + per-task resume; queueStore owns pause state; SW owns routing
- [x] Configurable knobs — preflightQuietMs and parallelCap are user-tunable with sane bounds
- [x] One source of truth — queueStore for per-task pause; uiStore for non-task UI
- [x] Backward compat — single-task semantics preserved (one banner, one Continue); GET_PAUSE_STATE SW handler stays for now
- [x] Pure tests — PauseAlert tested with RTL render-and-click

---

## Stuck-loop escalation reminder

If two consecutive attempts to make a check green fail, STOP. Common gotchas: (a) Zustand store not reset between tests — use `useQueueStore.setState({...})` in `beforeEach`; (b) `browser.runtime.sendMessage` undefined in jsdom — stub on `globalThis.browser` as the test setup does; (c) DetectionTrigger import circular with signalr.ts — `import type` should already isolate; if a circular concrete import is needed, refactor to push `TaskPauseInfo` into `messages.ts`. Escalate to Opus if a stuck-loop hits 2 failed attempts on the same hypothesis.
