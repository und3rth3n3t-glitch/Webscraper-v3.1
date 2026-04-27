# SPEC-human-anti-ban-v1.1

## Context

v1.0 shipped visible cursor, adaptive scroll, configurable pacing, opt-in per-char typing. Live testing on Wikipedia (post-v1.0) revealed and motivated this v1.1 round of small wins focused on tighter human-likeness:

1. **typeText** auto-focuses without any mouse motion — looks robotic, and on the first step of a flow there's no prior cursor activity at all.
2. Each `moveMouseToElement` call picks a brand-new random origin — mouse "teleports" between actions. Real users have a continuous cursor trail.
3. `naturalClick` with no scroll-aware behavior — if the element is offscreen, dispatched mousedown coords are negative or beyond viewport (objectively wrong even when click handler still fires).
4. Click coords are dead-center (`rect.left + width/2`); the move target was randomly placed at 30–70 % of the rect, so click ≠ where the mouse arrived. Easy fingerprint.
5. No pre-click hover dwell — mouseup fires immediately after move ends. Real humans hover briefly.
6. KeyboardEvent init includes only `key` — `code`/`keyCode`/`which` are absent. Some bot detectors check for the missing fields.
7. Inter-character delay is uniform — humans pause noticeably between words.
8. Right after a navigation completes, the next step fires immediately. Real users blink at the new page.
9. Per-session timing is too regular — adding occasional "thinking" pauses raises the noise floor against timing-pattern analysis.

**Already done in this branch (not in this spec):** the `typeTextVisible` element-rebind fix. Wikipedia's Codex search swaps the `<input>` element on first input; v1.1 was authored against the post-rebind code.

Outcome: continuous mouse trail, scroll-then-click, click-where-mouse-arrived, hover dwell, full keyboard event init, inter-word pacing, post-nav settle, occasional think pauses, and move+click before typing.

---

## Decisions (locked)

| Decision | Choice |
|---|---|
| Toggle scope | All v1.1 features always-on (no new prefs). They harden existing pathways; consistent with v1.0's "anti-ban mouse path always on" rule. |
| Mouse memory scope | Module-level `lastMousePos` in `humanBehavior.ts`. Reset to `null` on `pagehide`. |
| Scroll trigger | `naturalClick` calls `smoothScrollToElement(element)` before mouse move (the existing helper early-returns if already in viewport, so the call is free when not needed). |
| Click-coords fuzz | 30–70 % of rect, computed once per click. Mouse move and click event use the **same** fuzzed point, not center. |
| Hover dwell | 80–200 ms between move-end and mousedown. |
| Inter-word delay | After a space character, the next char's pre-delay is 180–450 ms instead of the standard 40–120 ms. |
| Keyboard event init | Helper `keyboardEventInit(ch)` returns `{ key, code, keyCode, which, bubbles, cancelable }` with mapped values. |
| Post-nav settle | 300–800 ms `randomDelay` in `executeFlow` after a navigating step completes, **only if** `window.location.href` changed during the step. |
| Thinking pause | 2 % per step, 1000–3000 ms `randomDelay` at the start of each loop step in `executeFlow`. |
| typeText pre-typing motion | Move + naturalClick before focus, but only when the element is visually clickable (`rect.width > 0 && rect.height > 0`). Otherwise fall back to bare `.focus()` (current behavior). |

---

## Files to modify

| File | Change |
|---|---|
| [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) | `lastMousePos` memory + reset; `MousePathOptions.target?: Point`; `naturalClick` scroll-into-view + shared target + hover dwell; `keyboardEventInit` helper; `typeText` move+click; inter-word delay in both `typeTextVisible` and atomic-path keystroke loop. |
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | Post-nav settle in `executeFlow` step loop; thinking pause at top of step loop. |
| **NEW** [src/content/scraping/humanBehaviorAntiBan.test.ts](src/content/scraping/humanBehaviorAntiBan.test.ts) | Vitest tests for `keyboardEventInit` mapping. |

No backend / DB / migration / permission / UI changes.

