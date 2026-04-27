# SPEC-PR3 — Pre-flight quiet timer + `FLOW_PREFLIGHT_READY` event
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1 (detector watchdog) shipped `aff52ba`; PR1.5 (cold-start + autoDetect UI) shipped `63f902b`; PR2 (state refactor: singleton → Scheduler Map) shipped `226f480`.

---

## Context

Batched parallel scraping needs a **config-agnostic** signal that means "this task has cleared its auth/cloudflare/cookie/captcha gates and the page is stable enough to walk away from." The plan calls this `FLOW_PREFLIGHT_READY`.

The mechanism is a **watchdog-quiet timer**: once the detector watchdog has been quiet for `PREFLIGHT_QUIET_MS` (default 5000ms) with the flow actively progressing, the content script emits the event once. Every detector fire (cold-start, post-navigation, post-failure, or `awaitUserAction` step) **resets** the timer; every Continue click **restarts** the quiet window.

PR3 lands the timer + event + manual override + setting **without behaviour change** for non-batch runs. The SW relays the event to the sidepanel and logs it for dogfooding visibility. **Nothing pauses the flow on emit yet** — that's PR4 (phase machine + same-origin gate). Single-task non-batch runs ignore the event.

**Wire-protocol additions** (all internal, not hub-relayed):
- `FLOW_PREFLIGHT_READY` (content → SW → sidepanel) — payload `{ taskId }`
- `FORCE_PREFLIGHT_READY` (sidepanel/SW → content) — payload `{ taskId }`
- `RESUME_FOR_DRAIN` (SW → content) — payload `{ taskId }`. **Not consumed in PR3** — added to the typed-constants module so PR4 can import it without a fresh round-trip; no listener is registered yet.

**No change** to `flowEventToHubPayload.ts` — these are extension-internal.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Timer state machine | `src/content/scraping/preflightTimer.ts` (new) | Class `PreflightTimer` with `arm`, `cancel`, `force`, `isReady` |
| Default quiet window | `src/content/scraping/constants.ts` (new) | `PREFLIGHT_QUIET_MS = 5000` |
| Wire constants | `src/types/messages.ts` | Add 3 entries to `MessageType` |
| Engine integration | `src/content/scraping/scrapingEngine.ts` | Construct timer per flow; cancel/arm bookend every detector pause; listen for `FORCE_PREFLIGHT_READY` |
| SW relay | `src/entrypoints/background.ts` | Add `FLOW_PREFLIGHT_READY` to `contentToSidepanel`; log only — no scheduler change |
| Settings field | `src/sidepanel/stores/settingsStore.ts` | Add persisted `batchPreflightQuietMs: number` (UI surface deferred to PR5) |
| Tests | `src/__tests__/preflightTimer.test.ts` (new) | `vi.useFakeTimers()` unit tests for the class |

