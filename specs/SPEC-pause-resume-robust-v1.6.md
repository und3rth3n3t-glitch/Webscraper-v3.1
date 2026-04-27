# SPEC: Robust pause/resume contract (PR1.6)

**Slug:** `pause-resume-robust`
**Version:** 1.6
**Author:** Opus (planning) → Sonnet (implementation)
**Predecessor:** PR1.5 (commit pending — detection-ui-coldstart)
**Successor:** PR1.7 (detection-on-failure)

---

## 1. Context

PR1 + PR1.5 introduced a watchdog that can pause the flow when an obstacle is detected (cookie banner, login wall, captcha, cloudflare, custom selectors). The current resume contract only works when the user dismisses the obstacle **without** triggering a page navigation, then clicks Continue in the sidepanel. In real-world use, users almost always resolve obstacles via actions that navigate the page:

| Obstacle | Natural action | Result |
|---|---|---|
| Cookie banner | Accept All | Page reload |
| Login wall | Fill + submit | Form POST → redirect |
| Captcha | Solve | Form submit → redirect |
| Cloudflare | (auto) | Full page swap |

When the page navigates during a watchdog pause:
1. Content script is destroyed → `waitForResumeSignal` Promise abandoned.
2. SW's `activePauseState` is orphaned (sidepanel banner persists, but resume click goes nowhere).
3. No continuation is registered for the cold-start case (cold-start watchdog runs in setup phase before any navigating step), so `tabs.onUpdated` doesn't re-deliver `EXECUTE_FLOW`.
4. Flow is dead. User must Stop and restart manually.

This PR makes pause-state and continuations resilient to page navigation that happens during a pause. The user clicking Continue in the sidepanel is the **sole** resume signal, and it works whether the page navigated during the pause or not. Composite obstacles (login → cloudflare → captcha) are handled naturally: pause persists across the entire chain, user clicks Continue once at the end.

**Locked decisions** (do not re-litigate during implementation):

- Pause **persists across page navigations** until the user clicks Continue. No auto-resume on detector clear, no polling.
- Continuations are **held** (not delivered) by the SW while `activePauseState` is set.
- On resume, SW clears pause state, then drains any held continuation for the active tab.
- For cold-start pauses (no surrounding navigating step), `runWatchdogPause` registers a continuation pointing at the current leg coordinates. For mid-loop pauses, the surrounding navigating step's continuation is reused.
- After EXECUTE_FLOW re-delivery via continuation, a watchdog runs at the start of the resumed leg before any step executes. This generalises PR1.5's narrow `navigateTo` re-check at scrapingEngine.ts:190.
- `RESUME_AFTER_PAUSE` is added to `sidepanelToContent` routing. SW intercepts it (and legacy `RESUME_AFTER_CLOUDFLARE`) to clear `activePauseState` and drain held continuations **before** forwarding to the content script.
- Banner copy update: "Sort out anything blocking the scraper in the page, then click Continue when you're ready." Single Continue button (PR1.8 will add the second "Skip next time" button).
- No new permissions. No schema changes. No backend changes.

---

## 2. File map

### Modified

| File | Concern |
|---|---|
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | `runWatchdogPause` signature (accepts resume context); generalised post-resume watchdog at top of every resumed leg; outer-finally `CANCEL_CONTINUATION` |
| [src/entrypoints/background.ts](src/entrypoints/background.ts) | Hold continuations while paused; intercept `RESUME_AFTER_PAUSE`/`RESUME_AFTER_CLOUDFLARE`; drain on resume; add to `sidepanelToContent` |
| [src/types/messages.ts](src/types/messages.ts) | (No change to types — payload extensions are inline.) |
| [src/sidepanel/components/AwaitActionPauseAlert.tsx](src/sidepanel/components/AwaitActionPauseAlert.tsx) | Banner copy update |
| [src/sidepanel/components/CloudflarePauseAlert.tsx](src/sidepanel/components/CloudflarePauseAlert.tsx) | Banner copy update |

### New

None.

### Deleted

None.

---

## 3. Detailed changes

### 3.1 — `src/content/scraping/scrapingEngine.ts`

Three coordinated changes.

#### 3.1.1 — Extend `runWatchdogPause` to accept a resume context and register a continuation while paused

