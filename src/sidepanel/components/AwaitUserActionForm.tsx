import BackButton from './BackButton';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import type { AwaitUserActionOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function AwaitUserActionForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<AwaitUserActionOptions>;

  if (!step) return null;

  const handleSave = () => {
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Await User Action</h2>
      </div>

      <p className="view-subtitle">
        Pause the scraper and wait for you to do something on the page — like logging in or solving a captcha.
      </p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Log in to your account"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Message shown to user</label>
        <textarea
          className="form-textarea"
          rows={4}
          value={opts.message || ''}
          onChange={e => updateStepOptions(step.id, { message: e.target.value } as Partial<AwaitUserActionOptions>)}
          placeholder="e.g. Please log in, then click Resume to continue."
        />
        <p className="form-hint">This message will appear in the extension when the scraper pauses.</p>
      </div>

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Step
        </button>
      </div>
    </div>
  );
}
