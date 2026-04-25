import { useState } from 'react';
import BackButton from './BackButton';
import PickedElementPreview from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import type { SetInputOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function SetInputForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, setView, commitDraft } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<SetInputOptions>;

  const [showAlternate, setShowAlternate] = useState(!!opts.alternateSelector);

  if (!step) return null;

  const updateOpt = (key: keyof SetInputOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<SetInputOptions>);

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
      useUiStore.getState().showToast('Please pick an input element first.', 'error');
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
        <h2 className="view-title">Type Text</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Search for product name"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Input element</label>
        <PickedElementPreview
          selector={step.selector}
          elementType={step.elementType}
          label={step.label}
          extra={step.extra ?? undefined}
          onRepick={() => handlePickElement('primary')}
        />
        {!step.selector && (
          <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickElement('primary')}>
            Pick Input Element
          </button>
        )}
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={opts.clearBefore !== false}
            onChange={e => updateOpt('clearBefore', e.target.checked)}
          />
          Clear field before typing
        </label>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={!!opts.pressEnterAfter}
            onChange={e => updateOpt('pressEnterAfter', e.target.checked)}
          />
          Press Enter when done
        </label>
      </div>

      {opts.pressEnterAfter && (
        <>
          <div className="form-group">
            <label className="form-label">After pressing Enter</label>
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
        </>
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
        <p className="form-hint">Try this if the primary input can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback input element</label>
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