Locate `runWatchdogPause` at lines 358-389. Current signature:

```typescript
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
): Promise<void> {
```

Replace the entire function with:

```typescript
interface PauseResumeContext {
  config: ScraperConfig;
  searchTerms: string[];
  previousIterations: WireIteration[];
  startTermIndex: number;
  startLoopStepIndex: number;
}

// Post-navigation watchdog. Wire-protocol decision:
//   - cloudflare uses reason='cloudflare' (existing dispatcher routes to CloudflarePauseAlert + auto-clear race)
//   - everything else uses reason='awaitUserAction' with a trigger field (existing dispatcher routes to AwaitActionPauseAlert)
// PR4 will rationalise the taxonomy once the dispatcher is rewritten.
//
// Pause-resilience: before sending FLOW_PAUSED we register a continuation
// pointing at the current leg. If the user resolves the obstacle via an
// action that navigates the page (Accept All cookies, login submit), the
// content script dies but the SW holds the continuation until the user
// clicks Continue, then re-delivers EXECUTE_FLOW so the flow resumes
// from the same leg on the new page.
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
  resumeCtx: PauseResumeContext,
): Promise<void> {
  const result = runDetectorWatchdog(cfg);
  swLog('[watchdog] result | fired:', result.fired, '| trigger:', result.trigger, '| cfg:', cfg);
  if (!result.fired) return;

  swLog('[watchdog] fired | taskId:', taskId, '| trigger:', result.trigger, '| url:', window.location.href);

  // Register a pause-continuation pointing at the current leg. If the user
  // resolves the obstacle via page-navigating action, the held continuation
  // re-delivers EXECUTE_FLOW after the user clicks Continue.
  try {
    browser.runtime.sendMessage({
      type: MessageType.REGISTER_CONTINUATION,
      payload: {
        config: resumeCtx.config,
        searchTerms: resumeCtx.searchTerms,
        taskId,
        startTermIndex: resumeCtx.startTermIndex,
        startLoopStepIndex: resumeCtx.startLoopStepIndex,
        previousIterations: resumeCtx.previousIterations,
      },
    });
    swLog('[watchdog] pause-continuation registered | startTermIndex:', resumeCtx.startTermIndex, '| startLoopStepIndex:', resumeCtx.startLoopStepIndex);
  } catch { /* extension context may be invalidated */ }

  if (result.trigger === DetectionTrigger.CLOUDFLARE) {
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: { reason: PauseReason.CLOUDFLARE, taskId },
    });
    await Promise.race([waitForChallengeToClear().promise, waitForResumeSignal()]);
  } else {
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: {
        reason: PauseReason.AWAIT_USER_ACTION,
        trigger: result.trigger,
        message: messageForTrigger(result.trigger),
        taskId,
      },
    });
    await waitForResumeSignal();
  }

  swLog('[watchdog] cleared/resumed | taskId:', taskId);
  browser.runtime.sendMessage({ type: MessageType.FLOW_RESUMED });
}
```

#### 3.1.2 — Update all `runWatchdogPause` call sites to pass the resume context

There are three call sites. All must pass the current leg coordinates.

**(a) Cold-start watchdog at lines 150-152.** Current:

```typescript
        swLog('[cold-start watchdog] enter | url:', window.location.href, '| autoDetect:', config.autoDetect);
        await runWatchdogPause(config.autoDetect, taskId);
        swLog('[cold-start watchdog] exit');
```

Replace with:

```typescript
        swLog('[cold-start watchdog] enter | url:', window.location.href, '| autoDetect:', config.autoDetect);
        await runWatchdogPause(config.autoDetect, taskId, {
          config,
          searchTerms,
          previousIterations: result.iterations,
          startTermIndex: 0,
          startLoopStepIndex: 0,
        });
        swLog('[cold-start watchdog] exit');
```

**(b) Post-nav watchdog inside `for (let si...)` loop at line 244.** Current:

```typescript
            if (isNavigating) {
              await runWatchdogPause(config.autoDetect, taskId);
            }
```

Replace with:

```typescript
            if (isNavigating) {
              await runWatchdogPause(config.autoDetect, taskId, {
                config,
                searchTerms,
                previousIterations: result.iterations,
                startTermIndex: i,
                startLoopStepIndex: si + 1,
              });
            }
```

**(c) navigateTo continuation watchdog at lines 190-193.** Current:

```typescript
        // navigateTo continuations: the navigateTo step blocks forever so the
        // post-navigation watchdog at line ~236 never fires for it. Run it here
        // at the top of the resumed iteration instead.
        if (i === startTermIndex && siStart > 0 && loopSteps[siStart - 1]?.type === 'navigateTo') {
          swLog('[post-nav watchdog] navigateTo continuation | taskId:', taskId, '| url:', window.location.href);
          await runWatchdogPause(config.autoDetect, taskId);
        }
```

Replace with the generalised "watchdog at start of every resumed leg" check:

```typescript
        // Resumed-leg watchdog: when EXECUTE_FLOW was re-delivered via a held
        // continuation (after pause-driven navigation, or after a navigateTo
        // step that blocks until reload), the prior step's post-nav watchdog
        // never ran. Re-check before stepping into the resumed leg so a
        // still-present obstacle re-pauses rather than letting the flow run
        // through it.
        if (i === startTermIndex && (siStart > 0 || startTermIndex > 0)) {
          swLog('[resumed-leg watchdog] enter | taskId:', taskId, '| termIndex:', i, '| siStart:', siStart, '| url:', window.location.href);
          await runWatchdogPause(config.autoDetect, taskId, {
            config,
            searchTerms,
            previousIterations: result.iterations,
            startTermIndex: i,
            startLoopStepIndex: siStart,
          });
        }
```

#### 3.1.3 — Cancel any pause-continuation when `executeFlow` exits cleanly

Locate the outer `finally` at lines 320-323:

```typescript
  } finally {
    swLog('[executeFlow] finally — clearing flowRunning | taskId:', taskId);
    flowRunning = false;
  }
```

Replace with:

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

#### 3.1.4 — Verify imports

The new `runWatchdogPause` references `WireIteration` and `ScraperConfig` in its `PauseResumeContext` interface. `ScraperConfig` is already imported at line 36-49. `WireIteration` is imported at line 25. **No import changes needed.**

No other edits to scrapingEngine.ts.

---

### 3.2 — `src/entrypoints/background.ts`

Three coordinated changes.

#### 3.2.1 — Add `RESUME_AFTER_PAUSE` to `sidepanelToContent` routing list

Locate the `sidepanelToContent` array at line 531-536:

```typescript
    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_CLOUDFLARE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
```

Replace with (add `'RESUME_AFTER_PAUSE'` adjacent to the other resume message):

```typescript
    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_CLOUDFLARE', 'RESUME_AFTER_PAUSE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
```

#### 3.2.2 — Intercept resume messages to clear pause state and drain held continuations

Locate the existing `RESUME_TASK` handler at lines 429-437 (queue-mode resume from server). It clears `activePauseState`. We need a sidepanel-equivalent handler that clears `activePauseState` AND drains held continuations.

Add a new handler block **immediately after** the `RESUME_TASK` block at line 437 (before `CANCEL_TASK`):

```typescript
    // Sidepanel-driven resume. Intercept BEFORE the sidepanelToContent routing
    // below so we can (1) clear activePauseState atomically and (2) drain any
    // held continuation that's been waiting because the page navigated during
    // the pause. The interceptor doesn't consume the message — it falls through
    // to the routing block, which forwards to the live content script (if one
    // is still listening). If the content script is dead (page navigated), the
    // drained continuation re-delivers EXECUTE_FLOW.
    if (type === 'RESUME_AFTER_PAUSE' || type === 'RESUME_AFTER_CLOUDFLARE') {
      const wasPaused = activePauseState !== null;
      activePauseState = null;
      console.warn('[SW] sidepanel resume | type:', type, '| wasPaused:', wasPaused);

      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = activeTab?.id;
        if (!tabId) return;
        const continuation = pendingContinuations.get(tabId);
        if (continuation) {
          // Drain: deliver the held continuation now.
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

      // Fall through to sidepanelToContent routing so the live content script
      // (if any) also receives the resume signal and its waitForResumeSignal
      // promise resolves.
    }
```

