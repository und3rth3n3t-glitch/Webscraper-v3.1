# SPEC-M4 — New extension steps + smart pause (v1.0)

**Status**: ready for Sonnet to implement.
**Plan**: [C:\Users\und3r\.claude\plans\ok-sonnet-has-finished-hidden-rossum.md](C:\Users\und3r\.claude\plans\ok-sonnet-has-finished-hidden-rossum.md)
**Date**: 2026-04-26

---

## 1. Context

WebScrape ships through M3 (result viewer + history committed as `5b6073d`). The
remaining feature milestone before M5 polish is **M4: new extension steps and
smarter pause behaviour**. Three sub-features in one milestone:

1. **`navigateTo` step** — a new step type that performs a same-tab hard
   navigation (`window.location.href = url`) and resumes scraping at the next
   step after the page reloads.
2. **Smart `awaitUserAction`** — gain optional `detectionRules` so a step can
   pause only when there's an actual obstruction (login wall, captcha, custom
   selector). Default behaviour without rules stays unconditional pause for
   back-compat.
3. **Cloudflare pause/resume across the network boundary** — the wiring is
   mostly there from M1.5; the gap is that `background.ts:213` filters out
   `awaitUserAction` pauses, and the hub DTO doesn't carry the trigger/message
   detail. Once closed, the run-detail polling page reflects paused state
   correctly for both kinds of pause.

