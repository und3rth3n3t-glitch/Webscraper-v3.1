import { useState } from 'react';
import BackButton from './BackButton';
import PickedElementPreview from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import type { BestMatchOptions } from '../../types/config';

const STRICTNESS_OPTIONS = [
  { value: 'loose',  label: 'Loose — matches if some words overlap' },
  { value: 'normal', label: 'Normal — matches if most words match' },
  { value: 'strict', label: 'Strict — only matches very close results' },
];

interface Props {
  editingStepId?: string;
}

export default function BestMatchForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<BestMatchOptions>;

  const [showAlternate, setShowAlternate] = useState(!!opts.alternateContainerSelector);

  if (!step) return null;

  const updateOpt = (key: keyof BestMatchOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<BestMatchOptions>);

  const handlePickContainer = async (field = 'container') => {
    try {
      await sendToContent('START_PICKER', { mode: 'container' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(field);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const handleSave = () => {
    if (!opts.containerSelector) {
      useUiStore.getState().showToast('Please pick a container element first.', 'error');
      return;
    }
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  const waitMethod = opts.waitMethod || 'contentChange';
  const containerClickableCount = (opts as unknown as Record<string, unknown>).containerClickableCount;

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Best Search Match</h2>
      </div>

      <p className="view-subtitle">Pick the container that holds the search results. At runtime, the closest match to your search term will be clicked.</p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Click best matching result"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Container element</label>
        {opts.containerSelector ? (
          <>
            <PickedElementPreview
              selector={opts.containerSelector}
              elementType="generic"
              onRepick={() => handlePickContainer('container')}
            />
            {containerClickableCount !== null && containerClickableCount !== undefined && (
              <p className="form-hint">
                {containerClickableCount as number} clickable element
                {containerClickableCount !== 1 ? 's' : ''} found inside this container
              </p>
            )}
          </>
        ) : (
          <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickContainer('container')}>
            Pick Container
          </button>
        )}
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={opts.sameOriginOnly ?? true}
            onChange={e => updateOpt('sameOriginOnly', e.target.checked)}
          />
          Only follow links on this site
        </label>
        <p className="form-hint">When on, links to other websites are ignored. Turn off if a result legitimately lives on a different site.</p>
      </div>

      <div className="form-group">
        <label className="form-label">Match strictness</label>
        <select
          className="form-select"
          value={opts.matchStrictness || 'normal'}
          onChange={e => updateOpt('matchStrictness', e.target.value)}
        >
          {STRICTNESS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="form-hint">How closely a result must match your search term to be clicked.</p>
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
              if (!e.target.checked) updateOpt('alternateContainerSelector', null);
            }}
          />
          Add fallback location
        </label>
        <p className="form-hint">Try this if the primary container can't be found.</p>
      </div>

      {showAlternate && (
        <div className="form-group form-group-indented">
          <label className="form-label">Fallback container element</label>
          <PickedElementPreview
            selector={opts.alternateContainerSelector ?? null}
            elementType="generic"
            onRepick={() => handlePickContainer('alternate')}
          />
          {!opts.alternateContainerSelector && (
            <button className="btn btn-secondary btn-full mt-8" onClick={() => handlePickContainer('alternate')}>
              Pick Fallback Container
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