#### 3.2.3 — Hold continuations in `tabs.onUpdated` while pause is active

Locate the existing `tabs.onUpdated` handler at lines 589-619. Inside the `if (changeInfo.status === 'complete')` block, before the existing `pendingContinuations.delete(tabId)` call, add a guard.

Current relevant block (lines 593-617):

```typescript
    if (changeInfo.status === 'complete') {
      const continuation = pendingContinuations.get(tabId);
      if (continuation) {
        const cp = continuation as Record<string, unknown>;
        // Capture tab URL at fire time so we can correlate with the content
        // script's view of where it is when its waitAfterAction returns.
        browser.tabs.get(tabId).then((t) => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| tabUrl:', t.url, '| changeInfoUrl:', changeInfo.url, '| startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex, '| searchTerms:', cp.searchTerms, '| previousIterations.length:', Array.isArray(cp.previousIterations) ? (cp.previousIterations as unknown[]).length : 'n/a');
        }).catch(() => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| (tab.get failed) | startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex);
        });
        // Delete immediately so that a second 'complete' event firing before the
        // setTimeout resolves (e.g. redirect then page-load) does NOT double-fire
        // EXECUTE_FLOW. If delivery actually fails we re-add so the next 'complete'
        // can retry — this preserves the redirect-retry behaviour without double-fire.
        pendingContinuations.delete(tabId);
        setTimeout(() => {
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
            .then(() => { console.warn('[SW] Continuation delivered to tabId:', tabId); })
            .catch((err: Error) => {
              console.warn('[SW] Continuation delivery failed for tabId:', tabId, '— re-registering for retry | err:', err.message);
              pendingContinuations.set(tabId, continuation);
            });
        }, 600);
      }
    }
```

Replace with (insert the `activePauseState` guard at the top):

```typescript
    if (changeInfo.status === 'complete') {
      const continuation = pendingContinuations.get(tabId);
      if (continuation) {
        const cp = continuation as Record<string, unknown>;
        // Pause-resilience: while activePauseState is set, the user is still
        // working on the obstacle. The page may have navigated as part of that
        // (e.g. login submit redirect). HOLD the continuation in the map and
        // do NOT deliver — it will be drained by the sidepanel-resume handler
        // when the user clicks Continue.
        if (activePauseState) {
          console.warn('[SW] tabs.onUpdated — holding continuation (pause active) | tabId:', tabId, '| reason:', activePauseState.reason);
          return;
        }

        // Capture tab URL at fire time so we can correlate with the content
        // script's view of where it is when its waitAfterAction returns.
        browser.tabs.get(tabId).then((t) => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| tabUrl:', t.url, '| changeInfoUrl:', changeInfo.url, '| startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex, '| searchTerms:', cp.searchTerms, '| previousIterations.length:', Array.isArray(cp.previousIterations) ? (cp.previousIterations as unknown[]).length : 'n/a');
        }).catch(() => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| (tab.get failed) | startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex);
        });
        // Delete immediately so that a second 'complete' event firing before the
        // setTimeout resolves (e.g. redirect then page-load) does NOT double-fire
        // EXECUTE_FLOW. If delivery actually fails we re-add so the next 'complete'
        // can retry — this preserves the redirect-retry behaviour without double-fire.
        pendingContinuations.delete(tabId);
        setTimeout(() => {
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
            .then(() => { console.warn('[SW] Continuation delivered to tabId:', tabId); })
            .catch((err: Error) => {
              console.warn('[SW] Continuation delivery failed for tabId:', tabId, '— re-registering for retry | err:', err.message);
              pendingContinuations.set(tabId, continuation);
            });
        }, 600);
      }
    }
```

No other edits to background.ts.

---

### 3.3 — `src/sidepanel/components/AwaitActionPauseAlert.tsx`

Banner copy update only — make it clear the user can resolve via any in-page action and click Continue when finished.

Locate lines 21-29:

```tsx
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Action needed</strong>
        <p>{awaitActionPaused.message}</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Continue
      </button>
    </div>
```

Replace with:

```tsx
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Paused — action needed</strong>
        <p>{awaitActionPaused.message}</p>
        <p className="detection-banner-hint">Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you're ready.</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Continue
      </button>
    </div>
```

