import { resolveElement, resolveWithAlternate } from './elementResolution';
import { extractPageBlocks, mergePages, type PageContent } from '../extraction/pageBlockExtractor';
import { findBestMatch } from '../../common/tokenMatcher';
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
import {
  waitForElement,
  waitForContentChange,
  expandHiddenElements,
  CHART_LIB_PATTERN,
} from '../extraction/domUtils';
import { extractTable } from '../extraction/tableExtractor';
import { extractTableHeadersWithPaths } from '../extraction/tableExtractor';
import { extractChartData } from '../extraction/chartExtractor';
import { shapeTable, shapeChart } from '../shaping';
import type { WireOutput, WireIteration } from '../shaping';
import { slugify, disambiguate } from '../../utils/slugify';
import { paginatePages, paginateElement } from './paginationHandler';
import { PREFS_KEY } from '../../sidepanel/utils/storage';
import { swLog } from '../../utils/swLog';
import { filterByExcludedIndices } from '../extraction/tableFilterUtils';
import { waitForChallengeToClear } from '../cloudflareDetector';
import { evaluateDetectionRules, runDetectorWatchdog } from '../detectionRules';
import { MessageType, PauseReason, DetectionTrigger } from '../../types/messages';
import { PreflightTimer } from './preflightTimer';
import { PREFLIGHT_QUIET_MS } from './constants';
import type { AutoDetectConfig } from '../../types/config';
import type {
  ScraperConfig,
  Step,
  ClickStep,
  BestMatchStep,
  GoBackStep,
  ScrapeStep,
  SelectEachStep,
  CaptureApiCallsStep,
  AwaitUserActionStep,
  NavigateToStep,
  ScrapeElementConfig,
  SelectorDescriptor,
  StepCondition,
} from '../../types/config';
import type { ScrapingResult } from '../../types/extraction';

let abortSignal = false;
let flowRunning = false;

// One PreflightTimer per executeFlow() invocation. Set in executeFlow's
// entry block, cleared in the finally. Module-scope so the
// FORCE_PREFLIGHT_READY listener (registered once per content-script
// load) can reach the active flow's timer. Null when no flow is running
// or when the active flow has no taskId (sidepanel-only mode).
let activePreflightTimer: PreflightTimer | null = null;

// Runtime-toggleable: when true, scrape output includes verbose diagnostic
// fields (saved-descriptor dumps on chart-resolution failures, etc.). The
// initial value is loaded from chrome.storage.local prefs (key set by the
// "Developer Options â†’ Show debug info in scrape output" checkbox in the
// sidepanel) and kept in sync via storage.onChanged. Off by default.
let DEBUG = false;

(async () => {
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = (result[PREFS_KEY] as Record<string, unknown> | undefined) || {};
    DEBUG = !!prefs.debug;
  } catch { /* expected */ }
})();

try {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[PREFS_KEY];
    if (!change) return;
    const next = (change.newValue as Record<string, unknown> | undefined) || {};
    DEBUG = !!next.debug;
  });
} catch { /* expected: SW restart timing */ }

try {
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as Record<string, unknown> | null;
    if (m?.type !== MessageType.FORCE_PREFLIGHT_READY) return;
    const payload = (m.payload ?? {}) as { taskId?: string };
    const t = activePreflightTimer;
    if (!t) {
      swLog('[FORCE_PREFLIGHT_READY] ignored — no active timer | requestedTaskId:', payload.taskId);
      return;
    }
    if (payload.taskId && payload.taskId !== t.taskId) {
      swLog('[FORCE_PREFLIGHT_READY] ignored — taskId mismatch | requested:', payload.taskId, '| active:', t.taskId);
      return;
    }
    t.force();
  });
} catch { /* expected: SW restart timing */ }

const NAVIGATING_STEP_TYPES = new Set(['click', 'bestMatch', 'goBack', 'navigateTo']);

export function abortFlow(): void {
  swLog('[abortFlow] called | flowRunning was:', flowRunning, '| stack:', new Error().stack);
  abortSignal = true;
  flowRunning = false;
}

export interface ExecuteFlowParams {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  afk?: boolean;
  startTermIndex?: number;
  startLoopStepIndex?: number;
  previousIterations?: WireIteration[];
}

