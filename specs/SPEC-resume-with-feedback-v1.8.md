# SPEC: Resume-with-feedback (PR1.8)

**Slug:** `resume-with-feedback`
**Version:** 1.8
**Author:** Opus (planning) → Sonnet (implementation)
**Predecessor:** PR1.7 (detection-on-failure)
**Successor:** none planned (defer further detection improvements pending dogfood)

---

## 1. Context

After PR1.6 (robust pause/resume) and PR1.7 (detection-on-failure), false positives are way down but not zero. When the watchdog still fires speculatively on the wrong thing — a Sourcepoint non-consent message that happens to match an iframe selector, a recaptcha widget in a footer that doesn't actually block — the user has to click Continue every time. There's no signal back to the system that "this was a false alarm, please stop firing on this pattern here."

This PR adds a second resume button: **"Skip next time."** Clicking it does what Continue does (clears pause, resumes flow) AND records that the trigger that fired (e.g., `cookieBanner`) is a false alarm on the current domain. The next time `runDetectorWatchdog` runs on that domain, the trigger is suppressed. The user, not the developer, becomes the training signal — one click per per-site false positive, never asked again.

**Granularity decision:** per-domain × per-trigger. Not per-selector (would require enriching `runDetectorWatchdog` to return the matched selector AND a way to map "the iframe sourcepoint matched" back to a stable selector — high cost for v1). Per-domain trigger suppression is coarser but simpler and fixable: if the user really does want cookie banners detected on the same domain later, they can clear the suppression in Detection Settings.

**Locked decisions** (do not re-litigate during implementation):

- New chrome.storage.local key: `blueberry_detection_memory`. Schema: `{ [hostname]: { ignoredTriggers: DetectionTrigger[], updatedAt: number } }`.
- Hostname extracted from `window.location.hostname` at pause time. No www-stripping or eTLD+1 logic — exact host. (Sites that use multiple hostnames for the same property will have separate entries; acceptable v1 cost.)
- Sent to SW in `FLOW_PAUSED` payload as `domain` field (only when reason = `awaitUserAction`).
- SW stores `domain` and `trigger` on `activePauseState`.
- New message: `RESUME_AFTER_PAUSE` with payload `{ markAsFalseAlarm?: boolean }`. Default behaviour (no payload, or `markAsFalseAlarm: false`) is identical to PR1.6 — clears pause, drains continuation. With `markAsFalseAlarm: true`, additionally calls `addIgnoredTrigger(domain, trigger)` before clearing pause.
- Detection memory consulted by `runDetectorWatchdog` via a synchronous in-memory cache. Cache loaded on content-script init, refreshed on `chrome.storage.onChanged` for the key.
- `cloudflare` trigger CANNOT be marked as false alarm — the button label changes to single "Continue" for cloudflare pauses (cloudflare false-positive is impossible in practice; the iframe is unambiguous).
- New view: `LEARNED_DETECTION` accessible from Detection Settings. Lists per-domain learned ignores with delete buttons.
- No backend changes. No new permissions.

---

## 2. File map

### Modified

| File | Concern |
|---|---|
| [src/types/messages.ts](src/types/messages.ts) | Add `domain` to `FLOW_PAUSED` awaitUserAction payload; document `RESUME_AFTER_PAUSE` payload shape |
| [src/content/detectionRules.ts](src/content/detectionRules.ts) | Consult detection-memory cache before each detector check |
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | Send `domain` in `FLOW_PAUSED` payload |
| [src/entrypoints/background.ts](src/entrypoints/background.ts) | Persist `domain` + `trigger` in `activePauseState`; handle `markAsFalseAlarm` on resume |
| [src/sidepanel/components/AwaitActionPauseAlert.tsx](src/sidepanel/components/AwaitActionPauseAlert.tsx) | Two-button layout (Continue + Skip-next-time); read trigger + domain from store |
| [src/sidepanel/stores/uiStore.ts](src/sidepanel/stores/uiStore.ts) | Extend `awaitActionPaused` shape to include `domain` and `trigger` |
| [src/sidepanel/App.tsx](src/sidepanel/App.tsx) | Pass through trigger/domain from `GET_PAUSE_STATE` response |
| [src/sidepanel/components/RunProgress.tsx](src/sidepanel/components/RunProgress.tsx) | Extract trigger/domain from `FLOW_PAUSED` and `GET_PAUSE_STATE` |
| [src/sidepanel/components/DetectionSettings.tsx](src/sidepanel/components/DetectionSettings.tsx) | Add link to LEARNED_DETECTION view |
| [src/sidepanel/components/ConfigTab.tsx](src/sidepanel/components/ConfigTab.tsx) | Register `LEARNED_DETECTION` view route |
| [src/sidepanel/styles/index.css](src/sidepanel/styles/index.css) | Two-button banner layout class |

### New

