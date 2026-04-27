# SPEC-human-anti-ban-v1.0

## Context

The extension automates flows that the authenticated user is allowed to do manually. Anti-ban risk is bot-fingerprinting (Cloudflare, in-app heuristics) penalising mechanical patterns. We already have invisible Fitts-curve mouse paths, hybrid atomic-commit typing, and randomised scroll deltas. Gaps:

1. No visible cursor — operator can't audit synthetic mouse paths in real time.
2. `scrollToBottom()` increments by a fixed 250–650 px regardless of viewport — covers ~3 % of long pages.
3. `expandHiddenElements()` uses raw `element.click()` (no mouse path) and has hardcoded delays + no safety cap.
4. Pagination delays are hardcoded.
5. Per-character "visible typing" was reverted to atomic-commit after focus-loss bugs — we want a safe opt-in path with auto-fallback.

Outcome: visible cursor (toggleable, off by default), adaptive viewport-based scroll, naturalClick + ms-configurable pacing for expand & pagination, opt-in per-character typing with focus-loss auto-fallback.

---

## Decisions (locked)

| Decision | Choice |
|---|---|
| Toggle scope | Global prefs in `browser.storage.local` under existing `PREFS_KEY` (mirrors `debug` toggle). |
| Defaults | Both `humanizeMouseVisible` and `humanizeTypingVisible` OFF. |
| Scroll fix | Adaptive viewport-based **plus** four new optional `ScrapeOptions` fields. |
| Pacing units | Milliseconds — operator can tune *down* as well as up. |
| Anti-ban mouse path | Always on (Fitts curve runs even when cursor is invisible). The `MOUSE_VISIBLE` flag only gates the cosmetic cursor element. |

---

## Files to modify

| File | Change |
|---|---|
| [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) | Module-level prefs loader, visible cursor element, adaptive `scrollToBottom`, exported `computeScrollIncrement`, `typeTextVisible` branch. |
| [src/content/scraping/paginationHandler.ts](src/content/scraping/paginationHandler.ts) | `paginatePages` and `paginateElement` accept `paginationDelayMs`. |
| [src/content/extraction/domUtils.ts](src/content/extraction/domUtils.ts) | `expandHiddenElements` uses `naturalClick`, accepts `delayMs`, gains 100-click safety cap. |
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | Thread the four new `ScrapeOptions` fields into both `scrollToBottom` callsites, the `expandHiddenElements` callsite, and `paginatePages`. |
| [src/types/config.ts](src/types/config.ts) | Extend `ScrapeOptions` with four optional fields. |
| [src/sidepanel/utils/storage.ts](src/sidepanel/utils/storage.ts) | Add the four new fields to `STEP_OPTION_DEFAULTS.scrape`. No schema bump. |
| [src/sidepanel/components/APISettingsView.tsx](src/sidepanel/components/APISettingsView.tsx) | Two new toggles below the existing debug one. |
| [src/sidepanel/components/ScrapeWholePageForm.tsx](src/sidepanel/components/ScrapeWholePageForm.tsx) | New "Human pacing" `<details>` with four number inputs. |
| [src/sidepanel/components/ScrapeElementsForm.tsx](src/sidepanel/components/ScrapeElementsForm.tsx) | Same "Human pacing" `<details>` as the wholepage form. |
| **NEW** [src/content/scraping/humanBehavior.test.ts](src/content/scraping/humanBehavior.test.ts) | Vitest tests for `computeScrollIncrement`. |

No backend / DB / migration / permission changes.

---

## F1 — Type extensions

**File:** [src/types/config.ts](src/types/config.ts) — extend `ScrapeOptions` (currently lines 91–99). Insert the four new optional fields after `pageCount`:

```ts
export interface ScrapeOptions {
  mode: 'wholePage' | 'specificElements';
  scrollToBottom: boolean;
  expandHidden: boolean;
  paginate: boolean;
  paginationSelector: SelectorDescriptor | null;
  pageCount: number;
  scrollIncrementVh?: number;     // 0.1–1.0, default 0.4
  scrollDelayMs?: number;         // ms, default 700
  paginationDelayMs?: number;     // ms, default 1500
  expandDelayMs?: number;         // ms, default 350
  elements: ScrapeElementConfig[];
}
```