**Out of scope** for M4:
- Manual `POST /api/runs/{id}/resume` endpoint (extension auto-resume only).
- SignalR push of run-status changes to web UI (polling stays).
- New `TaskResumed` hub event (resume path: extension auto-detects → next
  `TaskProgress` flips status from Paused → Running, already implemented at
  [`RunService.cs:47-51`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\RunService.cs#L47-L51)).
- SSO-redirect detection for `loginWall` rule.
- 64-char truncation of `PauseReason` in `MarkPausedAsync` (defer to M5).

---

## 2. Locked decisions (from staged planning)

| # | Decision | Rationale |
|---|---|---|
| L1 | All three sub-features in one M4 milestone | They share `FLOW_PAUSED`/network-resume plumbing |
| L2 | `awaitUserAction` without `detectionRules` pauses unconditionally | Preserves M1 back-compat; existing configs assume hard pause |
| L3 | `navigateTo` URL allowlist: only `http:` and `https:` schemes | Stops `javascript:` / `data:` / `file:` injection from a malicious config |
| L4 | Multiple detection rules use any-fires semantics; deterministic order `loginWall` → `captcha` → `selector` | Makes test assertions stable; first match becomes the trigger |
| L5 | `PauseReason` stays a free-form string; known values centralised in `PauseReasonConstants` | Avoids an enum migration; UI can render unknown reasons via fall-through label |
| L6 | Polling-only paused-state UI; no SignalR push to web UI | RunDetail polls at 1s; user sees paused within ~1s of opening |
| L7 | No manual resume endpoint | Spec marks optional; extension cloudflare detector auto-resumes locally |
| L8 | Reuse `.run-banner-warning` for paused state (no new CSS class) | Paused = attention-needed = amber, exactly what `--warning` semantics encode |
| L9 | Resume signal stays on `RESUME_AFTER_CLOUDFLARE` message type for now | Renaming to `RESUME_AFTER_PAUSE` is M5 polish — out of M4 scope to keep diff tight |
| L10 | Malformed selectors in `detectionRules.selector` treated as "rule did not fire" | Soft-locking a run on a typo is worse than missing a pause |

---

## 3. Extension changes

### 3.1 — Edit [src/types/config.ts](c:\Users\und3r\blueberry-v3\src\types\config.ts)

**Replace** `AwaitUserActionOptions` (currently lines 118-120):

```ts
export interface DetectionRules {
  loginWall?: boolean;
  captcha?: boolean;
  selector?: string;
}

export interface AwaitUserActionOptions {
  message: string;
  detectionRules?: DetectionRules;
}

export interface NavigateToOptions {
  url: string;
}
```

**Add** to the discriminated step union (currently lines 124-143):

```ts
export interface NavigateToStep extends BaseStep { type: 'navigateTo'; options: NavigateToOptions; }
```

And add `NavigateToStep` to the `Step` union (after `AwaitUserActionStep`).

### 3.2 — Edit [src/types/messages.ts](c:\Users\und3r\blueberry-v3\src\types\messages.ts)

**Widen** the two `FLOW_PAUSED` entries (currently lines 17-18) into one:

```ts
  | { type: 'FLOW_PAUSED';            payload:
        | { reason: 'cloudflare'; challengeType: CloudflareChallengeType; taskId?: string }
        | { reason: 'awaitUserAction'; trigger: 'loginWall' | 'captcha' | 'selector' | 'unconditional'; message: string; taskId?: string } }
```

### 3.3 — Edit [src/types/signalr.ts](c:\Users\und3r\blueberry-v3\src\types\signalr.ts)

**Widen** `QueueTask.pausedReason` (currently line 14):

```ts
  pausedReason?: 'cloudflare' | 'awaitUserAction';
```

**Widen** `TaskPaused` (currently lines 44-50) to:

```ts
export interface TaskPaused {
  taskId: string;
  configId: string;
  reason: 'cloudflare' | 'awaitUserAction';
  challengeType: string;
  trigger?: 'loginWall' | 'captcha' | 'selector' | 'unconditional';
  message?: string;
  pausedAt: string;
}
```

### 3.4 — Create `src/content/detectionRules.ts` (new file)

```ts
import { detectCloudflareChallenge } from './cloudflareDetector';
import type { DetectionRules } from '../types/config';

export type DetectionTrigger = 'loginWall' | 'captcha' | 'selector' | 'unconditional';

export interface DetectionResult {
  fired: boolean;
  trigger: DetectionTrigger;
}

const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]';

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.offsetParent === null && getComputedStyle(html).position !== 'fixed') return false;
  const rect = html.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function loginWallFires(): boolean {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
  return inputs.some(isVisible);
}

function captchaFires(): boolean {
  if (detectCloudflareChallenge().detected) return true;
  return document.querySelector(CAPTCHA_SELECTOR) !== null;
}

function selectorFires(selector: string): boolean {
  try {
    return document.querySelector(selector) !== null;
  } catch {
    return false;
  }
}

/**
 * Evaluates detection rules against the current document.
 * Returns `{ fired: true, trigger }` for the first rule that matches
 * (deterministic order: loginWall → captcha → selector).
 * If no rules are provided, returns `{ fired: true, trigger: 'unconditional' }`
 * to preserve M1 back-compat (a hard pause).
 * If rules are provided but none fire, returns `{ fired: false, trigger: 'unconditional' }`.
 */
export function evaluateDetectionRules(rules?: DetectionRules): DetectionResult {
  if (!rules || (rules.loginWall === undefined && rules.captcha === undefined && rules.selector === undefined)) {
    return { fired: true, trigger: 'unconditional' };
  }
  if (rules.loginWall && loginWallFires()) return { fired: true, trigger: 'loginWall' };
  if (rules.captcha && captchaFires()) return { fired: true, trigger: 'captcha' };
  if (rules.selector && selectorFires(rules.selector)) return { fired: true, trigger: 'selector' };
  return { fired: false, trigger: 'unconditional' };
}
```

### 3.5 — Edit [src/content/scraping/scrapingEngine.ts](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts)

**Add to imports** at the top of the file (alongside the existing `cloudflareDetector` import):

```ts
import { evaluateDetectionRules } from '../detectionRules';
import type { NavigateToStep } from '../../types/config';
```

(Locate the existing `import` block for engine helpers and add these — Sonnet should
match the existing import-style of the file.)

**Modify** line 69:

```ts
const NAVIGATING_STEP_TYPES = new Set(['click', 'bestMatch', 'goBack', 'navigateTo']);
```

**Modify** the dispatch switch (lines 362-382) — add a case before the `default` branch:

```ts
    case 'navigateTo':
      return executeNavigateTo(step, searchTerm, onProgress);
```

**Replace** `executeAwaitUserAction` (currently lines 614-627) with:

```ts
async function executeAwaitUserAction(step: AwaitUserActionStep, onProgress: OnProgress): Promise<null> {
  const opts = step.options;
  const evalResult = evaluateDetectionRules(opts.detectionRules);

  if (!evalResult.fired) {
    onProgress?.(`No obstruction detected — skipping pause`);
    return null;
  }

  onProgress?.(`Waiting for user: ${opts.message}`);

  browser.runtime.sendMessage({
    type: 'FLOW_PAUSED',
    payload: {
      reason: 'awaitUserAction',
      trigger: evalResult.trigger,
      message: opts.message,
    },
  });

  await waitForResumeSignal();

  browser.runtime.sendMessage({ type: 'FLOW_RESUMED' });
  return null;
}
```

**Add** a new function `executeNavigateTo` immediately after `executeAwaitUserAction`:

```ts
async function executeNavigateTo(
  step: NavigateToStep,
  searchTerm: string | null,
  onProgress: OnProgress,
): Promise<null> {
  const rawUrl = step.options.url;
  const url = searchTerm ? rawUrl.replace(/\{searchTerm\}/g, searchTerm) : rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`navigateTo: invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`navigateTo: unsupported scheme "${parsed.protocol}" — only http(s) allowed`);
  }

  onProgress?.(`Navigating to ${parsed.href}`);
  window.location.href = parsed.href;

  // Page is unloading — block forever so the rest of the loop iteration never runs.
  // The continuation registered at scrapingEngine.ts:166-179 will resume at si + 1
  // after the new page loads.
  await new Promise<null>(() => {});
  return null;
}
```

### 3.6 — Edit [src/background/flowEventToHubPayload.ts](c:\Users\und3r\blueberry-v3\src\background\flowEventToHubPayload.ts)

**Replace** `FlowPausedPayload` (currently line 24):

```ts
export type FlowPausedPayload =
  | { reason: 'cloudflare'; challengeType: string }
  | { reason: 'awaitUserAction'; trigger: 'loginWall' | 'captcha' | 'selector' | 'unconditional'; message: string };
