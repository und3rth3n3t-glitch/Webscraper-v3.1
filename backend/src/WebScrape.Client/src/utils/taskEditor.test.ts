import { describe, it, expect } from 'vitest';
import { parseSetInputSteps, autoBindSteps, buildSaveDto } from './taskEditor';
import { BlockType } from '../api/types';
import type { EditorState } from './taskEditor';

describe('parseSetInputSteps', () => {
  it('returns setInput steps from valid config', () => {
    const config = { steps: [
      { id: 'step1', type: 'setInput' },
      { id: 'step2', type: 'click' },
      { id: 'step3', type: 'setInput' },
    ]};
    const result = parseSetInputSteps(config);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('step1');
    expect(result[1].id).toBe('step3');
  });

  it('returns empty array for invalid JSON object (null)', () => {
    const result = parseSetInputSteps(null);
    expect(result).toEqual([]);
  });

  it('returns empty when steps is not an array', () => {
    const result = parseSetInputSteps({ steps: 'not-an-array' });
    expect(result).toEqual([]);
  });

  it('returns empty when steps array is empty', () => {
    const result = parseSetInputSteps({ steps: [] });
    expect(result).toEqual([]);
  });

  it('filters out steps missing id or type', () => {
    const config = { steps: [
      { id: 'ok', type: 'setInput' },
      { type: 'setInput' },           // missing id
      { id: 123, type: 'setInput' },  // id not string
      { id: 'also-ok', type: 'setInput' },
    ]};
    const result = parseSetInputSteps(config);
    expect(result).toHaveLength(2);
  });
});

describe('autoBindSteps', () => {
  it('returns empty record for 0 steps', () => {
    const result = autoBindSteps([], 'loop-id');
    expect(result).toEqual({});
  });

  it('binds the first step to loopRef for 1 step', () => {
    const steps = [{ id: 's1', type: 'setInput' as const }];
    const result = autoBindSteps(steps, 'loop-id');
    expect(result).toEqual({ s1: { kind: 'loopRef', loopBlockId: 'loop-id' } });
  });

  it('binds first to loopRef, rest to unbound for N steps', () => {
    const steps = [
      { id: 's1', type: 'setInput' as const },
      { id: 's2', type: 'setInput' as const },
      { id: 's3', type: 'setInput' as const },
    ];
    const result = autoBindSteps(steps, 'loop-id');
    expect(result.s1).toEqual({ kind: 'loopRef', loopBlockId: 'loop-id' });
    expect(result.s2).toEqual({ kind: 'unbound' });
    expect(result.s3).toEqual({ kind: 'unbound' });
  });
});

describe('buildSaveDto', () => {
  const baseState: EditorState = {
    name: 'My Task',
    loopBlockId: 'loop-uuid',
    scrapeBlockId: 'scrape-uuid',
    loopName: 'loop1',
    loopValues: ['alpha', '  ', 'beta', ''],
    scraperConfigId: 'config-uuid',
    stepBindings: { s1: { kind: 'loopRef', loopBlockId: 'loop-uuid' } },
  };

  it('strips blank/empty loop values', () => {
    const dto = buildSaveDto(baseState);
    const loopBlock = dto.blocks.find((b) => b.blockType === BlockType.Loop)!;
    expect(loopBlock.loop?.values).toEqual(['alpha', 'beta']);
  });

  it('builds correct two-block tree with correct blockTypes', () => {
    const dto = buildSaveDto(baseState);
    expect(dto.blocks).toHaveLength(2);
    expect(dto.blocks[0].blockType).toBe(BlockType.Loop);
    expect(dto.blocks[1].blockType).toBe(BlockType.Scrape);
  });

  it('sets scrape block parent to loop block id', () => {
    const dto = buildSaveDto(baseState);
    const scrapeBlock = dto.blocks.find((b) => b.blockType === BlockType.Scrape)!;
    expect(scrapeBlock.parentBlockId).toBe('loop-uuid');
  });

  it('passes scraperConfigId and stepBindings through', () => {
    const dto = buildSaveDto(baseState);
    const scrapeBlock = dto.blocks.find((b) => b.blockType === BlockType.Scrape)!;
    expect(scrapeBlock.scrape?.scraperConfigId).toBe('config-uuid');
    expect(scrapeBlock.scrape?.stepBindings).toEqual(baseState.stepBindings);
  });
});
