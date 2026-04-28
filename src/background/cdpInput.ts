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