export async function executeFlow(params: ExecuteFlowParams): Promise<ScrapingResult> {
  const {
    config,
    searchTerms,
    taskId,
    afk = false,
    startTermIndex = 0,
    startLoopStepIndex = 0,
    previousIterations = [],
  } = params;

  swLog('[executeFlow] called | taskId:', taskId, '| flowRunning:', flowRunning, '| searchTerms:', searchTerms, '| startTermIndex:', startTermIndex, '| startLoopStepIndex:', startLoopStepIndex, '| previousIterations.length:', previousIterations.length);
  if (flowRunning) {
    swLog('[executeFlow] BLOCKED by flowRunning guard — original flow still running, suppressing duplicate');
    return {
      configId: config.id,
      configName: config.name,
      scrapedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      iterations: [],
      totalTimeMs: 0,
      aborted: true,
      guardBlocked: true,
    };
  }
  flowRunning = true;
  abortSignal = false;

  // Pre-flight quiet timer: armed only for queue-mode flows (taskId set).
  // Sidepanel-only flows (no taskId) have no batch concept and skip the
  // timer entirely. Cancelled/re-armed by every detector pause and
  // explicitly cleared in the outer finally.
  if (taskId) {
    activePreflightTimer = new PreflightTimer({
      taskId,
      durationMs: PREFLIGHT_QUIET_MS,
      emit: (msg) => {
        browser.runtime.sendMessage(msg).catch(() => { /* SW asleep — drop */ });
      },
    });
    activePreflightTimer.arm();
    swLog('[preflightTimer] armed | taskId:', taskId, '| durationMs:', PREFLIGHT_QUIET_MS);
  }

  const startTime = Date.now();

  try {
    const isResume = startTermIndex > 0 || startLoopStepIndex > 0;

    const result: ScrapingResult = {
      configId: config.id,
      configName: config.name,
      scrapedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      iterations: [...previousIterations],
      totalTimeMs: 0,
    };

    const setupSteps = config.steps.filter((s) => s.isSetup);
    const loopSteps = config.steps.filter((s) => !s.isSetup);

    if (!isResume) {
      try {
        // Cold-start watchdog — runs once before any setup step so cookie
        // banners / login walls / cloudflare gates on the initial page are
        // caught even when the config has no leading navigateTo step.
        // Skipped on resume because the post-navigation watchdog at line ~227
        // already cleared the gate in the prior run-leg.
        swLog('[cold-start watchdog] enter | url:', window.location.href, '| autoDetect:', config.autoDetect);
        await runWatchdogPause(config.autoDetect, taskId, {
          config,
          searchTerms,
          previousIterations: result.iterations,
          startTermIndex: 0,
          startLoopStepIndex: 0,
        }, 'confirmedOnly');
        swLog('[cold-start watchdog] exit');

        for (const step of setupSteps) {
          checkAbort();
          await executeStep(step, null, 0, (msg) => sendProgress({ phase: 'setup', stepLabel: msg, status: 'running', taskId }), afk, taskId);
        }
      } catch (err) {
        const e = err as Error;
        if (e.message === 'ABORTED') {
          result.totalTimeMs = Date.now() - startTime;
          swLog('[executeFlow] setup ABORTED return | taskId:', taskId, '| iterations:', result.iterations.length, '| totalTimeMs:', result.totalTimeMs);
          return { ...result, aborted: true };
        }
        swLog('[executeFlow] setup phase error | taskId:', taskId, '| name:', e.name, '| msg:', e.message, '| stack:', e.stack);
        sendProgress({ phase: 'setup', stepLabel: '', status: 'error', taskId });
      }
    }

    const terms = searchTerms.length > 0 ? searchTerms : [null];
    const usedIterKeys = new Set<string>(previousIterations.map((it) => it.iterationKey));

    for (let i = startTermIndex; i < terms.length; i++) {
      const term = terms[i];
      checkAbort();

      sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'running', taskId });
      swLog('[executeFlow] iter START | taskId:', taskId, '| termIndex:', i, '| term:', term, '| url:', window.location.href);

      const iterOutputs: Record<string, WireOutput> = {};
      let iterStatus: 'success' | 'error' | 'skipped' = 'success';
      let iterError: string | undefined;

      try {
        const siStart = i === startTermIndex ? startLoopStepIndex : 0;

        // Resumed-leg watchdog: when EXECUTE_FLOW was re-delivered via a held
        // continuation (after pause-driven navigation, or after a navigateTo
        // step that blocks until reload), the prior step's post-nav watchdog
        // never ran. Re-check before stepping into the resumed leg so a
        // still-present obstacle re-pauses rather than letting the flow run
        // through it.
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

        for (let si = siStart; si < loopSteps.length; si++) {
          checkAbort();
          // Occasional "thinking" pause: 2 % of steps get a 1–3 s pre-delay to
          // raise the noise floor against per-session timing-pattern analysis.
          if (Math.random() < 0.02) {
            await randomDelay(1000, 3000);
          }
          const step = loopSteps[si];
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: step.label, status: 'running', taskId });
          swLog('[executeFlow] step START | taskId:', taskId, '| termIndex:', i, '| stepIndex:', si, '| type:', step.type, '| label:', step.label, '| url:', window.location.href);

          const isNavigating = NAVIGATING_STEP_TYPES.has(step.type);

          if (isNavigating) {
            try {
              browser.runtime.sendMessage({
                type: 'REGISTER_CONTINUATION',
                payload: {
                  config,
                  searchTerms,
                  taskId,
                  startTermIndex: i,
                  startLoopStepIndex: si + 1,
                  previousIterations: result.iterations,
                },
              });
            } catch { /* extension context may be invalidated */ }
          }

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
            // Always cancel the continuation for navigating steps â€” including when
            // the step throws (e.g. SkipIterationError). Without this, a phantom
            // continuation sits in the background and fires on the next navigation,
            // corrupting subsequent iterations.
            if (isNavigating) {
              try {
                browser.runtime.sendMessage({ type: 'CANCEL_CONTINUATION' });
                swLog('[executeFlow] CANCEL_CONTINUATION sent | taskId:', taskId, '| stepIndex:', si);
              } catch { /* expected */ }
            }
          }

          if (stepData !== null && step.type === 'scrape') {
            Object.assign(iterOutputs, stepData as Record<string, WireOutput>);
            swLog('[executeFlow] scrape merged into iterOutputs | taskId:', taskId, '| stepIndex:', si, '| outputKeys:', Object.keys(iterOutputs));
          }
        }

        sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'success', taskId });
        swLog('[executeFlow] iter END success | taskId:', taskId, '| termIndex:', i, '| outputKeys:', Object.keys(iterOutputs));
      } catch (err) {
        const e = err as Error;
        swLog('[executeFlow] iter CATCH | taskId:', taskId, '| termIndex:', i, '| name:', e.name, '| msg:', e.message, '| stack:', e.stack);
        if (e.message === 'ABORTED') {
          result.iterations.push({
            schemaVersion: 1,
            iterationKey: disambiguate(slugify(term ?? '') || 'default', usedIterKeys),
            iterationLabel: term ?? '',
            searchTerm: term,
            outputs: iterOutputs,
            status: 'error',
            error: 'Aborted by user',
          });
          swLog('[executeFlow] iter ABORTED — breaking outer loop | taskId:', taskId, '| termIndex:', i);
          break;
        }
        if (e.name === 'SkipIterationError') {
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: e.message, status: 'skipped', taskId });
          iterStatus = 'skipped';
          iterError = e.message;
        } else {
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: e.message, status: 'error', taskId });
          iterStatus = 'error';
          iterError = e.message;
        }
      }

      const iterKey = disambiguate(slugify(term ?? '') || 'default', usedIterKeys);
      usedIterKeys.add(iterKey);
      result.iterations.push({
        schemaVersion: 1,
        iterationKey: iterKey,
        iterationLabel: term ?? '',
        searchTerm: term,
        outputs: iterOutputs,
        status: iterStatus,
        error: iterError,
      });

      if (i < terms.length - 1) {
        // Inter-iteration pause (2â€“8s)
        await randomDelay(2000, 8000);

        // Every 25 iterations: longer idle pause (15â€“60s)
        if (i > 0 && i % 25 === 0) {
          await randomDelay(15_000, 60_000);
        }
      }
    }

    result.totalTimeMs = Date.now() - startTime;
    swLog('[executeFlow] normal return | taskId:', taskId, '| iterations.length:', result.iterations.length, '| totalTimeMs:', result.totalTimeMs);
    return result;
  } finally {
    swLog('[executeFlow] finally â€” clearing flowRunning | taskId:', taskId);
    flowRunning = false;
    if (activePreflightTimer) {
      activePreflightTimer.cancel();
      activePreflightTimer = null;
    }
    // Cancel any lingering pause-continuation. End-of-flow cleanup so a
    // stale continuation can't fire on a future tab navigation.
    try {
      browser.runtime.sendMessage({ type: MessageType.CANCEL_CONTINUATION });
    } catch { /* extension context may be invalidated */ }
  }
}