**Reuse:**
- `swLog` ([src/utils/swLog.ts](src/utils/swLog.ts)) for diagnostics.
- `MessageType` ([src/types/messages.ts](src/types/messages.ts)) for typed message strings — extending the existing constant.
- Existing `runWatchdogPause` ([src/content/scraping/scrapingEngine.ts:435](src/content/scraping/scrapingEngine.ts#L435)) and `executeAwaitUserAction` ([scrapingEngine.ts:875](src/content/scraping/scrapingEngine.ts#L875)) — bookend with `cancel()` / `arm()` calls without changing their flow.

**Maintainability principles applied:**
- No magic strings — all message types are `MessageType.*` consts.
- Configurable knob — `PREFLIGHT_QUIET_MS` lives in a constants module; settings store override layered for PR4/PR5.
- Pure logic in own module — `PreflightTimer` is fully testable with fake timers; no DOM/runtime coupling.
- Backward compatible — no behaviour change in PR3; non-batch flows unaffected; batch flows still don't pause on emit (PR4 wires that).

---

## File 1 (NEW): `src/content/scraping/constants.ts`

```typescript
// ── Pre-flight quiet timer ──
//
// Default duration (ms) of the watchdog-quiet window before a task is
// considered pre-flight ready (auth/cloudflare/cookie/captcha gates cleared
// and page stable). Reset on every detector fire; restarted after every
// Continue click. PR4/PR5 will read an override from the settings store
// (`batchPreflightQuietMs`); PR3 ships the constant only.
export const PREFLIGHT_QUIET_MS = 5000;
```

---

## File 2 (NEW): `src/content/scraping/preflightTimer.ts`

```typescript
import { MessageType } from '../../types/messages';
import { swLog } from '../../utils/swLog';

export interface PreflightTimerOptions {
  taskId: string;
  durationMs: number;
  // Injected so tests can capture emissions without runtime stubs.
  // In production wraps `browser.runtime.sendMessage(...).catch(() => {})`.
  emit: (msg: { type: typeof MessageType.FLOW_PREFLIGHT_READY; payload: { taskId: string } }) => void;
}

// One-shot quiet-window timer. Lifecycle:
//   arm()    → start countdown (or restart if already pending)
//   cancel() → stop without emitting (called when a detector fires)
//   force()  → emit immediately (manual override)
// Once `emit` has fired (timer-elapsed or force), all subsequent calls
// are no-ops. Designed for one PreflightTimer per executeFlow() invocation.
export class PreflightTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private emitted = false;

  constructor(private readonly opts: PreflightTimerOptions) {}

  get taskId(): string {
    return this.opts.taskId;
  }

  isReady(): boolean {
    return this.emitted;
  }

  isPending(): boolean {
    return this.handle !== null && !this.emitted;
  }

  // Start (or restart) the countdown. No-op once emitted.
  arm(): void {
    if (this.emitted) return;
    this.cancel();
    this.handle = setTimeout(() => {
      this.handle = null;
      if (this.emitted) return;
      this.emitted = true;
      swLog('[preflightTimer] elapsed → FLOW_PREFLIGHT_READY | taskId:', this.opts.taskId);
      this.opts.emit({
        type: MessageType.FLOW_PREFLIGHT_READY,
        payload: { taskId: this.opts.taskId },
      });
    }, this.opts.durationMs);
  }

  // Cancel any pending countdown without emitting. Idempotent.
  cancel(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  // Emit immediately, regardless of remaining time. One-shot.
  force(): void {
    if (this.emitted) return;
    this.cancel();
    this.emitted = true;
    swLog('[preflightTimer] FORCED → FLOW_PREFLIGHT_READY | taskId:', this.opts.taskId);
    this.opts.emit({
      type: MessageType.FLOW_PREFLIGHT_READY,
      payload: { taskId: this.opts.taskId },
    });
  }
}
```

---

## File 3 (MODIFIED): `src/types/messages.ts`

**Replace** the `MessageType` const (lines 62–73) with:

```typescript
export const MessageType = {
  EXECUTE_FLOW: 'EXECUTE_FLOW',
  FLOW_PROGRESS: 'FLOW_PROGRESS',
  FLOW_COMPLETE: 'FLOW_COMPLETE',
  FLOW_ERROR: 'FLOW_ERROR',
  FLOW_PAUSED: 'FLOW_PAUSED',
  FLOW_RESUMED: 'FLOW_RESUMED',
  FLOW_PREFLIGHT_READY: 'FLOW_PREFLIGHT_READY',
  FORCE_PREFLIGHT_READY: 'FORCE_PREFLIGHT_READY',
  RESUME_FOR_DRAIN: 'RESUME_FOR_DRAIN',
  RESUME_AFTER_PAUSE: 'RESUME_AFTER_PAUSE',
  REGISTER_CONTINUATION: 'REGISTER_CONTINUATION',
  CANCEL_CONTINUATION: 'CANCEL_CONTINUATION',
} as const;
export type MessageType = typeof MessageType[keyof typeof MessageType];
```

**Note:** `RESUME_FOR_DRAIN` is added now so PR4's content-script listener doesn't need a follow-up message-type bump. No PR3 code consumes it.

---

## File 4 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

### 4a — Add imports

**After** the existing `import { MessageType, PauseReason, DetectionTrigger } from '../../types/messages';` line (currently line 33), **append** the following imports:

```typescript
import { PreflightTimer } from './preflightTimer';
import { PREFLIGHT_QUIET_MS } from './constants';
```

### 4b — Add module-scope timer state

**After** the existing `let flowRunning = false;` declaration (line 53), **insert**:

```typescript
// One PreflightTimer per executeFlow() invocation. Set in executeFlow's
// entry block, cleared in the finally. Module-scope so the
// FORCE_PREFLIGHT_READY listener (registered once per content-script
// load) can reach the active flow's timer. Null when no flow is running
// or when the active flow has no taskId (sidepanel-only mode).
let activePreflightTimer: PreflightTimer | null = null;
```

### 4c — Register `FORCE_PREFLIGHT_READY` listener at module load

**After** the existing storage-onChanged try/catch block (currently lines 70–78, ending in `} catch { /* expected: SW restart timing */ }`), **insert**:

```typescript
try {
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as Record<string, unknown> | null;
    if (m?.type !== MessageType.FORCE_PREFLIGHT_READY) return;
    const payload = (m.payload ?? {}) as { taskId?: string };
    const t = activePreflightTimer;
    if (!t) {
      swLog('[FORCE_PREFLIGHT_READY] ignored — no active timer | requestedTaskId:', payload.taskId);
      return;
    }
    if (payload.taskId && payload.taskId !== t.taskId) {
      swLog('[FORCE_PREFLIGHT_READY] ignored — taskId mismatch | requested:', payload.taskId, '| active:', t.taskId);
      return;
    }
    t.force();
  });
} catch { /* expected: SW restart timing */ }
```

### 4d — Construct + arm timer at flow start

**Inside** `executeFlow` (line 98), the body currently sets `flowRunning = true; abortSignal = false;` then falls into a `try` block. **Replace** lines 123–124:

```typescript
  flowRunning = true;
  abortSignal = false;
```

with:

```typescript
  flowRunning = true;
  abortSignal = false;

  // Pre-flight quiet timer: armed only for queue-mode flows (taskId set).
  // Sidepanel-only flows (no taskId) have no batch concept and skip the
  // timer entirely. Cancelled/re-armed by every detector pause and
  // explicitly cleared in the outer finally.
  if (taskId) {
    activePreflightTimer = new PreflightTimer({
      taskId,
      durationMs: PREFLIGHT_QUIET_MS,
      emit: (msg) => {
        browser.runtime.sendMessage(msg).catch(() => { /* SW asleep — drop */ });
      },
    });
    activePreflightTimer.arm();
    swLog('[preflightTimer] armed | taskId:', taskId, '| durationMs:', PREFLIGHT_QUIET_MS);
  }
```

### 4e — Tear down timer in `finally`

**Replace** the existing `finally` block of `executeFlow` (currently lines 377–385):

```typescript
  } finally {
    swLog('[executeFlow] finally — clearing flowRunning | taskId:', taskId);
    flowRunning = false;
    // Cancel any lingering pause-continuation. End-of-flow cleanup so a
    // stale continuation can't fire on a future tab navigation.
    try {
      browser.runtime.sendMessage({ type: MessageType.CANCEL_CONTINUATION });
    } catch { /* extension context may be invalidated */ }
  }
```

with:

```typescript
  } finally {
    swLog('[executeFlow] finally — clearing flowRunning | taskId:', taskId);
    flowRunning = false;
    if (activePreflightTimer) {
      activePreflightTimer.cancel();
      activePreflightTimer = null;
    }
    // Cancel any lingering pause-continuation. End-of-flow cleanup so a
    // stale continuation can't fire on a future tab navigation.
    try {
      browser.runtime.sendMessage({ type: MessageType.CANCEL_CONTINUATION });
    } catch { /* extension context may be invalidated */ }
  }
```

### 4f — Bookend `runWatchdogPause` with cancel/arm

**Locate** `runWatchdogPause` (lines 435–487).

**Insert** a `cancel()` call **immediately after** the `if (!result.fired) return;` line (line 443) — i.e. only when we've decided to actually pause:

```typescript
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
  resumeCtx: PauseResumeContext,
  mode: 'all' | 'confirmedOnly' = 'all',
): Promise<void> {
  const result = runDetectorWatchdog(cfg, mode);
  swLog('[watchdog] result | fired:', result.fired, '| trigger:', result.trigger, '| cfg:', cfg);
  if (!result.fired) return;

  // Reset the pre-flight quiet window: a detector just fired, so the page
  // is not yet stable. Re-armed below after the user clicks Continue.
  activePreflightTimer?.cancel();

  swLog('[watchdog] fired | taskId:', taskId, '| trigger:', result.trigger, '| url:', window.location.href);
  // ...rest unchanged through to the FLOW_RESUMED line...
```

**Insert** an `arm()` call **immediately after** the `swLog('[watchdog] cleared/resumed | taskId:', taskId);` line (currently line 485), **before** the `FLOW_RESUMED` send. Resulting tail of the function:

```typescript
  swLog('[watchdog] cleared/resumed | taskId:', taskId);
  // Restart the pre-flight quiet window: the user just cleared the gate;
  // give the page another full PREFLIGHT_QUIET_MS to settle before
  // declaring the task pre-flight ready.
  activePreflightTimer?.arm();
  browser.runtime.sendMessage({ type: MessageType.FLOW_RESUMED });
}
```

### 4g — Bookend `executeAwaitUserAction` with cancel/arm

**Locate** `executeAwaitUserAction` (lines 875–903).

**Insert** a `cancel()` call **after** the `if (!evalResult.fired) { ... return null; }` early-return block (currently lines 880–883), and **before** the `onProgress?.(...waiting...)` line:

```typescript
async function executeAwaitUserAction(step: AwaitUserActionStep, onProgress: OnProgress, taskId?: string): Promise<null> {
  const opts = step.options;
  const evalResult = evaluateDetectionRules(opts.detectionRules);
  swLog('[awaitUserAction] enter | taskId:', taskId, '| fired:', evalResult.fired, '| trigger:', evalResult.trigger, '| url:', window.location.href);

  if (!evalResult.fired) {
    onProgress?.(`No obstruction detected — skipping pause`);
    return null;
  }

  // Reset the pre-flight quiet window: a config-driven detection fired,
  // so the page isn't stable. Re-armed below after the user resumes.
  activePreflightTimer?.cancel();

  onProgress?.(`Waiting for user: ${opts.message}`);
  // ...unchanged through to the FLOW_RESUMED line...
```

**Insert** an `arm()` call **immediately after** the `swLog('[awaitUserAction] resume signal received | taskId:', taskId);` line (currently line 899), **before** the `FLOW_RESUMED` send:

```typescript
  await waitForResumeSignal();
  swLog('[awaitUserAction] resume signal received | taskId:', taskId);
  activePreflightTimer?.arm();

  browser.runtime.sendMessage({ type: MessageType.FLOW_RESUMED });
  return null;
}
```

---

## File 5 (MODIFIED): `src/entrypoints/background.ts`

### 5a — Add `FLOW_PREFLIGHT_READY` to `contentToSidepanel` relay

**Replace** the `contentToSidepanel` array (currently lines 599–605):

```typescript
    const contentToSidepanel = [
      'ELEMENT_PICKED', 'ELEMENT_HOVER', 'PICKER_CANCELLED', 'PONG',
      'FLOW_PROGRESS', 'FLOW_COMPLETE', 'FLOW_ERROR',
      'CLOUDFLARE_DETECTED', 'FLOW_PAUSED', 'FLOW_RESUMED',
      'NETWORK_CALL_CAPTURED', 'PAGE_INFO',
      'SCAN_PROGRESS', 'SCAN_COMPLETE', 'SCAN_ERROR',
    ];
```

with:

```typescript
    const contentToSidepanel = [
      'ELEMENT_PICKED', 'ELEMENT_HOVER', 'PICKER_CANCELLED', 'PONG',
      'FLOW_PROGRESS', 'FLOW_COMPLETE', 'FLOW_ERROR',
      'CLOUDFLARE_DETECTED', 'FLOW_PAUSED', 'FLOW_RESUMED',
      'FLOW_PREFLIGHT_READY',
      'NETWORK_CALL_CAPTURED', 'PAGE_INFO',
      'SCAN_PROGRESS', 'SCAN_COMPLETE', 'SCAN_ERROR',
    ];
```

### 5b — Log on receipt (no scheduler change)

**Inside** the existing `if (contentToSidepanel.includes(type)) { ... }` block, **immediately before** the existing `if (type === 'FLOW_RESUMED') { ... }` block (currently around line 607), **insert** a log-only branch:

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

**Do not** add any branch to `handleRemoteFlowEvent`. `FLOW_PREFLIGHT_READY` is internal-only and is not a hub event.

---

## File 6 (MODIFIED): `src/sidepanel/stores/settingsStore.ts`

### 6a — Add field to `SettingsState`

**Replace** the `SettingsState` interface (lines 5–23):

```typescript
interface SettingsState {
  serverUrl: string;
  // jwtToken is NOT persisted in Zustand — loaded/saved via chrome.storage.local separately
  jwtToken: string;
  connected: boolean;
  lastConnectionError: string | null;
  pauseOnCloudflare: boolean;
  mode: 'local' | 'queue';
  workerName: string;
  connectionStatus: ConnectionStatus;

  // PR3 — pre-flight quiet window (ms). Surfaced in settings UI in PR5.
  // Default mirrors PREFLIGHT_QUIET_MS in src/content/scraping/constants.ts.
  // Override consumed by content script in PR4/PR5 (passed via EXECUTE_FLOW).
  batchPreflightQuietMs: number;

  setConnection: (url: string, token: string) => void;
  setConnected: (connected: boolean, error?: string) => void;
  setPauseOnCloudflare: (v: boolean) => void;
  clearToken: () => void;
  setMode: (mode: 'local' | 'queue') => void;
  setWorkerName: (name: string) => void;
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  setBatchPreflightQuietMs: (ms: number) => void;
}
```

### 6b — Add default + setter + partialize entry

**Replace** the store body (lines 25–70). The full replacement:

```typescript
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      serverUrl: '',
      jwtToken: '',
      connected: false,
      lastConnectionError: null,
      pauseOnCloudflare: true,
      mode: 'local',
      workerName: 'My Browser',
      connectionStatus: 'idle',
      batchPreflightQuietMs: 5000,

      setConnection: (serverUrl, jwtToken) =>
        set({ serverUrl, jwtToken, connected: false, lastConnectionError: null }),

      setConnected: (connected, error) =>
        set({ connected, lastConnectionError: error ?? null }),

      setPauseOnCloudflare: (pauseOnCloudflare) => set({ pauseOnCloudflare }),

      clearToken: () => set({ jwtToken: '', connected: false }),

      setMode: (mode) => set({ mode }),

      setWorkerName: (workerName) => set({ workerName }),

      setConnectionStatus: (connectionStatus, error) =>
        set({
          connectionStatus,
          lastConnectionError: error ?? null,
          connected: connectionStatus === 'connected',
        }),

      setBatchPreflightQuietMs: (batchPreflightQuietMs) =>
        set({ batchPreflightQuietMs }),
    }),
    {
      name: 'bb-settings',
      storage: createJSONStorage(() => localStorage),
      // Exclude jwtToken from localStorage — stored securely in chrome.storage.local
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        pauseOnCloudflare: s.pauseOnCloudflare,
        mode: s.mode,
        workerName: s.workerName,
        batchPreflightQuietMs: s.batchPreflightQuietMs,
      }),
    },
  ),
);
```

**Migration note:** existing persisted localStorage values (which lack `batchPreflightQuietMs`) hydrate with the field absent, then the initial-state default of `5000` fills in. Zustand's `persist` middleware merges initial state with persisted partial — no manual migration needed.

---

## File 7 (NEW): `src/__tests__/preflightTimer.test.ts`

```typescript
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
```

---

## What is NOT in this PR

| Concern | Why deferred | Where it lands |
|---|---|---|
| Pause flow on `FLOW_PREFLIGHT_READY` (wait for `RESUME_FOR_DRAIN`) | Only meaningful with phase machine — would deadlock single-task runs | PR4 |
| `RESUME_FOR_DRAIN` listener in content script | No emitter yet; constant is reserved | PR4 |
| Scheduler reaction to the event (state transition) | Phase machine doesn't exist yet | PR4 |
| Settings UI surface for `batchPreflightQuietMs` | UI section is bundled with the rest of the Batch settings card | PR5 |
| Override threading (settings → SW → content via EXECUTE_FLOW payload) | Trivial wiring once cap > 1; couple with PR4 | PR4 |
| Sidepanel handler for `FLOW_PREFLIGHT_READY` | No UI to react in yet (BatchTaskList lands in PR5) | PR5 |

---

## Verification

### Automated

```bash
# From repo root.
npm test -- src/__tests__/preflightTimer.test.ts
npm run type-check
npm run lint -- src/content/scraping/preflightTimer.ts src/content/scraping/constants.ts src/content/scraping/scrapingEngine.ts src/entrypoints/background.ts src/sidepanel/stores/settingsStore.ts src/types/messages.ts
npm run build
```

**Pre-existing typecheck noise (do not fix in this PR — unrelated to PR3):**
- `src/__tests__/runDetectorWatchdog.test.ts` — `CloudflareChallenge` mock missing `type`
- `src/entrypoints/background.ts(369,41)` and `src/offscreen/messageHandler.ts(12,3)` — `OnMessageListener` `true | undefined` strictness
- `src/entrypoints/content.ts(147,296)` — `ScraperConfig`-to-`Record<string, unknown>` cast
- `src/sidepanel/components/DataMappingView.tsx`, `ResultsView.tsx`, `src/types/index.ts` — pre-existing

These existed on commit `226f480` before this PR. Confirm `type-check` output **is identical** to the baseline (no new errors introduced).

### Manual smoke (4 cases)

Build: `npm run build`. Load the `.output/chrome-mv3` directory unpacked in Chrome. Open DevTools service-worker console + the active scrape window's console.

1. **No-auth scrape (timer fires).** Configure a queue-mode task on a page with no detectors (e.g. example.com). Run it. Expect SW console:
   - `[SW] FLOW_PREFLIGHT_READY | taskId: <id> | recordKnown: true` ~5s after the page settles.
   - Content console: `[preflightTimer] elapsed → FLOW_PREFLIGHT_READY | taskId: <id>`.
   - Flow continues to completion as before — **no behaviour change**.

2. **Login wall scrape (timer resets, then fires).** Run a queue-mode task that hits a login wall. Expect:
   - Watchdog pauses; sidepanel shows "Sign in to continue."
   - Content console: `[preflightTimer] elapsed` does **not** fire while paused.
   - Click Continue. Page resumes. ~5s later: `[preflightTimer] elapsed → FLOW_PREFLIGHT_READY`.

3. **Manual force.** While step 2 is paused (or before its quiet window elapses), open the SW DevTools console and run:
   ```js
   chrome.runtime.sendMessage({ type: 'FORCE_PREFLIGHT_READY', payload: { taskId: '<the-active-taskId>' } });
   ```
   Expect content console: `[preflightTimer] FORCED → FLOW_PREFLIGHT_READY`. SW console relays the event. Sending it a second time is a silent no-op (already emitted).

4. **Sidepanel-only run (no taskId).** Run a config from the sidepanel local mode. Expect:
   - No `[preflightTimer]` log lines anywhere.
   - No `FLOW_PREFLIGHT_READY` message in the SW console.
   - Flow completes as before — back-compat preserved.

### Edge cases

| Case | Decision |
|---|---|
| Flow aborted before quiet window elapses | **Cover** — `finally` calls `cancel()`, no emit |
| Flow naturally completes within 5s (rare) | **Cover** — `finally` cancels; no emit, harmless |
| Page navigates during a pause; held continuation re-delivers EXECUTE_FLOW | **Cover** — new flow invocation builds a fresh timer; the (rare) re-emission across legs is idempotent at the SW receiver in PR4 |
| `FORCE_PREFLIGHT_READY` arrives with no flow running | **Cover** — listener checks `activePreflightTimer === null` and logs+drops |
| `FORCE_PREFLIGHT_READY` arrives with a stale taskId | **Cover** — listener compares `payload.taskId` with `activePreflightTimer.taskId` and drops mismatches |
| SW restart mid-flow | **Ignore (v1)** — content-script timer survives; SW re-receives the eventual emit and (in PR3) just logs |
| Multiple emits on the same taskId due to PR4 RESUME_FOR_DRAIN cycles | **Ignore (PR3)** — currently impossible (one-shot); PR4 owns dedup if it changes the lifecycle |

---

## Maintainability checklist

- [x] No magic strings — `MessageType.FLOW_PREFLIGHT_READY`, `MessageType.FORCE_PREFLIGHT_READY`, `MessageType.RESUME_FOR_DRAIN`
- [x] Narrow types — `PreflightTimerOptions.emit` typed against the literal `MessageType.FLOW_PREFLIGHT_READY`
- [x] Public surface — `PreflightTimer` class only; `PREFLIGHT_QUIET_MS` constant only; nothing else exported
- [x] Configurable knob — constant + persisted setting; override threading deferred to PR4 (no premature plumbing)
- [x] Reuse — `swLog`, `MessageType`; no duplication
- [x] One responsibility — timer module owns timer state; engine owns the lifecycle bookend; SW relays only
- [x] Pure-ish testing — class is fully testable with `vi.useFakeTimers()`; no DOM, no runtime
- [x] Backward compat — non-batch flows skip the timer; batch flows still don't pause on emit (PR4); existing wire protocol unchanged

---

## Stuck-loop escalation reminder

If two consecutive attempts to make the timer integration green fail (test red, manual smoke wrong), STOP. Write a short report (what tried, what each produced, current root-cause hypothesis, next idea) and ask before attempt #3. Common gotchas in this area: fake-timer setup leaking between tests; `arm()` called from inside a `then()` that hasn't flushed; SW-context vs content-context message origins. If any of those are the suspected root cause and the fix isn't trivially obvious, escalate.
