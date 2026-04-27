import { describe, it, expect } from 'vitest';
import {
  addLoopChild,
  addScrapeChild,
  buildSaveBlocks,
  buildTree,
  deleteBlock,
  descendantsOf,
  hydrateFromDto,
  loopAncestorsOf,
  reorderSibling,
  updateLoop,
  updateScrape,
  type EditorBlock,
  type LoopEditorBlock,
  type ScrapeEditorBlock,
} from '../utils/taskTree';
import type { TaskBlockTreeDto } from '../api/types';

// Helpers
const mkLoop = (id: string, parentId: string | null, orderIndex = 0, name = 'loop1'): LoopEditorBlock => ({
  id, parentBlockId: parentId, blockType: 'loop', orderIndex, name, values: ['a', 'b'],
});
const mkScrape = (id: string, parentId: string, orderIndex = 0): ScrapeEditorBlock => ({
  id, parentBlockId: parentId, blockType: 'scrape', orderIndex, scraperConfigId: 'cfg1', stepBindings: {},
});

describe('buildTree', () => {
  it('builds single root', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null)];
    const tree = buildTree(blocks);
    expect(tree).toHaveLength(1);
    expect(tree[0].block.id).toBe('L1');
    expect(tree[0].children).toHaveLength(0);
  });

  it('nests scrape under loop', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null), mkScrape('S1', 'L1')];
    const tree = buildTree(blocks);
    expect(tree[0].children[0].block.id).toBe('S1');
  });

  it('orders siblings by orderIndex', () => {
    const blocks: EditorBlock[] = [
      mkLoop('L1', null, 1),
      mkLoop('L0', null, 0),
    ];
    const tree = buildTree(blocks);
    expect(tree[0].block.id).toBe('L0');
    expect(tree[1].block.id).toBe('L1');
  });
});

describe('loopAncestorsOf', () => {
  it('returns innermost-first for nested loops', () => {
    const blocks: EditorBlock[] = [
      mkLoop('outer', null, 0, 'outer'),
      mkLoop('inner', 'outer', 0, 'inner'),
      mkScrape('S1', 'inner'),
    ];
    const ancestors = loopAncestorsOf(blocks, 'S1');
    expect(ancestors[0].id).toBe('inner');
    expect(ancestors[1].id).toBe('outer');
  });

  it('returns empty when no loop parents', () => {
    // S1 is under L1 which IS a loop — use parentBlockId: null to test truly no loop ancestors
    const isolated: EditorBlock[] = [{ ...mkScrape('S1', 'L1'), parentBlockId: null as unknown as string }];
    expect(loopAncestorsOf(isolated, 'S1')).toHaveLength(0);
  });
});

describe('descendantsOf', () => {
  it('returns all descendants', () => {
    const blocks: EditorBlock[] = [
      mkLoop('L1', null),
      mkLoop('L2', 'L1'),
      mkScrape('S1', 'L2'),
    ];
    expect(descendantsOf(blocks, 'L1').sort()).toEqual(['L2', 'S1'].sort());
  });

  it('returns empty for leaf', () => {
    const blocks: EditorBlock[] = [mkScrape('S1', 'L1'), mkLoop('L1', null)];
    expect(descendantsOf(blocks, 'S1')).toHaveLength(0);
  });
});

describe('addLoopChild', () => {
  it('adds loop with correct parentBlockId and orderIndex', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null)];
    const result = addLoopChild(blocks, null, 'L2');
    const l2 = result.find((b) => b.id === 'L2')!;
    expect(l2.parentBlockId).toBeNull();
    expect(l2.orderIndex).toBe(1); // sibling after L1
  });

  it('names loop by count', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null, 0, 'loop1')];
    const result = addLoopChild(blocks, null, 'L2');
    const l2 = result.find((b) => b.id === 'L2') as LoopEditorBlock;
    expect(l2.name).toBe('loop2');
  });
});

describe('addScrapeChild', () => {
  it('adds scrape under given parent', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null)];
    const result = addScrapeChild(blocks, 'L1', 'S1');
    const s1 = result.find((b) => b.id === 'S1')!;
    expect(s1.parentBlockId).toBe('L1');
    expect(s1.orderIndex).toBe(0);
  });
});

describe('deleteBlock', () => {
  it('removes block and its descendants', () => {
    const blocks: EditorBlock[] = [
      mkLoop('L1', null),
      mkLoop('L2', 'L1'),
      mkScrape('S1', 'L2'),
    ];
    const result = deleteBlock(blocks, 'L1');
    expect(result).toHaveLength(0);
  });

  it('re-normalises orderIndex after delete', () => {
    const blocks: EditorBlock[] = [
      mkLoop('A', null, 0),
      mkLoop('B', null, 1),
      mkLoop('C', null, 2),
    ];
    const result = deleteBlock(blocks, 'B');
    const c = result.find((b) => b.id === 'C')!;
    expect(c.orderIndex).toBe(1);
  });
});

describe('reorderSibling', () => {
  it('swaps orderIndex with the sibling above', () => {
    const blocks: EditorBlock[] = [
      mkLoop('A', null, 0),
      mkLoop('B', null, 1),
    ];
    const result = reorderSibling(blocks, 'B', 'up');
    const a = result.find((b) => b.id === 'A')!;
    const b = result.find((b) => b.id === 'B')!;
    expect(b.orderIndex).toBe(0);
    expect(a.orderIndex).toBe(1);
  });

  it('does nothing when already at top', () => {
    const blocks: EditorBlock[] = [mkLoop('A', null, 0), mkLoop('B', null, 1)];
    const result = reorderSibling(blocks, 'A', 'up');
    expect(result).toEqual(blocks);
  });
});

describe('hydrateFromDto + buildSaveBlocks round-trip', () => {
  it('is identity for a nested tree', () => {
    const dtos: TaskBlockTreeDto[] = [
      { id: 'L1', parentBlockId: null, blockType: 'loop', orderIndex: 0, loop: { name: 'outer', values: ['x'] }, scrape: null },
      { id: 'L2', parentBlockId: 'L1', blockType: 'loop', orderIndex: 0, loop: { name: 'inner', values: ['y'] }, scrape: null },
      { id: 'S1', parentBlockId: 'L2', blockType: 'scrape', orderIndex: 0, loop: null, scrape: { scraperConfigId: 'c1', stepBindings: {} } },
    ];
    const editorBlocks = hydrateFromDto(dtos);
    const saved = buildSaveBlocks(editorBlocks);
    expect(saved).toEqual(dtos);
  });

  it('strips blank values on buildSaveBlocks', () => {
    const blocks: EditorBlock[] = [{ ...mkLoop('L1', null), values: ['a', '', 'b', '   '] }];
    const saved = buildSaveBlocks(blocks);
    expect(saved[0].loop!.values).toEqual(['a', 'b']);
  });
});

describe('updateLoop / updateScrape', () => {
  it('patches loop name', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null, 0, 'old')];
    const result = updateLoop(blocks, 'L1', { name: 'new' });
    expect((result[0] as LoopEditorBlock).name).toBe('new');
  });

  it('patches scrape config', () => {
    const blocks: EditorBlock[] = [mkLoop('L1', null), mkScrape('S1', 'L1')];
    const result = updateScrape(blocks, 'S1', { scraperConfigId: 'cfg2' });
    expect((result[1] as ScrapeEditorBlock).scraperConfigId).toBe('cfg2');
  });
});