```

**Replace** `mapFlowPaused` (currently lines 83-95):

```ts
export function mapFlowPaused(
  ctx: ActiveTaskContext,
  payload: FlowPausedPayload,
  now: () => string = () => new Date().toISOString(),
): TaskPaused {
  if (payload.reason === 'cloudflare') {
    return {
      taskId: ctx.taskId,
      configId: ctx.configId,
      reason: 'cloudflare',
      challengeType: payload.challengeType,
      pausedAt: now(),
    };
  }
  return {
    taskId: ctx.taskId,
    configId: ctx.configId,
    reason: 'awaitUserAction',
    challengeType: '',
    trigger: payload.trigger,
    message: payload.message,
    pausedAt: now(),
  };
}
```

### 3.7 — Edit [src/entrypoints/background.ts](c:\Users\und3r\blueberry-v3\src\entrypoints\background.ts)

**Replace** the FLOW_PAUSED case (currently lines 211-217):

```ts
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string };
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        const hubPayload = mapFlowPaused(activeRemoteTask, payload as unknown as FlowPausedPayload);
        relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
        return;
      }
```

### 3.8 — Edit [src/sidepanel/utils/queueDispatcher.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\utils\queueDispatcher.ts)

**Replace** the FLOW_PAUSED handler (currently lines 50-54):

```ts
  const offPaused = onMessage('FLOW_PAUSED', (payload) => {
    const p = payload as { taskId?: string; reason?: 'cloudflare' | 'awaitUserAction' };
    if (!p.taskId || (p.reason !== 'cloudflare' && p.reason !== 'awaitUserAction')) return;
    useQueueStore.getState().pauseTask(p.taskId, p.reason);
  });
