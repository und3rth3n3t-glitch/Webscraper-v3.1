import { PREFS_KEY } from '../../sidepanel/utils/storage';
import { swLog } from '../../utils/swLog';

interface Point { x: number; y: number }

let MOUSE_VISIBLE = false;
let TYPING_VISIBLE = false;
let CLEAR_VISIBLE = false;
let DEBUG = false;
// Default true so existing scrapes keep eased scrolling. Toggle off in
// Developer Options for fast test runs (see APISettingsView).
let HUMANIZE_SCROLL = true;

let lastMousePos: Point | null = null;

try {
  window.addEventListener('pagehide', () => { lastMousePos = null; });
} catch { /* SSR / no-window contexts */ }

(async () => {
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = (result[PREFS_KEY] as Record<string, unknown> | undefined) || {};
    MOUSE_VISIBLE = !!prefs.humanizeMouseVisible;
    TYPING_VISIBLE = !!prefs.humanizeTypingVisible;
    CLEAR_VISIBLE = !!prefs.humanizeClearVisible;
    DEBUG = !!prefs.debug;
    if (typeof prefs.humanizeScroll === 'boolean') HUMANIZE_SCROLL = prefs.humanizeScroll;
    if (!MOUSE_VISIBLE) removeCursor();
  } catch { /* expected */ }
})();

try {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[PREFS_KEY];
    if (!change) return;
    const next = (change.newValue as Record<string, unknown> | undefined) || {};
    const wasVisible = MOUSE_VISIBLE;
    MOUSE_VISIBLE = !!next.humanizeMouseVisible;
    TYPING_VISIBLE = !!next.humanizeTypingVisible;
    CLEAR_VISIBLE = !!next.humanizeClearVisible;
    DEBUG = !!next.debug;
    HUMANIZE_SCROLL = typeof next.humanizeScroll === 'boolean' ? next.humanizeScroll : true;
    if (wasVisible && !MOUSE_VISIBLE) removeCursor();
  });
} catch { /* SW restart timing */ }

async function sendCdpRequest(
  type: 'CDP_CLICK' | 'CDP_MOUSE_MOVE' | 'CDP_TYPE' | 'CDP_PRESS_KEY',
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const resp = await browser.runtime.sendMessage({ type, payload }) as { ok?: boolean } | undefined;
    return !!resp?.ok;
  } catch {
    return false;
  }
}

function dbg(...args: unknown[]): void {
  if (DEBUG) swLog(...args);
}

interface MousePathOptions {
  afk?: boolean;
  durationMs?: number;
  target?: Point;
}

export async function moveMouseToElement(
  element: HTMLElement,
  opts: MousePathOptions = {},
): Promise<Point | null> {
  if (opts.afk) return null;

  const rect = element.getBoundingClientRect();
  const target: Point = opts.target ?? {
    x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
    y: rect.top + rect.height * (0.3 + Math.random() * 0.4),
  };

  const origin: Point = lastMousePos ?? {
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
  };

  const duration = opts.durationMs ?? (400 + Math.random() * 300);
  await fittsMousePath(origin, target, duration);
  lastMousePos = target;
  return target;
}

async function fittsMousePath(from: Point, to: Point, durationMs: number): Promise<void> {
  const STEPS = 25;
  const NOISE_PX = 3;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const perp = { x: -dy * 0.2, y: dx * 0.2 };

  const cp1: Point = { x: from.x + dx * 0.3 + perp.x, y: from.y + dy * 0.3 + perp.y };
  const cp2: Point = { x: from.x + dx * 0.7 + perp.x, y: from.y + dy * 0.7 + perp.y };

  // Probe CDP once at the start. If the first move comes back trusted, keep
  // using CDP for the entire path so isTrusted is consistent across the
  // whole movement. If it fails, fall back to synthetic dispatch for the rest.
  let useCdp = true;

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const eased = easeInOutFitts(t);
    const pos = cubicBezier(from, cp1, cp2, to, eased);
    const noise = gaussianNoise(NOISE_PX);
    pos.x += noise.x;
    pos.y += noise.y;

    await dispatchMove(pos.x, pos.y, () => { useCdp = false; }, useCdp);
    moveCursor(pos.x, pos.y);

    const stepDelay = (durationMs / STEPS) * (1 + (t > 0.8 ? (t - 0.8) * 3 : 0));
    await delay(stepDelay);
  }

  // Correction sub-movements near target
  const corrections = 1 + Math.floor(Math.random() * 2);
  for (let c = 0; c < corrections; c++) {
    const jitter = gaussianNoise(2);
    const x = to.x + jitter.x;
    const y = to.y + jitter.y;
    await dispatchMove(x, y, () => { useCdp = false; }, useCdp);
    moveCursor(x, y);
    await delay(30 + Math.random() * 40);
  }
}

