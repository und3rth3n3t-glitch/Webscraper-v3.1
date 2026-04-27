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