```

(`pauseTask`'s signature widens automatically because it takes `QueueTask['pausedReason']`,
which we widened in §3.3.)

**Do not edit** [`src/sidepanel/components/RunProgress.tsx`](c:\Users\und3r\blueberry-v3\src\sidepanel\components\RunProgress.tsx) — its `cloudflarePaused` state is the in-extension cloudflare-resume banner and has its own UX semantics. Local-mode `awaitUserAction` is shown elsewhere in the run-progress surface and doesn't need this banner.

---

## 4. Backend changes

### 4.1 — Edit [`backend/src/WebScrape.Data/Constants/PauseReasonConstants.cs`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Constants\PauseReasonConstants.cs)

**Replace** the file contents:

```csharp
namespace WebScrape.Data.Constants;

// Wire-format pause reasons used in TaskPausedDto.Reason.
public static class PauseReasonConstants
{
    public const string Cloudflare = "cloudflare";
    public const string AwaitUserAction = "awaitUserAction";
}
```

### 4.2 — Edit [`backend/src/WebScrape.Data/Dto/HubPayloadDtos.cs`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Dto\HubPayloadDtos.cs)

**Replace** `TaskPausedDto` (currently lines 45-52):

```csharp
public class TaskPausedDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string Reason { get; set; } = PauseReasonConstants.Cloudflare;
    public string ChallengeType { get; set; } = "";
    public string? Trigger { get; set; }
    public string? Message { get; set; }
    public DateTimeOffset PausedAt { get; set; }
}
```

### 4.3 — No other backend changes

- `RunService.MarkPausedAsync` ([`RunService.cs:99-114`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\RunService.cs#L99-L114)) already writes `payload.Reason` to `RunItem.PauseReason`. The widened reason set ("cloudflare" | "awaitUserAction") flows through unchanged.
- `RunService.RecordProgressAsync` ([line 47](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\RunService.cs#L47)) already flips `Sent` or `Paused` → `Running` on the next progress, regardless of which pause reason. Resume needs no new code.
- `ScraperHub.TaskPaused` already routes the payload to `MarkPausedAsync`. No hub change.
- No EF migration. No DbContext change. No new DTO fields surfaced to `RunItemDto` (frontend reads `pauseReason` only).

---

## 5. Frontend changes

### 5.1 — Edit [`backend/src/WebScrape.Client/src/utils/runStatus.ts`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\utils\runStatus.ts)

**Add** at the bottom of the file:

```ts
export function pausedLabel(reason: string | null | undefined): string {
  if (reason === 'cloudflare') return 'Paused — solve the challenge in your browser';
  if (reason === 'awaitUserAction') return 'Paused — action needed in your browser';
  return 'Paused';
}
```

(Leave `STATUS_LABEL_MAP` and `statusLabel` unchanged — `statusLabel(Paused)` is still
the right answer when no reason is available.)

### 5.2 — Edit [`backend/src/WebScrape.Client/src/pages/RunDetail.tsx`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\pages\RunDetail.tsx)

**Add** to the existing import line for `runStatus`:

```ts
import { statusLabel, pausedLabel } from '../utils/runStatus';
```

**Replace** the banner block (currently lines 85-92):

```tsx
      {bannerClass ? (
        <div className={`run-banner ${bannerClass}`}>
          {run.status === RunItemStatus.Paused ? pausedLabel(run.pauseReason) : statusLabel(run.status)}
          {run.errorMessage ? ` — ${run.errorMessage}` : ''}
        </div>
      ) : (
        <div className="view-subtitle">{statusLabel(run.status)}</div>
      )}
