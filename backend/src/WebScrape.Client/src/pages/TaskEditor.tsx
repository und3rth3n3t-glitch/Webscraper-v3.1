import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useScraperConfigs, useTask } from '../api/queries';
import { useSaveTask } from '../api/mutations';
import BindingsEditor from '../components/BindingsEditor';
import type { ValidationErrorDto } from '../api/types';
import { autoBindSteps, buildSaveDto, parseSetInputSteps } from '../utils/taskEditor';
import type { EditorState } from '../utils/taskEditor';
import { axiosErrorMessage } from '../utils/errorMessages';

const LOOP_NAME = 'loop1';

function newEditorState(): EditorState {
  return {
    name: '',
    loopBlockId: crypto.randomUUID(),
    scrapeBlockId: crypto.randomUUID(),
    loopName: LOOP_NAME,
    loopValues: [],
    scraperConfigId: '',
    stepBindings: {},
  };
}

function mapValidationError(e: ValidationErrorDto): string {
  switch (e.code) {
    case 'MISSING_TASK_NAME':
      return 'Add a name for this task.';
    case 'CONFIG_NOT_OWNED':
      return 'Pick a scraper config you own.';
    case 'BINDING_LITERAL_MISSING_VALUE':
      return `Step '${e.stepId ?? '?'}' is set to a literal value but has no text.`;
    case 'LOOP_REF_NON_ANCESTOR':
      return `Step '${e.stepId ?? '?'}' references a loop that doesn't apply here.`;
    default:
      return `Couldn't save this task (${e.code}).`;
  }
}

export default function TaskEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();

  const { data: existingTask, isPending: loadingTask, isError: taskLoadError } = useTask(id);
  const { data: configs } = useScraperConfigs();
  const save = useSaveTask();

  const [state, setState] = useState<EditorState>(newEditorState);
  const [hydrated, setHydrated] = useState(false);
  const [complexStructure, setComplexStructure] = useState(false);

  useEffect(() => {
    if (!isEdit || !existingTask || hydrated) return;

    const loopBlock = existingTask.blocks.find(
      (b) => b.blockType === 'loop' && b.parentBlockId === null,
    );
    const scrapeBlock = loopBlock
      ? existingTask.blocks.find(
          (b) => b.blockType === 'scrape' && b.parentBlockId === loopBlock.id,
        )
      : undefined;

    if (!loopBlock || !scrapeBlock) {
      setComplexStructure(true);
      setHydrated(true);
      return;
    }

    if (existingTask.blocks.length > 2) {
      setComplexStructure(true);
    }

    setState({
      name: existingTask.name,
      loopBlockId: loopBlock.id,
      scrapeBlockId: scrapeBlock.id,
      loopName: loopBlock.loop?.name ?? LOOP_NAME,
      loopValues: loopBlock.loop?.values ?? [],
      scraperConfigId: scrapeBlock.scrape?.scraperConfigId ?? '',
      stepBindings: scrapeBlock.scrape?.stepBindings ?? {},
    });
    setHydrated(true);
  }, [isEdit, existingTask, hydrated]);

  const selectedConfig = useMemo(
    () => configs?.find((c) => c.id === state.scraperConfigId) ?? null,
    [configs, state.scraperConfigId],
  );

  const setInputSteps = useMemo(
    () => (selectedConfig ? parseSetInputSteps(selectedConfig.configJson) : []),
    [selectedConfig],
  );

  const handleConfigChange = (configId: string) => {
    const config = configs?.find((c) => c.id === configId);
    const steps = config ? parseSetInputSteps(config.configJson) : [];
    setState((s) => ({
      ...s,
      scraperConfigId: configId,
      stepBindings: autoBindSteps(steps, s.loopBlockId),
    }));
  };

  const saveError = useMemo(() => {
    const e = save.error;
    if (!e) return null;
    if (axios.isAxiosError(e) && e.response?.status === 400) {
      const data = e.response.data as { errors?: ValidationErrorDto[] };
      if (data.errors?.length) {
        return data.errors.map(mapValidationError).join(' ');
      }
    }
    return axiosErrorMessage(e, "Couldn't save this task.");
  }, [save.error]);

  const configMissing =
    isEdit &&
    hydrated &&
    !!state.scraperConfigId &&
    configs !== undefined &&
    !configs.find((c) => c.id === state.scraperConfigId);

  const canSave = !complexStructure && !!state.name.trim() && !!state.scraperConfigId;

  const submit = async () => {
    if (!canSave) return;
    await save.mutateAsync({ id, body: buildSaveDto(state) });
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

      {complexStructure && (
        <div className="run-banner run-banner-warning">
          This task has a more complex structure than this editor supports. You can view it but not save changes.
        </div>
      )}

      {saveError && <div className="danger-banner">{saveError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>
        <div>
          <div className="form-group">
            <label className="form-label" htmlFor="task-name">Name</label>
            <input
              id="task-name"
              className="form-input"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              placeholder="e.g. Bing news search"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="task-config">Scraper config</label>
            <select
              id="task-config"
              className="form-select"
              value={state.scraperConfigId}
              onChange={(e) => handleConfigChange(e.target.value)}
            >
              <option value="">— pick a config —</option>
              {configMissing && (
                <option value={state.scraperConfigId} disabled>
                  {state.scraperConfigId} (deleted)
                </option>
              )}
              {(configs ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="task-values">Loop values</label>
            <textarea
              id="task-values"
              className="form-textarea"
              rows={8}
              value={state.loopValues.join('\n')}
              onChange={(e) => {
                const vals = e.target.value.split('\n').map((v) => v.trimEnd());
                setState((s) => ({ ...s, loopValues: vals }));
              }}
              placeholder="One value per line. Each value runs the scrape once."
            />
            <div className="form-hint">One value per line. Each value runs the scrape once.</div>
          </div>
        </div>

        <div className="card">
          <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
            Input bindings
          </div>
          <BindingsEditor
            steps={setInputSteps}
            loopBlockId={state.loopBlockId}
            loopName={state.loopName}
            stepBindings={state.stepBindings}
            onChange={(bindings) => setState((s) => ({ ...s, stepBindings: bindings }))}
          />
        </div>
      </div>
    </div>
  );
}
