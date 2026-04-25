# SPEC — pressEnter defect fix (v1.0)

> Stage F implementation spec for sub-problem A.1 of the staged plan at `~/.claude/plans/in-specs-there-is-mossy-pelican.md`. Stages A–E confirmed; this is Stage F. Implementer should follow exactly; deviations need plan owner approval.

---

## Context

`SetInputOptions.pressEnterAfter` is exposed on every `setInput` step ([config.ts:35](../src/types/config.ts#L35)) and surfaced as a checkbox in [SetInputForm.tsx:96-97](../src/sidepanel/components/SetInputForm.tsx#L96-L97), but the user has never observed an actual form submission when the option is enabled. Three defects in [pressEnter at humanBehavior.ts:176-186](../src/content/scraping/humanBehavior.ts#L176-L186) cause this:

1. **Wrong keyboard event order.** Current sequence is `keydown → 50ms → keyup → keypress`; the browser's order is `keydown → keypress → keyup`.
2. **Cosmetic submit dispatch.** `form.dispatchEvent(new Event('submit', ...))` runs submit listeners but does **not** actually submit the form. The canonical API is `form.requestSubmit()`.
3. **Redundant inner delay.** `pressEnter` opens with a 150–350 ms `delay`, but the only caller ([executeSetInput at scrapingEngine.ts:349-352](../src/content/scraping/scrapingEngine.ts#L349-L352)) already runs `randomDelay(100, 300)` immediately before invoking `pressEnter`. The inner delay is dead weight.

This spec rewrites `pressEnter` to fix all three, drops `keypress` (matching the existing `typeText` convention of `keydown → keyup` only, per Stage B decision in the plan), and removes a dead `pressEnterAfter` branch from `typeText` whose only legitimate invocation is the engine's separate, direct `pressEnter` call.

---

## File 1 (MODIFIED): `src/content/scraping/humanBehavior.ts`

### Change 1 — Remove dead `pressEnterAfter` option from `typeText`

Locate the function signature at line 129. Replace lines 129–151 (the entire `typeText` function) with:

```ts
export async function typeText(
  element: HTMLElement,
  text: string,
  opts: { clearBefore?: boolean } = {},
): Promise<void> {
  if (opts.clearBefore) {
    await clearInput(element);
  }

  for (const char of text) {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value += char;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await delay(40 + Math.random() * 80);
  }
}
```

**Removed:**
- `pressEnterAfter?: boolean` from the `opts` type.
- The trailing `if (opts.pressEnterAfter) { await pressEnter(element); }` block (lines 148–150 in the original).

**Reason.** The only caller is [executeSetInput at scrapingEngine.ts:347](../src/content/scraping/scrapingEngine.ts#L347): `await typeText(el, searchTerm ?? '');` — it never passes an `opts` object. The engine performs its own `pressEnter` call with its own pre/post timing at [scrapingEngine.ts:349-352](../src/content/scraping/scrapingEngine.ts#L349-L352); the `typeText`-internal path was never reachable.

### Change 2 — Rewrite `pressEnter`

Locate the function at line 176. Replace lines 176–186 (the entire `pressEnter` function) with:

```ts
export async function pressEnter(element: HTMLElement): Promise<void> {
  if (!element) return;

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
```

**Changes vs. original:**
- Removed the leading `await delay(150 + Math.random() * 200)` — the caller already throttles ([scrapingEngine.ts:350](../src/content/scraping/scrapingEngine.ts#L350)).
- Reordered events: now `keydown → delay → keyup`. Removed `keypress` entirely (deprecated for non-printable keys; matches `typeText`'s `keydown → keyup` convention).
- Inter-event delay tuned to `40 + Math.random() * 60` (40–100 ms) to match the click-mousedown/mouseup gap at [humanBehavior.ts:124](../src/content/scraping/humanBehavior.ts#L124).
- `KeyboardEventInit` typed explicitly; added `which: 13` (some legacy/jQuery code reads `event.which`); added `cancelable: true` so listeners can `preventDefault`.
- `form.dispatchEvent(new Event('submit', ...))` replaced with `form.requestSubmit()`. This actually submits the form, runs submit listeners, and respects `event.preventDefault()` if the listener cancels — i.e. it does what the user means by "press Enter."

### Function order after changes

Order in the file is preserved: `moveMouseToElement`, `fittsMousePath`, `easeInOutFitts`, `cubicBezier`, `gaussianNoise`, `delay`, `naturalClick`, `typeText`, `clearInput`, `pressEnter`, `smoothScrollToElement` (and any below).

### Verify nothing else broke

After the edits, run from the repo root:

```bash
grep -n "pressEnterAfter" src/content/scraping/humanBehavior.ts
```

Expected output: **zero matches**. The `pressEnterAfter` symbol should remain only in `src/types/config.ts`, `src/sidepanel/components/SetInputForm.tsx`, `src/sidepanel/stores/configStore.ts`, `src/sidepanel/utils/storage.ts`, and `src/content/scraping/scrapingEngine.ts` (the option, the UI checkbox, the defaults, and the engine that consumes the option to call `pressEnter`).

```bash
grep -n "dispatchEvent(new Event('submit'" src/
```

Expected output: **zero matches**. The cosmetic submit dispatch is gone; nothing else should be relying on that pattern.

---

## No changes outside `humanBehavior.ts`

The following are deliberately not touched:
- [src/content/scraping/scrapingEngine.ts:349-352](../src/content/scraping/scrapingEngine.ts#L349-L352) — caller; signature of `pressEnter` unchanged.
- [src/sidepanel/components/SetInputForm.tsx](../src/sidepanel/components/SetInputForm.tsx) — UI checkbox copy "Press Enter when done" remains accurate.
- [src/types/config.ts](../src/types/config.ts) — `SetInputOptions.pressEnterAfter` shape unchanged.
- [src/sidepanel/stores/configStore.ts](../src/sidepanel/stores/configStore.ts), [src/sidepanel/utils/storage.ts](../src/sidepanel/utils/storage.ts) — defaults unchanged.

---

## Verification

### Automated

Run from the repo root:

```bash
npm run lint
npm run type-check
npm run build
```

All must pass with zero new errors.

No new unit tests. Rationale: `pressEnter` dispatches DOM events on a real element and calls `form.requestSubmit()`. JSDOM's submit/form behaviour does not faithfully simulate the browser's submit pipeline, and the function has zero pure logic worth unit-testing in isolation.

### Manual

1. **Vanilla form site.** Save a `setInput` step against a search input on a site with a real `<form>` (Wikipedia search, DuckDuckGo). Set `pressEnterAfter: true`. Run with any search term. **Expected:** the page navigates to search results — actual submission, not just text typed.

2. **SPA without `<form>`.** Same setup but on a React-style search input that has no form ancestor (e.g. a SPA where Enter is handled via `onKeyDown`). **Expected:** the keydown listener fires and the page transitions. (Open DevTools' Event Listener Breakpoints → "keydown" before running to verify the listener is hit.)

3. **Listener cancels submit.** Find a site whose form submit listener calls `event.preventDefault()` and replaces submission with a fetch. **Expected:** the page does **not** navigate (the listener wins). This proves `requestSubmit` is correctly running listeners, not bypassing them via `form.submit()`.

4. **Toggle off.** Same step with `pressEnterAfter: false`. **Expected:** no Enter sequence dispatched; the existing 600–1200 ms idle wait at [scrapingEngine.ts:354](../src/content/scraping/scrapingEngine.ts#L354) runs. Page should not submit.

### Edge cases (covered by design — no extra steps required)

- **Form has multiple submit buttons.** `requestSubmit()` picks the first; matches native Enter behaviour.
- **Form has `novalidate` attribute.** `requestSubmit()` honours it; no validation runs.
- **Input is detached from DOM at moment of dispatch.** Events go nowhere; matches current behaviour, no regression.
- **Input is not inside a `<form>`.** Only keyboard events fire, no submit signal — same coverage as before this fix.

---

## Out of scope (do not add in v1)

- PointerEvent / focus / blur fidelity work (FUTURE-spec section C, anti-detection).
- Direct `form.submit()` fallback when `requestSubmit` would have been cancelled by a listener — that would defeat the listener's authority and is the opposite of what users mean by "press Enter".
- Re-introducing `keypress` events. Deprecated for non-printable keys; matches `typeText`'s convention.
- Configurable Enter-press timing parameters.

---

## Rollback

If a regression is found post-merge, revert with:

```bash
git revert <commit-sha>
```

The change is self-contained in one file. No data migration was performed; existing saved configs are untouched.
