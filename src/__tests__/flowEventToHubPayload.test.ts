import { describe, it, expect } from 'vitest';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext,
} from '../background/flowEventToHubPayload';
import type { ScrapingResult } from '../types/extraction';

const FIXED_NOW = '2026-04-25T12:00:00.000Z';
const now = () => FIXED_NOW;

const ctx: ActiveTaskContext = {
  taskId: 'run-1',
  configId: 'cfg-1',
  configName: 'Demo',
  searchTerms: ['alpha', 'beta', 'gamma'],
  dataMapping: {
    version: 1,
    columns: [{ id: 'c1', originalName: 'foo', displayName: 'Foo', enabled: true, position: 0, sourceType: 'scrapeElement' }],
  },
};

describe('mapFlowProgress', () => {
  it('maps a setup-phase progress event with 0% progress', () => {
    const out = mapFlowProgress(ctx, { phase: 'setup', stepLabel: 'open page', status: 'running' });
    expect(out).toEqual({
      taskId: 'run-1',
      configId: 'cfg-1',
      currentTerm: 'alpha',
      currentStep: 'open page',
      progress: 0,
      phase: 'setup',
    });
  });

  it('maps a loop progress event using termIndex/total ratio for in-progress term', () => {
    const out = mapFlowProgress(ctx, {
      phase: 'loop', stepLabel: 'click result', status: 'running', termIndex: 1,
    });
    expect(out.currentTerm).toBe('beta');
    expect(out.currentStep).toBe('click result');
    expect(out.phase).toBe('loop');
    // 1 of 3 terms running, none completed → 33%
    expect(out.progress).toBe(33);
  });

  it('counts a successful term as completed when computing progress', () => {
    const out = mapFlowProgress(ctx, {
      phase: 'loop', stepLabel: '', status: 'success', termIndex: 1,
    });
    // 1 of 3 terms started + 1 success → 2/3 → 67%
    expect(out.progress).toBe(67);
  });

  it('falls back to empty currentTerm when termIndex is out of range', () => {
    const out = mapFlowProgress(ctx, { phase: 'loop', stepLabel: 'x', status: 'running', termIndex: 99 });
    expect(out.currentTerm).toBe('');
  });
});

describe('mapFlowComplete', () => {
  const result: ScrapingResult = {
    configId: 'cfg-1',
    configName: 'Demo',
    scrapedAt: '2026-04-25T11:59:00.000Z',
    sourceUrl: 'https://example.com',
    iterations: [
      { searchTerm: 'alpha', data: [{ foo: 'a' }], status: 'success' },
    ],
    totalTimeMs: 4321,
  };

  it('builds a TaskComplete with status "success" when not aborted', () => {
    const out = mapFlowComplete(ctx, { result }, now);
    expect(out.taskId).toBe('run-1');
    expect(out.configId).toBe('cfg-1');
    expect(out.completedAt).toBe(FIXED_NOW);
    expect(out.result.status).toBe('success');
    expect(out.result.configName).toBe('Demo');
    expect(out.result.iterations).toBe(result.iterations);
    expect(out.result.dataMapping).toBe(ctx.dataMapping);
    expect(out.result.totalTimeMs).toBe(4321);
    expect(out.result.timestamp).toBe(FIXED_NOW);
  });

  it('builds a TaskComplete with status "failed" when aborted', () => {
    const out = mapFlowComplete(ctx, { result: { ...result, aborted: true } }, now);
    expect(out.result.status).toBe('failed');
  });
});

describe('mapFlowError', () => {
  it('maps to a TaskError including stepLabel', () => {
    const out = mapFlowError(ctx, { error: 'boom', stepLabel: 'click' }, now);
    expect(out).toEqual({
      taskId: 'run-1',
      configId: 'cfg-1',
      error: 'boom',
      stepLabel: 'click',
      failedAt: FIXED_NOW,
    });
  });

  it('omits stepLabel when not provided', () => {
    const out = mapFlowError(ctx, { error: 'boom' }, now);
    expect(out.stepLabel).toBeUndefined();
  });
});

describe('mapFlowPaused', () => {
  it('maps a Cloudflare pause to TaskPaused', () => {
    const out = mapFlowPaused(ctx, { reason: 'cloudflare', challengeType: 'cf-turnstile' }, now);
    expect(out).toEqual({
      taskId: 'run-1',
      configId: 'cfg-1',
      reason: 'cloudflare',
      challengeType: 'cf-turnstile',
      pausedAt: FIXED_NOW,
    });
  });

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
});
