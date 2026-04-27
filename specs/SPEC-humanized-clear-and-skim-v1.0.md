# SPEC — Humanized clear (opt-in) + pre-scrape scroll

> Once approved, copy this file to `blueberry-v3/specs/SPEC-humanized-clear-and-skim-v1.0.md` per CLAUDE.md.

## Context

v1.1 hardened typing/click/keyboard. Two surfaces remain robotic:

1. **Clearing inputs** — `clearInput` snaps the value to `''` synchronously. The sync constraint is real (Chrome's 1 s background-tab `setTimeout` throttle could let the site restore the value), but only matters for *long* delay windows. A short `select() → Delete` is below that risk window.
2. **Landing-and-scraping** — when `executeStep` lands on the destination, scraping reads the DOM immediately. Whole-page scrapes with `scrollToBottom: false` never scroll; element-mode scrapes never bring the target into view first.

Outcomes:
- New opt-in pref `humanizeClearVisible` (default off → existing atomic clear). When on: `select()` + Delete keystroke.
- Always-on pre-scrape humanizing: brief skim before whole-page scrapes (skipped if `scrollToBottom` is on or `afk` is on); `smoothScrollToElement` before element-mode extraction.

---

## Decisions (locked)

| Decision | Choice |
|---|---|
| Clear strategy when pref on | `element.select()` then a single Delete keydown/keyup with native value-setter clear in between. Not per-char backspace. |
| Clear pref default | Off. Preserves current atomic behavior for everyone until they opt in. |
| Clear pref scope | New `humanizeClearVisible` pref + UI toggle, parallel to `humanizeTypingVisible` / `humanizeMouseVisible`. |
| Pre-scrape skim trigger | `scrapeWholePage` only, gated on `!opts.scrollToBottom && !afk`. Skipped when scrollToBottom is on (already scrolling). |
| Element scroll-into-view | `scrapeElement` calls `smoothScrollToElement(el)` after `resolveWithRetry` for **every** element (text, container, table, chart). Not afk-gated — mirrors `naturalClick` (only mouse-motion is afk-skipped; scroll-into-view always runs). |
| Skim shape | 2–4 bursts, each 30–60 % viewport, eased per-step (mirrors `smoothScrollToElement` loop), 300–700 ms reading pause between bursts. |
| Special-key event init | Hardcoded `deleteInit` literal locally inside `clearInputVisible` (mirrors `pressEnter`). Do not extend `keyboardEventInit`. |

---

## Files to modify

| File | Change |
|---|---|
| [src/content/scraping/humanBehavior.ts](../../blueberry-v3/src/content/scraping/humanBehavior.ts) | Add `CLEAR_VISIBLE` flag + IIFE/listener wiring; refactor `clearInput`; add private `clearInputVisible`; add exported `humanSkimScroll`. |
| [src/content/scraping/scrapingEngine.ts](../../blueberry-v3/src/content/scraping/scrapingEngine.ts) | Import `humanSkimScroll`, `smoothScrollToElement`; gated skim call in `scrapeWholePage`; scroll-into-view call at top of `scrapeElement`. |
| [src/sidepanel/components/APISettingsView.tsx](../../blueberry-v3/src/sidepanel/components/APISettingsView.tsx) | Add `clearVisible` state, `toggleClearVisible`, prefs-load line, and a third checkbox group. |

No new files. No `storage.ts` change — Prefs is `Record<string, unknown>`, no type to update.

---

## F1 — `CLEAR_VISIBLE` flag + prefs sync

**File:** `src/content/scraping/humanBehavior.ts`

Add after the existing `let TYPING_VISIBLE = false;` declaration (currently around line 7):

```ts
let CLEAR_VISIBLE = false;
```

Update the IIFE prefs loader (currently lines 16–25). Find:

```ts
    MOUSE_VISIBLE = !!prefs.humanizeMouseVisible;
    TYPING_VISIBLE = !!prefs.humanizeTypingVisible;
    DEBUG = !!prefs.debug;
```

Replace with:

```ts
    MOUSE_VISIBLE = !!prefs.humanizeMouseVisible;
    TYPING_VISIBLE = !!prefs.humanizeTypingVisible;
    CLEAR_VISIBLE = !!prefs.humanizeClearVisible;
    DEBUG = !!prefs.debug;
```

Update the `storage.onChanged` listener (currently lines 27–39). Find:

```ts
    MOUSE_VISIBLE = !!next.humanizeMouseVisible;
    TYPING_VISIBLE = !!next.humanizeTypingVisible;
    DEBUG = !!next.debug;
```

Replace with:

```ts
    MOUSE_VISIBLE = !!next.humanizeMouseVisible;
    TYPING_VISIBLE = !!next.humanizeTypingVisible;
    CLEAR_VISIBLE = !!next.humanizeClearVisible;
    DEBUG = !!next.debug;
```

---

## F2 — `clearInput` refactor + new `clearInputVisible`

**File:** `src/content/scraping/humanBehavior.ts`

Replace the current `clearInput` function (currently around lines 401–420) entirely with the two functions below. Keep `clearInput` exported; `clearInputVisible` is private.

```ts
export async function clearInput(element: HTMLElement): Promise<void> {
  if (!element) return;

  if (CLEAR_VISIBLE && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    await clearInputVisible(element);
    return;
  }

  element.focus();

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

  element.focus();
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
```

---

## F3 — `humanSkimScroll`

**File:** `src/content/scraping/humanBehavior.ts`

Add this function immediately **above** the `ScrollToBottomOptions` interface (currently around line 461 — search for `export interface ScrollToBottomOptions`). It uses `delay` (private, already in scope) and `randomDelay` (exported, defined further down — function-declaration hoisting makes this safe; verify with `pnpm build`).

```ts
export async function humanSkimScroll(): Promise<void> {
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
```

---

## F4 — scrapingEngine imports

**File:** `src/content/scraping/scrapingEngine.ts`

Update the import block (currently lines 4–12). Find:

```ts
import {
  typeText,
  clearInput,
  pressEnter,
  naturalClick,
  randomDelay,
  scrollToBottom,
  selectOption,
} from './humanBehavior';
```

Replace with:

```ts
import {
  typeText,
  clearInput,
  pressEnter,
  naturalClick,
  randomDelay,
  scrollToBottom,
  selectOption,
  humanSkimScroll,
  smoothScrollToElement,
} from './humanBehavior';
```

---

## F5 — Whole-page skim before extraction

**File:** `src/content/scraping/scrapingEngine.ts`

In `scrapeWholePage` (currently around lines 779–817), insert the skim call as the **first** statement of the function body. Find:

```ts
async function scrapeWholePage(
  opts: ScrapeStep['options'],
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  if (opts.scrollToBottom) {
    onProgress?.('Scrolling to load all content...');
```

Replace with:

```ts
async function scrapeWholePage(
  opts: ScrapeStep['options'],
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  // Brief pre-scrape skim — humans glance over a page before extracting.
  // Skipped when scrollToBottom is on (it does its own paging) or afk is on.
  if (!opts.scrollToBottom && !afk) {
    await humanSkimScroll();
  }

  if (opts.scrollToBottom) {
    onProgress?.('Scrolling to load all content...');
```

(Keep the rest of `scrapeWholePage` identical.)

---

## F6 — Element scroll-into-view before extraction

**File:** `src/content/scraping/scrapingEngine.ts`

In `scrapeElement` (currently around lines 849–948), insert a `smoothScrollToElement` call immediately after `resolveWithRetry`. Find:

```ts
async function scrapeElement(
  elConfig: ScrapeElementConfig,
  onProgress: OnProgress,
  afk: boolean,
  paginationDelayMs?: number,
): Promise<unknown> {
  const el = await resolveWithRetry(elConfig.selector, null, onProgress, elConfig.name);

  if (elConfig.detectedType === 'chart') {
```

Replace with:

```ts
async function scrapeElement(
  elConfig: ScrapeElementConfig,
  onProgress: OnProgress,
  afk: boolean,
  paginationDelayMs?: number,
): Promise<unknown> {
  const el = await resolveWithRetry(elConfig.selector, null, onProgress, elConfig.name);

  // Bring the target into the viewport before extracting. smoothScrollToElement
  // early-returns if already visible. Not afk-gated — matches naturalClick.
  await smoothScrollToElement(el);

  if (elConfig.detectedType === 'chart') {
```

(Keep the rest of `scrapeElement` identical.)

---

## F7 — APISettingsView toggle (state + effect + handler + JSX)

**File:** `src/sidepanel/components/APISettingsView.tsx`

### State

After the existing `const [typingVisible, setTypingVisible] = useState(false);` (currently line 38), add:

```tsx
const [clearVisible, setClearVisible] = useState(false);
```

### Effect prefs-load

Inside the existing `useEffect`'s `getPrefs().then(...)` block (currently around lines 50–53). Find:

```tsx
  setDebugEnabled(!!prefs.debug);
  setMouseVisible(!!prefs.humanizeMouseVisible);
  setTypingVisible(!!prefs.humanizeTypingVisible);
```

Replace with:

```tsx
  setDebugEnabled(!!prefs.debug);
  setMouseVisible(!!prefs.humanizeMouseVisible);
  setTypingVisible(!!prefs.humanizeTypingVisible);
  setClearVisible(!!prefs.humanizeClearVisible);
```

### Handler

Add this function immediately after the existing `toggleTypingVisible` (currently ends at line 84):

```tsx
const toggleClearVisible = async (next: boolean) => {
  setClearVisible(next);
  try {
    await setPref('humanizeClearVisible', next);
  } catch {
    showToast("Couldn't save preference.", 'error');
    setClearVisible(!next);
  }
};
```

### JSX

Insert this block immediately after the existing typing-visible `</div>` (currently line 299), before the next sibling element:

```tsx
<div className="form-group">
  <label className="form-check">
    <input
      type="checkbox"
      checked={clearVisible}
      onChange={(e) => toggleClearVisible(e.target.checked)}
    />
    Humanize input clearing
  </label>
  <p className="form-hint">Selects the existing text and presses Delete instead of wiping the field instantly. Turn on if a site flags the snap-clear as automated.</p>
</div>
```

---

## Verification

### Automated

1. `pnpm test` — existing 187 tests stay green. No new unit tests required (DOM-heavy paths).
2. `pnpm lint` — clean (the pre-existing `background.ts` `'resp' is assigned but never used` warning may persist; baseline).
3. `pnpm build` — content + sidepanel bundles successful (catches the `humanSkimScroll` ↔ `randomDelay` hoisting check and the new sidepanel pref reference).

### Manual

1. **Pref off (default):** open API Settings, leave "Humanize input clearing" off. Run a setInput step on Wikipedia search. Field empties instantly, no perceptible select.
2. **Pref on:** enable the checkbox. Re-run. Expect: brief native selection highlight (input UA rendering), then the field empties. Set a `keydown` listener in DevTools on the input — confirm a `Delete` event fires with `keyCode: 46` and `code: 'Delete'`.
3. **Whole-page skim, scrollToBottom off:** run a whole-page scrape on a long page with `scrollToBottom` disabled. Expect 2–4 smooth scroll bursts before extraction, with reading pauses between them.
4. **Whole-page skim suppressed when scrollToBottom on:** same scrape with `scrollToBottom: true`. Expect only the existing scrollToBottom behavior — no extra skim before it.
5. **Whole-page skim suppressed when afk:** same scrape with afk on. No skim. (`scrollToBottom` still runs if enabled, since it's not afk-gated either.)
6. **Element scroll-into-view:** scrape an element below the fold (non-table, non-chart, plain text). Expect the page smooth-scrolls so the target sits ~1/3 down the viewport before extraction.
7. **Element scroll-into-view, table:** scrape a paginated table below the fold. Page scrolls to bring the table into view; subsequent virtual-scroll extraction inside the wrapper still works (wrapper has its own scrollTop, undisturbed by window scroll).
8. **Element scroll-into-view, chart:** scrape a chart below the fold. Chart is in viewport before `extractChartData` runs.
9. **Repeated clears (pref on):** run a config that types into the same input across multiple iterations. Iteration 2+ enters clear with a non-empty value — confirm humanized clear executes both times.
10. **Pref live update:** change the checkbox while a config is editable (no run in flight). Switch tabs to a content page and run. Behavior reflects the new pref state without reloading the extension.

---

## Edge case decisions

| Case | Decision |
|---|---|
| `clearInput` on contenteditable / non-input (current `executeSetInput` resolves to such an element) | Cover — `instanceof` check falls through to atomic path. |
| `clearInputVisible` on input where `.value` is already empty | Cover — early-return; no events, no Delete keystroke. |
| Site re-fills value during the ~80 ms select-pause | Ignore (v1) — far below the 1 s throttle gap that motivated the original sync clear. Revisit if reported. |
| `element.select()` throws on `<input type="number">` or other UA-restricted types | Cover — `try/catch`, continue to Delete path. |
| Whole-page skim on a non-scrollable page | Cover — `window.scrollTo` past `document.body.scrollHeight` is clamped by the browser; eased loop completes harmlessly. |
| Whole-page skim leaves user mid-page (extraction expects top) | Acceptable — `extractPageBlocks` reads from the DOM tree, not viewport. Intermediate scroll position is irrelevant to extraction output. |
| Element scroll-into-view on already-visible element | Cover — `smoothScrollToElement` early-returns when rect is fully in viewport (humanBehavior.ts:380). |
| Element scroll-into-view on virtual-scroll table | Cover — page-level scroll doesn't disturb wrapper-level virtual scroll position. `scrollAndCollectVirtualTable` operates on the wrapper independently. |
| `humanizeClearVisible` enabled but the resolved element is detached/disconnected | Cover — `element.select()` on a detached node is a no-op or throws; either way the try/catch + Delete path handles it. |

---

## Implementation order (suggested for Sonnet)

1. **F1** — flag + IIFE + listener (smallest, isolated). Verify build.
2. **F2** — `clearInput` refactor + `clearInputVisible`. Run test suite.
3. **F3** — `humanSkimScroll`. Build to confirm `randomDelay` hoisting.
4. **F4** — scrapingEngine imports.
5. **F5** — `scrapeWholePage` skim call.
6. **F6** — `scrapeElement` scroll-into-view.
7. **F7** — APISettingsView toggle (state + effect + handler + JSX) all in one pass.
8. After each step, run `pnpm test && pnpm lint && pnpm build`. Fix forward, do not amend earlier commits.
9. Manual smoke per the 10 cases above.
10. Copy this spec to `blueberry-v3/specs/SPEC-humanized-clear-and-skim-v1.0.md` per CLAUDE.md.

---

## Out of scope (explicitly deferred)

- Backspace-per-char clearing (timer-throttling risk, length-dependent latency).
- Triple-click select-all visualization (more event surface than `element.select()` for marginal visual gain in input rendering).
- Pre-scrape skim when `scrollToBottom` is on (already scrolling).
- afk gate on element scroll-into-view (matches `naturalClick` semantics — only mouse motion is afk-skipped).
- Unit tests for new helpers (DOM-heavy; manual checks cover the value).

If any of these become motivated by future detection failures or user reports, file v1.1.