// â”€â”€ Resume signal â”€â”€

function waitForResumeSignal(): Promise<void> {
  swLog('[waitForResumeSignal] arming listener');
  return new Promise((resolve) => {
    const handler = (msg: unknown): void => {
      const t = (msg as Record<string, unknown>)?.type;
      // Accept both new MessageType.RESUME_AFTER_PAUSE and legacy RESUME_AFTER_CLOUDFLARE
      if (t === MessageType.RESUME_AFTER_PAUSE || t === 'RESUME_AFTER_CLOUDFLARE') {
        swLog('[waitForResumeSignal] resume received | type:', t);
        browser.runtime.onMessage.removeListener(handler);
        resolve();
      }
    };
    browser.runtime.onMessage.addListener(handler);
  });
}

function messageForTrigger(trigger: DetectionTrigger): string {
  switch (trigger) {
    case DetectionTrigger.LOGIN_WALL:       return 'Sign in to continue.';
    case DetectionTrigger.COOKIE_BANNER:    return 'Dismiss the cookie banner to continue.';
    case DetectionTrigger.CAPTCHA:          return 'Solve the captcha to continue.';
    case DetectionTrigger.CUSTOM_SELECTOR:  return 'Action needed in your browser.';
    default:                                return 'Action needed in your browser.';
  }
}

interface PauseResumeContext {
  config: ScraperConfig;
  searchTerms: string[];
  previousIterations: WireIteration[];
  startTermIndex: number;
  startLoopStepIndex: number;
}

// Post-navigation watchdog. Wire-protocol decision:
//   - cloudflare uses reason='cloudflare' (existing dispatcher routes to CloudflarePauseAlert + auto-clear race)
//   - everything else uses reason='awaitUserAction' with a trigger field (existing dispatcher routes to AwaitActionPauseAlert)
// PR4 will rationalise the taxonomy once the dispatcher is rewritten.
//
// Pause-resilience: before sending FLOW_PAUSED we register a continuation
// pointing at the current leg. If the user resolves the obstacle via an
// action that navigates the page (Accept All cookies, login submit), the
// content script dies but the SW holds the continuation until the user
// clicks Continue, then re-delivers EXECUTE_FLOW so the flow resumes
// from the same leg on the new page.
async function runWatchdogPause(
  cfg: AutoDetectConfig | undefined,
  taskId: string | undefined,
  resumeCtx: PauseResumeContext,
  mode: 'all' | 'confirmedOnly' = 'all',
): Promise<void> {
  const result = runDetectorWatchdog(cfg, mode);
  swLog('[watchdog] result | fired:', result.fired, '| trigger:', result.trigger, '| cfg:', cfg);
  if (!result.fired) return;

  // Reset the pre-flight quiet window: a detector just fired, so the page
  // is not yet stable. Re-armed below after the user clicks Continue.
  activePreflightTimer?.cancel();

  swLog('[watchdog] fired | taskId:', taskId, '| trigger:', result.trigger, '| url:', window.location.href);

  // Register a pause-continuation pointing at the current leg. If the user
  // resolves the obstacle via page-navigating action, the held continuation
  // re-delivers EXECUTE_FLOW after the user clicks Continue.
  try {
    browser.runtime.sendMessage({
      type: MessageType.REGISTER_CONTINUATION,
      payload: {
        config: resumeCtx.config,
        searchTerms: resumeCtx.searchTerms,
        taskId,
        startTermIndex: resumeCtx.startTermIndex,
        startLoopStepIndex: resumeCtx.startLoopStepIndex,
        previousIterations: resumeCtx.previousIterations,
      },
    });
    swLog('[watchdog] pause-continuation registered | startTermIndex:', resumeCtx.startTermIndex, '| startLoopStepIndex:', resumeCtx.startLoopStepIndex);
  } catch { /* extension context may be invalidated */ }

  if (result.trigger === DetectionTrigger.CLOUDFLARE) {
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: { reason: PauseReason.CLOUDFLARE, taskId },
    });
    await Promise.race([waitForChallengeToClear().promise, waitForResumeSignal()]);
  } else {
    browser.runtime.sendMessage({
      type: MessageType.FLOW_PAUSED,
      payload: {
        reason: PauseReason.AWAIT_USER_ACTION,
        trigger: result.trigger,
        message: messageForTrigger(result.trigger),
        domain: window.location.hostname,
        taskId,
      },
    });
    await waitForResumeSignal();
  }

  swLog('[watchdog] cleared/resumed | taskId:', taskId);
  // Restart the pre-flight quiet window: the user just cleared the gate;
  // give the page another full PREFLIGHT_QUIET_MS to settle before
  // declaring the task pre-flight ready.
  activePreflightTimer?.arm();
  browser.runtime.sendMessage({ type: MessageType.FLOW_RESUMED });
}