| File | Purpose |
|---|---|
| `src/sidepanel/utils/detectionMemory.ts` | Storage + cache helpers for the per-domain ignore list |
| `src/content/detectionMemoryCache.ts` | Sync cache wrapper for content-script use |
| `src/sidepanel/components/LearnedDetectionView.tsx` | UI for viewing/deleting learned ignores |
| `src/__tests__/detectionMemory.test.ts` | Vitest for the storage helpers |

### Deleted

None.

---

## 3. Detailed changes

### 3.1 — `src/types/messages.ts`

Extend the `FLOW_PAUSED` awaitUserAction payload to carry `domain`. Locate lines 17-19:

```typescript
  | { type: 'FLOW_PAUSED';            payload:
        | { reason: 'cloudflare'; challengeType?: CloudflareChallengeType; taskId?: string }
        | { reason: 'awaitUserAction'; trigger: DetectionTrigger; message: string; taskId?: string } }
```

Replace with:

```typescript
  | { type: 'FLOW_PAUSED';            payload:
        | { reason: 'cloudflare'; challengeType?: CloudflareChallengeType; taskId?: string }
        | { reason: 'awaitUserAction'; trigger: DetectionTrigger; message: string; domain: string; taskId?: string } }
```

(Also document the `RESUME_AFTER_PAUSE` payload shape inline. Locate line 33:)

Current:
```typescript
  | { type: 'RESUME_AFTER_PAUSE' }
```

Replace with:
```typescript
  | { type: 'RESUME_AFTER_PAUSE';     payload?: { markAsFalseAlarm?: boolean } }
```

No other changes to messages.ts.

---

### 3.2 — NEW: `src/sidepanel/utils/detectionMemory.ts`

Storage helpers, used by both the SW (to write) and the sidepanel (to read for the LEARNED_DETECTION view). Create with this content:

```typescript
import type { DetectionTrigger } from '../../types/messages';

const KEY = 'blueberry_detection_memory';

export interface DomainMemory {
  ignoredTriggers: DetectionTrigger[];
  updatedAt: number;
}

export type DetectionMemory = Record<string, DomainMemory>;

export async function getDetectionMemory(): Promise<DetectionMemory> {
  try {
    const result = await browser.storage.local.get(KEY);
    return (result[KEY] as DetectionMemory | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function getIgnoredTriggers(domain: string): Promise<DetectionTrigger[]> {
  const memory = await getDetectionMemory();
  return memory[domain]?.ignoredTriggers ?? [];
}

export async function addIgnoredTrigger(
  domain: string,
  trigger: DetectionTrigger,
): Promise<void> {
  if (!domain) return;
  const memory = await getDetectionMemory();
  const existing = memory[domain] ?? { ignoredTriggers: [], updatedAt: 0 };
  if (existing.ignoredTriggers.includes(trigger)) return;
  memory[domain] = {
    ignoredTriggers: [...existing.ignoredTriggers, trigger],
    updatedAt: Date.now(),
  };
  await browser.storage.local.set({ [KEY]: memory });
}

export async function removeIgnoredTrigger(
  domain: string,
  trigger: DetectionTrigger,
): Promise<void> {
  const memory = await getDetectionMemory();
  const existing = memory[domain];
  if (!existing) return;
  const next = existing.ignoredTriggers.filter((t) => t !== trigger);
  if (next.length === 0) {
    delete memory[domain];
  } else {
    memory[domain] = { ignoredTriggers: next, updatedAt: Date.now() };
  }
  await browser.storage.local.set({ [KEY]: memory });
}

export async function clearDomainMemory(domain: string): Promise<void> {
  const memory = await getDetectionMemory();
  if (memory[domain]) {
    delete memory[domain];
    await browser.storage.local.set({ [KEY]: memory });
  }
}

// Exported for tests and the in-content cache.
export const DETECTION_MEMORY_KEY = KEY;
```

---

### 3.3 — NEW: `src/content/detectionMemoryCache.ts`

Sync cache for use inside `runDetectorWatchdog` (which is called from synchronous detector code paths). Loads on init, refreshes on storage change. Create with this content:

```typescript
import { DETECTION_MEMORY_KEY, type DetectionMemory } from '../sidepanel/utils/detectionMemory';
import type { DetectionTrigger } from '../types/messages';

let cache: DetectionMemory = {};
let loaded = false;

// Initialise on content-script load. Synchronous reads happen later via
// `getCachedIgnoredTriggers`; reads before this completes return [].
export function initDetectionMemoryCache(): void {
  browser.storage.local.get(DETECTION_MEMORY_KEY).then((result) => {
    cache = (result[DETECTION_MEMORY_KEY] as DetectionMemory | undefined) ?? {};
    loaded = true;
  }).catch(() => { /* leave empty */ });

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[DETECTION_MEMORY_KEY];
      if (!change) return;
      cache = (change.newValue as DetectionMemory | undefined) ?? {};
    });
  } catch { /* SW restart edge case */ }
}

export function getCachedIgnoredTriggers(domain: string): DetectionTrigger[] {
  if (!loaded) return [];
  return cache[domain]?.ignoredTriggers ?? [];
}
```

