# FUTURE: V3 Resilience & UX Improvements

**Status:** Parked. Not scheduled.

**Purpose:** Capture design decisions reached during exploratory planning (2026-04-24) so we don't re-litigate them when work resumes. Each section below has an agreed problem statement and a proposed approach. None of this is implemented; nothing in the current codebase references these ideas.

---

## A. Priority-ordered fallback selectors + sticky flow index

**Problem.** Today each step has exactly one selector. Flows that can legitimately start from more than one page state (e.g. Wikipedia search: home page vs. search-results page vs. article page) can't express "this element might be here, or here, or there." The current `subsequentSelector` on `setInput` is a narrow workaround — it only applies on iteration 2+ of the same step, only to input fields, and does nothing for `click` / `bestMatch` / other step types.

**Agreed design.**

- Every step's primary action selector becomes an ordered list of selectors, not a single descriptor. List length 1 is the normal case.
- A flow run maintains a single `flowIndex`, starting at 0.
- When any step resolves at selector index N, `flowIndex` is set to N (sticky). It never decreases within a run.
- Steps that have only one selector ignore `flowIndex` entirely — always use index 0. This is the "this element is always in the same place" case and must not be affected by the flow having fallen back elsewhere.
- Steps with multiple selectors start searching at the current `flowIndex`; if not found, fall back to indices N+1, N+2, etc. Never up.
- `subsequentSelector` is deleted. It's a strictly less general version of the same idea.

**Why sticky:**

