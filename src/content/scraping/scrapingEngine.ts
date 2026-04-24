import { resolveElement, resolveAllSimilar } from './elementResolution';
import { findBestMatch } from '../../common/tokenMatcher';
import {
  typeText,
  clearInput,
  pressEnter,
  naturalClick,
  randomDelay,
  scrollToBottom,
  selectOption,
} from './humanBehavior';
import {
  waitForElement,
  waitForContentChange,
  expandHiddenElements,
  detectElementType,
  getElementLabel,
  TABLE_FRAMEWORK_SELECTORS,
  CHART_SELECTORS,
  promoteToChartContainer,
  deduplicateNested,
} from '../extraction/domUtils';
import { extractTable } from '../extraction/tableExtractor';
import { extractChartData } from '../extraction/chartExtractor';
import { paginatePages, paginateElement } from './paginationHandler';
import { filterByExcludedIndices } from '../extraction/tableFilterUtils';
import { detectCloudflareChallenge, waitForChallengeToClear } from '../cloudflareDetector';
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
  ScrapeElementConfig,
  SelectorDescriptor,
} from '../../types/config';
import type { ScrapingResult, IterationResult } from '../../types/extraction';

let abortSignal = false;
let flowRunning = false;

const NAVIGATING_STEP_TYPES = new Set(['click', 'bestMatch', 'goBack']);

export function abortFlow(): void {
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
  previousIterations?: IterationResult[];
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

  if (flowRunning) {
    return {
      configId: config.id,
      configName: config.name,
      scrapedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      iterations: [],
      totalTimeMs: 0,
      aborted: true,
    };
  }
  flowRunning = true;
  abortSignal = false;

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
        for (const step of setupSteps) {
          checkAbort();
          await executeStep(step, null, 0, (msg) => sendProgress({ phase: 'setup', stepLabel: msg, status: 'running', taskId }), afk);
        }
      } catch (err) {
        const e = err as Error;
        if (e.message === 'ABORTED') {
          result.totalTimeMs = Date.now() - startTime;
          return { ...result, aborted: true };
        }
        sendProgress({ phase: 'setup', stepLabel: '', status: 'error', taskId });
      }
    }

    const terms = searchTerms.length > 0 ? searchTerms : [null];

    for (let i = startTermIndex; i < terms.length; i++) {
      const term = terms[i];
      checkAbort();

      sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'running', taskId });

      const iterData: Record<string, unknown>[] = [];
      let iterStatus: 'success' | 'error' = 'success';
      let iterError: string | undefined;

      try {
        const siStart = i === startTermIndex ? startLoopStepIndex : 0;

        for (let si = siStart; si < loopSteps.length; si++) {
          checkAbort();
          const step = loopSteps[si];
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: step.label, status: 'running', taskId });

          if (NAVIGATING_STEP_TYPES.has(step.type)) {
            try {
              browser.runtime.sendMessage({
                type: 'REGISTER_CONTINUATION',
                payload: {
                  config,
                  searchTerms,
                  startTermIndex: i,
                  startLoopStepIndex: si + 1,
                  previousIterations: result.iterations,
                },
              });
            } catch { /* extension context may be invalidated */ }
          }

          const stepData = await executeStep(
            step,
            term,
            i,
            (msg) => sendProgress({ phase: 'loop', termIndex: i, stepLabel: msg, status: 'running', taskId }),
            afk,
          );

          if (NAVIGATING_STEP_TYPES.has(step.type)) {
            // Check for cloudflare after navigation
            const challenge = detectCloudflareChallenge();
            if (challenge.detected && challenge.type) {
              browser.runtime.sendMessage({
                type: 'FLOW_PAUSED',
                payload: { reason: 'cloudflare', challengeType: challenge.type, taskId },
              });

              await Promise.race([waitForChallengeToClear().promise, waitForResumeSignal()]);

              browser.runtime.sendMessage({ type: 'FLOW_RESUMED' });
            }

            try {
              browser.runtime.sendMessage({ type: 'CANCEL_CONTINUATION' });
            } catch { /* expected */ }
          }

          if (stepData !== null && step.type === 'scrape') {
            const scraped = stepData as Record<string, unknown>;
            for (const [, value] of Object.entries(scraped)) {
              if (Array.isArray(value)) {
                iterData.push(...(value as Record<string, unknown>[]));
              } else if (value !== null && typeof value === 'object') {
                iterData.push(value as Record<string, unknown>);
              }
            }
          }
        }

        sendProgress({ phase: 'loop', termIndex: i, stepLabel: '', status: 'success', taskId });
      } catch (err) {
        const e = err as Error;
        if (e.message === 'ABORTED') {
          result.iterations.push({
            searchTerm: term,
            data: iterData,
            status: 'error',
            error: 'Aborted by user',
          });
          break;
        }
        if (e.name === 'SkipIterationError') {
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: e.message, status: 'skipped', taskId });
          iterStatus = 'error';
          iterError = e.message;
        } else {
          sendProgress({ phase: 'loop', termIndex: i, stepLabel: e.message, status: 'error', taskId });
          iterStatus = 'error';
          iterError = e.message;
        }
      }

      result.iterations.push({
        searchTerm: term,
        data: iterData,
        status: iterStatus,
        error: iterError,
      });

      if (i < terms.length - 1) {
        // Inter-iteration pause (2–8s)
        await randomDelay(2000, 8000);

        // Every 25 iterations: longer idle pause (15–60s)
        if (i > 0 && i % 25 === 0) {
          await randomDelay(15_000, 60_000);
        }
      }
    }

    result.totalTimeMs = Date.now() - startTime;
    return result;
  } finally {
    flowRunning = false;
  }
}

