# SPEC: Detection-on-failure (PR1.7)

**Slug:** `detection-on-failure`
**Version:** 1.7
**Author:** Opus (planning) → Sonnet (implementation)
**Predecessor:** PR1.6 (pause-resume-robust)
**Successor:** PR1.8 (resume-with-feedback)

---

## 1. Context

The current watchdog (PR1, generalised in PR1.5, hardened in PR1.6) runs **speculatively** at cold-start and after every navigating step. It fires whenever any detector matches — including cookie banners and captchas, which are often visually-overlaying-but-functionally-irrelevant to a scraper.

The result: the user gets paused on every cookie banner on every site, even when the banner doesn't actually block the scrape. The detection-quality bar is "did anything matching trigger" rather than "is anything actually blocking us." Cookie banners and captchas are by far the worst offenders for false positives:

- **Cookie banner**: fixed-position overlay. Scraper's `querySelector` reaches the underlying DOM fine. Only matters when (1) the banner pattern locks scroll, (2) the banner sits on top of a click target, or (3) the banner sits over a form field.
- **Captcha**: usually only blocking when the user attempts a form action. A captcha widget in a footer contact form does not break passive scraping.

**Cloudflare** and **login walls** are different — they gate content server-side. Pre-emptive detection is correct for them. **`extraSelectors`** is user-curated — the user explicitly added them because they know they're real blockers; pre-emptive detection is correct.

This PR splits detectors into two tiers and changes when each tier runs:

| Tier | Detectors | When |
|---|---|---|
| **Confirmed** | cloudflare, loginWall, extraSelectors | Cold-start, post-navigation, post-failure |
| **Speculative** | cookieBanner, captcha | Post-failure only |

A "step failure" is any step that throws (excluding `ABORTED` and `SkipIterationError`). On failure, the full watchdog (both tiers) runs. If a detector fires, the user is paused; on resume, the failed step is retried **once**. If the watchdog finds nothing, the original error propagates as today.

This eliminates ~80% of cookie-banner false positives because banners that don't break a step never trigger a pause.

**Locked decisions** (do not re-litigate during implementation):

- Two tiers, hard-coded mapping. No user-configurable demotion.
- `runDetectorWatchdog` gains a `mode: 'all' | 'confirmedOnly'` parameter, default `'all'`.
- Cold-start and post-navigation watchdogs use `'confirmedOnly'`.
- A new "post-failure" watchdog wraps step execution. Uses `'all'`.
- Step retry on detection-after-failure: at most ONCE per step. Second failure (with or without detector match) propagates.
- Retry counter is per-step-invocation, NOT per-step-config. Each step gets its own one retry budget per invocation.
- `SkipIterationError` and `ABORTED` are NOT eligible for retry — they're meaningful signals, not failures.
- Cookie-banner detector tightening: drop `iframe[src*="quantcast.com"]` (too broad — Quantcast also serves ads); require iframe matches to be visibly large (>200×100px) to count.
- No new permissions. No schema changes.

---

## 2. File map

### Modified

| File | Concern |
|---|---|
| [src/content/detectionRules.ts](src/content/detectionRules.ts) | `runDetectorWatchdog` gains `mode` parameter; speculative-tier filter |
| [src/content/cookieBannerDetector.ts](src/content/cookieBannerDetector.ts) | Drop quantcast iframe selector; add visible-size threshold for iframe matches |
| [src/content/scraping/scrapingEngine.ts](src/content/scraping/scrapingEngine.ts) | Cold-start + post-nav watchdogs pass `'confirmedOnly'`; new post-failure retry block wraps step execution |

### New

| File | Purpose |
|---|---|
| `src/__tests__/runDetectorWatchdog.test.ts` | Vitest for the mode-aware watchdog (covers both tiers) |

### Deleted

None.

---

## 3. Detailed changes

### 3.1 — `src/content/detectionRules.ts`

Add the `mode` parameter and skip speculative detectors when `mode === 'confirmedOnly'`.

Current `runDetectorWatchdog` at lines 66-90:

