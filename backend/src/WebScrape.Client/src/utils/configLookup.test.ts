import { describe, it, expect } from 'vitest';
import { configNameFor } from './configLookup';
import { BlockType } from '../api/types';
import type { ScraperConfigDto, TaskDto } from '../api/types';

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 'task-1',
    name: 'Test',
    searchTerms: [],
    blocks: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const fakeConfig: ScraperConfigDto = {
  id: 'cfg-1',
  name: 'Demo Config',
  domain: 'example.com',
  configJson: {},
  schemaVersion: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('configNameFor', () => {
  it('returns the config name when scrape block is present and id is in cache', () => {
    const task = makeTask({
      blocks: [{
        id: 'b1',
        parentBlockId: null,
        blockType: BlockType.Scrape,
        orderIndex: 0,
        scrape: { scraperConfigId: 'cfg-1', stepBindings: {} },
      }],
    });
    expect(configNameFor(task, [fakeConfig])).toBe('Demo Config');
  });

  it('returns empty string when there is no scrape block', () => {
    const task = makeTask({
      blocks: [{
        id: 'b1',
        parentBlockId: null,
        blockType: BlockType.Loop,
        orderIndex: 0,
        loop: { name: 'loop1', values: ['a'] },
      }],
    });
    expect(configNameFor(task, [fakeConfig])).toBe('');
  });

  it('returns empty string when scrape block id is not in the configs cache', () => {
    const task = makeTask({
      blocks: [{
        id: 'b1',
        parentBlockId: null,
        blockType: BlockType.Scrape,
        orderIndex: 0,
        scrape: { scraperConfigId: 'unknown-id', stepBindings: {} },
      }],
    });
    expect(configNameFor(task, [fakeConfig])).toBe('');
  });

  it('returns empty string when configs cache is undefined', () => {
    const task = makeTask({
      blocks: [{
        id: 'b1',
        parentBlockId: null,
        blockType: BlockType.Scrape,
        orderIndex: 0,
        scrape: { scraperConfigId: 'cfg-1', stepBindings: {} },
      }],
    });
    expect(configNameFor(task, undefined)).toBe('');
  });
});