// ── Resume signal ──

function waitForResumeSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (msg: unknown): void => {
      if ((msg as Record<string, unknown>)?.type === 'RESUME_AFTER_CLOUDFLARE') {
        browser.runtime.onMessage.removeListener(handler);
        resolve();
      }
    };
    browser.runtime.onMessage.addListener(handler);
  });
}

// ── Wait after action ──

async function waitAfterAction(
  opts: { waitMethod?: string; waitAfterMs?: number; waitForSelector?: SelectorDescriptor | null },
  onProgress: OnProgress,
  defaultMethod = 'fixedDelay',
): Promise<void> {
  const waitMethod = opts.waitMethod || defaultMethod;
  const waitMs = opts.waitAfterMs ?? 1500;

  if (waitMethod === 'contentChange') {
    onProgress?.('Waiting for page to update...');
    try {
      await waitForContentChange(document.body.textContent ?? '', 10000);
    } catch {
      onProgress?.('Page did not change within timeout — continuing');
    }
  } else if (waitMethod === 'element' && opts.waitForSelector) {
    onProgress?.('Waiting for element to appear...');
    const desc = opts.waitForSelector;
    try {
      await waitForElement(() => resolveElement(desc).element, 10000);
    } catch {
      onProgress?.('Wait-for element did not appear within timeout — continuing');
    }
  } else {
    await randomDelay(waitMs * 0.8, waitMs * 1.2);
  }
}

// ── Step dispatch ──

type OnProgress = ((msg: string) => void) | undefined;