**File:** [src/sidepanel/utils/storage.ts:13](src/sidepanel/utils/storage.ts#L13) — extend the `scrape` entry in `STEP_OPTION_DEFAULTS`:

```ts
scrape: {
  mode: 'specificElements',
  scrollToBottom: true,
  expandHidden: false,
  paginate: false,
  paginationSelector: null,
  pageCount: 0,
  scrollIncrementVh: 0.4,
  scrollDelayMs: 700,
  paginationDelayMs: 1500,
  expandDelayMs: 350,
  elements: [],
},
```

No `schemaVersion` bump — the fields are optional and consumers default at runtime.

---

## F2 — Prefs loader in humanBehavior.ts

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — add at the very top of the file (after `interface Point`):

```ts
import { PREFS_KEY } from '../../sidepanel/utils/storage';

let MOUSE_VISIBLE = false;
let TYPING_VISIBLE = false;

(async () => {
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = (result[PREFS_KEY] as Record<string, unknown> | undefined) || {};
    MOUSE_VISIBLE = !!prefs.humanizeMouseVisible;
    TYPING_VISIBLE = !!prefs.humanizeTypingVisible;
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
    if (wasVisible && !MOUSE_VISIBLE) removeCursor();
  });
} catch { /* SW restart timing */ }
```

**Why `removeCursor()` on toggle-off:** if the operator turns the cursor off mid-flow, the existing element must be removed so it doesn't linger.

---

## F3 — Visible cursor helpers

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — add these helpers (place them between `delay()` and `naturalClick()`):

```ts
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
```

**Hook into `fittsMousePath`** at line 48–55 — add `moveCursor(pos.x, pos.y)` immediately after the `dispatchEvent('mousemove', ...)` call. Add another `moveCursor(...)` inside the corrections loop at line 65–72.

**Hook into `naturalClick`** at line 125–126 — add `pulseCursor()` between `mouseup` and `click` dispatches.

---

## F4 — Adaptive `scrollToBottom`

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts), replace the entire `scrollToBottom` function (lines 232–252) AND export a new helper:

```ts
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

  const incrementVh = opts?.incrementVh ?? 0.4;
  const baseDelay = opts?.delayMs ?? 700;

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
      await delay(1500 + Math.random() * 1000);
      if (document.body.scrollHeight === lastHeight) break;
    }
    lastHeight = document.body.scrollHeight;
    attempts++;
  }
}
```

**Callsite updates** in [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts):

- Line 730: `await scrollToBottom((scrollY, totalHeight) => onProgress?.(...), { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });`
- Line 749: `await scrollToBottom(undefined, { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });`

---

## F5 — Configurable pagination delay

**File:** [src/content/scraping/paginationHandler.ts](src/content/scraping/paginationHandler.ts) — add `paginationDelayMs?: number` to both function param objects.

`paginatePages` (current lines 21–63) — replace the body's two `randomDelay` calls (lines 55, 59) with:

```ts
const interPageBase = params.paginationDelayMs ?? 1500;
// after waitForContentChange returns:
await randomDelay(200, 400);                                        // post-DOM-settle (was 400-700)
lastSnapshot = document.body.innerText.substring(0, 2000);
pagesScraped++;
await onPage?.(i);
await randomDelay(interPageBase * 0.7, interPageBase * 1.3);        // configurable, was 600-1400
```

Same change inside `paginateElement` (lines 65–109).

