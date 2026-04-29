import { BlockType } from '../api/types';
import type { StepBindingDto, TaskBlockTreeDto } from '../api/types';

// ── Types ─────────────────────────────────────────────────────────────────

export type LoopEditorBlock = {
  id: string;
  parentBlockId: string | null;
  blockType: 'loop';
  orderIndex: number;
  name: string;
  values: string[];
  columns: string[];
  rows: string[][];
};

export type ScrapeEditorBlock = {
  id: string;
  parentBlockId: string | null;
  blockType: 'scrape';
  orderIndex: number;
  scraperConfigId: string;
  stepBindings: Record<string, StepBindingDto>;
};

export type EditorBlock = LoopEditorBlock | ScrapeEditorBlock;

export type LoopAncestor = { id: string; name: string; columns: string[] };

export type TreeNode = {
  block: EditorBlock;
  children: TreeNode[];
};

export type BlocksAction =
  | { type: 'HYDRATE'; blocks: EditorBlock[] }
  | { type: 'ADD_LOOP'; parentId: string | null; newId: string }
  | { type: 'ADD_SCRAPE'; parentId: string; newId: string }
  | { type: 'DELETE'; id: string }
  | { type: 'REORDER'; id: string; direction: 'up' | 'down' }
  | { type: 'UPDATE_LOOP'; id: string; patch: Partial<Pick<LoopEditorBlock, 'name' | 'values' | 'columns' | 'rows'>> }
  | { type: 'UPDATE_SCRAPE'; id: string; patch: Partial<Pick<ScrapeEditorBlock, 'scraperConfigId' | 'stepBindings'>> };

// ── Selectors ─────────────────────────────────────────────────────────────

/** Build a recursive tree from a flat block list, for rendering only. */
export function buildTree(blocks: EditorBlock[]): TreeNode[] {
  const childMap = new Map<string | null, EditorBlock[]>();
  for (const b of blocks) {
    const list = childMap.get(b.parentBlockId) ?? [];
    list.push(b);
    childMap.set(b.parentBlockId, list);
  }
  for (const list of childMap.values()) {
    list.sort((a, b) => a.orderIndex - b.orderIndex);
  }
  function buildNode(block: EditorBlock): TreeNode {
    return { block, children: (childMap.get(block.id) ?? []).map(buildNode) };
  }
  return (childMap.get(null) ?? []).map(buildNode);
}