```

(`run.pauseReason` is already on `RunItemDto` and surfaced through `api/types.ts` —
no new field plumbing needed. Verify by reading [`RunItemDto.cs:19`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Dto\RunItemDto.cs#L19) and the
frontend `RunItem` type in `api/types.ts`; if `pauseReason` is missing on the
frontend type, add `pauseReason?: string | null` to it.)

### 5.3 — No other frontend changes

- No new CSS class. Banner reuses `.run-banner-warning` (already mapped at [`RunDetail.tsx:15`](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\pages\RunDetail.tsx#L15)).
- `Runs.tsx` `DOT_FOR` mapping (paused → 'pending' colour) stays as-is.

---

## 6. Tests

### 6.1 — Create `src/__tests__/detectionRules.test.ts` (new file)

Use Vitest's jsdom environment (already configured for the existing tests).
Required `it()` cases:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateDetectionRules } from '../content/detectionRules';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('evaluateDetectionRules', () => {
  beforeEach(() => {
    document.title = '';
    document.body.innerHTML = '';
  });

  it('with no rules returns unconditional fire (back-compat)', () => {
    expect(evaluateDetectionRules()).toEqual({ fired: true, trigger: 'unconditional' });
    expect(evaluateDetectionRules({})).toEqual({ fired: true, trigger: 'unconditional' });
  });

  it('loginWall fires when password input is visible', () => {
    setBody('<input type="password" style="width:200px;height:20px" />');
    // Force layout — jsdom returns 0,0 by default; stub getBoundingClientRect.
    const input = document.querySelector('input')!;
    input.getBoundingClientRect = () => ({ width: 200, height: 20, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) });
    Object.defineProperty(input, 'offsetParent', { get: () => document.body });
    expect(evaluateDetectionRules({ loginWall: true })).toEqual({ fired: true, trigger: 'loginWall' });
  });

  it('loginWall does not fire when password input is absent', () => {
    setBody('<input type="text" />');
    expect(evaluateDetectionRules({ loginWall: true })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('captcha fires for cloudflare challenge form', () => {
    setBody('<form id="challenge-form"></form>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for recaptcha iframe', () => {
    setBody('<iframe src="https://www.google.com/recaptcha/api2/anchor?..."></iframe>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for hcaptcha iframe', () => {
    setBody('<iframe src="https://newassets.hcaptcha.com/captcha/..."></iframe>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for any element with data-sitekey', () => {
    setBody('<div data-sitekey="abc123"></div>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha does not fire on plain page', () => {
    setBody('<p>nothing here</p>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('selector fires when present', () => {
    setBody('<div id="cookie-banner"></div>');
    expect(evaluateDetectionRules({ selector: '#cookie-banner' })).toEqual({ fired: true, trigger: 'selector' });
  });

  it('selector does not fire when absent', () => {
    expect(evaluateDetectionRules({ selector: '#missing' })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('malformed selector is treated as not firing (no throw)', () => {
    expect(() => evaluateDetectionRules({ selector: '>><<' })).not.toThrow();
    expect(evaluateDetectionRules({ selector: '>><<' })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('multiple rules: first match wins in deterministic order', () => {
    setBody(`
      <input type="password" id="pw" />
      <form id="challenge-form"></form>
      <div id="cookie-banner"></div>
    `);
    const input = document.querySelector('input')!;
    input.getBoundingClientRect = () => ({ width: 200, height: 20, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) });
    Object.defineProperty(input, 'offsetParent', { get: () => document.body });
    expect(
      evaluateDetectionRules({ loginWall: true, captcha: true, selector: '#cookie-banner' })
    ).toEqual({ fired: true, trigger: 'loginWall' });
  });
});
```

### 6.2 — Extend `src/__tests__/flowEventToHubPayload.test.ts`

Inside the existing `describe('mapFlowPaused', ...)` block (currently at lines 109-120),
**add** these cases:

```ts
  it('maps an awaitUserAction pause to TaskPaused with trigger and message', () => {
    const out = mapFlowPaused(
      ctx,
      { reason: 'awaitUserAction', trigger: 'loginWall', message: 'Please sign in' },
      now,
    );
    expect(out).toEqual({
      taskId: 'run-1',
      configId: 'cfg-1',
      reason: 'awaitUserAction',
      challengeType: '',
      trigger: 'loginWall',
      message: 'Please sign in',
      pausedAt: FIXED_NOW,
    });
  });

  it('does not include trigger/message on cloudflare pauses', () => {
    const out = mapFlowPaused(ctx, { reason: 'cloudflare', challengeType: 'cf-turnstile' }, now);
    expect(out.trigger).toBeUndefined();
    expect(out.message).toBeUndefined();
  });
```