```typescript
// Detector priority (first match wins):
//   cloudflare → loginWall → captcha → cookieBanner → extraSelectors
// Each detector disabled via `cfg.{name} === false`; default-on otherwise.
export function runDetectorWatchdog(cfg?: AutoDetectConfig): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;

  if (enabled('cloudflare') && detectCloudflareChallenge().detected) {
    return { fired: true, trigger: DetectionTrigger.CLOUDFLARE };
  }
  if (enabled('loginWall') && loginWallFires()) {
    return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  }
  // When cloudflare is explicitly disabled, don't let its detection leak through captchaFires().
  const captchaFired = enabled('captcha') && (
    enabled('cloudflare') ? captchaFires() : document.querySelector(CAPTCHA_SELECTOR) !== null
  );
  if (captchaFired) {
    return { fired: true, trigger: DetectionTrigger.CAPTCHA };
  }
  if (enabled('cookieBanner') && detectCookieBanner()) {
    return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
  }
  const extras = cfg?.extraSelectors ?? [];
  if (extras.length > 0 && extraSelectorsFire(extras)) {
    return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}
```

Replace with:

```typescript
export type WatchdogMode = 'all' | 'confirmedOnly';

// Detector priority (first match wins):
//   cloudflare → loginWall → [captcha → cookieBanner] → extraSelectors
// Each detector disabled via `cfg.{name} === false`; default-on otherwise.
//
// Two tiers:
//   - "confirmed" (cloudflare, loginWall, extraSelectors): run on cold-start
//     and after navigation. These genuinely block content.
//   - "speculative" (captcha, cookieBanner): only run after a step has failed.
//     They often false-positive (cookie banner that doesn't actually block,
//     captcha widget in a non-blocking footer). Demoting them here cuts the
//     false-positive rate dramatically without losing real blockers — if a
//     banner DOES block a step, the post-failure watchdog catches it.
export function runDetectorWatchdog(
  cfg?: AutoDetectConfig,
  mode: WatchdogMode = 'all',
): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;

  if (enabled('cloudflare') && detectCloudflareChallenge().detected) {
    return { fired: true, trigger: DetectionTrigger.CLOUDFLARE };
  }
  if (enabled('loginWall') && loginWallFires()) {
    return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  }

  if (mode === 'all') {
    // When cloudflare is explicitly disabled, don't let its detection leak through captchaFires().
    const captchaFired = enabled('captcha') && (
      enabled('cloudflare') ? captchaFires() : document.querySelector(CAPTCHA_SELECTOR) !== null
    );
    if (captchaFired) {
      return { fired: true, trigger: DetectionTrigger.CAPTCHA };
    }
    if (enabled('cookieBanner') && detectCookieBanner()) {
      return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
    }
  }

  const extras = cfg?.extraSelectors ?? [];
  if (extras.length > 0 && extraSelectorsFire(extras)) {
    return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}
```

No other edits to detectionRules.ts. `evaluateDetectionRules` (used by the `awaitUserAction` step) is unchanged.

---

### 3.2 — `src/content/cookieBannerDetector.ts`

Two tightening changes: drop the quantcast selector (matches ads) and add a visible-size threshold for iframe matches (excludes tiny tracker iframes that happen to match a CMP-domain pattern).

Current `CONSENT_IFRAME_SELECTORS` at lines 18-30:

```typescript
const CONSENT_IFRAME_SELECTORS = [
  'iframe[id^="sp_message_iframe"]',    // Sourcepoint (Guardian, Times, etc.)
  'iframe[src*="sourcepoint.com"]',
  'iframe[src*="consentframework.com"]',
  'iframe[src*="cookielaw.org"]',       // OneTrust CDN
  'iframe[src*="onetrust.com"]',
  'iframe[src*="usercentrics"]',
  'iframe[src*="quantcast.com"]',
  'iframe[src*="didomi.io"]',
  'iframe[title*="cookie" i]',          // Accessibility-labelled consent iframes
  'iframe[title*="consent" i]',
  'iframe[title*="privacy" i]',
];
```

Replace with (drop quantcast, document why):