// â”€â”€ Wait after action â”€â”€

async function waitAfterAction(
  opts: { waitMethod?: string; waitAfterMs?: number; waitForSelector?: SelectorDescriptor | null },
  onProgress: OnProgress,
  defaultMethod = 'fixedDelay',
): Promise<void> {
  const waitMethod = opts.waitMethod || defaultMethod;
  const waitMs = opts.waitAfterMs ?? 1500;
  const wStart = Date.now();
  const urlBefore = window.location.href;
  swLog('[waitAfterAction] enter | method:', waitMethod, '| waitMs:', waitMs, '| urlBefore:', urlBefore);

  if (waitMethod === 'contentChange') {
    onProgress?.('Waiting for page to update...');
    try {
      const changed = await waitForContentChange(document.body.textContent ?? '', 10000);
      swLog('[waitAfterAction] contentChange resolved | changed:', changed, '| ms:', Date.now() - wStart, '| urlAfter:', window.location.href);
    } catch (err) {
      swLog('[waitAfterAction] contentChange threw | ms:', Date.now() - wStart, '| err:', (err as Error).message);
      onProgress?.('Page did not change within timeout â€” continuing');
    }
  } else if (waitMethod === 'element' && opts.waitForSelector) {
    onProgress?.('Waiting for element to appear...');
    const desc = opts.waitForSelector;
    try {
      await waitForElement(() => resolveElement(desc).element, 10000);
      swLog('[waitAfterAction] element appeared | ms:', Date.now() - wStart, '| urlAfter:', window.location.href);
    } catch (err) {
      swLog('[waitAfterAction] element wait threw | ms:', Date.now() - wStart, '| err:', (err as Error).message);
      onProgress?.('Wait-for element did not appear within timeout â€” continuing');
    }
  } else {
    await randomDelay(waitMs * 0.8, waitMs * 1.2);
    swLog('[waitAfterAction] fixedDelay done | ms:', Date.now() - wStart, '| urlAfter:', window.location.href);
  }
}

// â”€â”€ Step conditions â”€â”€

export function evaluateCondition(cond: StepCondition): boolean {
  try {
    if (cond.kind === 'urlMatches') {
      const regex = new RegExp(cond.pattern);
      const matches = regex.test(window.location.href);
      return cond.negate ? !matches : matches;
    }
    if (cond.kind === 'elementPresent') {
      const { confidence } = resolveElement(cond.selector);
      const present = confidence > 0;
      return cond.negate ? !present : present;
    }
    return true;
  } catch {
    // Invalid regex, missing selector fields, or any unexpected throw â†’ fail-closed.
    // Running a step on the wrong page is worse than skipping it.
    return false;
  }
}

// â”€â”€ Step dispatch â”€â”€

type OnProgress = ((msg: string) => void) | undefined;

async function executeStep(
  step: Step,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
  taskId?: string,
): Promise<Record<string, unknown> | null> {
  if (step.condition) {
    const passed = evaluateCondition(step.condition);
    if (!passed) {
      onProgress?.(`Skipping ${step.label || step.type}: condition not met`);
      return null;
    }
  }

  switch (step.type) {
    case 'setInput':
      return executeSetInput(step, searchTerm, iterationIndex, onProgress, afk);
    case 'click':
      return executeClick(step, onProgress, afk);
    case 'bestMatch':
      return executeBestMatch(step, searchTerm, onProgress, afk);
    case 'goBack':
      return executeGoBack(step, onProgress);
    case 'scrape':
      return executeScrape(step, onProgress, afk);
    case 'selectEach':
      return executeSelectEach(step, onProgress, afk);
    case 'captureApiCalls':
      return executeCaptureApiCalls(step, onProgress);
    case 'awaitUserAction':
      return executeAwaitUserAction(step, onProgress, taskId);
    case 'navigateTo':
      return executeNavigateTo(step, searchTerm, onProgress);
    default:
      onProgress?.(`Unknown step type`);
      return null;
  }
}

async function executeSetInput(
  step: import('../../types/config').SetInputStep,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;
  swLog('[setInput] iterationIndex:', iterationIndex, '| literalValue:', opts.literalValue, '| searchTerm:', searchTerm, '| valueToType will be:', opts.literalValue ?? searchTerm ?? '');

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

  void iterationIndex; // No longer used â€” alternate is iteration-independent.
  void afk; // afk mode: typeText handles delays; no change needed for text input
  return null;
}

async function executeClick(
  step: ClickStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;
  const el = await resolveWithRetry(
    step.selector!,
    opts.alternateSelector ?? null,
    onProgress,
    step.label || 'button',
  );

  onProgress?.(`Clicking ${step.label || 'element'}`);
  await naturalClick(el, { afk });

  await waitAfterAction(opts, onProgress);
  return null;
}

const STRICTNESS_THRESHOLDS: Record<string, number> = { loose: 0.3, normal: 0.5, strict: 0.7 };