Init the cache from the content-script entry point. Locate the content-script entrypoint (`src/entrypoints/content.ts` or wherever the watchdog-using code is bootstrapped). Find the existing init block and add a call to `initDetectionMemoryCache()` near other cache/listener initialisations. **If you can't find a clean init point, add the call at the top of `src/content/detectionRules.ts` as a side-effect import in the file's module scope — the module loads once per content-script lifetime.**

Concretely: at the top of `src/content/detectionRules.ts`, add (after existing imports):

```typescript
import { initDetectionMemoryCache, getCachedIgnoredTriggers } from './detectionMemoryCache';

// Initialise once per content-script lifetime.
initDetectionMemoryCache();
```

---

### 3.4 — `src/content/detectionRules.ts`

Consult the cache in `runDetectorWatchdog` before checking each detector. Locate the function (post-PR1.7 form). The detection logic is:

```typescript
export function runDetectorWatchdog(
  cfg?: AutoDetectConfig,
  mode: WatchdogMode = 'all',
): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;
```

Add a domain-ignore check right after the `enabled` helper. Replace the function with:

```typescript
export function runDetectorWatchdog(
  cfg?: AutoDetectConfig,
  mode: WatchdogMode = 'all',
): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;
  const ignored = new Set(getCachedIgnoredTriggers(window.location.hostname));
  const notIgnored = (t: DetectionTrigger): boolean => !ignored.has(t);

  if (enabled('cloudflare') && notIgnored(DetectionTrigger.CLOUDFLARE) && detectCloudflareChallenge().detected) {
    return { fired: true, trigger: DetectionTrigger.CLOUDFLARE };
  }
  if (enabled('loginWall') && notIgnored(DetectionTrigger.LOGIN_WALL) && loginWallFires()) {
    return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  }

  if (mode === 'all') {
    const captchaFired = enabled('captcha') && notIgnored(DetectionTrigger.CAPTCHA) && (
      enabled('cloudflare') ? captchaFires() : document.querySelector(CAPTCHA_SELECTOR) !== null
    );
    if (captchaFired) {
      return { fired: true, trigger: DetectionTrigger.CAPTCHA };
    }
    if (enabled('cookieBanner') && notIgnored(DetectionTrigger.COOKIE_BANNER) && detectCookieBanner()) {
      return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
    }
  }

  if (notIgnored(DetectionTrigger.CUSTOM_SELECTOR)) {
    const extras = cfg?.extraSelectors ?? [];
    if (extras.length > 0 && extraSelectorsFire(extras)) {
      return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
    }
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}
```

Note: `cloudflare` is included in the ignore-check for completeness, but the UI in 3.7 will not let users mark cloudflare as false alarm. So in practice the cloudflare ignore check will always pass. Keeping it consistent here is for future-proofing.

No other edits to detectionRules.ts.

---

### 3.5 — `src/content/scraping/scrapingEngine.ts`

Add `domain` to the `FLOW_PAUSED` payload sent from `runWatchdogPause`. Locate the post-PR1.7 form of `runWatchdogPause`. Inside the `else` branch (non-cloudflare path), find the FLOW_PAUSED send:

```typescript
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: {
        reason: PauseReason.AWAIT_USER_ACTION,
        trigger: result.trigger,
        message: messageForTrigger(result.trigger),
        taskId,
      },
    });
```

Replace with:

```typescript
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: {
        reason: PauseReason.AWAIT_USER_ACTION,
        trigger: result.trigger,
        message: messageForTrigger(result.trigger),
        domain: window.location.hostname,
        taskId,
      },
    });
```

The cloudflare branch does NOT need `domain` (false-alarm not allowed for cloudflare).

The `executeAwaitUserAction` step (lines 777-803) also sends `FLOW_PAUSED`. Locate its payload:

```typescript
  browser.runtime.sendMessage({
    type: MessageType.FLOW_PAUSED,
    payload: {
      reason: PauseReason.AWAIT_USER_ACTION,
      trigger: evalResult.trigger,
      message: opts.message,
      taskId,
    },
  });
```

Replace with:

```typescript
  browser.runtime.sendMessage({
    type: MessageType.FLOW_PAUSED,
    payload: {
      reason: PauseReason.AWAIT_USER_ACTION,
      trigger: evalResult.trigger,
      message: opts.message,
      domain: window.location.hostname,
      taskId,
    },
  });
```

No other edits to scrapingEngine.ts.

---

### 3.6 — `src/entrypoints/background.ts`