```typescript
// Iframes used by consent management platforms to host their dialog UI.
// These are sandboxed so their inner DOM is inaccessible — we detect the
// iframe element itself instead.
//
// Quantcast intentionally NOT listed: the same domain serves CMP iframes AND
// ad/analytics iframes. We can't tell them apart by URL alone, so leaving it
// out avoids ad-driven false positives. If a Quantcast-hosted CMP becomes a
// problem in practice, add it back gated by a size threshold.
const CONSENT_IFRAME_SELECTORS = [
  'iframe[id^="sp_message_iframe"]',    // Sourcepoint (Guardian, Times, etc.)
  'iframe[src*="sourcepoint.com"]',
  'iframe[src*="consentframework.com"]',
  'iframe[src*="cookielaw.org"]',       // OneTrust CDN
  'iframe[src*="onetrust.com"]',
  'iframe[src*="usercentrics"]',
  'iframe[src*="didomi.io"]',
  'iframe[title*="cookie" i]',          // Accessibility-labelled consent iframes
  'iframe[title*="consent" i]',
  'iframe[title*="privacy" i]',
];

// Minimum iframe size to count as a consent dialog. Tracking pixels and
// 1×1 analytics iframes match SP/CMP URL patterns sometimes — exclude them.
const MIN_CONSENT_IFRAME_W = 200;
const MIN_CONSENT_IFRAME_H = 100;
```

Update `matchesConsentIframe` at lines 42-48 from:

```typescript
function matchesConsentIframe(): boolean {
  for (const sel of CONSENT_IFRAME_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && isVisible(el)) return true;
  }
  return false;
}
```

To:

```typescript
function matchesConsentIframe(): boolean {
  for (const sel of CONSENT_IFRAME_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || !isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= MIN_CONSENT_IFRAME_W && rect.height >= MIN_CONSENT_IFRAME_H) {
      return true;
    }
  }
  return false;
}
```

Also remove the noisy debug log line. Locate `detectCookieBanner` at lines 60-66:

```typescript
export function detectCookieBanner(): boolean {
  const byId = matchesIdSelector();
  const byIframe = matchesConsentIframe();
  const byRole = matchesRoleDialogKeyword();
  console.warn('[detectCookieBanner] byId:', byId, '| byIframe:', byIframe, '| byRole:', byRole);
  return byId || byIframe || byRole;
}
```

Replace with:

```typescript
export function detectCookieBanner(): boolean {
  return matchesIdSelector() || matchesConsentIframe() || matchesRoleDialogKeyword();
}
```

No other edits.

---

### 3.3 — `src/content/scraping/scrapingEngine.ts`

Two changes: pass `'confirmedOnly'` from cold-start + post-nav watchdogs; add a post-failure retry block.

#### 3.3.1 — Cold-start and post-nav watchdogs use `'confirmedOnly'`

The `runWatchdogPause` function (modified in PR1.6) currently calls `runDetectorWatchdog(cfg)`. Add a `mode` parameter and forward it.

Locate the function signature (post-PR1.6 form):

```typescript
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
  resumeCtx: PauseResumeContext,
): Promise<void> {
  const result = runDetectorWatchdog(cfg);
```

Change to:

```typescript
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
  resumeCtx: PauseResumeContext,
  mode: 'all' | 'confirmedOnly' = 'all',
): Promise<void> {
  const result = runDetectorWatchdog(cfg, mode);
```

(The `'all' | 'confirmedOnly'` literal type matches `WatchdogMode` from detectionRules.ts; you can either inline as shown or import the type. Inline is fine since this is the only caller.)

Now update the three call sites to pass `'confirmedOnly'` for the proactive paths:

**Cold-start watchdog (PR1.5/1.6 location, lines ~150-158).** Append `'confirmedOnly'` as the 4th argument:

```typescript
        await runWatchdogPause(config.autoDetect, taskId, {
          config,
          searchTerms,
          previousIterations: result.iterations,
          startTermIndex: 0,
          startLoopStepIndex: 0,
        }, 'confirmedOnly');
```

