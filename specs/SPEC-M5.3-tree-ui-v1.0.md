# SPEC-M5.3 — Tree UI (Task Editor)
**Version**: 1.0  
**Status**: Ready for implementation  
**Theme**: M5 Theme 1 — Tree-shaped task editor with nested loops, multi-scrape, per-scrape config dropdown, multi-ancestor bindings  

---

## 1. Context

The current `TaskEditor.tsx` is hardcoded to exactly one loop block containing one scrape block. Any task with a different structure sets `complexStructure = true` and renders a "view-only" warning that prevents saving. The backend (`TaskValidator`, `QueueExpansionService`, `LoopBlockExpander`/`ScrapeBlockExpander`) already supports arbitrary nested trees with sibling loops, multiple scrapes per loop, and nested loops.

This spec replaces the single-loop-single-scrape form with a two-pane tree editor:
- **Left pane**: block tree with +/−/reorder actions
- **Right pane**: inspector for the selected block (loop name + values, or scrape config + bindings)

No backend changes. Schema, validator, expander, and dispatch path are tree-ready today.

---

## 2. Prerequisites

No other work in-flight blocks this spec. `BindingsEditor.tsx` signature changes are contained here.

---

## 3. New file: `utils/taskTree.ts`

**Full path**: `backend/src/WebScrape.Client/src/utils/taskTree.ts`

This file is pure (no React, no side effects). All mutators return new arrays.

```typescript
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

export type LoopAncestor = { id: string; name: string };

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
  | { type: 'UPDATE_LOOP'; id: string; patch: Partial<Pick<LoopEditorBlock, 'name' | 'values'>> }
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
      result.push({ id: parent.id, name: parent.name });
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
  patch: Partial<Pick<LoopEditorBlock, 'name' | 'values'>>,
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
        loop: { name: b.name, values: b.values.filter((v) => v.trim().length > 0) },
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
```

---

## 4. Modified file: `utils/taskEditor.ts`

**Full path**: `backend/src/WebScrape.Client/src/utils/taskEditor.ts`

**Delete**:
- `EditorState` type (lines 6–13) — replaced by `EditorBlock[]` flat state in `taskTree.ts`
- `buildSaveDto` function (lines 16–38) — replaced by `buildSaveBlocks` in `taskTree.ts`
- The `BlockType` import (no longer needed)
- The `SaveTaskDto` import (no longer needed)

**Modify**: `autoBindSteps` — change parameter from `loopBlockId: string` to `innermostLoopBlockId: string | null`. When null, all steps are unbound.

**Full replacement** of `utils/taskEditor.ts`:

```typescript
import type { StepBindingDto } from '../api/types';

export type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

export function parseSetInputSteps(configJson: unknown): SetInputStep[] {
  try {
    const obj = configJson as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) return [];
    return obj.steps.filter(
      (s): s is SetInputStep =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>).type === 'setInput' &&
        typeof (s as Record<string, unknown>).id === 'string',
    );
  } catch {
    return [];
  }
}

export function autoBindSteps(
  steps: SetInputStep[],
  innermostLoopBlockId: string | null,
): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  let firstBound = false;
  for (const step of steps) {
    if (!firstBound && innermostLoopBlockId) {
      result[step.id] = { kind: 'loopRef', loopBlockId: innermostLoopBlockId };
      firstBound = true;
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}
```

---

## 5. Modified file: `components/BindingsEditor.tsx`

**Full path**: `backend/src/WebScrape.Client/src/components/BindingsEditor.tsx`

**Change**: Replace `loopBlockId: string` + `loopName: string` props with `loopAncestors: LoopAncestor[]`. Each ancestor is an `{ id, name }` pair, innermost first.

The select value encoding for loop references changes to `loopRef:<loopBlockId>` to distinguish multiple loop options. The existing `StepBindingDto.loopRef` shape is unchanged — only the UI representation changes.

**Full replacement** of `components/BindingsEditor.tsx`:

```tsx
import type { StepBindingDto } from '../api/types';
import type { LoopAncestor } from '../utils/taskTree';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type Props = {
  steps: SetInputStep[];
  loopAncestors: LoopAncestor[];
  stepBindings: Record<string, StepBindingDto>;
  onChange: (bindings: Record<string, StepBindingDto>) => void;
};

function selectValue(binding: StepBindingDto): string {
  if (binding.kind === 'loopRef') return `loopRef:${binding.loopBlockId}`;
  return binding.kind;
}

function bindingFromSelect(value: string): StepBindingDto {
  if (value.startsWith('loopRef:')) {
    return { kind: 'loopRef', loopBlockId: value.slice('loopRef:'.length) };
  }
  if (value === 'literal') return { kind: 'literal', value: '' };
  return { kind: 'unbound' };
}

export default function BindingsEditor({ steps, loopAncestors, stepBindings, onChange }: Props) {
  if (steps.length === 0) {
    return (
      <div className="form-hint">
        This config has no inputs. Loop values will run the scrape, but won't be substituted.
      </div>
    );
  }

  if (loopAncestors.length === 0) {
    return (
      <div className="form-hint">
        This scrape has no parent loops. Add a loop ancestor to bind values.
      </div>
    );
  }

  const update = (stepId: string, binding: StepBindingDto) => {
    onChange({ ...stepBindings, [stepId]: binding });
  };

  return (
    <div>
      {steps.length > 1 && (
        <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>
          Other inputs default to Unbound — bind them manually.
        </div>
      )}
      {steps.map((step) => {
        const binding = stepBindings[step.id] ?? { kind: 'unbound' as const };
        return (
          <div key={step.id} className="form-group">
            <label className="form-label">{step.id}</label>
            <select
              className="form-select"
              value={selectValue(binding)}
              onChange={(e) => update(step.id, bindingFromSelect(e.target.value))}
            >
              {loopAncestors.map((a) => (
                <option key={a.id} value={`loopRef:${a.id}`}>
                  Loop value ({a.name}.currentItem)
                </option>
              ))}
              <option value="literal">Literal value</option>
              <option value="unbound">Unbound</option>
            </select>
            {binding.kind === 'literal' && (
              <input
                className="form-input"
                placeholder="Static text"
                value={binding.value}
                onChange={(e) => update(step.id, { kind: 'literal', value: e.target.value })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

---

## 6. New file: `components/taskEditor/TaskTreePanel.tsx`

**Full path**: `backend/src/WebScrape.Client/src/components/taskEditor/TaskTreePanel.tsx`

Left-pane tree. Handles the root-level "+ Add loop" button. Recursively renders `TaskTreeNode` for each root.

```tsx
import type React from 'react';
import type { EditorBlock, BlocksAction, TreeNode } from '../../utils/taskTree';
import TaskTreeNode from './TaskTreeNode';

type Props = {
  roots: TreeNode[];
  blocks: EditorBlock[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddAndSelect: (blockType: 'loop' | 'scrape', parentId: string | null) => void;
  dispatch: React.Dispatch<BlocksAction>;
};

export default function TaskTreePanel({
  roots,
  blocks,
  selectedId,
  onSelect,
  onAddAndSelect,
  dispatch,
}: Props) {
  return (
    <div className="card task-tree">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Blocks
      </div>

      {roots.length === 0 && (
        <div className="form-hint">No blocks yet.</div>
      )}

      {roots.map((node) => (
        <TaskTreeNode
          key={node.block.id}
          node={node}
          blocks={blocks}
          selectedId={selectedId}
          onSelect={onSelect}
          onAddAndSelect={onAddAndSelect}
          dispatch={dispatch}
        />
      ))}

      <div className="task-tree__add-menu">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onAddAndSelect('loop', null)}
        >
          + Add loop
        </button>
      </div>
    </div>
  );
}
```

---

## 7. New file: `components/taskEditor/TaskTreeNode.tsx`

**Full path**: `backend/src/WebScrape.Client/src/components/taskEditor/TaskTreeNode.tsx`

One row in the tree. Loop nodes render children recursively. Hover actions: `+ Loop child`, `+ Scrape child` (loops only), `↑`, `↓`, `🗑`.

```tsx
import type React from 'react';
import type { TreeNode, EditorBlock, BlocksAction } from '../../utils/taskTree';
import { descendantsOf } from '../../utils/taskTree';