Three changes: extend `activePauseState` to include `trigger` and `domain`; handle the `markAsFalseAlarm` payload on resume; ignore `markAsFalseAlarm` on cloudflare resume.

#### 3.6.1 — Extend `activePauseState` type

Locate line 35:

```typescript
  let activePauseState: { reason: 'cloudflare' | 'awaitUserAction'; message?: string } | null = null;
```

Replace with:

```typescript
  let activePauseState: {
    reason: 'cloudflare' | 'awaitUserAction';
    message?: string;
    trigger?: import('../types/messages').DetectionTrigger;
    domain?: string;
  } | null = null;
```

#### 3.6.2 — Capture `trigger` + `domain` on `FLOW_PAUSED`

Locate `handleRemoteFlowEvent` case `'FLOW_PAUSED'` at lines 322-333:

```typescript
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
```

Replace with:

```typescript
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
```

**Important:** queue-mode is not the only path that sets `activePauseState`. Look for ANY other place that assigns to `activePauseState` and apply the same shape change. (At time of writing, `handleRemoteFlowEvent` is the only setter besides `null` clears.)

Also ensure non-queue-mode (sidepanel-driven) flow gets `trigger` + `domain` into `activePauseState`. The current code doesn't set `activePauseState` for sidepanel-only runs (the check `if (!activeRemoteTask) return` early-exits in `handleRemoteFlowEvent`). To make the false-alarm signal work for sidepanel runs, we need a SECOND setter that runs regardless of queue/sidepanel mode.

Locate the `contentToSidepanel` block at lines 513-527. After the existing `browser.runtime.sendMessage(message).catch(...)` call, BEFORE `handleRemoteFlowEvent(...)`, add:

```typescript
      // Mirror pause state into activePauseState for sidepanel-only runs.
      // handleRemoteFlowEvent below also sets it but only when activeRemoteTask
      // is set (queue mode). Both paths converge on the same activePauseState.
      if (type === 'FLOW_PAUSED') {
        const fp = (message.payload ?? {}) as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        if (fp.reason === 'cloudflare' || fp.reason === 'awaitUserAction') {
          activePauseState = {
            reason: fp.reason as 'cloudflare' | 'awaitUserAction',
            message: fp.message,
            trigger: fp.trigger,
            domain: fp.domain,
          };
        }
      }
      if (type === 'FLOW_RESUMED') {
        activePauseState = null;
      }
```

The `contentToSidepanel` block becomes:

```typescript
    if (contentToSidepanel.includes(type)) {
      if (type === 'FLOW_RESUMED') {
        console.warn('[SW] FLOW_RESUMED relayed | activeTaskId:', activeRemoteTask?.task.id);
      }
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });

      // Mirror pause state into activePauseState for sidepanel-only runs.
      if (type === 'FLOW_PAUSED') {
        const fp = (message.payload ?? {}) as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        if (fp.reason === 'cloudflare' || fp.reason === 'awaitUserAction') {
          activePauseState = {
            reason: fp.reason as 'cloudflare' | 'awaitUserAction',
            message: fp.message,
            trigger: fp.trigger,
            domain: fp.domain,
          };
        }
      }
      if (type === 'FLOW_RESUMED') {
        activePauseState = null;
      }

      handleRemoteFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return;
    }
```

#### 3.6.3 — Handle `markAsFalseAlarm` in the resume interceptor

Locate the PR1.6 sidepanel-resume interceptor (immediately after `RESUME_TASK`):

```typescript
    if (type === 'RESUME_AFTER_PAUSE' || type === 'RESUME_AFTER_CLOUDFLARE') {
      const wasPaused = activePauseState !== null;
      activePauseState = null;
      console.warn('[SW] sidepanel resume | type:', type, '| wasPaused:', wasPaused);

      // ... drain held continuations ...
    }
```

Replace with (add false-alarm capture BEFORE clearing `activePauseState`):

```typescript
    if (type === 'RESUME_AFTER_PAUSE' || type === 'RESUME_AFTER_CLOUDFLARE') {
      const wasPaused = activePauseState !== null;
      const resumePayload = (message.payload ?? {}) as { markAsFalseAlarm?: boolean };

      // Capture false-alarm signal BEFORE clearing activePauseState.
      // Cloudflare cannot be marked as false alarm (UI doesn't expose the button).
      if (
        resumePayload.markAsFalseAlarm
        && type === 'RESUME_AFTER_PAUSE'
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
      console.warn('[SW] sidepanel resume | type:', type, '| wasPaused:', wasPaused, '| markAsFalseAlarm:', resumePayload.markAsFalseAlarm);

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

      // Fall through to sidepanelToContent routing.
    }
```