**Resumed-leg watchdog (PR1.6 location, the generalised post-resume check inside the `for (let si...)` loop).** Append `'confirmedOnly'`:

```typescript
        if (i === startTermIndex && (siStart > 0 || startTermIndex > 0)) {
          swLog('[resumed-leg watchdog] enter | taskId:', taskId, '| termIndex:', i, '| siStart:', siStart, '| url:', window.location.href);
          await runWatchdogPause(config.autoDetect, taskId, {
            config,
            searchTerms,
            previousIterations: result.iterations,
            startTermIndex: i,
            startLoopStepIndex: siStart,
          }, 'confirmedOnly');
        }
```

**Post-nav watchdog (PR1.6 location, after a navigating step).** Append `'confirmedOnly'`:

```typescript
            if (isNavigating) {
              await runWatchdogPause(config.autoDetect, taskId, {
                config,
                searchTerms,
                previousIterations: result.iterations,
                startTermIndex: i,
                startLoopStepIndex: si + 1,
              }, 'confirmedOnly');
            }
```

#### 3.3.2 — Post-failure retry block

The current step execution at lines ~224-257 (post-PR1.6) is a single try/finally. Wrap it in a one-retry loop that runs the FULL watchdog (`'all'` mode) on failure.

Locate the block. Current shape (post-PR1.6):

```typescript
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
            swLog('[executeFlow] step OK  | taskId:', taskId, '| stepIndex:', si, '| type:', step.type, '| stepData keys:', stepData ? Object.keys(stepData) : null, '| url:', window.location.href);

            if (isNavigating) {
              await runWatchdogPause(config.autoDetect, taskId, {
                config,
                searchTerms,
                previousIterations: result.iterations,
                startTermIndex: i,
                startLoopStepIndex: si + 1,
              }, 'confirmedOnly');
            }
          } finally {
            if (isNavigating) {
              try {
                browser.runtime.sendMessage({ type: 'CANCEL_CONTINUATION' });
                swLog('[executeFlow] CANCEL_CONTINUATION sent | taskId:', taskId, '| stepIndex:', si);
              } catch { /* expected */ }
            }
          }
```

Replace the entire block with (one retry guarded by post-failure watchdog):

```typescript
          let stepData: Record<string, unknown> | null = null;
          const urlBeforeStep = window.location.href;
          let retried = false;

          try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              try {
                stepData = await executeStep(
                  step,
                  term,
                  i,
                  (msg) => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId }),
                  afk,
                  taskId,
                );
                break; // step succeeded — exit retry loop
              } catch (stepErr) {
                const se = stepErr as Error;
                // ABORTED and SkipIterationError are meaningful signals, not failures.
                if (se.message === 'ABORTED' || se.name === 'SkipIterationError') throw stepErr;
                // Already retried once — propagate.
                if (retried) throw stepErr;

                // Post-failure watchdog: full detector set including speculative tier.
                // If something blocking is detected, pause for the user, then retry once.
                swLog('[executeFlow] step FAILED — running post-failure watchdog | taskId:', taskId, '| stepIndex:', si, '| err:', se.message);
                const detection = runDetectorWatchdog(config.autoDetect, 'all');
                if (!detection.fired) {
                  swLog('[executeFlow] post-failure watchdog clean — propagating original error | taskId:', taskId);
                  throw stepErr;
                }
                swLog('[executeFlow] post-failure watchdog FIRED — pausing for user | trigger:', detection.trigger);
                // runWatchdogPause re-evaluates the detector but we know it'll
                // fire again (or fire on something else). Use 'all' mode to keep
                // catching speculative obstacles on the retry pause.
                await runWatchdogPause(config.autoDetect, taskId, {
                  config,
                  searchTerms,
                  previousIterations: result.iterations,
                  startTermIndex: i,
                  startLoopStepIndex: si,
                }, 'all');
                retried = true;
                // Loop continues — retry the step on the (presumably) cleared page.
              }
            }

            // Post-navigation settle: real users glance at the new page before acting.
            // Only fires when the step was a navigating type AND the URL actually changed.
            if (isNavigating && window.location.href !== urlBeforeStep) {
              await randomDelay(300, 800);
            }
            swLog('[executeFlow] step OK  | taskId:', taskId, '| stepIndex:', si, '| type:', step.type, '| stepData keys:', stepData ? Object.keys(stepData) : null, '| url:', window.location.href, '| retried:', retried);

            if (isNavigating) {
              await runWatchdogPause(config.autoDetect, taskId, {
                config,
                searchTerms,
                previousIterations: result.iterations,
                startTermIndex: i,
                startLoopStepIndex: si + 1,
              }, 'confirmedOnly');
            }
          } finally {
            if (isNavigating) {
              try {
                browser.runtime.sendMessage({ type: 'CANCEL_CONTINUATION' });
                swLog('[executeFlow] CANCEL_CONTINUATION sent | taskId:', taskId, '| stepIndex:', si);
              } catch { /* expected */ }
            }
          }
```