---

## F1 — Mouse position memory

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts)

Add module-level state directly **after** the existing `let DEBUG = false;` declaration (currently around line 9 in the post-rebind file — search for the prefs block):

```ts
let lastMousePos: Point | null = null;

try {
  window.addEventListener('pagehide', () => { lastMousePos = null; });
} catch { /* SSR / no-window contexts */ }
```

Update `moveMouseToElement` (currently lines 44–63) to support a target override AND record the last position:

```ts
interface MousePathOptions {
  afk?: boolean;
  durationMs?: number;
  target?: Point;            // NEW: caller can pre-compute the target so click coords match
}

export async function moveMouseToElement(
  element: HTMLElement,
  opts: MousePathOptions = {},
): Promise<Point | null> {            // NEW: returns the final position (for caller convenience)
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
```

**Why record `target` and not the post-correction jittered coords:** the corrections are sub-pixel jitter; `target` is close enough to where the cursor logically rests, and using it keeps subsequent movements deterministically continuous from a known point.

---

## F2 — Scroll into view + shared click point + hover dwell in `naturalClick`

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — replace `naturalClick` (currently lines 183–210) entirely:

```ts
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

  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  await delay(40 + Math.random() * 60);
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  pulseCursor();
  element.dispatchEvent(new MouseEvent('click', eventInit));
}
```

**Forward-declaration note:** `smoothScrollToElement` is declared further down the file. JavaScript function-declaration hoisting makes this safe at call time; verify with `pnpm build`.

---

## F3 — `keyboardEventInit` helper + use in typing

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — add this helper just **above** `typeText` (currently around line 211):

```ts
function keyboardEventInit(ch: string): KeyboardEventInit {
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
```

---

## F4 — `typeText` move+click + inter-word delay (atomic path)

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — replace the body of `typeText` (currently lines 212–249) with:

```ts
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

  // ── existing atomic-commit path (mostly unchanged) ──
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

  // Per-char keystrokes (cosmetic — value already committed). Use full
  // keyboard event init and inter-word pause for consistency with the
  // visible path and against detectors that compare key-event fields.
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
```

---

## F5 — `typeTextVisible` inter-word delay + full keyboard event init

**File:** [src/content/scraping/humanBehavior.ts](src/content/scraping/humanBehavior.ts) — inside the existing `typeTextVisible` per-char loop (post-rebind code, currently around lines 287–311), find:

```ts
const ch = text[i];
const valueBeforeSet = element.value;
typedSoFar += ch;
if (setter) setter.call(element, typedSoFar); else (element as HTMLInputElement).value = typedSoFar;
const valueAfterSet = element.value;

element.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
element.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
await delay(40 + Math.random() * 80);
const valueAfterDispatch = element.value;
element.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
```

Replace with:

```ts
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
```

Also update the atomic-fallback `keydown` dispatch in the same function (the missedFocus ≥ 3 branch — search for `'[typeTextVisible] FALLBACK atomic'`) — this branch only dispatches `input` + `change`, **no keydown/keyup**, so no change is needed there.

---

## F6 — Post-navigation settle in `executeFlow`

**File:** [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts)

In the step loop body (currently around lines 174–237), capture the URL before `executeStep` and add a settle delay after navigating steps that actually navigated.

Locate this block (around line 198):

```ts
let stepData: Record<string, unknown> | null = null;
try {
  stepData = await executeStep(
    step,
    term,
    i,
    (msg) => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId }),
    afk,
    taskId,
  );
```

Replace with:

```ts
let stepData: Record<string, unknown> | null = null;
const urlBeforeStep = window.location.href;
try {
  stepData = await executeStep(
    step,
    term,
    i,
    (msg) => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId }),
    afk,
    taskId,
  );

  // Post-navigation settle: real users glance at the new page before acting.
  // Only fires when the step was a navigating type AND the URL actually changed.
  if (isNavigating && window.location.href !== urlBeforeStep) {
    await randomDelay(300, 800);
  }
```