**Note on dynamic `import()`**: WXT bundles content scripts and the SW separately. Dynamic import of `../sidepanel/utils/detectionMemory` from background.ts may need the file to be reachable from the SW's bundle. Verify by building (`npm run build`) and inspecting `.output/chrome-mv3/background.js` — the import should resolve via WXT's tree-shaking. **If the dynamic import fails at runtime**, fall back to a static import at the top of background.ts: `import { addIgnoredTrigger } from '../sidepanel/utils/detectionMemory';` — and use it directly without the dynamic wrapper.

#### 3.6.4 — `GET_PAUSE_STATE` already returns the full `activePauseState`

Verify lines 458-461:

```typescript
    if (type === 'GET_PAUSE_STATE') {
      sendResponse({ pauseState: activePauseState });
      return;
    }
```

This now returns the extended shape including `trigger` and `domain` automatically. No change needed here.

No other edits to background.ts.

---

### 3.7 — `src/sidepanel/components/AwaitActionPauseAlert.tsx`

Two-button layout. Show "Skip next time" button only when trigger and domain are known AND trigger is not cloudflare.

Replace the entire file content with:

```tsx
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { DetectionTrigger } from '../../types/messages';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'cookie banners',
  captcha: 'captchas',
  loginWall: 'sign-in prompts',
  customSelector: 'this',
  unconditional: 'this',
};

export default function AwaitActionPauseAlert() {
  const awaitActionPaused = useUiStore(s => s.awaitActionPaused);
  const setAwaitActionPaused = useUiStore(s => s.setAwaitActionPaused);

  if (!awaitActionPaused) return null;

  const { trigger, domain } = awaitActionPaused;
  // Cloudflare cannot be marked as false alarm — its iframe is unambiguous.
  const showSkipButton = !!trigger && !!domain && trigger !== DetectionTrigger.CLOUDFLARE;
  const triggerLabel = trigger ? TRIGGER_LABEL[trigger] ?? 'this' : 'this';

  const sendResume = async (markAsFalseAlarm: boolean) => {
    try {
      await sendToContent('RESUME_AFTER_PAUSE', { markAsFalseAlarm });
    } catch {
      // content script may be torn down; SW interceptor handles drain anyway.
    } finally {
      setAwaitActionPaused(null);
    }
  };

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Paused — action needed</strong>
        <p>{awaitActionPaused.message}</p>
        <p className="detection-banner-hint">Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you're ready.</p>
      </div>
      <div className="detection-banner-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => sendResume(false)}>
          Continue
        </button>
        {showSkipButton && (
          <button
            className="btn btn-text btn-sm"
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

Note: `btn-text` is assumed to exist as a low-emphasis button variant. If it does not exist in the project's design system, use `btn-secondary` for both and rely on text differentiation. Verify by grep: `grep -r 'btn-text' src/sidepanel/styles/`. If absent, use `btn-secondary` for both.

---

### 3.8 — `src/sidepanel/stores/uiStore.ts`

Extend `awaitActionPaused` shape. Locate line 27:

```typescript
  awaitActionPaused: { message: string } | null;
```

Replace with:

```typescript
  awaitActionPaused: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null;
```

Locate line 41:

```typescript
  setAwaitActionPaused: (v: { message: string } | null) => void;
```

Replace with:

```typescript
  setAwaitActionPaused: (v: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null) => void;
```

No other edits to uiStore.ts.

---

### 3.9 — `src/sidepanel/App.tsx`

The `GET_PAUSE_STATE` init block already destructures `pauseState` from the response. Update the `setAwaitActionPaused` call to forward `trigger` and `domain`. Locate lines 36-42 (PR1.5 form):

```typescript
        const pauseRes = await browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' }).catch(() => null);
        const ps = (pauseRes as { pauseState?: { reason: string; message?: string } } | null)?.pauseState;
        if (ps?.reason === 'cloudflare') {
          useUiStore.getState().setCloudflarePaused(true);
        } else if (ps?.reason === 'awaitUserAction') {
          useUiStore.getState().setAwaitActionPaused({ message: ps.message ?? 'Action needed in your browser.' });
        }
```

Replace with:

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

---

### 3.10 — `src/sidepanel/components/RunProgress.tsx`

Update the `FLOW_PAUSED` handler and the `GET_PAUSE_STATE` mount-time check (added in PR1.5) to pass `trigger` and `domain` through to `setAwaitActionPaused`.

Locate the FLOW_PAUSED handler:

```typescript
  useContentMessage('FLOW_PAUSED', (payload) => {
    const p = payload as Record<string, unknown>;
    if (p.reason === 'cloudflare') {
      setCloudflarePaused(true);
    } else {
      setAwaitActionPaused({ message: (p.message as string) || 'Action needed in your browser.' });
    }
  });