Key invariants to verify after the edit:
1. The retry loop is INSIDE the existing outer try/finally that handles `CANCEL_CONTINUATION`. The finally still runs when the retry loop throws.
2. `ABORTED` and `SkipIterationError` propagate without retrying.
3. `retried` is reset for each new step (declared inside the `for (let si...)` loop body).
4. The post-failure pause uses the SAME leg coordinates (`startLoopStepIndex: si`, not `si + 1`) — when the held continuation re-delivers (page navigated mid-pause), execution restarts at `si`, hitting the resumed-leg watchdog and then the step again. That's the retry-after-navigation path.

#### 3.3.3 — Imports

`runDetectorWatchdog` is already imported at line 32. No new imports needed in scrapingEngine.ts.

---

### 3.4 — NEW: `src/__tests__/runDetectorWatchdog.test.ts`

Pure unit tests for the mode-aware watchdog. Mock the underlying detector functions via `vi.mock` since they touch `document` (jsdom can provide a body but we want focused behaviour tests).

Create the file with this exact content:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDetectorWatchdog } from '../content/detectionRules';
import { DetectionTrigger } from '../types/messages';

// Mock the detector primitives so we control which fires.
vi.mock('../content/cloudflareDetector', () => ({
  detectCloudflareChallenge: vi.fn(() => ({ detected: false })),
  waitForChallengeToClear: vi.fn(),
}));

vi.mock('../content/cookieBannerDetector', () => ({
  detectCookieBanner: vi.fn(() => false),
}));

vi.mock('../content/visibility', () => ({
  isVisible: vi.fn(() => true),
}));

import { detectCloudflareChallenge } from '../content/cloudflareDetector';
import { detectCookieBanner } from '../content/cookieBannerDetector';

describe('runDetectorWatchdog — mode: all (default)', () => {
  beforeEach(() => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: false });
    vi.mocked(detectCookieBanner).mockReturnValue(false);
    document.body.innerHTML = '';
  });

  it('returns no-fire when nothing matches', () => {
    expect(runDetectorWatchdog()).toEqual({ fired: false, trigger: DetectionTrigger.UNCONDITIONAL });
  });

  it('fires on cloudflare when detected', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.CLOUDFLARE });
  });

  it('fires on loginWall when password input visible', () => {
    document.body.innerHTML = '<input type="password" />';
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.LOGIN_WALL });
  });

  it('fires on cookieBanner in mode=all', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog(undefined, 'all')).toEqual({ fired: true, trigger: DetectionTrigger.COOKIE_BANNER });
  });

  it('fires on extraSelectors when present', () => {
    document.body.innerHTML = '<div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] })).toEqual({
      fired: true,
      trigger: DetectionTrigger.CUSTOM_SELECTOR,
    });
  });

  it('respects per-config disable for cookieBanner', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog({ cookieBanner: false })).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('respects per-config disable for cloudflare', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog({ cloudflare: false })).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });
});