(Keep the rest of the try/finally identical.)

---

## F7 — Thinking pause at top of step loop

**File:** [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts)

At the very top of the step loop body (currently around line 174 — the line `for (let si = siStart; si < loopSteps.length; si++) {`), insert immediately after `checkAbort();` and before `const step = loopSteps[si];`:

```ts
// Occasional "thinking" pause: 2 % of steps get a 1–3 s pre-delay to
// raise the noise floor against per-session timing-pattern analysis.
if (Math.random() < 0.02) {
  await randomDelay(1000, 3000);
}
```

`randomDelay` is already imported from `./humanBehavior` at the top of the file. No new import needed.

---

## F8 — Tests

**NEW file:** [src/content/scraping/humanBehaviorAntiBan.test.ts](src/content/scraping/humanBehaviorAntiBan.test.ts):

```ts
import { describe, it, expect } from 'vitest';

// keyboardEventInit is module-private. Re-export it for tests by appending
// the export below as part of F3 if not already exported, OR have F3 add:
//   export function keyboardEventInit(ch: string): KeyboardEventInit { ... }
// (The implementer should choose one. Default: export it.)
import { keyboardEventInit } from './humanBehavior';

describe('keyboardEventInit', () => {
  it('maps lowercase letters to KeyX with uppercase keyCode', () => {
    const init = keyboardEventInit('a');
    expect(init.key).toBe('a');
    expect(init.code).toBe('KeyA');
    expect(init.keyCode).toBe(65);
    expect(init.which).toBe(65);
  });

  it('maps uppercase letters consistently', () => {
    expect(keyboardEventInit('Z').code).toBe('KeyZ');
    expect(keyboardEventInit('Z').keyCode).toBe(90);
  });

  it('maps digits to DigitN', () => {
    expect(keyboardEventInit('0').code).toBe('Digit0');
    expect(keyboardEventInit('9').code).toBe('Digit9');
    expect(keyboardEventInit('5').keyCode).toBe(53);
  });

  it('maps space to Space/32', () => {
    expect(keyboardEventInit(' ').code).toBe('Space');
    expect(keyboardEventInit(' ').keyCode).toBe(32);
  });

  it('leaves code undefined for symbols but still sets keyCode', () => {
    const init = keyboardEventInit('-');
    expect(init.code).toBeUndefined();
    expect(init.keyCode).toBe('-'.charCodeAt(0));
  });

  it('always sets bubbles and cancelable', () => {
    const init = keyboardEventInit('x');
    expect(init.bubbles).toBe(true);
    expect(init.cancelable).toBe(true);
  });
});
```

**Implementer action for F3:** export `keyboardEventInit` (change `function keyboardEventInit` → `export function keyboardEventInit`). The other helpers (`isVisuallyClickable`) stay private.

---

## Verification

### Automated
1. `pnpm test` — new `humanBehaviorAntiBan.test.ts` plus existing suite green.
2. `pnpm lint` — clean (no new warnings vs baseline; the pre-existing `background.ts` warning may persist).
3. `pnpm build` — content + sidepanel bundles successful (catches forward-declaration / hoisting issues in F2).

### Manual
1. **Mouse memory:** enable visible cursor in API Settings → run any flow with ≥ 2 click steps → confirm the purple dot moves continuously between targets, never teleporting from a fresh random origin (except on the very first action of a tab).
2. **Scroll-into-view:** run a scrape on a long page where pagination is below the fold → click step → cursor should scroll the page so the button is visible *before* the move begins.
3. **Click-where-mouse-arrived:** with visible cursor on, observe pulse position vs button center — pulses should land within 30–70 % of the button rect, not always at center.
4. **Hover dwell:** with visible cursor on, click a button — there should be a perceptible 100 ms-ish stillness between arrival and the pulse.
5. **Move+click before typing:** Wikipedia search with visible cursor on → setInput step → cursor moves to search box and pulses *before* the first character appears. Compare against the `setInput` log: previously typing started immediately on focus; now there's a click step first.
6. **Inter-word pause:** type a 2-word search term ("New York") → observe a longer pause between "w " and "Y" than between "N" and "e".
7. **Keyboard event init:** in DevTools, set a breakpoint on the input's keydown handler (or `addEventListener('keydown', e => console.log(e.code, e.keyCode))` on the search box) → confirm `code` and `keyCode` are populated, not undefined/0.
8. **Post-nav settle:** any flow with a navigation step → the next step starts ~500 ms later than before (visible in the `[executeFlow] step START` timestamps with debug on).
9. **Thinking pause:** run a flow with ≥ 50 steps → expect roughly 1 long pause; verify nothing breaks in the longest-running iteration.