Also update the resume to use the new message type. Locate lines 10-18:

```tsx
  const handleResume = async () => {
    try {
      await sendToContent('RESUME_AFTER_CLOUDFLARE');
      setAwaitActionPaused(null);
    } catch {
      // content script may have torn down — clear local state regardless
      setAwaitActionPaused(null);
    }
  };
```

Replace with (use the new `RESUME_AFTER_PAUSE` message; the SW intercepts both, but using the type-correct one is cleaner):

```tsx
  const handleResume = async () => {
    try {
      await sendToContent('RESUME_AFTER_PAUSE');
      setAwaitActionPaused(null);
    } catch {
      // content script may have torn down (page navigated during pause).
      // The SW interceptor already cleared activePauseState and drained any
      // held continuation, so the flow will resume regardless.
      setAwaitActionPaused(null);
    }
  };
```

---

### 3.4 — `src/sidepanel/components/CloudflarePauseAlert.tsx`

Banner copy update — same UX intent. Locate lines 16-26:

```tsx
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Security check detected</strong>
        <p>The site is showing a Cloudflare challenge. Complete it in the page, then resume.</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Resume
      </button>
    </div>
```

Replace with:

```tsx
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Paused — security check</strong>
        <p>The site is showing a Cloudflare challenge. Complete it in the page (the scraper will wait) and click Continue when you're through.</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Continue
      </button>
    </div>
```

No other edits.

---

### 3.5 — CSS for the new `detection-banner-hint` class

The new `<p className="detection-banner-hint">` element needs a style so it renders smaller / muted. Locate `src/sidepanel/styles/index.css` and find the `.detection-banner` class definitions (search for `.detection-banner-body`).

Add after the existing `.detection-banner-body` rule:

```css
.detection-banner-hint {
  margin-top: 0.5rem;
  font-size: 0.85em;
  opacity: 0.8;
}
```

If `.detection-banner-body` does not exist (PR1 may have used different class names), instead add the rule next to wherever `.detection-banner` is defined. **Do not invent new colour tokens** — `opacity` reuses whatever colour the parent banner uses.

---

## 4. Verification

### 4.1 — Automated

Run from the extension repo root (`c:\Users\und3r\blueberry-v3`):

```bash
npm run type-check    # MUST pass — runWatchdogPause signature change is a breaking refactor; all 3 call sites must be updated
npm test              # all existing vitest green; no new tests in this PR
npm run lint          # ESLint clean
npm run build         # WXT build clean
```

If `npm run type-check` complains about `runWatchdogPause` arity, you missed a call site. Re-read 3.1.2.

### 4.2 — Manual smoke (in this order)

Start the extension (`npm run build`, reload unpacked extension in Chrome).

1. **Cold-start cookie banner — Accept All path.** Open https://www.theguardian.com (banner showing). Open sidepanel. Load any config that scrapes the loaded page. Click Run. Expected: pause banner appears with new copy. **Click "Accept All" in the page** (page reloads). Expected: pause banner persists across reload. Click Continue in sidepanel. Expected: cold-start watchdog re-runs on the loaded-without-banner page, finds nothing, flow proceeds.

2. **Cold-start cookie banner — dismiss-only path.** Open a site with a banner that has an X button (no reload). Click X to close the banner without reloading. Click Continue. Expected: same as before but no navigation involved. Flow proceeds.

3. **Composite chain — login then cloudflare.** Open a config targeting a site that requires login then has cloudflare. Click Run. Expected: pause banner appears. Sign in via the page (form submits, redirect happens). Banner persists across redirect. Cloudflare challenge appears next; banner still shows. Complete cloudflare in page (page swaps). Banner still shows. Click Continue. Expected: flow proceeds — single Continue click resolved the entire chain.

4. **Mid-loop pause — navigation.** Build a config with `navigateTo` to a site with a cookie banner, then a Scrape step. Run. Expected: pause after navigation. Click Accept All in page. Banner persists across reload. Click Continue. Expected: flow proceeds with the resumed leg's watchdog re-checking before the Scrape step.

5. **Stop during pause.** Trigger any pause. Click Stop in sidepanel (not Continue). Expected: flow ends, banner disappears, no orphaned continuation (verify by starting a new run on the same tab — no phantom EXECUTE_FLOW).