describe('runDetectorWatchdog — mode: confirmedOnly', () => {
  beforeEach(() => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: false });
    vi.mocked(detectCookieBanner).mockReturnValue(false);
    document.body.innerHTML = '';
  });

  it('still fires on cloudflare', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CLOUDFLARE,
    });
  });

  it('still fires on loginWall', () => {
    document.body.innerHTML = '<input type="password" />';
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.LOGIN_WALL,
    });
  });

  it('still fires on extraSelectors', () => {
    document.body.innerHTML = '<div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] }, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CUSTOM_SELECTOR,
    });
  });

  it('SUPPRESSES cookieBanner detection even when match exists', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('SUPPRESSES captcha detection even when match exists', () => {
    document.body.innerHTML = '<iframe src="https://www.google.com/recaptcha/foo"></iframe>';
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('priority: cloudflare beats both speculative and confirmed siblings', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    document.body.innerHTML = '<input type="password" /><div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] }, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CLOUDFLARE,
    });
  });
});
```

If `vitest` is not configured for jsdom, this file may need a `// @vitest-environment jsdom` directive at the top. Check existing tests in `src/__tests__/` for the convention. If others (e.g. `parseExtraSelectors.test.ts`) don't need a directive, neither does this one — vitest config sets jsdom globally.

---

## 4. Verification

### 4.1 — Automated

```bash
npm run type-check    # MUST pass — runDetectorWatchdog signature widened (default arg keeps existing callers compiling)
npm test              # all existing vitest green + new runDetectorWatchdog.test.ts (12 cases)
npm run lint          # ESLint clean
npm run build         # WXT build clean
```

### 4.2 — Manual smoke (in this order)

Build (`npm run build`), reload extension.

1. **Cold-start with cookie banner — should NOT pause anymore.** Open https://www.theguardian.com (banner showing). Run a config that scrapes the loaded-page text. Expected: NO pause. Scrape proceeds because cookie banner doesn't actually block text scraping. Result viewer shows scraped content.

2. **Cold-start with cookie banner that DOES block scrolling.** Open a site whose banner pattern locks scroll (modal-style with `body { overflow: hidden }`). Run a config that does scroll-to-bottom. Expected: scroll fails (gets stuck) → post-failure watchdog runs → cookie banner detected → pause. Dismiss banner. Click Continue. Expected: scroll retries, reaches bottom, scrape completes.

3. **Cold-start with cloudflare.** Open a cloudflare-protected URL. Run any config. Expected: cold-start watchdog still fires for cloudflare. Pause banner shows. Complete challenge. Click Continue. Flow proceeds.

4. **Cold-start with login wall.** Open a site requiring login. Run any config. Expected: cold-start watchdog still fires for loginWall. Pause shows. Sign in (page navigates). Banner persists across nav (PR1.6). Click Continue. Flow proceeds with cold-start re-check on the logged-in page.

5. **`extraSelectors` still pre-emptive.** Build a config with `.paywall` in extraSelectors. Open a page where `.paywall` exists. Run. Expected: cold-start watchdog fires on extraSelectors (still in confirmed tier). Pause shows. Dismiss. Continue. Flow proceeds.

6. **Click step blocked by banner overlay.** Open a site where the cookie banner sits over the click target (z-index covering). Run a config with a click step targeting the covered element. Expected: click step fails (no contentChange detected, or click intercepted) → post-failure watchdog fires on cookieBanner → pause. Dismiss. Continue. Click retries successfully.

7. **Step fails for non-detection reason — should not pause.** Build a config with an intentionally wrong selector (`#does-not-exist`). Run. Expected: click fails → post-failure watchdog runs → no detector matches → original error propagates → step shown as error in result viewer. NO pause.

8. **Retry budget: only one retry per step.** Trigger a post-failure pause. After resume, the page still has the obstacle (e.g. user clicked Continue without dismissing). Expected: step retries once, fails again, second post-failure watchdog NOT triggered (retried=true), original error propagates → step shown as error.

9. **`SkipIterationError` does NOT trigger retry.** Build a `bestMatch` config with a search term that doesn't match anything (forces `SkipIterationError`). Run. Expected: iteration is marked skipped, NO post-failure watchdog runs, NO pause.