type Props = {
  node: TreeNode;
  blocks: EditorBlock[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddAndSelect: (blockType: 'loop' | 'scrape', parentId: string | null) => void;
  dispatch: React.Dispatch<BlocksAction>;
  configNames?: Record<string, string>;
  depth?: number;
};

export default function TaskTreeNode({
  node,
  blocks,
  selectedId,
  onSelect,
  onAddAndSelect,
  dispatch,
  configNames = {},
  depth = 0,
}: Props) {
  const { block, children } = node;
  const isSelected = block.id === selectedId;
  const isLoop = block.blockType === 'loop';

  const label = isLoop
    ? block.name
    : block.scraperConfigId
    ? (configNames[block.scraperConfigId] ?? 'Scrape')
    : 'New scrape';

  const siblings = blocks.filter((b) => b.parentBlockId === block.parentBlockId);
  const siblingsSorted = [...siblings].sort((a, b) => a.orderIndex - b.orderIndex);
  const siblingIdx = siblingsSorted.findIndex((b) => b.id === block.id);
  const canMoveUp = siblingIdx > 0;
  const canMoveDown = siblingIdx < siblings.length - 1;

  const handleDelete = () => {
    const descCount = descendantsOf(blocks, block.id).length;
    if (descCount > 0) {
      if (!window.confirm(`Delete this loop and ${descCount} child block(s)?`)) return;
    }
    dispatch({ type: 'DELETE', id: block.id });
  };

  const icon = isLoop ? '⟲' : '◈';
  const typeClass = isLoop ? 'task-tree__node--loop' : 'task-tree__node--scrape';

  return (
    <div style={{ paddingLeft: depth > 0 ? `calc(${depth} * var(--spacing-lg))` : undefined }}>
      <div
        className={`task-tree__node ${typeClass}${isSelected ? ' task-tree__node--selected' : ''}`}
        onClick={() => onSelect(block.id)}
      >
        <span className="task-tree__icon">{icon}</span>
        <span className="task-tree__label">{label}</span>
        <span className="task-tree__actions">
          {isLoop && (
            <>
              <button
                className="btn btn-ghost btn-xs"
                title="Add loop child"
                onClick={(e) => { e.stopPropagation(); onAddAndSelect('loop', block.id); }}
              >
                + Loop
              </button>
              <button
                className="btn btn-ghost btn-xs"
                title="Add scrape child"
                onClick={(e) => { e.stopPropagation(); onAddAndSelect('scrape', block.id); }}
              >
                + Scrape
              </button>
            </>
          )}
          <button
            className="btn btn-ghost btn-xs"
            title="Move up"
            disabled={!canMoveUp}
            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REORDER', id: block.id, direction: 'up' }); }}
          >
            ↑
          </button>
          <button
            className="btn btn-ghost btn-xs"
            title="Move down"
            disabled={!canMoveDown}
            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REORDER', id: block.id, direction: 'down' }); }}
          >
            ↓
          </button>
          <button
            className="btn btn-ghost btn-xs task-tree__del"
            title="Delete"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
          >
            🗑
          </button>
        </span>
      </div>

      {children.length > 0 && (
        <div className="task-tree__children">
          {children.map((child) => (
            <TaskTreeNode
              key={child.block.id}
              node={child}
              blocks={blocks}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddAndSelect={onAddAndSelect}
              dispatch={dispatch}
              configNames={configNames}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 8. New file: `components/taskEditor/LoopBlockInspector.tsx`

**Full path**: `backend/src/WebScrape.Client/src/components/taskEditor/LoopBlockInspector.tsx`

Right pane when a loop block is selected. Edits loop name and values.

```tsx
import type React from 'react';
import type { LoopEditorBlock, BlocksAction } from '../../utils/taskTree';

type Props = {
  block: LoopEditorBlock;
  dispatch: React.Dispatch<BlocksAction>;
};

export default function LoopBlockInspector({ block, dispatch }: Props) {
  return (
    <div className="card">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Loop
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="loop-name">Name</label>
        <input
          id="loop-name"
          className="form-input"
          value={block.name}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { name: e.target.value } })
          }
          placeholder="e.g. loop1"
        />
        <div className="form-hint">Used to reference this loop's current value in bindings.</div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="loop-values">Values</label>
        <textarea
          id="loop-values"
          className="form-textarea"
          rows={8}
          value={block.values.join('\n')}
          onChange={(e) => {
            const vals = e.target.value.split('\n').map((v) => v.trimEnd());
            dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: vals } });
          }}
          placeholder="One value per line. Each value runs the loop once."
        />
        <div className="form-hint">One value per line. Each value runs the loop once.</div>
      </div>
    </div>
  );
}
```

---

## 9. New file: `components/taskEditor/ScrapeBlockInspector.tsx`

**Full path**: `backend/src/WebScrape.Client/src/components/taskEditor/ScrapeBlockInspector.tsx`

Right pane when a scrape block is selected. Config dropdown + bindings editor.

```tsx
import { useMemo } from 'react';
import type React from 'react';
import type { ScrapeEditorBlock, EditorBlock, BlocksAction } from '../../utils/taskTree';
import { loopAncestorsOf } from '../../utils/taskTree';
import type { ScraperConfigDto } from '../../api/types';
import BindingsEditor from '../BindingsEditor';
import { autoBindSteps, parseSetInputSteps } from '../../utils/taskEditor';

type Props = {
  block: ScrapeEditorBlock;
  blocks: EditorBlock[];
  configs: ScraperConfigDto[];
  dispatch: React.Dispatch<BlocksAction>;
};

export default function ScrapeBlockInspector({ block, blocks, configs, dispatch }: Props) {
  const loopAncestors = useMemo(
    () => loopAncestorsOf(blocks, block.id),
    [blocks, block.id],
  );

  const selectedConfig = useMemo(
    () => configs.find((c) => c.id === block.scraperConfigId) ?? null,
    [configs, block.scraperConfigId],
  );

  const setInputSteps = useMemo(
    () => (selectedConfig ? parseSetInputSteps(selectedConfig.configJson) : []),
    [selectedConfig],
  );

  const configMissing =
    !!block.scraperConfigId && !configs.find((c) => c.id === block.scraperConfigId);

  const handleConfigChange = (configId: string) => {
    const config = configs.find((c) => c.id === configId);
    const steps = config ? parseSetInputSteps(config.configJson) : [];
    const innermostLoopId = loopAncestors[0]?.id ?? null;
    dispatch({
      type: 'UPDATE_SCRAPE',
      id: block.id,
      patch: {
        scraperConfigId: configId,
        stepBindings: autoBindSteps(steps, innermostLoopId),
      },
    });
  };

  return (
    <div className="card">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Scrape
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="scrape-config">Scraper config</label>
        <select
          id="scrape-config"
          className="form-select"
          value={block.scraperConfigId}
          onChange={(e) => handleConfigChange(e.target.value)}
        >
          <option value="">— pick a config —</option>
          {configMissing && (
            <option value={block.scraperConfigId} disabled>
              {block.scraperConfigId} (deleted)
            </option>
          )}
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Input bindings
      </div>
      <BindingsEditor
        steps={setInputSteps}
        loopAncestors={loopAncestors}
        stepBindings={block.stepBindings}
        onChange={(bindings) =>
          dispatch({ type: 'UPDATE_SCRAPE', id: block.id, patch: { stepBindings: bindings } })
        }
      />
    </div>
  );
}
```

---

## 10. Full rewrite: `pages/TaskEditor.tsx`

**Full path**: `backend/src/WebScrape.Client/src/pages/TaskEditor.tsx`

Delete all existing content (238 lines) and replace with the following.

```tsx
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useScraperConfigs, useTask } from '../api/queries';
import { useSaveTask } from '../api/mutations';
import type { ValidationErrorDto } from '../api/types';
import { axiosErrorMessage } from '../utils/errorMessages';
import {
  addLoopChild,
  addScrapeChild,
  buildSaveBlocks,
  buildTree,
  deleteBlock,
  hydrateFromDto,
  reorderSibling,
  updateLoop,
  updateScrape,
  type BlocksAction,
  type EditorBlock,
  type LoopEditorBlock,
  type ScrapeEditorBlock,
} from '../utils/taskTree';
import TaskTreePanel from '../components/taskEditor/TaskTreePanel';
import LoopBlockInspector from '../components/taskEditor/LoopBlockInspector';
import ScrapeBlockInspector from '../components/taskEditor/ScrapeBlockInspector';

function blocksReducer(state: EditorBlock[], action: BlocksAction): EditorBlock[] {
  switch (action.type) {
    case 'HYDRATE': return action.blocks;
    case 'ADD_LOOP': return addLoopChild(state, action.parentId, action.newId);
    case 'ADD_SCRAPE': return addScrapeChild(state, action.parentId, action.newId);
    case 'DELETE': return deleteBlock(state, action.id);
    case 'REORDER': return reorderSibling(state, action.id, action.direction);
    case 'UPDATE_LOOP': return updateLoop(state, action.id, action.patch);
    case 'UPDATE_SCRAPE': return updateScrape(state, action.id, action.patch);
    default: return state;
  }
}

function mapValidationError(e: ValidationErrorDto): string {
  switch (e.code) {
    case 'MISSING_TASK_NAME': return 'Add a name for this task.';
    case 'CONFIG_NOT_OWNED': return 'Pick a scraper config you own.';
    case 'BINDING_LITERAL_MISSING_VALUE':
      return `Step '${e.stepId ?? '?'}' is set to a literal value but has no text.`;
    case 'LOOP_REF_NON_ANCESTOR':
      return `Step '${e.stepId ?? '?'}' references a loop that doesn't apply here.`;
    default: return `Couldn't save this task (${e.code}).`;
  }
}

export default function TaskEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();

  const { data: existingTask, isPending: loadingTask, isError: taskLoadError } = useTask(id);
  const { data: configs } = useScraperConfigs();
  const save = useSaveTask();

  const [taskName, setTaskName] = useState('');
  const [blocks, dispatch] = useReducer(blocksReducer, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!isEdit || !existingTask || hydrated) return;
    setTaskName(existingTask.name);
    const editorBlocks = hydrateFromDto(existingTask.blocks);
    dispatch({ type: 'HYDRATE', blocks: editorBlocks });
    const firstRoot = [...existingTask.blocks]
      .filter((b) => b.parentBlockId === null)
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];
    if (firstRoot) setSelectedId(firstRoot.id);
    setHydrated(true);
  }, [isEdit, existingTask, hydrated]);

  // Clear selection if the selected block was deleted
  useEffect(() => {
    if (selectedId && !blocks.find((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [blocks, selectedId]);

  const selectedBlock = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [blocks, selectedId],
  );

  const treeRoots = useMemo(() => buildTree(blocks), [blocks]);

  const configNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of configs ?? []) map[c.id] = c.name;
    return map;
  }, [configs]);

  const handleAddAndSelect = useCallback(
    (blockType: 'loop' | 'scrape', parentId: string | null) => {
      if (blockType === 'scrape' && parentId === null) return;
      const newId = crypto.randomUUID();
      if (blockType === 'loop') {
        dispatch({ type: 'ADD_LOOP', parentId, newId });
      } else {
        dispatch({ type: 'ADD_SCRAPE', parentId: parentId!, newId });
      }
      setSelectedId(newId);
    },
    [],
  );

  const saveError = useMemo(() => {
    const e = save.error;
    if (!e) return null;
    if (axios.isAxiosError(e) && e.response?.status === 400) {
      const data = e.response.data as { errors?: ValidationErrorDto[] };
      if (data.errors?.length) return data.errors.map(mapValidationError).join(' ');
    }
    return axiosErrorMessage(e, "Couldn't save this task.");
  }, [save.error]);

  const canSave = !!taskName.trim() && blocks.length > 0;

  const submit = async () => {
    if (!canSave) return;
    await save.mutateAsync({ id, body: { name: taskName, blocks: buildSaveBlocks(blocks) } });
    nav('/tasks');
  };

  if (isEdit && loadingTask) return <div className="loading-state">Loading…</div>;

  if (isEdit && taskLoadError) {
    return (
      <div className="view">
        <div className="danger-banner">This task no longer exists.</div>
        <Link to="/tasks" className="btn btn-ghost">← Back to tasks</Link>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back to tasks">←</Link>
          <h2 className="view-title">{isEdit ? 'Edit task' : 'New task'}</h2>
        </div>
        <div className="flex gap-sm">
          <button className="btn btn-ghost" onClick={() => nav('/tasks')}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={save.isPending || !canSave}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && <div className="danger-banner">{saveError}</div>}

      <div className="form-group" style={{ maxWidth: 400 }}>
        <label className="form-label" htmlFor="task-name">Name</label>
        <input
          id="task-name"
          className="form-input"
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
          placeholder="e.g. Bing news search"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: 'var(--spacing-lg)',
          alignItems: 'start',
        }}
      >
        <TaskTreePanel
          roots={treeRoots}
          blocks={blocks}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAddAndSelect={handleAddAndSelect}
          dispatch={dispatch}
          configNames={configNames}
        />

        <div>
          {blocks.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-title">This task is empty</div>
              <div className="empty-state-desc">
                Add a loop to iterate values, or a scrape to grab a single page.
              </div>
            </div>
          )}
          {blocks.length > 0 && !selectedBlock && (
            <div className="form-hint">Select a block on the left to configure it.</div>
          )}
          {selectedBlock?.blockType === 'loop' && (
            <LoopBlockInspector
              block={selectedBlock as LoopEditorBlock}
              dispatch={dispatch}
            />
          )}
          {selectedBlock?.blockType === 'scrape' && (
            <ScrapeBlockInspector
              block={selectedBlock as ScrapeEditorBlock}
              blocks={blocks}
              configs={configs ?? []}
              dispatch={dispatch}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

Note: `TaskTreePanel` now accepts `configNames` — add that prop to its Props type (update section 6 accordingly: pass `configNames={configNames}` from editor, accept `configNames?: Record<string, string>` in panel, and pass `configNames={configNames}` to each `TaskTreeNode`).

---

## 10a. TaskTreePanel prop update

`TaskTreePanel.tsx` needs to accept and forward `configNames`. Add to its `Props` type:

```tsx
  configNames?: Record<string, string>;
```

And pass it to each `TaskTreeNode`:

```tsx
      {roots.map((node) => (
        <TaskTreeNode
          key={node.block.id}
          node={node}
          blocks={blocks}
          selectedId={selectedId}
          onSelect={onSelect}
          onAddAndSelect={onAddAndSelect}
          dispatch={dispatch}
          configNames={configNames}
        />
      ))}
```

---

## 11. CSS additions to `index.css`

**Append after line 490** (after the `.danger-banner` block, at the end of the file):

```css
/* ===== Task tree ===== */
.task-tree {
  padding: var(--spacing-sm);
}
.task-tree__node {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
  position: relative;
}
.task-tree__node:hover { background: var(--bg-hover); }
.task-tree__node--selected { background: var(--bg-hover); outline: 2px solid var(--purple-primary); }
.task-tree__node--loop .task-tree__icon { color: var(--purple-primary); }
.task-tree__node--scrape .task-tree__icon { color: var(--text-muted); }
.task-tree__label { flex: 1; font-size: var(--font-size-sm); color: var(--text-dark); }
.task-tree__actions {
  display: none;
  align-items: center;
  gap: 2px;
}
.task-tree__node:hover .task-tree__actions { display: flex; }
.task-tree__del { color: var(--danger) !important; }
.task-tree__children { border-left: 2px solid var(--border); margin-left: var(--spacing-md); }
.task-tree__add-menu {
  margin-top: var(--spacing-sm);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--bg-light);
}

/* btn-xs variant (tree action buttons) */
.btn.btn-xs {
  padding: 1px 6px;
  font-size: 11px;
  min-height: unset;
}
```

---

## 12. New test file: `src/__tests__/taskTree.test.ts`

**Full path**: `backend/src/WebScrape.Client/src/__tests__/taskTree.test.ts`

```typescript
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
    const blocks: EditorBlock[] = [mkScrape('S1', 'L1'), mkLoop('L1', null)];
    // S1 is under L1 which IS a loop — adjust to test truly no ancestors
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
```

---

## 13. Verification

### Typecheck + lint + test

```bash
# From repo root
cd backend/src/WebScrape.Client
npm run typecheck
npm run lint
npx vitest run src/__tests__/taskTree.test.ts
```

### Dev server smoke test

```bash
cd backend/src/WebScrape.Client
npm run dev
```

### Manual test script

1. **New task — empty state**: Navigate to `/tasks/new`. Right pane shows "This task is empty" message and no error. Save button is disabled.

2. **Add root loop**: Click "+ Add loop" in the tree panel. A `loop1` node appears. It is auto-selected. Right pane shows `LoopBlockInspector` with name field and values textarea.

3. **Edit loop**: Change loop name to `keyword`. Set values to two lines: `cat` / `dog`. Verify loop node label in tree updates as you type.

4. **Add scrape child**: Hover over the loop node. Click `+ Scrape`. A "New scrape" node appears under the loop, auto-selected. Right pane shows `ScrapeBlockInspector`.

5. **Config dropdown**: Select a config in the scrape inspector. Node label in tree updates to the config name.

6. **Bindings**: The bindings editor shows the innermost loop (`keyword`) as the only loop-ref option. The first `setInput` step auto-binds to it.

7. **Add sibling scrape**: Hover over the loop node again. Click `+ Scrape`. A second scrape appears. Set a different config. Verify both scrapes are listed in the tree.

8. **Nested loop**: Hover over loop1. Click `+ Loop`. A `loop2` node appears under it. Click `+ Scrape` on loop2. The bindings for that scrape show both `loop2` (innermost) and `loop1` as options.

9. **Reorder**: With two root-level siblings, click `↑` and `↓` and verify order swaps.

10. **Delete with children**: Delete a loop that has children. `window.confirm` appears with correct child count. Confirm → loop and all children removed from tree.

11. **Save**: Fill task name. Click Save. Task appears in task list at `/tasks`.

12. **Edit existing complex task**: Open a task previously flagged as `complexStructure`. It opens cleanly in the tree editor without a warning banner. Tree renders the full structure.

13. **Populate preview**: After saving a nested 2-loop task, open it from `/tasks`. Click "Run". `PopulatePreviewModal` shows `loop1×loop2` iterations with correct `iterationLabel` per item (already works; verify only).

---

## 14. What is deleted

| What | Where | Why |
|---|---|---|
| `EditorState` type | `utils/taskEditor.ts` lines 6–13 | Replaced by `EditorBlock[]` flat state |
| `buildSaveDto` function | `utils/taskEditor.ts` lines 16–38 | Replaced by `buildSaveBlocks` in `taskTree.ts` |
| `complexStructure` state | `pages/TaskEditor.tsx` line 52 | Tree editor handles all shapes |
| `complexStructure` guard | `pages/TaskEditor.tsx` lines 66–74 | Same |
| "complex structure" banner | `pages/TaskEditor.tsx` lines 165–169 | Same |
| Hardcoded `LOOP_NAME` | `pages/TaskEditor.tsx` line 12 | Tree names loops dynamically |
| `newEditorState()` | `pages/TaskEditor.tsx` lines 14–24 | `useReducer` starts from `[]` |
| `handleConfigChange` (TaskEditor) | `pages/TaskEditor.tsx` lines 98–106 | Moved to `ScrapeBlockInspector` |
| `canSave` complexStructure check | `pages/TaskEditor.tsx` line 127 | Condition removed |
| `loopBlockId: string, loopName: string` props | `components/BindingsEditor.tsx` lines 6–8 | Replaced by `loopAncestors: LoopAncestor[]` |
| `BlockType` import | `utils/taskEditor.ts` line 1 | Moved to `taskTree.ts` |
| `SaveTaskDto` import | `utils/taskEditor.ts` line 2 | Moved to `taskTree.ts` |
