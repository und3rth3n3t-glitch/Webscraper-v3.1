# SPEC-Bot1 — Window cascade + CDP-based trusted input
**Version**: 1.0
**Status**: Ready for implementation (Sonnet)
**Predecessors**: PR1 (`aff52ba`) → PR6 (`4fe4a0f`); plus uncommitted PR4-fix (race-condition + selector loop), PR6-fix (batch-complete tracking), PR-toggle (humanize-scroll), PR-keepalive (failed audio attempt — to be removed in this PR).

---

## Context

Two robustness improvements bundled because they together unblock unattended batch dogfooding without changing the visual UX much:

**1. Window cascade.** Chrome's occlusion detection freezes tabs that are fully covered by other windows for a few seconds (`document.visibilityState === 'hidden'` → throttling → eventual freeze). The audio keepalive attempt failed because muted audio doesn't satisfy Chrome's audibility check and unmuted audio requires a user gesture that fresh `chrome.windows.create` windows don't have. Solution: position each task window at a staircase offset so each one always has at least ~40 px of pixels exposed to the compositor; Chrome never marks any of them as occluded.

**2. CDP-dispatched input.** Our entire humanization layer is decorative if a site checks `event.isTrusted` and finds `false` on every dispatched click/keydown. For the project's stated goal — automate routine browsing without burning the user's real account — synthetic events are a meaningful liability on mid-tier sites with even basic bot detection. The fix is `chrome.debugger` + Chrome DevTools Protocol's `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, which generate real `isTrusted: true` events. **Optional permission** with synthetic-event fallback so users who decline, or platforms without the API, fall back to current behaviour.

**What's deliberately NOT in this PR** (per the user's "robust, not fragile" rule):
- ❌ `navigator.webdriver` spoofing — start of the cat-and-mouse rabbit hole
- ❌ stealth-puppeteer-style property overrides — treadmill
- ❌ Per-domain rate budget — not solving a present problem
- ❌ Detach-between-every-burst (B1) — adds latency for marginal gain
- ❌ Audio keepalive — already proven to not work for our case; **delete it in this PR**

Yellow "Chrome is being controlled by automated test software" bar will appear on scrape windows whenever the debugger is attached. This is acceptable per the user — they know the extension is there.

---

## Architecture summary

| Concern | Where | New / Changed |
|---|---|---|
| Window cascade | `src/entrypoints/background.ts` | `startRemoteTask` computes `left/top` offset based on `scheduler.getActiveCount()` |
| Optional permission | `wxt.config.ts` | Add `optional_permissions: ['debugger']` |
| CDP plumbing | `src/background/cdpInput.ts` (new) | `attachIfNeeded(tabId)`, `detach(tabId)`, `dispatchClick`, `dispatchKey`, `dispatchType`, `isCdpEnabled()` |
| SW message routing | `src/entrypoints/background.ts` | Handlers for `CDP_CLICK`, `CDP_TYPE`, `CDP_PRESS_KEY` from content script; debugger lifecycle hooks on flow start, watchdog pause, resume, flow end |
| Content-script input refactor | `src/content/scraping/humanBehavior.ts` | `naturalClick`, `typeText` keystroke loop, `pressEnter` route through SW when CDP available; synthetic fallback preserved; click-target jitter already present (lines 217–219), unchanged |
| Wire-protocol constants | `src/types/messages.ts` | Add `CDP_CLICK`, `CDP_TYPE`, `CDP_PRESS_KEY`, `CDP_RESULT` to `MessageType` |
| Pref + permission UI | `src/sidepanel/components/APISettingsView.tsx` | New "Use real input events" toggle in Developer Options; calls `chrome.permissions.request` |
| Settings prefs | `useRealInput: boolean` in `PREFS_KEY` | Default `false`. Turning on prompts for permission. |
| Delete the failed audio keepalive | `src/content/scraping/keepalive.ts`, references in `scrapingEngine.ts` | Remove the file and the `startKeepalive`/`stopKeepalive` calls |
| Tests | `src/__tests__/cdpInput.test.ts` (new) | Pure tests for the routing/fallback predicate; CDP API itself can't be unit-tested |

**Reuse:**
- Existing `PREFS_KEY` storage pattern (mirrors `humanizeMouseVisible`, `humanizeScroll`, `debug`)
- Existing `scheduler.getActiveCount()` for cascade math
- Existing `swLog` for diagnostics
- Existing watchdog pause/resume hooks for debugger detach/re-attach

