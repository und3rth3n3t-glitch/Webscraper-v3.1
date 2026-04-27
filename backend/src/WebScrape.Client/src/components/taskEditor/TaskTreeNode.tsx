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