**Callsite update** in [src/content/scraping/scrapingEngine.ts:745](src/content/scraping/scrapingEngine.ts#L745):

```ts
const pagesScraped = await paginatePages({
  paginationSelector: opts.paginationSelector,
  pageCount: opts.pageCount || 0,
  paginationDelayMs: opts.paginationDelayMs,
  onPage: async () => { ... },
  onProgress,
  afk,
});
```

Also pass `paginationDelayMs: opts.paginationDelayMs` from any `paginateElement` callsite (search & update — there's one in `scrapeElement`/the table-pagination path; same shape).

---

## F6 — `expandHiddenElements` uses `naturalClick` + safety cap

**File:** [src/content/extraction/domUtils.ts](src/content/extraction/domUtils.ts) — replace the entire `expandHiddenElements` function (lines 463–497):

```ts
import { naturalClick } from '../scraping/humanBehavior'; // add to top of file

const MAX_EXPAND_CLICKS = 100; // safety cap on hostile pages with hundreds of [aria-expanded="false"]

export async function expandHiddenElements(opts: {
  isAborted?: () => boolean;
  onProgress?: (msg: string) => void;
  delayMs?: number;
} = {}): Promise<void> {
  const patterns = [
    '[aria-expanded="false"]',
    'details:not([open])',
    'button[class*="show-more" i]',
    'button[class*="load-more" i]',
    'a[class*="show-more" i]',
    '[data-toggle="collapse"]',
    '.accordion-toggle',
    '.expand-btn',
  ];

  const baseDelay = opts.delayMs ?? 350;
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  let totalClicked = 0;
  for (const pattern of patterns) {
    if (opts.isAborted?.()) return;
    if (totalClicked >= MAX_EXPAND_CLICKS) {
      opts.onProgress?.(`Expand cap reached (${MAX_EXPAND_CLICKS}) — moving on`);
      return;
    }
    const elements = document.querySelectorAll(pattern);
    for (const el of elements) {
      if (opts.isAborted?.()) return;
      if (totalClicked >= MAX_EXPAND_CLICKS) return;
      if ((el as HTMLElement).offsetParent === null) continue;
      try {
        // naturalClick runs the Fitts curve regardless of cursor visibility — afk:false
        // keeps the anti-ban benefit even when the operator hasn't enabled the cosmetic cursor.
        await naturalClick(el as HTMLElement, { afk: false });
        totalClicked++;
        if (totalClicked % 5 === 0) {
          opts.onProgress?.(`Expanding hidden sections... (${totalClicked} so far)`);
        }
        await delay(baseDelay * (0.7 + Math.random() * 0.6)); // ±30 % jitter
      } catch { /* expected */ }
    }
  }
}
```

**Callsite update** in [src/content/scraping/scrapingEngine.ts:737](src/content/scraping/scrapingEngine.ts#L737):

```ts
await expandHiddenElements({ delayMs: opts.expandDelayMs });
```

**Watch for:** circular import. `domUtils.ts` already exports `waitForElement`, `waitForContentChange`, `expandHiddenElements`, `CHART_LIB_PATTERN` — `humanBehavior.ts` does not import from `domUtils.ts`, so importing `naturalClick` into `domUtils.ts` is one-way. Verify with `pnpm build`.

---

## F7 — Visible typing path

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — modify `typeText` (lines 129–168). Add a branch at the top **after focus**:

```ts
export async function typeText(
  element: HTMLElement,
  text: string,
  opts: { clearBefore?: boolean } = {},
): Promise<void> {
  if (opts.clearBefore) {
    await clearInput(element);
  }

  element.focus();

  const isTextInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  if (!isTextInput) return;

  if (TYPING_VISIBLE) {
    await typeTextVisible(element as HTMLInputElement | HTMLTextAreaElement, text);
    return;
  }

  // ── existing atomic-commit path (unchanged) ──
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

  for (const char of text) {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await delay(40 + Math.random() * 80);
  }
}

async function typeTextVisible(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): Promise<void> {
  if (!text) return;

  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;

  let missedFocus = 0;

  for (let i = 0; i < text.length; i++) {
    if (document.activeElement !== element) {
      element.focus({ preventScroll: true });
      missedFocus++;
      if (missedFocus >= 3) {
        // Page is fighting us. Commit the rest atomically and stop the per-char loop.
        if (setter) setter.call(element, text); else (element as HTMLInputElement).value = text;
        element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }

    const ch = text[i];
    const nextValue = element.value + ch;
    if (setter) setter.call(element, nextValue); else (element as HTMLInputElement).value = nextValue;

    element.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    element.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    await delay(40 + Math.random() * 80);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }

  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

**Two safety properties:**
1. Re-focuses with `preventScroll:true` before each char that lost focus — addresses the autocomplete-steals-focus bug.
2. After 3 missed-focus events, silently commits the full text atomically and returns — guaranteed correct value even if the page is hostile.

---

## F8 — Sidepanel toggles

**File:** [src/sidepanel/components/APISettingsView.tsx](src/sidepanel/components/APISettingsView.tsx) — directly under the existing debug `form-group` (lines 241–251), add:

```tsx
<div className="form-group">
  <label className="form-check">
    <input
      type="checkbox"
      checked={mouseVisible}
      onChange={(e) => toggleMouseVisible(e.target.checked)}
    />
    Show synthetic mouse cursor
  </label>
  <p className="form-hint">Draws a small dot on the page so you can see where the automation is moving. Cosmetic only — does not change what the site sees.</p>
</div>

<div className="form-group">
  <label className="form-check">
    <input
      type="checkbox"
      checked={typingVisible}
      onChange={(e) => toggleTypingVisible(e.target.checked)}
    />
    Type one character at a time
  </label>
  <p className="form-hint">Slower, more human-looking typing. Some sites with aggressive autocomplete can steal focus mid-type — turn this off if a search field stops accepting your text.</p>
</div>
```

Wire up alongside the existing `debugEnabled`/`toggleDebug` state — add two more `useState<boolean>(false)` hooks initialised in the same `useEffect` from `getPrefs()`, and two more `toggle*` async functions calling `setPref('humanizeMouseVisible', ...)` / `setPref('humanizeTypingVisible', ...)`. Mirror the rollback-on-error pattern.

---

## F9 — Scrape-form pacing UI

**File:** [src/sidepanel/components/ScrapeWholePageForm.tsx](src/sidepanel/components/ScrapeWholePageForm.tsx) — directly above the `<StepConditionEditor stepId={step.id} />` line, add:

```tsx
<details className="form-group">
  <summary className="form-label" style={{ cursor: 'pointer' }}>Human pacing (advanced)</summary>
  <p className="form-hint">All values in milliseconds (or fraction of viewport for scroll step). Leave blank for sensible defaults.</p>

  <label className="form-label mt-8">Scroll step size (× viewport)</label>
  <input
    type="number"
    step="0.05"
    min="0.1"
    max="1.0"
    className="form-input"
    value={opts.scrollIncrementVh ?? ''}
    placeholder="0.4"
    onChange={(e) => updateOpt('scrollIncrementVh', e.target.value === '' ? undefined : Number(e.target.value))}
  />

  <label className="form-label mt-8">Pause between scroll steps (ms)</label>
  <input
    type="number"
    min="0"
    className="form-input"
    value={opts.scrollDelayMs ?? ''}
    placeholder="700"
    onChange={(e) => updateOpt('scrollDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
  />

  <label className="form-label mt-8">Pause between pagination clicks (ms)</label>
  <input
    type="number"
    min="0"
    className="form-input"
    value={opts.paginationDelayMs ?? ''}
    placeholder="1500"
    onChange={(e) => updateOpt('paginationDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
  />

  <label className="form-label mt-8">Pause between expand-button clicks (ms)</label>
  <input
    type="number"
    min="0"
    className="form-input"
    value={opts.expandDelayMs ?? ''}
    placeholder="350"
    onChange={(e) => updateOpt('expandDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
  />
</details>
```

**File:** [src/sidepanel/components/ScrapeElementsForm.tsx](src/sidepanel/components/ScrapeElementsForm.tsx) — add the same `<details>` block in the equivalent position. Read the file to find the analogous spot before `StepConditionEditor` (or end-of-form).

---

## F10 — Tests

**NEW file:** [src/content/scraping/humanBehavior.test.ts](src/content/scraping/humanBehavior.test.ts):

```ts
import { describe, it, expect } from 'vitest';
import { computeScrollIncrement } from './humanBehavior';

describe('computeScrollIncrement', () => {
  it('returns viewport × incrementVh for normal values', () => {
    expect(computeScrollIncrement(800, 0.4)).toBe(320);
    expect(computeScrollIncrement(1000, 0.5)).toBe(500);
  });

  it('clamps incrementVh to [0.1, 1.0]', () => {
    expect(computeScrollIncrement(1000, 0)).toBe(100);   // floor 0.1 × 1000
    expect(computeScrollIncrement(1000, 5)).toBe(1000);  // ceil 1.0 × 1000
  });

  it('clamps the result to [60, 2000] px', () => {
    expect(computeScrollIncrement(100, 0.1)).toBe(60);   // 100 × 0.1 = 10 → floor 60
    expect(computeScrollIncrement(5000, 1.0)).toBe(2000); // ceil 2000
  });
});
```

---

## Verification

### Automated
1. `pnpm test` — new `humanBehavior.test.ts` plus existing suite green.
2. `pnpm lint` — clean.
3. `pnpm build` — content script + sidepanel bundles successful (catches circular-import / missing-import regressions in F6).

### Manual
1. Toggle **Show synthetic mouse cursor** ON → run any flow with a click → confirm a purple dot follows the Fitts curve and pulses on click. Open DevTools, search for `bb-spoof-cursor` — element exists.
2. Toggle OFF → run same flow → no `bb-spoof-cursor` in DOM. Refresh page mid-flow — cursor recreates if it was on, stays absent if off.
3. On a long infinite-scroll page, leave `scrollIncrementVh` blank and `scrollToBottom: true` — confirm `window.scrollY + window.innerHeight` reaches `document.body.scrollHeight` at completion (not the prior ~3 %).
4. Set `paginationDelayMs` to 200 → run a paginated scrape → observe pages cycle ~200 ms apart. Set to 5000 → pages cycle ~5 s apart.
5. Toggle **Type one character at a time** ON → run setInput on the previously-broken search field → confirm focus is preserved and value commits. Toggle OFF → confirm atomic-path still works.
6. Edge case: type into a field whose page autocomplete steals focus → after 3 misses, value should still commit fully (silent fallback).

---

## Edge case decisions

| Case | Decision |
|---|---|
| Page navigates mid-cursor-move | Cover — `ensureCursor()` recreates lazily on each `moveCursor` call. |
| Sites with `body { pointer-events: none }` | Cover — cursor uses `pointer-events:none` on itself. |
| Iframes | Ignore (v1) — visible cursor only renders in top frame. |
| Page steals focus mid-type | Cover — re-focus + 3-miss atomic fallback. |
| z-index war with site overlays | Ignore (v1) — cosmetic only; max int32 is best effort. |
| Hostile page with hundreds of `[aria-expanded=false]` | Cover — `MAX_EXPAND_CLICKS = 100` cap. |
| Existing scrape configs without new fields | Cover — fields are optional; `STEP_OPTION_DEFAULTS` adds them on next migrate; runtime callsites apply defaults. No schema bump. |
| `humanizeTypingVisible` ON for non-text element | Cover — `typeText` already returns early when not input/textarea. |

---

## Sonnet implementation order (suggested)

1. F1 (types + defaults) → confirms TS shape before anything else compiles.
2. F2 (prefs loader) + F3 (cursor helpers) — independent; can land together.
3. F4 (scroll) + F10 (tests) — together so tests are written against the new helper.
4. F5 (pagination).
5. F6 (expand) — verify no circular import.
6. F7 (typing branch).
7. F8 (settings UI) + F9 (scrape forms) — UI last.

After each step, run `pnpm test && pnpm lint && pnpm build`. If the build breaks, do not amend earlier commits — fix forward.
