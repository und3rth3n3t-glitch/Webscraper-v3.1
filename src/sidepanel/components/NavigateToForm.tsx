import BackButton from './BackButton';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import type { NavigateToOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function NavigateToForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<NavigateToOptions>;

  if (!step) return null;

  const url = opts.url ?? '';
  const canSave = url.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Go to URL</h2>
      </div>

      <p className="view-subtitle">
        Send the browser to a specific page. Useful as a starting point or to jump back to a known URL.
      </p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Open product page"
        />
      </div>

      <div className="form-group">
        <label className="form-label">URL</label>
        <input
          className="form-input"
          value={url}
          onChange={e => updateStepOptions(step.id, { url: e.target.value } as Partial<NavigateToOptions>)}
          placeholder="https://example.com/page/{searchTerm}"
        />
        <p className="form-hint">
          Use <code>{'{searchTerm}'}</code> anywhere in the URL to substitute the current loop term.
        </p>
      </div>

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full"
          onClick={handleSave}
          disabled={!canSave}
        >
          Save Step
        </button>
      </div>
    </div>
  );
}
