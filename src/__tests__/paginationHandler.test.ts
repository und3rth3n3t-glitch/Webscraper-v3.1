import { describe, it, expect, vi, beforeEach } from 'vitest';
import { paginatePages } from '../content/scraping/paginationHandler';
import type { SelectorDescriptor } from '../types/config';
import type { PageContent } from '../content/extraction/pageBlockExtractor';

const FAKE_SELECTOR: SelectorDescriptor = {
  cssSelector: 'li.next a',
  xpathSelector: '',
  textContent: 'next',
  tagName: 'A',
  attributes: {},
  position: { parentSelector: null, childIndex: 0 },
  ariaLabel: null,
  placeholder: null,
  frameId: null,
  frameSrc: null,
  inShadowDom: false,
  shadowHostSelector: null,
  shadowSelector: null,
};

const PAGE_FIXTURE: PageContent = {
  pageTitle: '',
  blocks: [],
  tables: [],
  charts: [],
};

const messages: Array<{ type: string; payload?: unknown }> = [];

beforeEach(() => {
  messages.length = 0;
  document.body.innerHTML = '';

  // Stub global browser.runtime.sendMessage
  (globalThis as unknown as { browser?: unknown }).browser = {
    runtime: {
      sendMessage: vi.fn((msg: unknown) => {
        messages.push(msg as { type: string; payload?: unknown });
        return Promise.resolve();
      }),
    },
  };

  // Stub elementResolution.resolveElement to return whatever button we put in the DOM.
  // The actual resolver is tested elsewhere; here we just need it to find the next btn.
});

describe('paginatePages — finished states', () => {
  it('returns finished when pageCountTarget is reached', async () => {
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 1,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.finished).toBe(true);
    expect(result.pages).toHaveLength(1);
    // No continuation registered (we hit cap).
    expect(messages.find((m) => m.type === 'REGISTER_CONTINUATION')).toBeUndefined();
  });

  it('returns finished when no next button is found', async () => {
    document.body.innerHTML = '<div>no pagination here</div>';
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 10,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.finished).toBe(true);
    expect(result.pages).toHaveLength(1);
  });

  it('appends to resumedPages when resuming', async () => {
    const earlier: PageContent = { ...PAGE_FIXTURE, blocks: [{ type: 'paragraph', text: 'page 1' }] };
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 2,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [earlier],
      resumedPagesScraped: 1,
      extractCurrentPage: () => Promise.resolve(PAGE_FIXTURE),
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].blocks).toEqual([{ type: 'paragraph', text: 'page 1' }]);
    expect(result.finished).toBe(true); // hit pageCountTarget=2
  });
});

describe('paginatePages — accumulator size guard', () => {
  it('stops when accumulator exceeds soft byte limit', async () => {
    // Build a fixture that's just over 10 MB worth of strings.
    const huge: PageContent = {
      ...PAGE_FIXTURE,
      blocks: Array.from({ length: 1000 }, () => ({
        type: 'paragraph' as const,
        text: 'X'.repeat(11_000),
      })),
    };
    const result = await paginatePages({
      termIndex: 0,
      stepIndex: 0,
      paginationSelector: FAKE_SELECTOR,
      pageCountTarget: 10,
      config: {} as never,
      searchTerms: [],
      taskId: 't1',
      previousIterations: [],
      resumedPages: [],
      resumedPagesScraped: 0,
      extractCurrentPage: () => Promise.resolve(huge),
    });

    expect(result.finished).toBe(true);
  });
});