async function executeBestMatch(
  step: BestMatchStep,
  searchTerm: string | null,
  onProgress: OnProgress,
  afk: boolean,
): Promise<{ matchedText: string; matchScore: number } | null> {
  const opts = step.options;
  const strictness = opts.matchStrictness || 'normal';
  const threshold = STRICTNESS_THRESHOLDS[strictness] ?? 0.5;
  const fuzzy = strictness === 'loose';

  if (!searchTerm) {
    throw new SkipIterationError('No search term provided for best match step');
  }
  if (!opts.containerSelector) {
    throw new SkipIterationError('No container configured for best match step');
  }

  const { element: container } = resolveWithAlternate(
    opts.containerSelector,
    opts.alternateContainerSelector ?? null,
  );
  if (!container) {
    // Pass-through: assume we've already landed on the destination page
    // (e.g. search that sometimes hits disambiguation, sometimes the article directly).
    // Caveat: relies on container (and alternate) selectors being specific enough not
    // to exist on the "already-landed" page.
    onProgress?.('Best-match container not found on this page â€” continuing as if already on destination');
    return null;
  }

  const clickableSelector = opts.clickableFilter || 'a, button';
  let clickableElements = Array.from(container.querySelectorAll<HTMLElement>(clickableSelector))
    .filter((el) => el.offsetParent !== null);

  if (opts.sameOriginOnly ?? true) {
    const currentHost = location.host;
    const before = clickableElements.length;
    clickableElements = clickableElements.filter((el) => {
      if (!(el instanceof HTMLAnchorElement) || !el.href) return true;
      try {
        return new URL(el.href, location.href).host === currentHost;
      } catch {
        return true;
      }
    });
    if (clickableElements.length < before) {
      onProgress?.(`Filtered to ${clickableElements.length} same-site links (dropped ${before - clickableElements.length} off-site)`);
    }
  }

  onProgress?.(`Found ${clickableElements.length} clickable elements in container, scoring against "${searchTerm}"`);

  if (clickableElements.length === 0) {
    throw new SkipIterationError(`No clickable elements found in container for "${searchTerm}"`);
  }

  const { element: bestEl, score, text } = findBestMatch(clickableElements, searchTerm, threshold, fuzzy);

  if (!bestEl) {
    const topCandidate = (clickableElements[0] as HTMLElement).innerText?.trim().substring(0, 50) || '(empty)';
    throw new SkipIterationError(
      `No clickable element matched "${searchTerm}" at ${strictness} strictness. Closest: "${topCandidate}"`,
    );
  }

  if (bestEl instanceof HTMLAnchorElement && bestEl.hasAttribute('download')) {
    bestEl.removeAttribute('download');
  }

  const displayScore = Math.min(score * 100, 100).toFixed(0);
  onProgress?.(`Clicking best match: "${text.substring(0, 50)}" (${displayScore}% match)`);

  const clickHref = bestEl instanceof HTMLAnchorElement ? bestEl.href : '(non-anchor)';
  swLog('[bestMatch] about to click | matchText:', text.substring(0, 80), '| score:', score, '| href:', clickHref, '| urlBefore:', window.location.href);

  await randomDelay(300, 800);
  await naturalClick(bestEl as HTMLElement, { afk });

  swLog('[bestMatch] click done, entering waitAfterAction(contentChange) | urlAfterClick:', window.location.href);
  await waitAfterAction(opts, onProgress, 'contentChange');
  swLog('[bestMatch] waitAfterAction returned | urlNow:', window.location.href);

  return { matchedText: text.substring(0, 100), matchScore: score };
}

async function executeGoBack(step: GoBackStep, onProgress: OnProgress): Promise<null> {
  onProgress?.('Going back to previous page...');
  history.back();
  await waitAfterAction(step.options, onProgress, 'contentChange');
  return null;
}

async function scrapeElementToWire(
  elConfig: ScrapeElementConfig,
  onProgress: OnProgress,
  afk: boolean,
  paginationDelayMs: number | undefined,
  usedKeys: Set<string>,
): Promise<{ outputKey: string; output: WireOutput }> {
  const baseKey = elConfig.outputKey?.trim()
    ? slugify(elConfig.outputKey.trim())
    : slugify(elConfig.name) || 'output';
  const outputKey = disambiguate(baseKey, usedKeys);

  const rawResult = await scrapeElement(elConfig, onProgress, afk, paginationDelayMs);

  if (elConfig.detectedType === 'table' && Array.isArray(rawResult)) {
    const { element: el } = resolveElement(elConfig.selector);
    const tableEl = el
      ? el.tagName === 'TABLE'
        ? el
        : el.querySelector('table')
      : null;
    const headerPaths = tableEl
      ? extractTableHeadersWithPaths(tableEl as Element)
      : (rawResult as Record<string, unknown>[]).length > 0
        ? Object.keys((rawResult as Record<string, unknown>[])[0])
            .filter((k) => k !== '_group')
            .map((k) => ({ flatKey: k, path: [k] }))
        : [];

    const wireTable = shapeTable(rawResult as Record<string, unknown>[], headerPaths, elConfig);
    wireTable.label = outputKey;
    return { outputKey, output: wireTable };
  }

  if (elConfig.detectedType === 'chart') {
    return { outputKey, output: shapeChart(rawResult, outputKey) };
  }

  return { outputKey, output: { kind: 'raw', data: rawResult } };
}