10. **Cookie-banner detector tightening — Quantcast no longer auto-fires.** Visit a site that loads Quantcast for ads only (most major news sites). Open DevTools console; type:

    ```js
    document.querySelectorAll('iframe[src*="quantcast.com"]').length
    ```

    If > 0, run a config that just scrapes (no navigation). Expected: NO pause from quantcast iframe match (selector removed).

11. **Cookie-banner detector tightening — small CMP iframes ignored.** Inject a fake small Sourcepoint iframe on any page via DevTools:

    ```js
    const f = document.createElement('iframe');
    f.id = 'sp_message_iframe_test';
    f.src = 'about:blank';
    f.style.width = '50px';
    f.style.height = '20px';
    document.body.appendChild(f);
    ```

    Run a config. Expected: NO pre-emptive pause (iframe smaller than 200×100 threshold). Remove the iframe.

### 4.3 — Smoke confirmation

Report passes/failures and any false positives or negatives observed in the wild.

---

## 5. Maintainability checklist (per CLAUDE.md Stage F)

- [ ] **No magic strings.** `'all' | 'confirmedOnly'` is a literal-union type; `WatchdogMode` is exported for callers that import it.
- [ ] **Narrow types.** `WatchdogMode` is a 2-member union; default arg keeps all existing callers source-compatible.
- [ ] **Minimal public surface.** Only `runDetectorWatchdog` signature widened. `evaluateDetectionRules` (used by `awaitUserAction`) untouched.
- [ ] **Reuse > create.** Reuses existing detectors, existing `runWatchdogPause`, existing continuation/pause infrastructure from PR1.6. Only new code is the retry loop and the size-threshold check.
- [ ] **One responsibility per module.** `detectionRules.ts` decides what fires. `cookieBannerDetector.ts` decides what counts as a banner. `scrapingEngine.ts` decides when to check.
- [ ] **Tests.** 12 new vitest cases in `runDetectorWatchdog.test.ts`. Cookie-banner tightening is integration-tested via manual smoke (mocking `getBoundingClientRect` for jsdom is brittle and low-value).
- [ ] **Backward compat.** v3/v4/v5 configs unchanged. `runDetectorWatchdog` default arg preserves old behaviour for any external caller. Per-config `cookieBanner: false` etc. still works.
- [ ] **Edge case decisions.**
  - Step retries ONCE on detection match. Unlimited retries would loop forever if user clicks Continue without resolving the obstacle.
  - SkipIterationError treated as meaningful, not as failure-needing-retry.
  - `extraSelectors` stays in confirmed tier — user-curated, treated as authoritative.

---

## 6. Out of scope

- Resume-with-feedback / learning loop (PR1.8).
- Network-level login detection (later).
- Pick-element UI for `extraSelectors` (later).
- Per-domain auto-suppression of false-positive triggers (PR1.8).
- Auto-dismissal of cookie banners (out of scope entirely).

---

## 7. Stuck-loop escalation

Per global CLAUDE.md: if two consecutive attempts at the same fix fail, stop and report. Likely failure modes:

- **Retry loop never exits.** The `break` after a successful `executeStep` MUST be the only exit besides `throw`. If you accidentally wrap the `break` in another condition, the loop runs forever. Verify: a clean step success path goes straight to `break`.
- **CANCEL_CONTINUATION fires twice for navigating steps.** The post-PR1.6 finally already sends CANCEL_CONTINUATION. The retry loop is INSIDE that finally's try, not outside — so the finally runs once, after the retry loop completes (either via break or throw). If you see double-cancel logs, you've nested the finally incorrectly.
- **Retry pause uses `confirmedOnly` instead of `all`.** The retry pause MUST use `'all'` so the speculative tier (cookie banner, captcha) keeps blocking. If you accidentally pass `'confirmedOnly'`, the retry pauses only when there's a confirmed obstacle — defeating the whole point.
- **Step that succeeded after navigation doesn't get the post-nav settle delay.** The `if (isNavigating && url changed) randomDelay` block must remain AFTER the retry loop, not inside it. Otherwise the settle runs on every retry attempt, even the failing ones.