```

Replace with:

```typescript
  useContentMessage('FLOW_PAUSED', (payload) => {
    const p = payload as Record<string, unknown>;
    if (p.reason === 'cloudflare') {
      setCloudflarePaused(true);
    } else {
      setAwaitActionPaused({
        message: (p.message as string) || 'Action needed in your browser.',
        trigger: p.trigger as import('../../types/messages').DetectionTrigger | undefined,
        domain: p.domain as string | undefined,
      });
    }
  });
```

Locate the mount-time GET_PAUSE_STATE block (added in PR1.5):

```typescript
  useEffect(() => {
    browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' })
      .then((res: unknown) => {
        const ps = (res as { pauseState?: { reason: string; message?: string } } | null)?.pauseState;
        if (ps?.reason === 'cloudflare') {
          setCloudflarePaused(true);
        } else if (ps?.reason === 'awaitUserAction') {
          setAwaitActionPaused({ message: ps.message ?? 'Action needed in your browser.' });
        }
      })
      .catch(() => {});
  }, []);
```

Replace with:

```typescript
  useEffect(() => {
    browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' })
      .then((res: unknown) => {
        const ps = (res as { pauseState?: { reason: string; message?: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } } | null)?.pauseState;
        if (ps?.reason === 'cloudflare') {
          setCloudflarePaused(true);
        } else if (ps?.reason === 'awaitUserAction') {
          setAwaitActionPaused({
            message: ps.message ?? 'Action needed in your browser.',
            trigger: ps.trigger,
            domain: ps.domain,
          });
        }
      })
      .catch(() => {});
  }, []);
```

---

### 3.11 — `src/sidepanel/components/DetectionSettings.tsx`

Add a link to the LEARNED_DETECTION view. Locate the existing component (post-PR1.5). After the existing `Done` button or the existing `<div className="form-actions">` block, add a new section above the form-actions:

```tsx
      <div className="form-group">
        <button
          className="btn btn-text btn-sm"
          onClick={() => setView('LEARNED_DETECTION')}
        >
          View learned ignores
        </button>
        <p className="form-hint">
          When you click "Skip on this site" on a pause banner, the trigger is remembered per site. Manage them here.
        </p>
      </div>
```

Make sure `setView` is destructured from `useConfigStore` (it should already be — it's used by `handleDone`).

If `btn-text` doesn't exist, use `btn-secondary`.

---

### 3.12 — NEW: `src/sidepanel/components/LearnedDetectionView.tsx`

Lists per-domain learned ignores with delete buttons. Create with this content:

```tsx
import { useEffect, useState } from 'react';
import BackButton from './BackButton';
import {
  getDetectionMemory,
  removeIgnoredTrigger,
  clearDomainMemory,
  type DetectionMemory,
} from '../utils/detectionMemory';
import type { DetectionTrigger } from '../../types/messages';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'Cookie banners',
  captcha: 'Captchas',
  loginWall: 'Sign-in prompts',
  customSelector: 'Custom selectors',
  cloudflare: 'Cloudflare',
  unconditional: 'Unconditional',
};