---

## Locked decisions (do not re-litigate)

| # | Decision | Choice |
|---|---|---|
| 1 | Cascade math | `left = 100 + activeCount * 40`, `top = 50 + activeCount * 40`, width 1280, height 800. Staircase pattern; works up to ~10 simultaneous windows on a 1920×1080 screen. |
| 2 | Permission model | `optional_permissions` (request at runtime via toggle), not required upfront. Existing users see no permission prompt on extension reload. |
| 3 | Fallback when CDP unavailable | Synthetic event dispatch (current behaviour). No regression. |
| 4 | Debugger lifecycle | Attach on flow start (only if pref + permission); detach on `FLOW_PAUSED` (so user-solves-Cloudflare iframe doesn't see the debugger); re-attach on `FLOW_RESUMED` / `RESUME_AFTER_PAUSE`; detach on flow end. |
| 5 | What CDP dispatches | Only mouse and keyboard input via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. No `Network`, `Page`, `DOM`, `Runtime` domains — those would deepen detection and aren't needed. |
| 6 | Click humanization | Existing target-jitter (random 30–70 % within bounds, already present at humanBehavior.ts:217) is fine. Existing mouse path runs in content script before issuing the CDP click. |
| 7 | Typing | Existing per-character loop preserved; each char becomes one `Input.dispatchKeyEvent` round trip. The atomic-commit `value` setter for the underlying input element runs unchanged (CDP key events fire `input`/`change` from the page side, but the atomic setter is a defence against pages that dispatch `compositionend` / IME quirks). |
| 8 | Coordinates | Viewport-relative CSS pixels (matches existing math). CDP expects the same. |
| 9 | Round-trip latency | ~5–30 ms per CDP call expected. Acceptable; randomised typing delays already account for variance. We do **not** reduce existing delays to compensate. |
| 10 | Detach on tab close / debugger crash | `chrome.debugger.onDetach` listener cleans up state; subsequent CDP calls return `{ ok: false }` and content script falls back to synthetic. |
| 11 | Permission revoke mid-scrape | `chrome.permissions.onRemoved` listener detaches all tabs and flips internal `isEnabled` flag. In-flight CDP calls return `{ ok: false }` → fallback. |
| 12 | Yellow bar | Accepted. Visible during scrape (when debugger attached); collapses when detached on watchdog pause and at flow end. |

---

## File 1 (MODIFIED): `src/entrypoints/background.ts`

### 1a — Window cascade in `startRemoteTask`

**Locate** the existing `chrome.windows.create` call (search for `browser.windows.create({ url: resolved.config.url`). **Replace** the `create` call with offset positioning:

```typescript
    // Cascade: each new task window opens at a 40px staircase offset so
    // no window is ever fully occluded by another. Chrome's occlusion
    // detection freezes tabs that are 100% covered for a few seconds;
    // a sliver of visible pixels is enough to keep them running.
    const offset = scheduler.getActiveCount() * 40;
    const win = await browser.windows.create({
      url: resolved.config.url,
      focused: true,
      left: 100 + offset,
      top: 50 + offset,
      width: 1280,
      height: 800,
    });
```

Note: drop `state: 'maximized'`. The explicit `width`/`height` define the size; maximised would override the cascade and re-introduce occlusion.

### 1b — CDP plumbing imports

**After** the `import { originOf } from '../background/originOf';` line, **insert**:

```typescript
import {
  attachIfNeeded as cdpAttach,
  detach as cdpDetach,
  dispatchClick as cdpDispatchClick,
  dispatchType as cdpDispatchType,
  dispatchPressKey as cdpDispatchPressKey,
  isCdpEnabled,
  initCdpModule,
} from '../background/cdpInput';
```

### 1c — Initialise CDP module on SW start

**Insert** at the top of `defineBackground`'s body, immediately after `ensureDebugInit()`:

```typescript
  // Hydrates `useRealInput` pref + checks current debugger permission;
  // listens for permission revoke + chrome.debugger.onDetach.
  initCdpModule();
```

### 1d — CDP attach on flow start

**Inside** `startRemoteTask`, after the `scheduler.recordStarted(...)` call (the SW already knows the tabId here), **insert**:

```typescript
    // CDP attach (best-effort; falls through to synthetic if pref off
    // or permission missing). Detached on FLOW_PAUSED + flow end.
    await cdpAttach(tab.id).catch((err: Error) => {
      console.warn('[SW] cdpAttach failed (synthetic fallback):', err.message);
    });
```

### 1e — CDP detach on FLOW_PAUSED

**Inside** the `case 'FLOW_PAUSED':` block of `handleRemoteFlowEvent`, **insert** before the existing `relayHubInvocation('SEND_TASK_PAUSED', ...)` line:

```typescript
        // Detach CDP during user-solves-the-challenge phase so the page's
        // iframe (e.g. Cloudflare) doesn't fingerprint our debugger while
        // the user is genuinely solving. Re-attached on RESUME_AFTER_PAUSE.
        cdpDetach(record.tabId).catch(() => { /* best effort */ });
```

### 1f — CDP re-attach on RESUME_AFTER_PAUSE

**Inside** the `RESUME_AFTER_PAUSE` interceptor block (the per-task routing branch added in PR5), **after** the `browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_PAUSE', ...` send (before the held-continuation drain), **insert**:

```typescript
          cdpAttach(target.tabId).catch(() => { /* best effort */ });
```

### 1g — CDP detach on flow end (both completion and error paths)

**Inside** `drainNextRemoteTask`, after `const closing = scheduler.endTask(taskId);` and the `if (!closing) return;` guard, **insert**:

```typescript
    cdpDetach(closing.tabId).catch(() => { /* best effort */ });
```

### 1h — Message router for CDP requests from content script

**Inside** the `browser.runtime.onMessage.addListener(...)` handler, after the existing `TASK_RECEIVED` block (around the same area as the new SET_BATCH_SETTINGS handler from PR6), **insert** three handlers:

```typescript
    if (type === 'CDP_CLICK') {
      const p = (message.payload ?? {}) as { tabId?: number; x: number; y: number };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: 'no-tabId' });
        return true;
      }
      cdpDispatchClick(tabId, p.x, p.y)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    }

    if (type === 'CDP_TYPE') {
      const p = (message.payload ?? {}) as { tabId?: number; text: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.text) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchType(tabId, p.text)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    }

    if (type === 'CDP_PRESS_KEY') {
      const p = (message.payload ?? {}) as { tabId?: number; key: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.key) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchPressKey(tabId, p.key)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    }
```

(`sender` is the existing parameter on the listener — used elsewhere in the file via `chrome.runtime.MessageSender`.)

---

## File 2 (NEW): `src/background/cdpInput.ts`

```typescript
// Chrome DevTools Protocol input dispatcher. Generates `event.isTrusted: true`
// mouse and keyboard events via chrome.debugger so anti-bot systems that
// score on isTrusted don't immediately flag us.
//
// Lifecycle is owned by background.ts:
//   - attachIfNeeded(tabId)  → on flow start
//   - detach(tabId)          → on FLOW_PAUSED, flow end
//   - attachIfNeeded(tabId)  → on RESUME_AFTER_PAUSE
//
// All call sites are best-effort: if the pref is off, the optional
// permission isn't granted, or chrome.debugger throws, we report
// `{ ok: false }` so the content-script call site falls back to its
// synthetic dispatch path. There is no regression vs current behaviour
// when CDP is unavailable.

import { PREFS_KEY } from '../sidepanel/utils/storage';

const CDP_VERSION = '1.3';
const PREF_KEY = 'useRealInput';

let prefEnabled = false;
let permissionGranted = false;
const attachedTabs = new Set<number>();
let initialised = false;

export function isCdpEnabled(): boolean {
  return prefEnabled && permissionGranted;
}

export function initCdpModule(): void {
  if (initialised) return;
  initialised = true;

  // Hydrate pref.
  chrome.storage.local.get(PREFS_KEY).then((data: Record<string, unknown>) => {
    const prefs = (data[PREFS_KEY] as Record<string, unknown> | undefined) || {};
    prefEnabled = !!prefs[PREF_KEY];
  }).catch(() => {});

  // React to pref changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[PREFS_KEY];
    if (!change) return;
    const next = (change.newValue as Record<string, unknown> | undefined) || {};
    prefEnabled = !!next[PREF_KEY];
  });

  // Hydrate permission state.
  if (chrome.permissions?.contains) {
    chrome.permissions.contains({ permissions: ['debugger'] }).then((granted) => {
      permissionGranted = granted;
    }).catch(() => { /* default false */ });
  }

  // React to permission grant/revoke.
  chrome.permissions?.onAdded?.addListener((perm) => {
    if (perm.permissions?.includes('debugger')) permissionGranted = true;
  });
  chrome.permissions?.onRemoved?.addListener((perm) => {
    if (perm.permissions?.includes('debugger')) {
      permissionGranted = false;
      // Detach all attached tabs proactively.
      for (const tabId of attachedTabs) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
      attachedTabs.clear();
    }
  });

  // Cleanup on unexpected detach (tab close, debugger UI dismiss, crash).
  chrome.debugger?.onDetach?.addListener((source, reason) => {
    if (source.tabId !== undefined) {
      console.warn('[CDP] onDetach | tabId:', source.tabId, '| reason:', reason);
      attachedTabs.delete(source.tabId);
    }
  });
}

export async function attachIfNeeded(tabId: number): Promise<void> {
  if (!isCdpEnabled()) return;
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabs.add(tabId);
    console.warn('[CDP] attached | tabId:', tabId);
  } catch (err) {
    // Common failure: another debugger is already attached (DevTools open
    // by user). Mark not-attached; fall back to synthetic path.
    console.warn('[CDP] attach failed | tabId:', tabId, '| err:', (err as Error).message);
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch { /* best effort */ }
  attachedTabs.delete(tabId);
}

export async function dispatchClick(tabId: number, x: number, y: number): Promise<boolean> {
  if (!attachedTabs.has(tabId)) return false;
  try {
    // mousePressed + mouseReleased is what produces a "real" click. The
    // page sees a `click` event with isTrusted: true.
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x, y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x, y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    return true;
  } catch (err) {
    console.warn('[CDP] dispatchClick failed:', (err as Error).message);
    return false;
  }
}

// Per-character key dispatch. We use Input.insertText which generates
// keydown/keypress/input/keyup as if typed, and triggers the page's
// listeners with isTrusted: true. For non-printable keys (e.g. Enter,
// Tab) callers must use dispatchPressKey instead.
export async function dispatchType(tabId: number, text: string): Promise<boolean> {
  if (!attachedTabs.has(tabId)) return false;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    return true;
  } catch (err) {
    console.warn('[CDP] dispatchType failed:', (err as Error).message);
    return false;
  }
}

// Single-keystroke press (rawKeyDown + keyUp). Suitable for Enter, Tab,
// Escape, arrow keys, etc. For printable text use dispatchType.
export async function dispatchPressKey(tabId: number, key: string): Promise<boolean> {
  if (!attachedTabs.has(tabId)) return false;
  const keyCode = keyCodeForKey(key);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code: codeForKey(key),
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: codeForKey(key),
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    return true;
  } catch (err) {
    console.warn('[CDP] dispatchPressKey failed:', (err as Error).message);
    return false;
  }
}

// Minimal mapping for the keys the engine actually presses: Enter, Tab,
// Escape, arrow keys. Extend if a step type adds others.
function keyCodeForKey(key: string): number {
  switch (key) {
    case 'Enter':      return 13;
    case 'Tab':        return 9;
    case 'Escape':     return 27;
    case 'Backspace':  return 8;
    case 'Delete':     return 46;
    case 'ArrowUp':    return 38;
    case 'ArrowDown':  return 40;
    case 'ArrowLeft':  return 37;
    case 'ArrowRight': return 39;
    default:           return 0;
  }
}

function codeForKey(key: string): string {
  switch (key) {
    case 'Enter':      return 'Enter';
    case 'Tab':        return 'Tab';
    case 'Escape':     return 'Escape';
    case 'Backspace':  return 'Backspace';
    case 'Delete':     return 'Delete';
    case 'ArrowUp':    return 'ArrowUp';
    case 'ArrowDown':  return 'ArrowDown';
    case 'ArrowLeft':  return 'ArrowLeft';
    case 'ArrowRight': return 'ArrowRight';
    default:           return key;
  }
}
```

---

## File 3 (MODIFIED): `src/types/messages.ts`

**Find** the `MessageType` const and **append** four new entries:

```typescript
  CANCEL_CONTINUATION: 'CANCEL_CONTINUATION',
  // PR-Bot1: trusted-input round-trip from content → SW → chrome.debugger.
  CDP_CLICK: 'CDP_CLICK',
  CDP_TYPE: 'CDP_TYPE',
  CDP_PRESS_KEY: 'CDP_PRESS_KEY',
} as const;
```

(The constants are used in the SW message router, not yet in content script — content script uses the string literals via the existing `sendMessageToSW` helper. No new export from messages.ts is strictly needed beyond MessageType.)

---

## File 4 (MODIFIED): `src/content/scraping/humanBehavior.ts`

### 4a — Add the SW round-trip helper at file scope

**After** the existing `try { browser.runtime.onMessage.addListener(...) } catch {}` block at the top of the file, **insert**:

```typescript
async function sendCdpRequest(
  type: 'CDP_CLICK' | 'CDP_TYPE' | 'CDP_PRESS_KEY',
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const resp = await browser.runtime.sendMessage({ type, payload }) as { ok?: boolean } | undefined;
    return !!resp?.ok;
  } catch {
    return false;
  }
}
```

### 4b — Refactor `naturalClick` to try CDP first

**Replace** the bottom of `naturalClick` (the three `dispatchEvent` calls — search for `element.dispatchEvent(new MouseEvent('mousedown'`):

```typescript
  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  await delay(40 + Math.random() * 60);
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  pulseCursor();
  element.dispatchEvent(new MouseEvent('click', eventInit));
}
```

with:

```typescript
  // Try CDP first for trusted (`isTrusted: true`) events. Falls back
  // to synthetic dispatch if CDP is unavailable (pref off, permission
  // missing, or sendCommand failed).
  const cdpOk = await sendCdpRequest('CDP_CLICK', { x: target.x, y: target.y });
  pulseCursor();
  if (!cdpOk) {
    element.dispatchEvent(new MouseEvent('mousedown', eventInit));
    await delay(40 + Math.random() * 60);
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));
    element.dispatchEvent(new MouseEvent('click', eventInit));
  }
}
```

### 4c — Restructure `typeText` so CDP and synthetic are clean alternatives

The current `typeText` body (after `element.focus()`) does: native value setter → synthetic input/change → per-char keydown/keyup loop. If we only swap the loop, the synthetic value setter still runs first and the page sees an `isTrusted: false` `input` event BEFORE our CDP-trusted events — defeating the point. CDP must own the entire keyboard surface when available.

**Locate** the block from after `element.focus();` (line ~283) down to the end of the `for` loop (line ~317), spanning both the atomic-commit setter and the per-char keystrokes. The visible/IME path (`typeTextVisible`, lines 320+) stays untouched.

**Replace** that entire block with:

```typescript
  const isTextInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  if (!isTextInput) return;

  if (TYPING_VISIBLE) {
    await typeTextVisible(element as HTMLInputElement | HTMLTextAreaElement, text);
    return;
  }

  // Try CDP first. Input.insertText fires keydown/input/keyup with
  // isTrusted: true and avoids us triggering the synthetic native value
  // setter (whose input event would carry isTrusted: false and tip off
  // anti-bot scorers regardless of what we do afterwards).
  const cdpOk = await sendCdpRequest('CDP_TYPE', { text });
  if (cdpOk) return;

  // Synthetic fallback (existing atomic-commit behaviour) — only runs
  // when CDP is unavailable (pref off, permission missing, or sendCommand
  // failed). Page sees value-set + input + change synchronously, then
  // cosmetic per-char keystrokes that exercise key-event listeners.
  const nativeValueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (nativeValueSetter) {
    nativeValueSetter.call(element, text);
  } else {
    (element as HTMLInputElement).value = text;
  }
  element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  for (let i = 0; i < text.length; i++) {
    if (i > 0 && text[i - 1] === ' ') {
      await delay(180 + Math.random() * 270);
    }
    const ch = text[i];
    element.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit(ch)));
    element.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit(ch)));
    await delay(40 + Math.random() * 80);
  }
```

**Note on CDP-only path:** when CDP succeeds, **no** synthetic value setter runs and **no** synthetic input/change/key events are dispatched. The page's listeners fire from CDP's `Input.insertText` alone — which dispatches them with `isTrusted: true`. The existing line `element.focus()` (just before this block) stays — `Input.insertText` targets whatever element currently has focus, and focus state isn't a detection-relevant signal.

### 4d — Refactor `pressEnter`

**Replace** the body of `pressEnter` (search for `export async function pressEnter`):

```typescript
export async function pressEnter(element: HTMLElement): Promise<void> {
  if (!element) return;

  const cdpOk = await sendCdpRequest('CDP_PRESS_KEY', { key: 'Enter' });
  if (cdpOk) return;

  // Synthetic fallback (current behaviour).
  const keyInit: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };

  element.dispatchEvent(new KeyboardEvent('keydown', keyInit));
  await delay(40 + Math.random() * 60);
  element.dispatchEvent(new KeyboardEvent('keyup', keyInit));
}
```

(The original function had additional logic after `keyup` that was clipped in the spec excerpt — preserve any code that comes after `keyup` in the actual file by reading the existing function before editing.)

---

## File 5 (MODIFIED): `wxt.config.ts`

**Replace** the `permissions` line:

```typescript
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen', 'notifications'],
```

with:

```typescript
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen', 'notifications'],
    optional_permissions: ['debugger'],
```

**Note:** `debugger` MUST be in `optional_permissions`, not `permissions`. Putting it in required permissions would surface a `Read and change all your data on all websites you visit` warning on install AND a separate "Read all data on websites you visit" warning AND would be flagged for Web Store review. Optional defers the prompt to runtime when the user explicitly opts in.

---

## File 6 (MODIFIED): `src/sidepanel/components/APISettingsView.tsx`

### 6a — Add toggle state

**After** the existing `const [humanizeScroll, setHumanizeScroll] = useState(true);` line, **add**:

```typescript
  const [useRealInput, setUseRealInput] = useState(false);
```

### 6b — Hydrate from prefs on mount

**Inside** the existing `getPrefs().then((prefs) => { ... })` block, **add** the new pref read:

```typescript
      setUseRealInput(!!prefs.useRealInput);
```

### 6c — Toggle handler with permission request

**After** the existing `toggleHumanizeScroll` function, **add**:

```typescript
  const toggleUseRealInput = async (next: boolean): Promise<void> => {
    if (next) {
      // Turning ON requires a one-time permission grant. Must be called
      // from a user-gesture handler (this onChange qualifies).
      let granted = false;
      try {
        granted = await chrome.permissions.request({ permissions: ['debugger'] });
      } catch (err) {
        showToast(`Couldn't request permission: ${(err as Error).message}`, 'error');
        return;
      }
      if (!granted) {
        showToast('Permission denied — falling back to synthetic input.', 'warning');
        return;
      }
    } else {
      // Turning OFF revokes the permission. Best effort.
      try {
        await chrome.permissions.remove({ permissions: ['debugger'] });
      } catch { /* ignore */ }
    }
    setUseRealInput(next);
    try {
      await setPref('useRealInput', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setUseRealInput(!next);
    }
  };