async function executeScrape(
  step: ScrapeStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, WireOutput>> {
  const opts = step.options;
  const outputs: Record<string, WireOutput> = {};
  swLog('[executeScrape] enter | mode:', opts.mode, '| elements:', opts.elements?.length ?? 0, '| url:', window.location.href);

  if (opts.mode === 'wholePage') {
    onProgress?.('Scraping whole page...');
    const pageData = await scrapeWholePage(opts, onProgress, afk);
    outputs['page'] = { kind: 'raw', data: pageData };
  } else {
    const usedKeys = new Set<string>();
    for (const elConfig of opts.elements || []) {
      onProgress?.(`Scraping "${elConfig.name}"...`);
      const { outputKey, output } = await scrapeElementToWire(elConfig, onProgress, afk, opts.paginationDelayMs, usedKeys);
      usedKeys.add(outputKey);
      outputs[outputKey] = output;
    }
  }

  swLog('[executeScrape] exit | keys:', Object.keys(outputs));
  return outputs;
}

async function executeSelectEach(
  step: SelectEachStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  const opts = step.options.selectEachOptions;
  const data: Record<string, unknown> = {};

  const controlEl = await resolveWithRetry(opts.controlSelector!, null, onProgress, 'control');
  const selectedOptions = (opts.options || []).filter((o) => o.selected);

  onProgress?.(`Select Each: iterating ${selectedOptions.length} options`);

  for (const option of selectedOptions) {
    checkAbort();
    onProgress?.(`Selecting option: ${option.label}`);

    if (opts.controlType === 'select') {
      await selectOption(controlEl, option.value);
    } else {
      const optEl = findOptionElement(controlEl, option);
      if (optEl) await naturalClick(optEl, { afk });
    }

    const waitMs = opts.waitAfterSelectMs ?? 1500;
    await randomDelay(waitMs * 0.7, waitMs * 1.3);

    const optionData: Record<string, Record<string, WireOutput>> = {};
    for (const subStep of opts.subSteps || []) {
      checkAbort();
      if (subStep.type === 'scrape') {
        const subData = await executeScrape(subStep, onProgress, afk);
        Object.assign(optionData, subData);
      }
    }

    data[option.label] = optionData;
  }

  return data;
}

async function executeCaptureApiCalls(step: CaptureApiCallsStep, onProgress: OnProgress): Promise<null> {
  const opts = step.options;
  const nonce = (window as Window & { __bb_nonce?: string }).__bb_nonce ?? '';

  onProgress?.('Starting API capture...');
  window.postMessage({ type: '__bb_start_recording', nonce, urlPattern: opts.urlPattern }, '*');

  onProgress?.(`Capturing API calls for ${opts.durationMs}ms...`);
  await new Promise<void>((r) => setTimeout(r, opts.durationMs));

  window.postMessage({ type: '__bb_stop_recording', nonce }, '*');
  onProgress?.('API capture complete');
  return null;
}

async function executeAwaitUserAction(step: AwaitUserActionStep, onProgress: OnProgress, taskId?: string): Promise<null> {
  const opts = step.options;
  const evalResult = evaluateDetectionRules(opts.detectionRules);
  swLog('[awaitUserAction] enter | taskId:', taskId, '| fired:', evalResult.fired, '| trigger:', evalResult.trigger, '| url:', window.location.href);

  if (!evalResult.fired) {
    onProgress?.(`No obstruction detected â€” skipping pause`);
    return null;
  }

  // Reset the pre-flight quiet window: a config-driven detection fired,
  // so the page isn't stable. Re-armed below after the user resumes.
  activePreflightTimer?.cancel();

  onProgress?.(`Waiting for user: ${opts.message}`);

  browser.runtime.sendMessage({
    type: MessageType.FLOW_PAUSED,
    payload: {
      reason: PauseReason.AWAIT_USER_ACTION,
      trigger: evalResult.trigger,
      message: opts.message,
      domain: window.location.hostname,
      taskId,
    },
  });

  await waitForResumeSignal();
  swLog('[awaitUserAction] resume signal received | taskId:', taskId);
  activePreflightTimer?.arm();

  browser.runtime.sendMessage({ type: MessageType.FLOW_RESUMED });
  return null;
}

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
    throw new Error(`navigateTo: unsupported scheme "${parsed.protocol}" â€” only http(s) allowed`);
  }

  onProgress?.(`Navigating to ${parsed.href}`);
  window.location.href = parsed.href;

  // Page is unloading â€” block forever so the rest of the loop iteration never runs.
  // The continuation registered at scrapingEngine.ts:166-179 will resume at si + 1
  // after the new page loads.
  await new Promise<null>(() => {});
  return null;
}

// â”€â”€ Page-level scraping â”€â”€

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
    await scrollToBottom((scrollY, totalHeight) =>
      onProgress?.(`Scrolling... ${Math.round((scrollY / totalHeight) * 100)}%`),
    { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });
  }

  if (opts.expandHidden) {
    onProgress?.('Expanding hidden sections...');
    await expandHiddenElements({ delayMs: opts.expandDelayMs });
  }

  const pages: PageContent[] = [];

  if (opts.paginate && opts.paginationSelector) {
    pages.push(await extractPageBlocks());

    const pagesScraped = await paginatePages({
      paginationSelector: opts.paginationSelector,
      pageCount: opts.pageCount || 0,
      paginationDelayMs: opts.paginationDelayMs,
      onPage: async () => {
        if (opts.scrollToBottom) await scrollToBottom(undefined, { incrementVh: opts.scrollIncrementVh, delayMs: opts.scrollDelayMs });
        pages.push(await extractPageBlocks());
      },
      onProgress,
      afk,
    });

    return { content: mergePages(pages), pagesScraped };
  }

  return { content: await extractPageBlocks(), pagesScraped: 1 };
}

// â”€â”€ Element-level scraping â”€â”€

function findPaginationContainer(tableEl: HTMLElement, paginationDescriptor: SelectorDescriptor): Element {
  const { element: paginBtn } = resolveElement(paginationDescriptor);
  if (!paginBtn) {
    return tableEl.closest('section, div, article') || tableEl.parentElement || tableEl;
  }

  let current: Element | null = tableEl.parentElement;
  while (current && current !== document.body) {
    if (current.contains(paginBtn)) return current;
    current = current.parentElement;
  }

  return tableEl.closest('section, div, article') || tableEl.parentElement || tableEl;
}

