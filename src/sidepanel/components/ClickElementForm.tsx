import { useState } from 'react';
import BackButton from './BackButton';
import PickedElementPreview from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import type { ClickOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function ClickElementForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<ClickOptions>;

  const [showAlternate, setShowAlternate] = useState(!!opts.alternateSelector);

  if (!step) return null;

  const updateOpt = (key: keyof ClickOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<ClickOptions>);

  const handlePickElement = async (field = 'primary') => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(field);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const handleSave = () => {
    if (!step.selector) {
      useUiStore.getState().showToast('Please pick an element to click first.', 'error');
      return;
    }
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  const waitMethod = opts.waitMethod || 'fixedDelay';

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Click</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Click the search button"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Element to click</label>
        <PickedElementPreview
          selector={step.selector}
          elementType={step.elementType}
          extra={step.extra ?? undefined}
          onRepick={() => handlePickElement('primary')}
        />
        {!step.selector && (
          <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickElement('primary')}>
            Pick Element
          </button>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">After clicking</label>
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
          <p className="form-hint">How long to wait before the next step runs.</p>
        </div>
      )}

      {waitMethod === 'elementAppear' && (
        <div className="form-group">
          <label className="form-label">Element to wait for</label>
          <input
            className="form-input"
            value={(opts.waitForSelector as unknown as string) || ''}
            onChange={e => updateOpt('waitForSelector', e.target.value ? (e.target.value as unknown as typeof opts.waitForSelector) : null)}
            placeholder="CSS selector, e.g. .results"
          />
          <p className="form-hint">The page element that should appear before continuing.</p>
        </div>
      )}

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={showAlternate}
            onChange={e => {
              setShowAlternate(e.target.checked);
              if (!e.target.checked) updateOpt('alternateSelector', null);
            }}
          />
          Add fallback location
        </label>
        <p className="form-hint">Try this if the primary button can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback element to click</label>
          <PickedElementPreview
            selector={opts.alternateSelector ?? null}
            onRepick={() => handlePickElement('alternate')}
          />
          {!opts.alternateSelector && (
            <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickElement('alternate')}>
              Pick Fallback Element
            </button>
          )}
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
