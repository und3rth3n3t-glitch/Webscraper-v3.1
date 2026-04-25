import { describe, it, expect } from 'vitest';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import type { ScraperConfig } from '../types/config';
import type { QueueTask } from '../types/signalr';

function makeConfig(id: string, name: string): ScraperConfig {
  return {
    id,
    name,
    domain: 'example.com',
    domainLocked: true,
    url: `https://example.com/${id}`,
    steps: [],
    schemaVersion: 3,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeTask(overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    id: 'run-1',
    configId: 'cfg-1',
    configName: 'Demo',
    searchTerms: ['alpha', 'beta'],
    priority: 0,
    createdAt: '2026-04-25T00:00:00Z',
    status: 'pending',
    ...overrides,
  };
}

describe('resolveQueueTask', () => {
  it('uses inlineConfig when present', () => {
    const inline = makeConfig('cfg-1', 'Inline');
    const task = makeTask({ inlineConfig: inline });

    const resolved = resolveQueueTask(task, []);

    expect(resolved.config).toBe(inline);
    expect(resolved.searchTerms).toEqual(['alpha', 'beta']);
    expect(resolved.taskId).toBe('run-1');
    expect(resolved.configId).toBe('cfg-1');
    expect(resolved.configName).toBe('Demo');
  });

  it('falls back to a local config matching configId when no inlineConfig', () => {
    const local = makeConfig('cfg-1', 'Local');
    const other = makeConfig('cfg-2', 'Other');
    const task = makeTask();

    const resolved = resolveQueueTask(task, [other, local]);

    expect(resolved.config).toBe(local);
  });

  it('prefers inlineConfig over a matching local config', () => {
    const inline = makeConfig('cfg-1', 'Inline');
    const local = makeConfig('cfg-1', 'Local');
    const task = makeTask({ inlineConfig: inline });

    const resolved = resolveQueueTask(task, [local]);

    expect(resolved.config).toBe(inline);
  });

  it('throws ConfigNotFoundError when neither is available', () => {
    const task = makeTask();
    expect(() => resolveQueueTask(task, [])).toThrow(ConfigNotFoundError);
    expect(() => resolveQueueTask(task, [makeConfig('cfg-9', 'Nope')])).toThrow(ConfigNotFoundError);
  });

  it('attaches the configId to the thrown error', () => {
    const task = makeTask({ configId: 'missing-id' });
    try {
      resolveQueueTask(task, []);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigNotFoundError);
      expect((err as ConfigNotFoundError).configId).toBe('missing-id');
    }
  });
});