function isLikelyChart(el: Element): boolean {
  // Element renders an SVG (Highcharts, Recharts, ApexCharts, ECharts, etc.).
  if (el.querySelector('svg')) return true;
  // Self or close ancestor has a chart-library class (Chart.js / canvas-rendered libs).
  let cur: Element | null = el;
  for (let i = 0; i < 4 && cur; i++) {
    const cls = ((cur as HTMLElement).className || '').toString();
    if (CHART_LIB_PATTERN.test(cls)) return true;
    cur = cur.parentElement;
  }
  return false;
}

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
    // Sanity check: does the resolved element actually look like a chart?
    // Catches cases where the saved descriptor's fuzzy strategies mismatch on
    // refresh and land on something else (Mapbox map div, image carousel, etc).
    if (!isLikelyChart(el)) {
      const desc = elConfig.selector;
      return {
        _canExtract: false,
        _warning: "The element saved as a chart doesn't contain a chart on this page. The page layout likely shifted between when you picked the chart and now. Try re-picking the chart.",
        _resolvedTagName: (el as HTMLElement).tagName,
        _resolvedClassName: ((el as HTMLElement).className || '').toString().substring(0, 200),
        ...(DEBUG ? {
          _savedDescriptor: {
            cssSelector: desc?.cssSelector,
            xpath: desc?.xpathSelector,
            tagName: desc?.tagName,
            textContent: desc?.textContent?.substring(0, 80),
            ariaLabel: desc?.ariaLabel,
            parentSelector: desc?.position?.parentSelector,
            childIndex: desc?.position?.childIndex,
            attributes: desc?.attributes,
          },
        } : {}),
      };
    }

    const result = await extractChartData(el);
    if (!result.canExtract) {
      // Non-fatal: emit a warning entry for this chart and let the rest of
      // the iteration continue. The wholepage extractor handles unextractable
      // charts the same way (chart block with canExtract: false).
      if (result.data) {
        return { ...(result.data as unknown as Record<string, unknown>), _warning: result.message };
      }
      return {
        _canExtract: false,
        _warning: result.message,
        _resolvedTagName: (el as HTMLElement).tagName,
        _resolvedClassName: ((el as HTMLElement).className || '').toString().substring(0, 200),
      };
    }
    return result.data;
  }

  if (elConfig.detectedType === 'table') {
    const allData: Record<string, unknown>[] = [];

    const virtualWrapper = findVirtualScrollWrapper(el);
    if (virtualWrapper) {
      const virtualRows = await scrollAndCollectVirtualTable(virtualWrapper, el, onProgress);
      if (virtualRows.length > 0) {
        if (elConfig.dynamicHeaders) return filterByExcludedIndices(virtualRows, elConfig.excludedColumnIndices);
        if (elConfig.tableFields?.length > 0) return applyFieldFilter(virtualRows, elConfig.tableFields);
        return virtualRows;
      }
    }

    const scrapeCurrentPage = (): Record<string, unknown>[] => {
      const { element: freshEl } = resolveElement(elConfig.selector);
      const target = (freshEl as HTMLElement) || el;
      const rows = extractTable(target);
      if (elConfig.dynamicHeaders) return filterByExcludedIndices(rows, elConfig.excludedColumnIndices);
      if (elConfig.tableFields?.length > 0) return applyFieldFilter(rows, elConfig.tableFields);
      return rows;
    };

    if (elConfig.paginate && elConfig.paginationSelector) {
      allData.push(...scrapeCurrentPage());
      const container = findPaginationContainer(el, elConfig.paginationSelector);

      await paginateElement({
        paginationSelector: elConfig.paginationSelector,
        paginationCount: elConfig.paginationCount || 0,
        paginationDelayMs,
        container,
        onPage: async () => { allData.push(...scrapeCurrentPage()); },
        onProgress,
        afk,
      });

      return allData;
    }

    return scrapeCurrentPage();
  }

  if (elConfig.selectMode === 'all') {
    return extractContainer(el);
  }

  return el.textContent?.trim() ?? '';
}

async function extractContainer(element: HTMLElement): Promise<{ sections: unknown[] }> {
  const sections: Array<Record<string, unknown>> = [];
  const processed = new Set<Node>();

  const walk = (node: Element): void => {
    if (processed.has(node) || !node.tagName) return;

    const tag = node.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = node.textContent?.trim();
      if (text) sections.push({ type: 'heading', text, level: tag });
      processed.add(node);
      return;
    }

    if (
      tag === 'table' ||
      node.getAttribute?.('role') === 'table' ||
      node.getAttribute?.('role') === 'grid'
    ) {
      try {
        const rows = extractTable(node as HTMLElement);
        if (rows.length > 0) {
          sections.push({ type: 'table', columns: Object.keys(rows[0]), rows });
        }
      } catch { /* expected */ }
      processed.add(node);
      node.querySelectorAll('*').forEach((c) => processed.add(c));
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.querySelectorAll(':scope > li'))
        .map((li) => li.textContent?.trim())
        .filter(Boolean);
      if (items.length > 0) sections.push({ type: 'list', items });
      processed.add(node);
      node.querySelectorAll('*').forEach((c) => processed.add(c));
      return;
    }

    if (tag === 'canvas' || (tag === 'svg' && node.querySelectorAll('path, rect, circle').length > 5)) {
      sections.push({ type: 'chart', element: node });
      processed.add(node);
      return;
    }

    if (tag === 'p' || tag === 'blockquote' || tag === 'pre') {
      const text = node.textContent?.trim();
      if (text) sections.push({ type: 'text', content: text });
      processed.add(node);
      return;
    }

    for (const child of node.children) {
      walk(child);
    }
  };

  walk(element);

  for (const section of sections) {
    if (section.type === 'chart' && section.element) {
      try {
        const result = await extractChartData(section.element as HTMLElement);
        section.data = result.canExtract ? result.data : null;
        section.method = result.method;
        section.canExtract = result.canExtract;
        section._extractionNote = result._extractionNote;
      } catch {
        section.data = null;
        section.method = null;
        section.canExtract = false;
        section._extractionNote = 'Chart extraction failed unexpectedly.';
      }
      delete section.element;
    }
  }

  const links = Array.from(element.querySelectorAll('a[href]'))
    .map((a) => ({ text: a.textContent?.trim(), href: (a as HTMLAnchorElement).href }))
    .filter((l) => l.text && l.href);
  if (links.length > 0) sections.push({ type: 'links', items: links });

  const images = Array.from(element.querySelectorAll('img[src]'))
    .map((img) => ({ src: (img as HTMLImageElement).src, alt: (img as HTMLImageElement).alt || '' }))
    .filter((img) => img.src);
  if (images.length > 0) sections.push({ type: 'images', items: images });

  return { sections };
}