### 6.3 — Extend `backend/tests/WebScrape.Tests/Services/RunServiceTests.cs`

Locate the existing cloudflare pause test at line ~143-160 (the test that ends at
[`line 159`](c:\Users\und3r\blueberry-v3\backend\tests\WebScrape.Tests\Services\RunServiceTests.cs#L159) with `Assert.Equal("cloudflare", stored.PauseReason);`).

**Add** these `[Fact]`s after it (use the same `Build()` and `SeedSentRun(...)` helpers
the existing test uses; mirror the style):

```csharp
[Fact]
public async Task MarkPaused_With_AwaitUserAction_Reason_PersistsReason()
{
    var (svc, db, _, task, worker) = await Build();
    var runId = await SeedSentRun(db, task.Id, worker.Id);

    await svc.MarkPausedAsync(new TaskPausedDto
    {
        TaskId = runId.ToString(),
        ConfigId = Guid.NewGuid().ToString(),
        Reason = PauseReasonConstants.AwaitUserAction,
        Trigger = "loginWall",
        Message = "Sign in",
    });

    var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
    Assert.Equal(RunItemStatus.Paused, stored.Status);
    Assert.Equal("awaitUserAction", stored.PauseReason);
}

[Theory]
[InlineData("cloudflare")]
[InlineData("awaitUserAction")]
public async Task RecordProgress_After_Pause_Flips_To_Running(string reason)
{
    var (svc, db, _, task, worker) = await Build();
    var runId = await SeedSentRun(db, task.Id, worker.Id);

    await svc.MarkPausedAsync(new TaskPausedDto
    {
        TaskId = runId.ToString(),
        ConfigId = Guid.NewGuid().ToString(),
        Reason = reason,
    });

    await svc.RecordProgressAsync(new TaskProgressDto
    {
        TaskId = runId.ToString(),
        ConfigId = Guid.NewGuid().ToString(),
        CurrentStep = "next step",
        CurrentTerm = "alpha",
        Progress = 50,
        Phase = "loop",
    });

    var stored = await db.RunItems.SingleAsync(r => r.Id == runId);
    Assert.Equal(RunItemStatus.Running, stored.Status);
    Assert.Equal(50, stored.ProgressPercent);
}
```

(Add `using WebScrape.Data.Constants;` at the top of the test file if not already
imported.)

---

## 7. File checksum (post-merge tree)

Extension (under `src/`):

```
types/
  config.ts                       [edited: AwaitUserActionOptions, +DetectionRules, +NavigateToOptions, +NavigateToStep, Step union]
  messages.ts                     [edited: FLOW_PAUSED widened]
  signalr.ts                      [edited: QueueTask.pausedReason widened, TaskPaused widened]
content/
  detectionRules.ts               [new]
  scraping/
    scrapingEngine.ts             [edited: imports, NAVIGATING_STEP_TYPES, switch case, executeAwaitUserAction body, +executeNavigateTo]
background/
  flowEventToHubPayload.ts        [edited: FlowPausedPayload, mapFlowPaused]
entrypoints/
  background.ts                   [edited: FLOW_PAUSED case allowlist]
sidepanel/
  utils/
    queueDispatcher.ts            [edited: FLOW_PAUSED handler reason check]
__tests__/
  detectionRules.test.ts          [new]
  flowEventToHubPayload.test.ts   [edited: +awaitUserAction cases]
```

Backend (under `backend/`):

```
src/
  WebScrape.Data/
    Constants/
      PauseReasonConstants.cs     [edited: +AwaitUserAction]
    Dto/
      HubPayloadDtos.cs           [edited: TaskPausedDto +Trigger +Message]
  WebScrape.Client/src/
    utils/runStatus.ts            [edited: +pausedLabel]
    pages/RunDetail.tsx           [edited: pausedLabel in banner]
    api/types.ts                  [edited only if pauseReason is missing on RunItem type]
tests/
  WebScrape.Tests/
    Services/RunServiceTests.cs   [edited: +2 tests]
```

No EF migration. No `WebScrapeDbContext` change. No new entity columns.

---

## 8. Verification commands

```bash
# Backend
cd c:\Users\und3r\blueberry-v3\backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests

# Extension
cd c:\Users\und3r\blueberry-v3
npm run test
npm run build

# Frontend (web UI)
cd c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client
npm run typecheck
npm run test:run
npm run build
```

All previously-passing tests must remain green. New tests in §6 must pass.

---

## 9. Manual end-to-end (gate before declaring done)

Run these against a live local stack (Postgres up, backend `dotnet run`, web UI
`npm run dev`, extension loaded in browser). Each step must hold.

1. **`navigateTo` smoke** — Author a task whose root loop block contains a single
   scrape block with steps `[navigateTo(https://example.com), scrape(h1)]`.
   Dispatch one iteration. The browser tab navigates to example.com, scrape
   captures the `h1`, run completes, web UI shows extracted text.

2. **`navigateTo` URL safety** — Same task but `url: "javascript:alert(1)"`.
   Dispatch. No alert dialog appears. Run fails with error message
   `navigateTo: unsupported scheme "javascript:" — only http(s) allowed`.
   Repeat with `url: "data:text/html,<h1>x</h1>"` — same error message
   (different scheme).

3. **`awaitUserAction` unconditional (back-compat)** — Author a task with one
   scrape block whose first step is `awaitUserAction(message: "Click continue")`
   with **no `detectionRules`**. Dispatch. Extension pauses immediately. Web UI
   `RunDetail` banner reads "Paused — action needed in your browser" within ~2s.
   Send `RESUME_AFTER_CLOUDFLARE` from devtools (or use the existing extension
   resume button). Run continues, finishes successfully.

4. **`awaitUserAction` loginWall fires** — Same task plus
   `detectionRules: { loginWall: true }`, dispatched against a page with a
   visible password input. Pauses; banner appears.

5. **`awaitUserAction` loginWall does NOT fire** — Same config, dispatched
   against `https://example.com` (no password input). Step is a no-op; the
   `onProgress` log line in extension devtools reads "No obstruction detected
   — skipping pause"; run continues without pausing.

6. **`awaitUserAction` selector** — `detectionRules: { selector: '#cookie-banner' }`.
   Test against a page with that ID (pauses) and a page without (no-op).

7. **Cloudflare end-to-end** — Trigger a real cloudflare-protected page (or
   stub by injecting `<form id="challenge-form"></form>` via devtools after
   navigation). Within ~2s `psql -c "SELECT status, pause_reason FROM
   run_items WHERE id = '<runId>';"` shows `paused | cloudflare`. Web UI
   banner reads "Paused — solve the challenge in your browser". Remove the
   stub element. On the next step's `TaskProgress`, status flips to
   `running` and progress resumes.

8. **(Negative)** Cross-user isolation: one user's `RunDetail` cannot read
   another user's run (already enforced by `GetAsync` user-scoping;
   regression-test by switching users in two tabs).

---

## 10. Out of scope (do not implement)

- Manual `POST /api/runs/{id}/resume` endpoint and its UI button.
- SignalR push of run-status changes to web UI (polling stays).
- New `TaskResumed` hub event.
- Renaming `RESUME_AFTER_CLOUDFLARE` → `RESUME_AFTER_PAUSE`.
- SSO-redirect detection for `loginWall`.
- 64-char truncation of `PauseReason` in `MarkPausedAsync`.
- Cleanup of M1.5 diagnostic console.log lines (deferred to M5).
- Updating `RunProgress.tsx` (`cloudflarePaused` is local-mode UX, separate concern).