/** Returns all ancestor IDs of blockId, from root toward parent (outermost first). */
export function ancestorsOf(blocks: EditorBlock[], blockId: string): EditorBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const result: EditorBlock[] = [];
  let current = byId.get(blockId);
  while (current?.parentBlockId) {
    const parent = byId.get(current.parentBlockId);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

/** Returns loop ancestors of blockId, innermost first. */
export function loopAncestorsOf(blocks: EditorBlock[], blockId: string): LoopAncestor[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const result: LoopAncestor[] = [];
  let current = byId.get(blockId);
  while (current?.parentBlockId) {
    const parent = byId.get(current.parentBlockId);
    if (!parent) break;
    if (parent.blockType === 'loop') {
      result.push({ id: parent.id, name: parent.name, columns: parent.columns });
    }
    current = parent;
  }
  return result;
}

/** Returns IDs of all descendants of blockId (breadth-first). */
export function descendantsOf(blocks: EditorBlock[], blockId: string): string[] {
  const ids: string[] = [];
  const queue = [blockId];
  while (queue.length) {
    const pid = queue.shift()!;
    const children = blocks.filter((b) => b.parentBlockId === pid);
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

// ── Mutators ──────────────────────────────────────────────────────────────

export function addLoopChild(
  blocks: EditorBlock[],
  parentId: string | null,
  newId: string,
): EditorBlock[] {
  const siblings = blocks.filter((b) => b.parentBlockId === parentId);
  const loopCount = blocks.filter((b) => b.blockType === 'loop').length;
  const newBlock: LoopEditorBlock = {
    id: newId,
    parentBlockId: parentId,
    blockType: 'loop',
    orderIndex: siblings.length,
    name: `loop${loopCount + 1}`,
    values: [],
    columns: [],
    rows: [],
  };
  return [...blocks, newBlock];
}

export function addScrapeChild(
  blocks: EditorBlock[],
  parentId: string,
  newId: string,
): EditorBlock[] {
  const siblings = blocks.filter((b) => b.parentBlockId === parentId);
  const newBlock: ScrapeEditorBlock = {
    id: newId,
    parentBlockId: parentId,
    blockType: 'scrape',
    orderIndex: siblings.length,
    scraperConfigId: '',
    stepBindings: {},
  };
  return [...blocks, newBlock];
}

export function deleteBlock(blocks: EditorBlock[], id: string): EditorBlock[] {
  const toDelete = new Set([id, ...descendantsOf(blocks, id)]);
  const remaining = blocks.filter((b) => !toDelete.has(b.id));

  // Re-normalise orderIndex within each parent group
  const byParent = new Map<string | null, EditorBlock[]>();
  for (const b of remaining) {
    const list = byParent.get(b.parentBlockId) ?? [];
    list.push(b);
    byParent.set(b.parentBlockId, list);
  }
  const reindexed: EditorBlock[] = [];
  for (const list of byParent.values()) {
    list.sort((a, b) => a.orderIndex - b.orderIndex);
    list.forEach((b, i) => reindexed.push({ ...b, orderIndex: i }));
  }
  return reindexed;
}

export function reorderSibling(
  blocks: EditorBlock[],
  id: string,
  direction: 'up' | 'down',
): EditorBlock[] {
  const block = blocks.find((b) => b.id === id);
  if (!block) return blocks;
  const siblings = blocks
    .filter((b) => b.parentBlockId === block.parentBlockId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const idx = siblings.findIndex((b) => b.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return blocks;
  const swapBlock = siblings[swapIdx];
  return blocks.map((b) => {
    if (b.id === id) return { ...b, orderIndex: swapBlock.orderIndex };
    if (b.id === swapBlock.id) return { ...b, orderIndex: block.orderIndex };
    return b;
  });
}

export function updateLoop(
  blocks: EditorBlock[],
  id: string,
  patch: Partial<Pick<LoopEditorBlock, 'name' | 'values' | 'columns' | 'rows'>>,
): EditorBlock[] {
  return blocks.map((b) =>
    b.id === id && b.blockType === 'loop' ? { ...b, ...patch } : b,
  );
}

export function updateScrape(
  blocks: EditorBlock[],
  id: string,
  patch: Partial<Pick<ScrapeEditorBlock, 'scraperConfigId' | 'stepBindings'>>,
): EditorBlock[] {
  return blocks.map((b) =>
    b.id === id && b.blockType === 'scrape' ? { ...b, ...patch } : b,
  );
}

// ── DTO round-trip ─────────────────────────────────────────────────────────

export function hydrateFromDto(dtoBlocks: TaskBlockTreeDto[]): EditorBlock[] {
  return dtoBlocks.map((dto): EditorBlock => {
    if (dto.blockType === 'loop') {
      return {
        id: dto.id,
        parentBlockId: dto.parentBlockId,
        blockType: 'loop',
        orderIndex: dto.orderIndex,
        name: dto.loop?.name ?? 'loop',
        values: dto.loop?.values ?? [],
        columns: dto.loop?.columns ?? [],
        rows: dto.loop?.rows ?? [],
      };
    }
    return {
      id: dto.id,
      parentBlockId: dto.parentBlockId,
      blockType: 'scrape',
      orderIndex: dto.orderIndex,
      scraperConfigId: dto.scrape?.scraperConfigId ?? '',
      stepBindings: dto.scrape?.stepBindings ?? {},
    };
  });
}

export function buildSaveBlocks(blocks: EditorBlock[]): TaskBlockTreeDto[] {
  return blocks.map((b): TaskBlockTreeDto => {
    if (b.blockType === 'loop') {
      return {
        id: b.id,
        parentBlockId: b.parentBlockId,
        blockType: BlockType.Loop,
        orderIndex: b.orderIndex,
        loop: {
          name: b.name,
          values: b.values.filter((v) => v.trim().length > 0),
          ...(b.columns.length > 0 ? { columns: b.columns, rows: b.rows } : {}),
        },
        scrape: null,
      };
    }
    return {
      id: b.id,
      parentBlockId: b.parentBlockId,
      blockType: BlockType.Scrape,
      orderIndex: b.orderIndex,
      loop: null,
      scrape: { scraperConfigId: b.scraperConfigId, stepBindings: b.stepBindings },
    };
  });
}