// â”€â”€ Utilities â”€â”€

function applyFieldFilter(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const filtered: Record<string, unknown> = {};
    fields.forEach((f) => { if (row[f] !== undefined) filtered[f] = row[f]; });
    return filtered;
  });
}

async function resolveWithRetry(
  primary: SelectorDescriptor,
  alternate: SelectorDescriptor | null,
  onProgress: OnProgress,
  label: string,
  maxRetries = 3,
): Promise<HTMLElement> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    checkAbort();
    const { element, confidence, strategy } = resolveWithAlternate(primary, alternate);
    if (element) {
      onProgress?.(`Resolved "${label}" via ${strategy} (${(confidence * 100).toFixed(0)}%)`);
      return element as HTMLElement;
    }

    if (attempt < maxRetries) {
      onProgress?.(`Couldn't find "${label}", retrying (${attempt}/${maxRetries})...`);
      await randomDelay(1000, 1500);
    }
  }

  const primaryHints = describeDescriptor(primary);
  const altHints = alternate ? `; alternate: ${describeDescriptor(alternate)}` : '';
  onProgress?.(`Resolver failed for "${label}". Tried: ${primaryHints}${altHints}`);
  throw new Error(
    `Element not found: Could not locate "${label}" after ${maxRetries} attempts. Tried: ${primaryHints}${altHints}`,
  );
}

function describeDescriptor(descriptor: SelectorDescriptor): string {
  const parts: string[] = [];
  if (descriptor.cssSelector)             parts.push(`css=${descriptor.cssSelector}`);
  if (descriptor.attributes?.name)        parts.push(`name=${descriptor.attributes.name}`);
  if (descriptor.ariaLabel)               parts.push(`aria-label=${descriptor.ariaLabel}`);
  if (descriptor.placeholder)             parts.push(`placeholder=${descriptor.placeholder}`);
  if (descriptor.tagName)                 parts.push(`tag=${descriptor.tagName}`);
  return parts.join(' | ') || '(empty descriptor)';
}

function findOptionElement(
  container: HTMLElement,
  option: { value: string; label: string },
): HTMLElement | null {
  const byValue = container.querySelector<HTMLElement>(`[value="${CSS.escape(option.value)}"]`);
  if (byValue) return byValue;
  const children = Array.from(container.querySelectorAll<HTMLElement>('*'));
  return children.find((el) => el.textContent?.trim() === option.label) || null;
}

function findVirtualScrollWrapper(el: HTMLElement): HTMLElement | null {
  const selectors = [
    '.p-datatable-wrapper',
    '.p-scroller-viewport',
    '.k-grid-content',
    '.dx-datagrid-rowsview',
    '.MuiDataGrid-virtualScroller',
    '.tabulator-tableholder',
    '.slick-viewport',
  ];
  for (const sel of selectors) {
    const wrapper =
      (el.querySelector<HTMLElement>(sel) || el.closest<HTMLElement>(sel)) ?? null;
    if (wrapper && wrapper.scrollHeight > wrapper.clientHeight * 1.5) return wrapper;
  }
  return null;
}

async function scrollAndCollectVirtualTable(
  wrapper: HTMLElement,
  tableRoot: HTMLElement,
  onProgress: OnProgress,
): Promise<Record<string, unknown>[]> {
  const allRows = new Map<string, Record<string, unknown>>();
  const maxScrolls = 100;

  const rowKey = (row: Record<string, unknown>): string =>
    Object.keys(row)
      .sort()
      .map((k) => `${k}\x00${row[k]}`)
      .join('\x01');

  const collectVisible = (): void => {
    const rows = extractTable(tableRoot);
    for (const row of rows) {
      const key = rowKey(row);
      if (!allRows.has(key)) allRows.set(key, row);
    }
  };

  collectVisible();

  for (let i = 0; i < maxScrolls; i++) {
    const prevTop = wrapper.scrollTop;
    wrapper.scrollTop += wrapper.clientHeight * 0.8;
    await new Promise<void>((r) => setTimeout(r, 300 + Math.random() * 200));

    if (Math.abs(wrapper.scrollTop - prevTop) < 5) break;

    collectVisible();
    onProgress?.(`Scrolling table... (${allRows.size} rows collected)`);
  }

  return [...allRows.values()];
}

function checkAbort(): void {
  if (abortSignal) throw new Error('ABORTED');
}

class SkipIterationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipIterationError';
  }
}

function sendProgress(payload: {
  phase: 'setup' | 'loop';
  stepLabel: string;
  status: string;
  termIndex?: number;
  taskId?: string;
}): void {
  try {
    browser.runtime.sendMessage({ type: 'FLOW_PROGRESS', payload });
  } catch { /* extension context may be invalidated */ }
}