- Avoids the "search falls back to index 1 → click picks index 0 somewhere unrelated → flow breaks" problem.
- Avoids requiring the user to define explicit "page states" (which the engine couldn't reliably detect anyway).

**Why single-selector steps ignore the index:**

- Without this, falling back anywhere in the flow would make every other step try to resolve at index 1+ of a list it doesn't have, and the flow would fail pointlessly.
- With this, the user only defines alternatives on the steps that actually differ across page states.

**Decisions still to make before implementation:**

- Does the array treatment apply to the primary action selector only (e.g. `SetInputStep.selector`, `ClickStep.selector`, `BestMatchStep.containerSelector`), or to secondary fields too (`waitForSelector`, `ClickOptions.waitForSelector`)? Prior discussion implied primary-only. Not locked.
- Does `flowIndex` reset between iterations of the same flow, or persist across terms? Intuition says reset per-term (each search is a fresh attempt at the page state), but this wasn't explicitly decided.

**Scope impact:**

- Type changes: `selector: SelectorDescriptor | null` → `selectors: SelectorDescriptor[]` on every step that gets the treatment.
- Engine: new `resolveWithFallbacks()` wrapper; `flowIndex` threaded through `executeFlow` → `executeStep`.
- UI: every affected step-editor form needs add / reorder / delete UI for the selector list.
- Storage migration: existing saved configs carry single descriptors; bump schema version and map `selector → [selector]` on load.

---

## B. Step conditions ("only run if")

**Problem.** Some flows legitimately branch. Wikipedia is the canonical example: `bestMatch` is needed on a disambiguation page, but must not run if the search landed directly on an article. Today the user has no way to express "run this step only if this element exists" or "skip this step if the URL matches X."

**Agreed minimal v1.**

- Each step gains an optional `condition` field. Shape:
  - Type: *element present* or *URL matches pattern* (regex or glob — pick one at design time).
  - Evaluation: before the step runs.
  - On fail: skip step, continue to the next step in the flow. No inter-step state. No "else" branch.
- This is enough for Wikipedia: put a condition on `bestMatch` requiring the disambiguation container be present. On an article page → condition fails → `bestMatch` skipped → `scrape` runs on the article page directly.

**Deferred (explicitly out of scope for v1):**

- "If previous step was skipped, do X" — that's full branching, DAG not linear flow. Not now.
- Compound conditions (AND / OR of multiple predicates). One condition per step is enough.

**Scope impact:**

- `BaseStep` gains `condition?: StepCondition | null`.
- Engine: condition check before dispatching each step.
- UI: small editor in every step form, or a shared `<StepConditionEditor>` component.

**Relation to section A:** Independent. Can ship in either order.

---

## C. Visible cursor overlay

**Status.** Not a security / anti-detection feature. Safe to defer.

**Why it doesn't matter for bot detection.** Bot-detection scripts run in the page's JS context. They observe the `MouseEvent` sequence — and V3 already produces a realistic one: Fitts-style cubic Bezier path ([humanBehavior.ts:29-75](../src/content/scraping/humanBehavior.ts)), Gaussian noise on every sample, correction sub-movements near target, full `mousemove → mousedown → mouseup → click` with matching `clientX/clientY`. They **cannot** observe whether the OS cursor actually moved — the OS cursor position is not exposed to page JS beyond what the events themselves report.

**What a visible cursor would actually be: a UX / transparency feature.** Letting the user watch the bot work. Useful for debugging, demos, and reassuring end users. Not stealth.

**Unfixable weakness in any extension-based click simulation.** `event.isTrusted === false` on synthetic events is a browser-level guarantee. No amount of visible-cursor work changes that.

**Higher-impact anti-detection work, if ever needed.** In rough priority order:

1. Dispatch `PointerEvent`s alongside `MouseEvent`s. Modern detection looks at pointer events.
2. Fuller keyboard event sequence on typing: `keydown → keypress → input → keyup` with per-key timing variance. Verify V3's `typeText` actually does this.
3. Focus / blur patterns on inputs (click should produce focus; tabbing away should produce blur).

**Design sketch for the visible overlay itself, when we do build it:**

- Small absolutely-positioned `<div>` (size ~20×20px, high z-index, `pointer-events: none`, unique non-obvious class name).
- Injected by content script on first `moveMouseToElement` call; removed when flow ends.
- Inside `fittsMousePath`, after each sample, also set `overlay.style.transform = translate3d(pos.x, pos.y, 0)` — use transform not left/top (avoids layout thrashing).
- Suppressed entirely when `afk:true` — no overlay, no events. Already the Fitts behaviour.
- Optional tail / trail effect for visibility, or a subtle click flash on mousedown.

---

## D. Auto-new-tab + initial URL navigation (backend integration)

**Problem.** Today `ScraperConfig.url` is stored but unused at runtime ([types/config.ts:159](../src/types/config.ts#L159)). When a SignalR task arrives from the backend, the extension has no mechanism to open a new tab, navigate to the task's initial URL, and start the flow there. The user has to have the correct page open already.

**Why this matters.** In the distributed-worker model, the Angular app queues tasks → backend sends `ReceiveTask` → extension executes. Expecting a human to pre-navigate to the right URL defeats the AFK execution premise. The extension needs to drive tab lifecycle itself.

**Decisions to make before implementation:**

- **Who opens the tab:** background vs. offscreen document. Background has `chrome.tabs` access directly; offscreen is SignalR-owner but would need to message background. Likely background.
- **Content-script injection:** WXT-managed content scripts register against URL matches; if the task's URL doesn't match, the script isn't there to run the flow. Either (a) constrain task URLs to declared match patterns, (b) use `chrome.scripting.executeScript` on demand, or (c) inject a programmatic content script from background.
- **Tab reuse vs. fresh tab:** open a new tab every task, or reuse one tab across tasks from the same domain? New tab is safer (clean state) but has a cold-start cost on every task.
- **How the first step finds its target page:** trust that `chrome.tabs.update({ url })` completed before the flow starts (listen for `tabs.onUpdated` complete), or have the content script signal ready.
- **Failure modes:** URL didn't load, cloudflare on first request, extension popup closed mid-navigation. Pause-and-wait contract with the backend (`TaskPaused`) needs to cover these.

**Relation to existing V3 work:**

- SignalR offscreen document is already designed ([project_v3_architecture memory](../../.claude/projects/c--Users-und3r-Web-Scraper-Version-2/memory/project_v3_architecture.md)).
- `awaitUserAction` already exists and handles the "pause for human input" case — reuse its pause/resume plumbing for failure modes.

---

## Known caveats captured elsewhere

- **bestMatch container pass-through (landed 2026-04-24):** works only if the container selector is specific enough not to exist on "already-landed" pages. Wikipedia's `div.mw-parser-output` exists on both disambiguation and article pages, so the user needs a tighter selector there. Best-effort, not bulletproof. This is inherent to DOM-structural disambiguation and is a motivation for feature B above (URL-based step conditions).