---

## Edge case decisions

| Case | Decision |
|---|---|
| `typeText` element has zero-area rect (popover not yet open, `display:none` ancestor) | Cover — `isVisuallyClickable` falls back to bare `.focus()`. |
| `naturalClick` on element with `getBoundingClientRect()` returning all zeros | Cover — `smoothScrollToElement` early-returns; `moveMouseToElement` proceeds with target at (0,0); click dispatches at (0,0). Same as today; no regression. |
| Element scrolled offscreen so far that `smoothScrollToElement` can't bring it into view (sticky-positioned overlays) | Ignore (v1.1) — rely on existing fallback; click coords may be slightly off. Revisit if reported. |
| `lastMousePos` stale across tab navigation | Cover — `pagehide` listener resets it. Worst case: one teleport per nav. |
| `lastMousePos` on iframe boundary | Ignore (v1.1) — each frame has its own module instance, so coords don't cross frames. Cosmetic only. |
| Thinking pause hits during a time-sensitive step (e.g. autocomplete dropdown will dismiss after N ms) | Ignore (v1.1) — 2 % rate × 50 steps × low-likelihood collision is acceptable noise. If reported, lower the rate or gate by step type. |
| Post-nav settle on a step that navigated away then back to same URL | Edge — URL string equality means we'd skip the settle. Acceptable: round-trip nav is rare; settle is best-effort. |
| `keyboardEventInit` called with empty string | Cover — `''.charCodeAt(0)` is `NaN`; treat as no-op. Caller is expected to pass single chars; empty strings shouldn't reach here from `typeText` since the for-loop skips them. |
| User holds existing typing-visible toggle ON during this rollout | Cover — `typeTextVisible` is the only place that calls `keyboardEventInit` for visible typing; both paths get the upgrade. |
| Pre-click hover dwell on a button that auto-dismisses on hover (tooltips, etc.) | Ignore (v1.1) — 80–200 ms is well under any tooltip delay; not a realistic conflict. |

---

## Sonnet implementation order (suggested)

1. **F1** (mouse memory) — sets up `lastMousePos` + `MousePathOptions.target` foundation that F2 needs.
2. **F2** (naturalClick rewrite) — depends on F1's `target` option and updated `moveMouseToElement` signature.
3. **F3** (helpers) — pure additions, no dependencies. Export `keyboardEventInit` (F8 imports it).
4. **F4** (typeText changes) — depends on F2 (`naturalClick`) and F3 (`keyboardEventInit`, `isVisuallyClickable`).
5. **F5** (typeTextVisible changes) — depends on F3 (`keyboardEventInit`).
6. **F8** (tests) — alongside F3.
7. **F6** (post-nav settle) — independent.
8. **F7** (thinking pause) — independent.

After each step, run `pnpm test && pnpm lint && pnpm build`. If anything breaks, do **not** amend earlier commits — fix forward (per CLAUDE.md).

---

## Out of scope (explicitly skipped — confirmed with user)

- **Backspace / typo simulation.** Risk of submitting wrong text outweighs realism win.
- **Mouse drift during idle waits.** No known detector looks for stillness; complexity not justified.
- **Occasional scroll-direction reversal in `scrollToBottom`.** Hard to do without breaking pagination/extraction logic that depends on monotonic scroll position.

If any of these become motivated by future detection failures, file a v1.2.