async function dispatchMove(
  x: number,
  y: number,
  onCdpFail: () => void,
  useCdp: boolean,
): Promise<void> {
  if (useCdp) {
    const ok = await sendCdpRequest('CDP_MOUSE_MOVE', { x, y });
    if (ok) return;
    onCdpFail();
  }
  document.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
}

function easeInOutFitts(t: number): number {
  if (t < 0.65) return (t / 0.65) * (t / 0.65) * 0.65;
  return 0.65 + (1 - Math.pow(1 - (t - 0.65) / 0.35, 2)) * 0.35;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
    y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

function gaussianNoise(amplitude: number): Point {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return { x: z * amplitude, y: z * amplitude };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const CURSOR_ID = 'bb-spoof-cursor';
const CURSOR_STYLE =
  'position:fixed;left:0;top:0;width:14px;height:14px;border-radius:50%;' +
  'background:rgba(95,37,159,0.55);border:2px solid #fff;pointer-events:none;' +
  'z-index:2147483647;transform:translate(-50%,-50%);' +
  'transition:transform 60ms linear,background-color 120ms;will-change:left,top';

function ensureCursor(): HTMLDivElement | null {
  if (!MOUSE_VISIBLE) return null;
  if (!document.body) return null;
  let el = document.getElementById(CURSOR_ID) as HTMLDivElement | null;
  if (el) return el;
  el = document.createElement('div');
  el.id = CURSOR_ID;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = CURSOR_STYLE;
  document.body.appendChild(el);
  return el;
}

function moveCursor(x: number, y: number) {
  const el = ensureCursor();
  if (!el) return;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function pulseCursor() {
  const el = ensureCursor();
  if (!el) return;
  el.style.transform = 'translate(-50%,-50%) scale(1.6)';
  el.style.background = 'rgba(187,22,163,0.7)';
  setTimeout(() => {
    if (!el.isConnected) return;
    el.style.transform = 'translate(-50%,-50%) scale(1)';
    el.style.background = 'rgba(95,37,159,0.55)';
  }, 120);
}

function removeCursor() {
  const el = document.getElementById(CURSOR_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

export async function naturalClick(
  element: HTMLElement,
  opts: { afk?: boolean } = {},
): Promise<void> {
  // Scroll into view first so the click coords land on a real visible point.
  // smoothScrollToElement already early-returns if the rect is already
  // fully in the viewport, so this is free when not needed.
  await smoothScrollToElement(element);

  // Strip target/rel to avoid triggering new-tab navigation
  if (element instanceof HTMLAnchorElement) {
    element.removeAttribute('target');
    element.removeAttribute('rel');
  }

  const rect = element.getBoundingClientRect();
  const target: Point = {
    x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
    y: rect.top + rect.height * (0.3 + Math.random() * 0.4),
  };

  await moveMouseToElement(element, { afk: opts.afk ?? false, target });

  // Pre-click hover dwell — humans pause briefly before pressing.
  await delay(80 + Math.random() * 120);

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: target.x,
    clientY: target.y,
  };

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

export function keyboardEventInit(ch: string): KeyboardEventInit {
  const upper = ch.toUpperCase();
  let code: string | undefined;
  let keyCode: number | undefined;

  if (/^[A-Z]$/.test(upper)) {
    code = `Key${upper}`;
    keyCode = upper.charCodeAt(0); // 65–90
  } else if (/^[0-9]$/.test(ch)) {
    code = `Digit${ch}`;
    keyCode = ch.charCodeAt(0); // 48–57
  } else if (ch === ' ') {
    code = 'Space';
    keyCode = 32;
  } else {
    keyCode = ch.charCodeAt(0);
  }

  return { key: ch, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
}

function isVisuallyClickable(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export async function typeText(
  element: HTMLElement,
  text: string,
  opts: { clearBefore?: boolean } = {},
): Promise<void> {
  if (opts.clearBefore) {
    await clearInput(element);
  }

  // Move mouse to the input and click it before typing — only when visually
  // clickable. Hidden / zero-area inputs (popovers, off-screen anchors) fall
  // back to bare focus to avoid clicking through to a covering element.
  if (isVisuallyClickable(element)) {
    try {
      await naturalClick(element);
    } catch { /* expected on rare detached elements */ }
  }
  element.focus();

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
}

async function typeTextVisible(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): Promise<void> {
  if (!text) return;

  const setterFor = (el: HTMLInputElement | HTMLTextAreaElement) =>
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;

  let setter = setterFor(element);
  let missedFocus = 0;
  // Track what we've typed so far so per-char value-setting survives the page
  // overwriting element.value mid-loop (combobox autocomplete, dropdown
  // selection, etc.). Building on element.value would let the page corrupt us.
  let typedSoFar = '';

  const describeActive = (): string => {
    const a = document.activeElement;
    if (!a) return 'null';
    return `${a.tagName}#${a.id || '-'}.${(a.className || '').toString().slice(0, 30)}`;
  };

  dbg('[typeTextVisible] START', { text, hasFocus: document.hasFocus(), elemConnected: element.isConnected, active: describeActive() });

  for (let i = 0; i < text.length; i++) {
    // Element-replacement detection: Vue/React combobox widgets (Wikipedia
    // Codex, etc.) swap the static input for a fresh reactive one as soon as
    // we focus or first input. Our reference becomes detached and every write
    // goes to a phantom node. If the page has refocused onto a new input,
    // re-target to it and re-apply what we've typed so far for continuity.
    if (!element.isConnected) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        dbg('[typeTextVisible] element replaced, retargeting', { i, typedSoFar, newActive: describeActive() });
        element = active;
        setter = setterFor(element);
        if (setter) setter.call(element, typedSoFar); else (element as HTMLInputElement).value = typedSoFar;
        missedFocus = 0;
      }
    }

    const focusMatch = document.activeElement === element;
    if (!focusMatch) {
      element.focus({ preventScroll: true });
      missedFocus++;
      dbg('[typeTextVisible] focus miss', { i, missedFocus, refocusedTo: document.activeElement === element, active: describeActive() });
      if (missedFocus >= 3) {
        // Page is fighting us. Commit the rest atomically and stop the per-char loop.
        dbg('[typeTextVisible] FALLBACK atomic', { i, typedSoFar, elemValue: element.value, elemConnected: element.isConnected });
        if (setter) setter.call(element, text); else (element as HTMLInputElement).value = text;
        element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }

    // Inter-word pause: humans pause after spaces.
    if (i > 0 && text[i - 1] === ' ') {
      await delay(180 + Math.random() * 270);
    }

    const ch = text[i];
    const valueBeforeSet = element.value;
    typedSoFar += ch;
    if (setter) setter.call(element, typedSoFar); else (element as HTMLInputElement).value = typedSoFar;
    const valueAfterSet = element.value;

    element.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit(ch)));
    element.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    await delay(40 + Math.random() * 80);
    const valueAfterDispatch = element.value;
    element.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit(ch)));

    dbg('[typeTextVisible] char', {
      i, ch, typedSoFar,
      valueBeforeSet, valueAfterSet, valueAfterDispatch,
      elemConnected: element.isConnected,
      activeMatch: document.activeElement === element,
      active: describeActive(),
    });
  }

  element.dispatchEvent(new Event('change', { bubbles: true }));
  dbg('[typeTextVisible] END', { typedSoFar, elemValue: element.value, elemConnected: element.isConnected });
}

export async function clearInput(element: HTMLElement): Promise<void> {
  if (!element) return;

  if (CLEAR_VISIBLE && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    await clearInputVisible(element);
    return;
  }

  element.focus({ preventScroll: true });

  // Synchronous clear — no delays so Chrome's background-tab timer throttling
  // (1 s minimum per setTimeout) cannot create a gap where the site's JS
  // restores the old value before we finish clearing.
  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (nativeInputValueSetter && 'value' in element) {
    nativeInputValueSetter.call(element, '');
  } else if ('value' in element) {
    (element as HTMLInputElement).value = '';
  }

  element.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clearInputVisible(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  if (!element.value) return;

  element.focus({ preventScroll: true });
  try {
    element.select();
  } catch { /* some inputs (number, email in some UAs) disallow programmatic select() */ }

  // Brief dwell on the selection, like a real user pausing before pressing Delete.
  await delay(80 + Math.random() * 120);

  const deleteInit: KeyboardEventInit = {
    key: 'Delete',
    code: 'Delete',
    keyCode: 46,
    which: 46,
    bubbles: true,
    cancelable: true,
  };

  element.dispatchEvent(new KeyboardEvent('keydown', deleteInit));

  // Native value-setter to '' so React/Vue see the change. Same idiom as the
  // atomic path; total elapsed time is well under the 1 s throttle window.
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(element, ''); else (element as HTMLInputElement).value = '';

  element.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  await delay(40 + Math.random() * 60);
  element.dispatchEvent(new KeyboardEvent('keyup', deleteInit));
}

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

  const form = element.closest('form');
  if (form) form.requestSubmit();
}

export async function smoothScrollToElement(element: HTMLElement): Promise<void> {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  if (rect.top >= 0 && rect.bottom <= viewportHeight) return;

  if (!HUMANIZE_SCROLL) {
    element.scrollIntoView({ block: 'start', behavior: 'auto' });
    return;
  }

  const targetY = window.scrollY + rect.top - viewportHeight / 3;
  const startY = window.scrollY;
  const distance = targetY - startY;
  // Scale step count with distance so long scrolls (e.g. bottom→top) take proportionally longer.
  const steps = Math.max(20, Math.min(60, Math.ceil(Math.abs(distance) / 50) + Math.floor(Math.random() * 10)));

  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    window.scrollTo(0, startY + distance * eased);
    await delay(16 + Math.random() * 22);
  }
}

export async function humanSkimScroll(): Promise<void> {
  if (!HUMANIZE_SCROLL) return;
  const skimSteps = 2 + Math.floor(Math.random() * 3); // 2–4 bursts
  for (let s = 0; s < skimSteps; s++) {
    const viewport = window.innerHeight || 800;
    const distance = viewport * (0.3 + Math.random() * 0.3); // 30–60 % vh
    const startY = window.scrollY;
    const subSteps = 8 + Math.floor(Math.random() * 6); // 8–13 frames per burst
    for (let i = 0; i <= subSteps; i++) {
      const progress = i / subSteps;
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      window.scrollTo(0, startY + distance * eased);
      await delay(12 + Math.random() * 18);
    }
    await randomDelay(300, 700); // reading pause between bursts
  }
}

export interface ScrollToBottomOptions {
  incrementVh?: number;   // fraction of viewport per step (0.1–1.0). Default 0.4.
  delayMs?: number;       // base inter-step delay. ±30 % jitter applied. Default 700.
}

export function computeScrollIncrement(viewportPx: number, incrementVh: number): number {
  const safeVh = Math.max(0.1, Math.min(1.0, incrementVh));
  const raw = viewportPx * safeVh;
  // Clamp so very tall (300vh+) phantom viewports or zero-height edge cases stay sane.
  return Math.max(60, Math.min(2000, raw));
}

export async function scrollToBottom(
  onProgressOrOpts?: ScrollToBottomOptions | ((scrollY: number, totalHeight: number) => void),
  maybeOpts?: ScrollToBottomOptions,
): Promise<void> {
  // Back-compat: callers used to pass just an onProgress callback.
  let onProgress: ((y: number, h: number) => void) | undefined;
  let opts: ScrollToBottomOptions | undefined;
  if (typeof onProgressOrOpts === 'function') {
    onProgress = onProgressOrOpts;
    opts = maybeOpts;
  } else {
    opts = onProgressOrOpts;
  }

  // Fast mode: bigger steps + tiny delays. Lazy-loaded sites may load less
  // content; that's the explicit trade-off advertised in the toggle copy.
  const incrementVh = HUMANIZE_SCROLL ? (opts?.incrementVh ?? 0.4) : 1.0;
  const baseDelay = HUMANIZE_SCROLL ? (opts?.delayMs ?? 700) : 50;

  let lastHeight = document.body.scrollHeight;
  let attempts = 0;
  const maxAttempts = 50;

  while (attempts < maxAttempts) {
    const viewport = window.innerHeight || 800;
    const baseStep = computeScrollIncrement(viewport, incrementVh);
    const scrollAmount = baseStep * (0.85 + Math.random() * 0.3); // ±15 % jitter
    window.scrollBy(0, scrollAmount);

    await delay(baseDelay * (0.7 + Math.random() * 0.6)); // ±30 % jitter

    onProgress?.(window.scrollY, document.body.scrollHeight);

    const newHeight = document.body.scrollHeight;
    if (newHeight === lastHeight) {
      await delay(HUMANIZE_SCROLL ? 1500 + Math.random() * 1000 : 100);
      if (document.body.scrollHeight === lastHeight) break;
    }
    lastHeight = document.body.scrollHeight;
    attempts++;
  }
}

export async function selectOption(element: HTMLElement, value: string): Promise<void> {
  if (!element || element.tagName !== 'SELECT') return;
  const sel = element as HTMLSelectElement;

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(sel, value);
  } else {
    sel.value = value;
  }

  sel.dispatchEvent(new Event('change', { bubbles: true }));
  sel.dispatchEvent(new Event('input', { bubbles: true }));
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}
