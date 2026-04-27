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
            dispatch({ type: 'UPDATE_LOOP', id: block.id, patch: { values: e.target.value.split('\n') } });
          }}
          onBlur={(e) => {
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
