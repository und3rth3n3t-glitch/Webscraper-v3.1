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
  configNames?: Record<string, string>;
};

export default function TaskTreePanel({
  roots,
  blocks,
  selectedId,
  onSelect,
  onAddAndSelect,
  dispatch,
  configNames,
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
          configNames={configNames}
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