async function executeStep(
  step: Step,
  searchTerm: string | null,
  iterationIndex: number,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown> | null> {
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
      return executeAwaitUserAction(step, onProgress);
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
  const isInitial = opts.isInitialInput !== false;
  const useSubsequent = iterationIndex > 0 && opts.subsequentSelector && isInitial;
  const descriptor = useSubsequent ? opts.subsequentSelector! : step.selector!;

  const el = await resolveWithRetry(descriptor, onProgress, step.label || 'input');

  onProgress?.(`Typing "${searchTerm ?? ''}" into ${step.label || 'input field'}`);

  if (opts.clearBefore !== false) {
    await clearInput(el);
  }

  await typeText(el, searchTerm ?? '');

  if (opts.pressEnterAfter) {
    await randomDelay(100, 300);
    await pressEnter(el);
    await waitAfterAction(opts, onProgress);
  } else {
    await randomDelay(600, 1200);
  }

  void afk; // afk mode: typeText handles delays; no change needed for text input
  return null;
}

async function executeClick(
  step: ClickStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<null> {
  const opts = step.options;
  const el = await resolveWithRetry(step.selector!, onProgress, step.label || 'button');

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
  const candidateSource = opts.candidateSource || 'similar';

  if (!searchTerm) {
    throw new SkipIterationError('No search term provided for best match step');
  }

  let clickableElements: HTMLElement[] = [];

  if (candidateSource === 'container' && opts.containerSelector) {
    const { element: container } = resolveElement(opts.containerSelector);
    if (!container) {
      throw new SkipIterationError('Could not find the container element');
    }
    const clickableSelector = opts.clickableFilter || 'a, button';
    clickableElements = Array.from(container.querySelectorAll<HTMLElement>(clickableSelector))
      .filter((el) => el.offsetParent !== null);
    onProgress?.(`Found ${clickableElements.length} clickable elements in container, scoring against "${searchTerm}"`);
  } else {
    await resolveWithRetry(step.selector!, onProgress, step.label || 'example link');
    const similar = resolveAllSimilar(step.selector!);

    for (const el of similar) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.tagName === 'A' || htmlEl.tagName === 'BUTTON') {
        clickableElements.push(htmlEl);
      } else {
        const anchor = htmlEl.querySelector<HTMLElement>('a');
        if (anchor) {
          clickableElements.push(anchor);
        } else {
          const button = htmlEl.querySelector<HTMLElement>('button');
          if (button) clickableElements.push(button);
        }
      }
    }
    onProgress?.(`Found ${clickableElements.length} similar elements, scoring against "${searchTerm}"`);
  }

  if (clickableElements.length === 0) {
    throw new SkipIterationError(`No clickable elements found for "${searchTerm}"`);
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

  await randomDelay(300, 800);
  await naturalClick(bestEl as HTMLElement, { afk });

  await waitAfterAction(opts, onProgress, 'contentChange');

  return { matchedText: text.substring(0, 100), matchScore: score };
}

async function executeGoBack(step: GoBackStep, onProgress: OnProgress): Promise<null> {
  onProgress?.('Going back to previous page...');
  history.back();
  await waitAfterAction(step.options, onProgress, 'contentChange');
  return null;
}

async function executeScrape(
  step: ScrapeStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  const opts = step.options;
  const data: Record<string, unknown> = {};

  if (opts.mode === 'wholePage') {
    onProgress?.('Scraping whole page...');
    const pageData = await scrapeWholePage(opts, onProgress, afk);
    Object.assign(data, pageData);
  } else {
    for (const elConfig of opts.elements || []) {
      onProgress?.(`Scraping "${elConfig.name}"...`);
      data[elConfig.name] = await scrapeElement(elConfig, onProgress, afk);
    }
  }

  return data;
}

async function executeSelectEach(
  step: SelectEachStep,
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  const opts = step.options.selectEachOptions;
  const data: Record<string, unknown> = {};

  const controlEl = await resolveWithRetry(opts.controlSelector!, onProgress, 'control');
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

    const optionData: Record<string, unknown> = {};
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

async function executeAwaitUserAction(step: AwaitUserActionStep, onProgress: OnProgress): Promise<null> {
  const opts = step.options;
  onProgress?.(`Waiting for user: ${opts.message}`);

  browser.runtime.sendMessage({
    type: 'FLOW_PAUSED',
    payload: { reason: 'awaitUserAction', message: opts.message },
  });

  await waitForResumeSignal();

  browser.runtime.sendMessage({ type: 'FLOW_RESUMED' });
  return null;
}

// ── Page-level scraping ──

async function scrapeWholePage(
  opts: ScrapeStep['options'],
  onProgress: OnProgress,
  afk: boolean,
): Promise<Record<string, unknown>> {
  if (opts.scrollToBottom) {
    onProgress?.('Scrolling to load all content...');
    await scrollToBottom((scrollY, totalHeight) =>
      onProgress?.(`Scrolling... ${Math.round((scrollY / totalHeight) * 100)}%`),
    );
  }

  if (opts.expandHidden) {
    onProgress?.('Expanding hidden sections...');
    await expandHiddenElements();
  }

  const allData: Array<Record<string, unknown>> = [];

  if (opts.paginate && opts.paginationSelector) {
    allData.push(await extractPageContent());

    const pagesScraped = await paginatePages({
      paginationSelector: opts.paginationSelector,
      pageCount: opts.pageCount || 0,
      onPage: async () => {
        if (opts.scrollToBottom) await scrollToBottom();
        allData.push(await extractPageContent());
      },
      onProgress,
      afk,
    });

    return { ...mergePageData(allData), pagesScraped };
  }

  return { ...(await extractPageContent()), pagesScraped: 1 };
}

async function extractPageContent(): Promise<Record<string, unknown>> {
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map((h) => (h as HTMLElement).textContent?.trim())
    .filter(Boolean);

  const paragraphs = Array.from(document.querySelectorAll('p'))
    .map((p) => p.textContent?.trim())
    .filter((t) => t && t.length > 20);

  const lists = Array.from(document.querySelectorAll('ul,ol'))
    .map((list) => ({
      type: list.tagName.toLowerCase(),
      items: Array.from(list.querySelectorAll('li'))
        .map((li) => li.textContent?.trim())
        .filter(Boolean),
    }))
    .filter((l) => l.items.length > 0);

  const tableEls = new Set<Element>();
  for (const el of document.querySelectorAll(TABLE_FRAMEWORK_SELECTORS)) {
    try {
      if (detectElementType(el as HTMLElement) === 'table') tableEls.add(el);
    } catch { /* expected */ }
  }
  deduplicateNested(tableEls);

  const tables: Array<Record<string, unknown>> = [];
  for (const el of tableEls) {
    try {
      const data = extractTable(el as HTMLElement);
      if (data && data.length > 0) {
        tables.push({ label: getElementLabel(el as HTMLElement), rows: data });
      }
    } catch { /* expected */ }
  }

  const chartEls = new Set<Element>();
  for (const sel of CHART_SELECTORS) {
    let nodeList: NodeListOf<Element>;
    try { nodeList = document.querySelectorAll(sel); } catch { continue; }
    for (const el of nodeList) {
      try {
        if (chartEls.has(el)) continue;
        const chartEl = promoteToChartContainer(el as HTMLElement);
        if (!chartEls.has(chartEl) && detectElementType(chartEl) === 'chart') {
          chartEls.add(chartEl);
        }
      } catch { /* expected */ }
    }
  }
  deduplicateNested(chartEls);

  const charts: Array<Record<string, unknown>> = [];
  for (const el of chartEls) {
    try {
      const result = await extractChartData(el as HTMLElement);
      charts.push({
        title: result.title,
        label: getElementLabel(el as HTMLElement),
        data: result.data,
        method: result.method,
        canExtract: result.canExtract,
        ...(result.canExtract ? {} : { _extractionNote: (result as unknown as Record<string, unknown>)._extractionNote || (result as unknown as Record<string, unknown>).message }),
      });
    } catch { /* expected */ }
  }

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ text: a.textContent?.trim(), href: (a as HTMLAnchorElement).href }))
    .filter((l) => l.text);

  return {
    pageTitle: document.title,
    content: { headings, paragraphs, lists, tables, charts, links },
  };
}