6. **Two pauses on the same chain.** Trigger a pause, click Continue while the page is fine, but a second obstacle appears immediately (e.g., site shows banner then captcha). Expected: second pause fires with new trigger; user clicks Continue again; flow proceeds.

7. **Pause + close tab.** Trigger a pause. Close the tab. Expected: existing `tabs.onRemoved` handler clears the continuation; no orphan state in SW. (Open DevTools → Service Worker → check that `pendingContinuations.size === 0`.)

8. **Pause + page navigates to unrelated URL.** Trigger pause. Manually type a different URL in the address bar. Expected: continuation still held (pause active). Click Continue. Expected: continuation re-delivers EXECUTE_FLOW on the new URL. Cold-start watchdog runs on the unrelated page. If clean, flow runs (probably failing on a missing element since user navigated away from the target). This is acceptable: user controls the page state at the moment of Continue.

9. **awaitUserAction step still works.** Configs that use the `awaitUserAction` step type with `detectionRules` must still pause and resume correctly. This step uses `executeAwaitUserAction` (not `runWatchdogPause`) — but the resume signal `RESUME_AFTER_PAUSE` should still wake it via `waitForResumeSignal`. Verify with an existing awaitUserAction config.

10. **Queue-mode resume from server still works.** If running in queue mode, the server-initiated `RESUME_TASK` path (background.ts:429-437) still uses `RESUME_AFTER_CLOUDFLARE` and clears `activePauseState`. Verify a queue task that pauses on cloudflare can be resumed from the server side. (The existing handler pre-dates this PR and should be unaffected.)

### 4.3 — Smoke confirmation

Report which steps passed, which failed, and any incidental observations.

---

## 5. Maintainability checklist (per CLAUDE.md Stage F)

- [ ] **No magic strings.** New message types are routed via `MessageType.RESUME_AFTER_PAUSE` (already defined in PR1).
- [ ] **Narrow types.** `PauseResumeContext` is a typed interface. No `any`.
- [ ] **Minimal public surface.** No new exports.
- [ ] **Reuse > create.** Reuses `pendingContinuations` map, `activePauseState` global, existing `tabs.onUpdated` handler, existing `MessageType` constants.
- [ ] **Tests.** Behavioural change is integration-level; manual smoke covers it. Unit tests would require mocking `browser.runtime.sendMessage`, `browser.tabs.*`, and `chrome.storage.session` — high cost for one routing change.
- [ ] **Backward compat.** `RESUME_AFTER_CLOUDFLARE` continues to work (legacy code path retained). New `RESUME_AFTER_PAUSE` is additive. v3/v4/v5 configs unchanged.

---

## 6. Out of scope

- Detection-on-failure (PR1.7).
- Two-button resume (PR1.8 — adds the false-alarm signal).
- Network-level login detection (later).
- Pick-element UI for `extraSelectors` (later).
- Backend changes / queue-mode protocol changes (none).

---

## 7. Stuck-loop escalation

Per global CLAUDE.md: if two consecutive attempts at the same fix fail, stop and report. Likely failure modes:

- **Continuation delivered while pause active despite the guard.** Verify the `if (activePauseState) return;` short-circuit is INSIDE the `if (continuation)` block at the top of the `if (changeInfo.status === 'complete')` branch. If the guard runs but delivery still fires, check whether the resume-handler's `pendingContinuations.delete` and `setTimeout(send)` race against a concurrent `tabs.onUpdated` firing — investigate ordering before adding more locks.
- **`runWatchdogPause` signature mismatch errors.** All three call sites must pass `{ config, searchTerms, previousIterations: result.iterations, startTermIndex, startLoopStepIndex }`. The cold-start case uses `0, 0`. The post-nav case uses `i, si + 1`. The resumed-leg case uses `i, siStart`.
- **Resume click does nothing after page navigation.** The SW interceptor block at 3.2.2 must run BEFORE the `sidepanelToContent` routing block at 3.2.1. Both can fire because the interceptor doesn't `return` — it falls through. If you accidentally added a `return`, only the drain runs and the live content script (if any) never gets the resume signal.