export default function LearnedDetectionView() {
  const [memory, setMemory] = useState<DetectionMemory>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const m = await getDetectionMemory();
    setMemory(m);
    setLoaded(true);
  };

  useEffect(() => { refresh(); }, []);

  const domains = Object.keys(memory).sort();

  const handleRemove = async (domain: string, trigger: DetectionTrigger) => {
    await removeIgnoredTrigger(domain, trigger);
    await refresh();
  };

  const handleClearDomain = async (domain: string) => {
    await clearDomainMemory(domain);
    await refresh();
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Learned ignores</h2>
      </div>

      <p className="view-subtitle">
        Sites where you told the scraper to stop pausing for a particular thing. Remove an entry and the scraper will pause for it again next time.
      </p>

      {loaded && domains.length === 0 && (
        <p className="form-hint">Nothing learned yet. When the scraper pauses on a false alarm, click "Skip on this site" to add an entry here.</p>
      )}

      {domains.map((domain) => (
        <div key={domain} className="learned-detection-domain">
          <div className="learned-detection-header">
            <strong>{domain}</strong>
            <button
              className="btn btn-text btn-sm"
              onClick={() => handleClearDomain(domain)}
            >
              Clear all
            </button>
          </div>
          <ul className="learned-detection-list">
            {memory[domain].ignoredTriggers.map((t) => (
              <li key={t} className="learned-detection-item">
                <span>{TRIGGER_LABEL[t] ?? t}</span>
                <button
                  className="btn btn-text btn-sm"
                  onClick={() => handleRemove(domain, t)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
```

---

### 3.13 — `src/sidepanel/components/ConfigTab.tsx`

Register the `LEARNED_DETECTION` view. Add an import alongside the other component imports:

```typescript
import LearnedDetectionView from './LearnedDetectionView';
```

In the `renderView` switch, add a case after `'DETECTION_SETTINGS'`:

```typescript
      case 'LEARNED_DETECTION':
        return <LearnedDetectionView />;
```

---

### 3.14 — `src/sidepanel/styles/index.css`

Add the two-button layout class and learned-detection list styles. Find the `.detection-banner-body` rule (added in PR1.6 if it didn't already exist) and add adjacent rules:

```css
.detection-banner-actions {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-items: stretch;
}

.learned-detection-domain {
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color, rgba(0,0,0,0.1));
  border-radius: 6px;
}

.learned-detection-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
}

.learned-detection-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.learned-detection-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0;
  font-size: 0.9em;
}
```

If `--border-color` is not a defined token in the project, replace with whatever neutral border token is used elsewhere — `grep` for an existing `.form-group` border to find it.

---

### 3.15 — NEW: `src/__tests__/detectionMemory.test.ts`

Tests for the storage helpers. Mocks `browser.storage.local`. Create with this content:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getDetectionMemory,
  getIgnoredTriggers,
  addIgnoredTrigger,
  removeIgnoredTrigger,
  clearDomainMemory,
  DETECTION_MEMORY_KEY,
} from '../sidepanel/utils/detectionMemory';
import { DetectionTrigger } from '../types/messages';

// Minimal in-memory storage mock.
let storage: Record<string, unknown> = {};

beforeEach(() => {
  storage = {};
  // @ts-expect-error — test override
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (kv: Record<string, unknown>) => { Object.assign(storage, kv); }),
      },
    },
  };
});

describe('detectionMemory', () => {
  it('returns empty memory when storage is empty', async () => {
    expect(await getDetectionMemory()).toEqual({});
  });

  it('returns empty triggers list for unknown domain', async () => {
    expect(await getIgnoredTriggers('example.com')).toEqual([]);
  });

  it('adds a trigger for a domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
  });

  it('does not duplicate triggers', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
  });

  it('keeps multiple triggers per domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    const triggers = await getIgnoredTriggers('example.com');
    expect(triggers.sort()).toEqual([DetectionTrigger.CAPTCHA, DetectionTrigger.COOKIE_BANNER].sort());
  });

  it('isolates triggers per domain', async () => {
    await addIgnoredTrigger('a.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('b.com', DetectionTrigger.CAPTCHA);
    expect(await getIgnoredTriggers('a.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
    expect(await getIgnoredTriggers('b.com')).toEqual([DetectionTrigger.CAPTCHA]);
  });

  it('removes a single trigger', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    await removeIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.CAPTCHA]);
  });

  it('removes the domain entry when the last trigger is removed', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await removeIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    const memory = await getDetectionMemory();
    expect(memory['example.com']).toBeUndefined();
  });

  it('clearDomainMemory removes the entire domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    await clearDomainMemory('example.com');
    const memory = await getDetectionMemory();
    expect(memory['example.com']).toBeUndefined();
  });

  it('updates updatedAt on add', async () => {
    const before = Date.now();
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    const memory = await getDetectionMemory();
    expect(memory['example.com'].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('storage key is exported for cache wiring', () => {
    expect(DETECTION_MEMORY_KEY).toBe('blueberry_detection_memory');
  });
});
```

---

## 4. Verification

### 4.1 — Automated

```bash
npm run type-check    # MUST pass — multiple type widenings (FLOW_PAUSED payload, awaitActionPaused store)
npm test              # all existing vitest green + 11 new detectionMemory tests + the PR1.7 watchdog tests still pass
npm run lint          # ESLint clean
npm run build         # WXT build clean; verify the dynamic import in background.ts resolves (look for the addIgnoredTrigger code in background.js)
```

### 4.2 — Manual smoke

Build, reload extension. Run on a freshly cleared chrome.storage.local (or use a fresh profile).

1. **Skip-next-time on cookie banner.** Open https://www.theguardian.com (banner visible). Run a config that does a click step blocked by the banner (forces post-failure pause from PR1.7). Pause banner appears with two buttons. Click "Skip cookie banners on this site". Resume happens, false-alarm recorded.

2. **Verify suppression.** Stop the run. Reload the page. Run the same config again. Expected: NO pause on the cookie banner (suppression cache says "ignore"). The click step still fails because the banner is in the way, but no watchdog match → original error propagates → step shown as error.

3. **Verify scope.** Visit https://www.bbc.co.uk in the same profile. Run a config there. Expected: cookie banner detection still works on bbc.co.uk (suppression is per-domain).

4. **LEARNED_DETECTION view.** Open Detection Settings on any config. Click "View learned ignores". Expected: page lists `theguardian.com` with `Cookie banners`. Click "Remove" next to that row. Expected: row disappears. (Empty state shown if no other entries.)

5. **Re-enable detection.** After removing the entry in step 4, repeat step 1 on theguardian.com. Expected: pause fires again on cookie banner (suppression was removed).

6. **Cloudflare doesn't get the Skip button.** Trigger a cloudflare pause (any cf-protected URL). Expected: only the Continue button is visible. No "Skip" option.

7. **Domain isolation across www / non-www.** Visit https://example.com vs https://www.example.com (treat as different sites in this v1 — suppressing one doesn't affect the other). This is documented as acceptable. Verify by adding suppression on one and checking the other still pauses. (If the project later wants etld+1 unification, that's a future change.)

8. **`activePauseState` carries trigger/domain after PR1.6 GET_PAUSE_STATE.** Trigger a pause. Close the sidepanel. Reopen it. Expected: banner re-appears with the correct trigger label ("Skip cookie banners on this site"), not a generic "Skip this on this site".

9. **Concurrent pauses don't cross-pollute.** Trigger a pause on site A, mark as false alarm. While the suppression is being written, click Continue on a separate run on site B (cookieBanner). Expected: only site A's suppression is recorded. (Race-tolerance check; addIgnoredTrigger is fire-and-forget, but should serialise via storage.)

10. **`awaitUserAction` step inherits the new payload.** Configs that use the explicit `awaitUserAction` step also send the new `domain` field. Verify a paused awaitUserAction step shows the Skip button (with the trigger from `evalResult.trigger`).

### 4.3 — Smoke confirmation

Report results. Note any sites where suppression behaved unexpectedly.

---

## 5. Maintainability checklist (per CLAUDE.md Stage F)

- [ ] **No magic strings.** Storage key exported as `DETECTION_MEMORY_KEY`. Trigger names come from `DetectionTrigger` enum.
- [ ] **Narrow types.** `DetectionMemory`, `DomainMemory` are explicit interfaces. `DetectionTrigger` is the existing enum.
- [ ] **Minimal public surface.** `detectionMemory.ts` exports 5 helpers + 1 type + 1 const. `detectionMemoryCache.ts` exports 2 functions. Nothing else.
- [ ] **Reuse > create.** Reuses chrome.storage.local (already in use), `DetectionTrigger` enum, `BackButton` component, existing `view` routing.
- [ ] **One responsibility per module.** `detectionMemory.ts` is async storage. `detectionMemoryCache.ts` is sync read-only cache. `LearnedDetectionView.tsx` is the UI. `AwaitActionPauseAlert.tsx` handles the resume.
- [ ] **Tests.** 11 new vitest cases covering all storage helpers. UI is integration-tested manually.
- [ ] **Backward compat.** Existing pause flow without trigger/domain still works (defensive `if (!trigger || !domain)` guard hides the Skip button). Configs without `autoDetect` unchanged.
- [ ] **Edge case decisions.**
  - Per-domain (not per-eTLD+1). www vs non-www are distinct entries. Acceptable v1 cost.
  - Cloudflare cannot be marked false alarm — UI gate.
  - Synchronous cache returns `[]` when not yet loaded (init race tolerable: worst case is one extra pause until cache loads).
  - Suppressed trigger doesn't pause, but doesn't generate any UI signal either. User who wonders "why didn't this fire?" can check LEARNED_DETECTION.

---

## 6. Out of scope

- Per-selector granularity (current is per-trigger).
- eTLD+1 grouping (current is exact hostname).
- Snapshot-and-diff learning (the "what disappeared on resume" feature — PR1.9+).
- Network-level login detection.
- Pick-element UI for `extraSelectors`.
- Auto-clearing learned ignores after N days.

---

## 7. Stuck-loop escalation

Per global CLAUDE.md: if two consecutive attempts at the same fix fail, stop and report. Likely failure modes:

- **Dynamic import in background.ts fails at runtime.** WXT may not bundle `detectionMemory.ts` into the SW chunk if it's only dynamically imported. Fix: switch to a static import at the top of background.ts. The function is small and pure-storage, no side effects on import.
- **Cache read returns `[]` even after a successful write.** The cache initialiser uses `browser.storage.onChanged` — verify it fires for `chrome.storage.local` writes (it should; same storage area). If the listener isn't being called, check that the content script imports `initDetectionMemoryCache()` exactly once per content-script instance.
- **`activePauseState.trigger` is undefined in the SW even though the content-script payload includes it.** Verify the `contentToSidepanel` block at 3.6.2 captures into `activePauseState` BEFORE the relay, and that the destructured payload uses `flowPayload.trigger` (not `flowPayload.payload.trigger` — the relay handler already strips one layer).
- **Skip button stays visible on cloudflare pauses.** The check is `trigger !== DetectionTrigger.CLOUDFLARE`. Cloudflare pauses use `reason: 'cloudflare'` (handled by `CloudflarePauseAlert`, not `AwaitActionPauseAlert`), so this branch shouldn't be reached. If it IS reached for cloudflare, the dispatcher has a bug — investigate FLOW_PAUSED routing rather than papering over here.