function mergePageData(pages: Array<Record<string, unknown>>): Record<string, unknown> {
  if (pages.length === 0) return {};
  if (pages.length === 1) return pages[0];

  const merged: Record<string, unknown> = { pageTitle: (pages[0] as { pageTitle?: unknown }).pageTitle, content: {} };
  const content = merged.content as Record<string, unknown>;

  for (const key of ['headings', 'paragraphs', 'links']) {
    content[key] = pages.flatMap((p) => ((p as { content?: Record<string, unknown[]> }).content?.[key]) || []);
  }
  content.lists = pages.flatMap((p) => ((p as { content?: Record<string, unknown[]> }).content?.lists) || []);
  content.tables = pages.flatMap((p) => ((p as { content?: Record<string, unknown[]> }).content?.tables) || []);
  content.charts = pages.flatMap((p) => ((p as { content?: Record<string, unknown[]> }).content?.charts) || []);

  return merged;
}

// ── Element-level scraping ──

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

async function scrapeElement(
  elConfig: ScrapeElementConfig,
  onProgress: OnProgress,
  afk: boolean,
): Promise<unknown> {
  const el = await resolveWithRetry(elConfig.selector, onProgress, elConfig.name);

  if (elConfig.detectedType === 'chart') {
    const result = await extractChartData(el);
    if (!result.canExtract) {
      if (result.data) {
        return { ...(result.data as unknown as Record<string, unknown>), _warning: result.message };
      }
      throw new Error(result.message);
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

// ── Utilities ──

function applyFieldFilter(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const filtered: Record<string, unknown> = {};
    fields.forEach((f) => { if (row[f] !== undefined) filtered[f] = row[f]; });
    return filtered;
  });
}

async function resolveWithRetry(
  descriptor: SelectorDescriptor,
  onProgress: OnProgress,
  label: string,
  maxRetries = 3,
): Promise<HTMLElement> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    checkAbort();
    const { element } = resolveElement(descriptor);
    if (element) return element as HTMLElement;

    if (attempt < maxRetries) {
      onProgress?.(`Couldn't find "${label}", retrying (${attempt}/${maxRetries})...`);
      await randomDelay(1000, 1500);
    }
  }
  throw new Error(
    `Element not found: Could not locate "${label}" after ${maxRetries} attempts. The page layout may have changed.`,
  );
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