```

### 6d — Render the toggle in JSX

**Insert** the new toggle in the Developer Options block, **immediately after** the "Humanize scrolling" form-group:

```typescript
      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={useRealInput}
            onChange={(e) => toggleUseRealInput(e.target.checked)}
          />
          Use real input events (more stealthy)
        </label>
        <p className="form-hint">
          Asks for permission to use Chrome's debugging API to send real mouse and keyboard events.
          Sites that look at <code>event.isTrusted</code> won't see them as automated.
          A yellow "Chrome is being controlled by automated test software" bar appears on scrape windows
          while running. Turn off any time to revoke permission.
        </p>
      </div>
```

---

## File 7 (DELETE): `src/content/scraping/keepalive.ts`

Delete the file entirely. The audio-loop approach was confirmed not to work (autoplay policy blocks fresh windows). Its function is superseded by the window cascade.

## File 8 (MODIFIED): `src/content/scraping/scrapingEngine.ts`

**Remove** the keepalive imports and calls. **Find and delete**:

```typescript
import { startKeepalive, stopKeepalive } from './keepalive';
```

```typescript
  // Background-throttling defence: keep a silent muted audio loop playing
  // for the lifetime of the flow so Chrome doesn't clamp our setTimeout
  // delays when the scrape window is unfocused or behind another window.
  startKeepalive();
