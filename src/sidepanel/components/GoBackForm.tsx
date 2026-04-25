import BackButton from './BackButton';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import type { GoBackOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function GoBackForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<GoBackOptions>;

  if (!step) return null;

  const updateOpt = (key: keyof GoBackOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<GoBackOptions>);

  const handleSave = () => {
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  const waitMethod = opts.waitMethod || 'contentChange';

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Go Back</h2>
      </div>

      <p className="view-subtitle">Navigate to the previous page using browser history.</p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Return to search results"
        />
      </div>

      <div className="form-group">
        <label className="form-label">After going back</label>
        <select
          className="form-select"
          value={waitMethod}
          onChange={e => updateOpt('waitMethod', e.target.value)}
        >
          <option value="fixedDelay">Wait a set amount of time</option>
          <option value="contentChange">Wait for the page to update</option>
          <option value="elementAppear">Wait for a specific element to appear</option>
        </select>
      </div>

      {waitMethod === 'fixedDelay' && (
        <div className="form-group">
          <label className="form-label">Wait time (ms)</label>
          <input
            type="number"
            className="form-input"
            value={opts.waitAfterMs ?? 1500}
            min={0}
            max={30000}
            step={100}
            onChange={e => updateOpt('waitAfterMs', Number(e.target.value))}
          />
        </div>
      )}

      {waitMethod === 'elementAppear' && (
        <div className="form-group">
          <label className="form-label">Element to wait for</label>
          <input
            className="form-input"
            value={(opts.waitForSelector as unknown as string) || ''}
            onChange={e => updateOpt('waitForSelector', e.target.value ? (e.target.value as unknown as typeof opts.waitForSelector) : null)}
            placeholder="CSS selector, e.g. .search-results"
          />
        </div>
      )}

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Step
        </button>
      </div>
    </div>
  );
}
