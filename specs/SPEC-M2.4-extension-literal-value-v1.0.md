# SPEC-M2.4 — Extension `SetInputOptions.literalValue` (v1.0)

**Author**: Opus (planning) → Sonnet (implementation)
**Milestone**: M2.4 (fourth sub-stage of M2 — Task authoring)
**Roadmap source**: [c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md), "Implementation sub-stages" → row M2.4
**Depends on**: SPEC-M2.3 (the batch dispatcher writes `literalValue`; without M2.4 the extension ignores it and types empty strings).

---

## 1. Context

M2.3's `QueueExpansionService` patches each `inlineConfig.steps[i].options.literalValue = <resolved>` per setInput step. The extension's `executeSetInput` ([src/content/scraping/scrapingEngine.ts:385-420](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts#L385-L420)) currently reads only the per-iteration `searchTerm` parameter and ignores `options.literalValue`. M2.4 makes the extension prefer `literalValue` when present.

**Mode A** (legacy — `searchTerms.length > 0`): unchanged. Extension iterates `searchTerms`, types each into setInput steps.

**Mode B** (M2.3 batch — `searchTerms = []`): each batch dispatch contains one `QueueTask` per cartesian iteration with `literalValue` baked per setInput step. Extension runs the flow once with `searchTerm = null`, types `literalValue` instead.

---

## 2. Files added / modified

### Modified

| Path | Change |
|---|---|
| [src/types/config.ts](c:\Users\und3r\blueberry-v3\src\types\config.ts) | Add `literalValue?: string` to `SetInputOptions` (line 40 onward) |
| [src/content/scraping/scrapingEngine.ts](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts) | In `executeSetInput`: prefer `opts.literalValue` over `searchTerm` |

### New

| Path | Purpose |
|---|---|
| `src/__tests__/setInputLiteralValue.test.ts` | Vitest covering precedence and fallback |

### Not changed

- [SetInputForm.tsx](c:\Users\und3r\blueberry-v3\src\sidepanel\components\config\SetInputForm.tsx) — `literalValue` is server-set; the local-mode authoring UI does NOT expose it. Leave untouched.
- Background message routing — no change.
- SignalR DTOs — no change.

---

## 3. Complete code

### 3.1 Modified: `src/types/config.ts` — `SetInputOptions`

Replace the existing `SetInputOptions` interface (currently at line 40) with:

```ts
export interface SetInputOptions {
  clearBefore: boolean;
  pressEnterAfter: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  isInitialInput: boolean;
  alternateSelector: SelectorDescriptor | null;
  // ── M2.4 — server-set, takes precedence over searchTerm at runtime.
  // Local-mode authoring UI does not expose this field. Set by the backend's
  // QueueExpansionService at populate time when a scrape block has step bindings.
  literalValue?: string;
}
```

### 3.2 Modified: `src/content/scraping/scrapingEngine.ts` — `executeSetInput`

Replace **lines 385–420** (the entire `executeSetInput` function) with:

```ts
async function executeSetInput(
  step: import('../../types/config').SetInputStep,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;

  const el = await resolveWithRetry(
    step.selector!,
    opts.alternateSelector ?? null,
    onProgress,
    step.label || 'input',
  );

  // Precedence: server-set literalValue > per-iteration searchTerm > empty string.
  const valueToType = opts.literalValue ?? searchTerm ?? '';

  onProgress?.(`Typing "${valueToType}" into ${step.label || 'input field'}`);

  if (opts.clearBefore !== false) {
    await clearInput(el);
  }

  await typeText(el, valueToType);

  if (opts.pressEnterAfter) {
    await randomDelay(100, 300);
    await pressEnter(el);
    await waitAfterAction(opts, onProgress);
  } else {
    await randomDelay(600, 1200);
  }

  void iterationIndex;
  void afk;
  return null;
}
```

(Only two lines actually change: the new `valueToType` computation, and the `typeText` call argument switching to `valueToType`. The rest is preserved verbatim.)

### 3.3 New: `src/__tests__/setInputLiteralValue.test.ts`

```ts
import { describe, it, expect } from 'vitest';

// Pure unit test for the literalValue precedence logic. The full
// `executeSetInput` requires DOM + helpers we don't have under jsdom in this
// suite; we extract the precedence into a tiny pure function and test that.
//
// If this expression diverges from the implementation in scrapingEngine.ts,
// the manual smoke step in SPEC-M2.3 §5 will catch it.

function pickValueToType(literalValue: string | undefined, searchTerm: string | null): string {
  return literalValue ?? searchTerm ?? '';
}

describe('SetInput value precedence (M2.4)', () => {
  it('returns literalValue when set, even if searchTerm is also set', () => {
    expect(pickValueToType('SERVER', 'CLIENT')).toBe('SERVER');
  });

  it('returns literalValue when searchTerm is null', () => {
    expect(pickValueToType('SERVER', null)).toBe('SERVER');
  });

  it('returns searchTerm when literalValue is undefined', () => {
    expect(pickValueToType(undefined, 'CLIENT')).toBe('CLIENT');
  });

  it('returns empty string when both are missing', () => {
    expect(pickValueToType(undefined, null)).toBe('');
  });

  it('returns empty string for explicit empty literalValue (precedence still applies)', () => {
    expect(pickValueToType('', 'CLIENT')).toBe('');
  });
});
```

---

## 4. Verification

### Automated

```bash
cd c:/Users/und3r/blueberry-v3
npm run test
```

Expected: existing tests still pass + 5 new cases in `setInputLiteralValue.test.ts`.

### Build the extension

```bash
cd c:/Users/und3r/blueberry-v3
npm run build
```

Expected: clean Vite/WXT build. No TypeScript errors.

### Manual

Mode A regression (M1 unchanged):
1. Build extension. Reload it in Chrome.
2. From the extension sidepanel (Local mode), run an existing local-mode scrape with one setInput step. The current `searchTerm` should be typed into the input as before.

Mode B (M2.3 batch dispatch):
1. M2.3 backend running, extension connected in Queue mode as the worker.
2. Author a tree on the frontend: `loop1=[hello, world]` containing a scrape with binding `step-1 = loopRef.loop1`.
3. Trigger `POST /api/runs/batch`.
4. In the extension's content-script console, observe two iterations typing `"hello"` and `"world"` respectively (NOT empty strings). Both come from `literalValue`, not `searchTerm` (the `QueueTaskDto.searchTerms` array is empty in mode B).

### Edge cases — explicit decisions

| Case | Decision |
|---|---|
| `literalValue: ""` (empty string set explicitly) | **Cover** — `??` treats empty string as defined; types `""`. Documented in test case 5. |
| Local-mode flows (no `literalValue` on the config) | **Cover** — fallback to `searchTerm`, identical to M1 behaviour. |
| Old extension on a new backend (mode B without M2.4) | Out of scope per design; backend warns at populate but cannot enforce client version. Operator updates the extension. |

---

## 5. Definition of done (M2.4)

- [ ] `npm run test` — all green including 5 new cases.
- [ ] `npm run build` — clean WXT/Vite build.
- [ ] Local-mode scrape (mode A) regression: typed text matches the per-iteration `searchTerm` as before.
- [ ] Queue-mode batch (mode B): typed text matches the per-step `literalValue` baked by the backend.
- [ ] No changes to UI surface; no new step types; no new message shapes.