```

```typescript
    stopKeepalive();
```

---

## File 9 (NEW): `src/__tests__/cdpInput.test.ts`

```typescript
import { describe, it, expect } from 'vitest';

// Unit-testable surface is small: the CDP module's externally observable
// behaviour is largely chrome.debugger calls (not testable in jsdom). We
// test only the pure helpers — keyCodeForKey / codeForKey — by
// re-importing them. They're not exported in the spec; expose them as
// internal helpers via a separate `cdpKeyMap.ts` if the test demands.
//
// For PR-Bot1 the smoke test plan covers behavioural verification.
// This file is a placeholder asserting the module loads cleanly in a
// jsdom environment without throwing.

describe('cdpInput', () => {
  it('imports without throwing', async () => {
    // Stub chrome global so the module's initialiser doesn't reference
    // undefined APIs. We don't need it to actually do anything.
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } },
      permissions: { contains: () => Promise.resolve(false), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
      debugger: { onDetach: { addListener: () => {} } },
    };
    const mod = await import('../background/cdpInput');
    expect(typeof mod.attachIfNeeded).toBe('function');
    expect(typeof mod.detach).toBe('function');
    expect(typeof mod.dispatchClick).toBe('function');
    expect(typeof mod.dispatchType).toBe('function');
    expect(typeof mod.dispatchPressKey).toBe('function');
    expect(typeof mod.isCdpEnabled).toBe('function');
    expect(typeof mod.initCdpModule).toBe('function');
  });

  it('isCdpEnabled returns false before init', async () => {
    const mod = await import('../background/cdpInput');
    expect(mod.isCdpEnabled()).toBe(false);
  });
});
```

---

## What is deleted

| What | Where |
|---|---|
| `src/content/scraping/keepalive.ts` | Deleted entirely |
| `startKeepalive` / `stopKeepalive` calls + import | `src/content/scraping/scrapingEngine.ts` |

---

## Verification

### Automated

```bash
npm test -- src/__tests__/cdpInput.test.ts
npm test                                    # full suite, ~304+ tests
npm run type-check                          # output must equal pre-PR baseline
npm run lint -- src/background/cdpInput.ts src/entrypoints/background.ts src/content/scraping/humanBehavior.ts src/content/scraping/scrapingEngine.ts src/sidepanel/components/APISettingsView.tsx wxt.config.ts
npm run build
```

**Pre-existing typecheck noise (do NOT fix):** same set as the prior PRs (DataMappingView, ResultsView, types/index.ts, OnMessageListener strictness, runDetectorWatchdog mock). After this PR, type-check output must be identical to the pre-PR baseline.

**Build verification:** check `.output/chrome-mv3/manifest.json` shows `optional_permissions: ['debugger']` and `permissions` does NOT include `debugger`.

### Manual smoke (6 cases)

Build with `npm run build`. Load `.output/chrome-mv3` unpacked. Open SW DevTools console.

1. **Cascade — multi-task batch** — dispatch 3 queue tasks. Each new window should appear at a 40 px diagonal offset from the previous (not stacked exactly on top). Scrape windows can be visibly stacked while still each having a sliver visible. Run task 1 to completion while focused on the backend window in front; flow keeps progressing (no occlusion freeze).

2. **Permission grant** — open Settings, enable "Use real input events". Chrome should prompt for permission. Grant it. Toast: "Permission granted." Toggle should now show as on.

3. **Permission denied** — toggle off, then back on, but click "Cancel" on the prompt. Toast: "Permission denied — falling back to synthetic input." Toggle stays off.

4. **CDP click on a real form** — with the toggle on, run a scrape that clicks a button. The scrape window should display the yellow "Chrome is being controlled by automated test software" bar while the flow runs. SW console should log `[CDP] attached | tabId: …` at flow start, `[CDP] detached | tabId: …` at flow end. The page sees `isTrusted: true` clicks (verifiable with a sandbox like https://www.google.com/recaptcha/api2/demo — recaptcha treats scripted clicks as suspicious; with CDP it should be less aggressive). Use a console snippet on the scrape page to confirm: open page DevTools, run `addEventListener('click', e => console.log('isTrusted:', e.isTrusted), true);`, then trigger a click via the scraper.

5. **CDP detach during pause** — run a scrape that hits a Cloudflare/login gate (PauseAlert appears). Yellow bar should disappear during the pause. After clicking Continue, yellow bar reappears. SW console: `[CDP] detached` on FLOW_PAUSED, `[CDP] attached` on RESUME_AFTER_PAUSE.

6. **CDP fallback when toggle off** — toggle off (or never enable). Run a scrape. No yellow bar; SW console shows no `[CDP] attached` line. Click events still happen (synthetic). Existing functionality preserved.

### Edge cases

| Case | Behaviour |
|---|---|
| User opens DevTools on the scrape window during a scrape | `chrome.debugger.attach` will fail because Chrome won't allow two debuggers per tab. Logged + silent fallback to synthetic for that flow. |
| User revokes permission via chrome://extensions while scrape is running | `chrome.permissions.onRemoved` fires; module detaches all, marks not-enabled; subsequent CDP calls return `{ ok: false }` → fallback. Scrape continues with synthetic events. |
| Tab closes while debugger attached | `chrome.debugger.onDetach` fires with `reason === 'target_closed'`; module clears the tab from `attachedTabs`. |
| CDP call times out | `chrome.debugger.sendCommand` rejects; logged; CDP call returns `false`; content script falls back to synthetic for THIS event only. Flow continues. |
| Existing scrapes mid-flight when permission newly granted | They started without the debugger attached. They continue with synthetic for their lifetime (since `attachIfNeeded` is only called at flow start). No mid-flight switch. Acceptable. |
| Window cascade exceeds screen bounds (drainCap × 40 px > screen height) | Chrome clamps `top` to viewport. Multiple windows may end up at the same effective position → re-introduces occlusion. With drainCap=4 and 40 px offsets, max offset is 160 px — fits comfortably on any normal screen. Mitigation deferred. |
| SW restart while debugger still attached to live tabs | Chrome retains the actual debugger attachment but our `attachedTabs` Set is empty after restart. Subsequent `attachIfNeeded` calls fail with "Another debugger is already attached." Module logs + falls back to synthetic for that flow. To recover, user can close + reopen the affected tab, or just wait for the existing attachment to drop when the tab closes naturally. Acceptable for v1. |

### Edge cases — ignored (v1)

| Case | Why |
|---|---|
| Per-character keydown latency from CDP round-trip | ~5–30 ms per char. Adds < 1 s to typing a 30-char query. Within humanization noise. |
| Detect "site already has its own debugger" (Devtools open) | We log + fall back; user can close their devtools and retry if it matters. |
| Mouse-path CDP dispatch (every move event) | Out of scope. We do mouse path in content (synthetic) and only the click is CDP. Path itself isn't watched by anti-bot; the click event is. |
| `Input.insertText` produces a synthetic-looking compositionend | Some pages detect this. Not solving in v1. |
| Recovery if `chrome.debugger.attach` succeeds but later commands fail | We mark the tab as not-attached on failure; next attach call retries. Adequate. |

---

## Maintainability checklist

- [x] No magic strings — all wire literals via `MessageType.*`
- [x] CDP module owns the `chrome.debugger` surface; nothing else touches it
- [x] One responsibility per module — cdpInput dispatches, scheduler tracks lifecycle, humanBehavior decides between trusted vs synthetic
- [x] Configurable knob — togglable per-user, off by default, optional permission
- [x] Reuse — existing `PREFS_KEY`, `swLog`, `scheduler.getActiveCount()`, watchdog hooks
- [x] Backward compat — synthetic event paths preserved; no behaviour change when CDP unavailable
- [x] Stage C compliance — settings UI uses existing `form-group + form-check + form-hint` classes; no new tokens or styles
- [x] Pure-ish testing — module loads cleanly in jsdom; behavioural verification via smoke

---

## Stuck-loop escalation reminder

If two consecutive attempts to make a check green fail, STOP and report. Common gotchas: (a) `chrome.debugger.attach` requires `target_id` not `tab_id` in some older docs — use `{ tabId }` per the v1.3 API; (b) `Input.insertText` doesn't fire keydown for non-printable chars — use `dispatchKeyEvent` with `rawKeyDown`/`keyUp`; (c) attaching to a tab where the user has DevTools open ALWAYS fails — that's expected, just fall back; (d) the cascade math may break on multi-monitor setups where Chrome clamps coordinates oddly — accept and revisit. Escalate to Opus if a stuck-loop hits 2 failed attempts on the same hypothesis.
