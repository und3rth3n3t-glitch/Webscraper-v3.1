import BackButton from './BackButton';
import PickedElementPreview from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { generateId } from '../utils/uuid';
import { X } from 'lucide-react';
import type { SelectEachOptions } from '../../types/config';

interface SubStep {
  id: string;
  type: string;
  label: string;
  options?: Record<string, unknown>;
}

interface SelectEachInner {
  controlType: string | null;
  controlSelector: SelectEachOptions['selectEachOptions']['controlSelector'];
  options: Array<{ value: string; label: string; selected: boolean }>;
  contentAreaSelector: SelectEachOptions['selectEachOptions']['contentAreaSelector'];
  subSteps: SubStep[];
  waitAfterSelectMs: number;
}

interface Props {
  editingStepId?: string;
}

export default function SelectEachForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const rawOpts = (step?.options || {}) as Partial<SelectEachOptions>;
  const opts: Partial<SelectEachInner> = (rawOpts.selectEachOptions || {}) as Partial<SelectEachInner>;

  if (!step) return null;

  const updateSelectEach = (changes: Partial<SelectEachInner>) => {
    updateStepOptions(step.id, {
      selectEachOptions: { ...opts, ...changes } as unknown as SelectEachOptions['selectEachOptions'],
    } as Partial<SelectEachOptions>);
  };

  const toggleOption = (value: string) => {
    const options = opts.options || [];
    updateSelectEach({
      options: options.map(o => o.value === value ? { ...o, selected: !o.selected } : o),
    });
  };

  const selectAll = () =>
    updateSelectEach({ options: (opts.options || []).map(o => ({ ...o, selected: true })) });

  const clearAll = () =>
    updateSelectEach({ options: (opts.options || []).map(o => ({ ...o, selected: false })) });

  const handlePickControl = async () => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField('selectEachControl');
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const addSubStep = (type: string) => {
    const subStep: SubStep = {
      id: generateId(),
      type,
      label: type === 'scrape' ? 'Scrape data' : 'Sub-step',
      options: type === 'scrape' ? { mode: 'specificElements', elements: [] } : {},
    };
    updateSelectEach({ subSteps: [...(opts.subSteps || []), subStep] });
  };

  const removeSubStep = (id: string) => {
    updateSelectEach({ subSteps: (opts.subSteps || []).filter(s => s.id !== id) });
  };

  const handleSave = () => {
    if (!opts.controlSelector) {
      useUiStore.getState().showToast('Please pick the control element first.', 'error');
      return;
    }
    if ((opts.options || []).filter(o => o.selected).length === 0) {
      useUiStore.getState().showToast('Select at least one option.', 'error');
      return;
    }
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  const options = opts.options || [];

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Select Each</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Step label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Select each region"
        />
      </div>

      <div className="form-group">
        <label className="form-label">Pick the control</label>
        <PickedElementPreview
          selector={opts.controlSelector ?? null}
          elementType={opts.controlType || null}
          onRepick={handlePickControl}
        />
        {!opts.controlSelector && (
          <button className="btn btn-secondary btn-full mt-8" onClick={handlePickControl}>
            Pick Dropdown / Tab / Radio
          </button>
        )}
      </div>

      {opts.controlSelector && (
        <>
          {options.length > 0 && (
            <div className="form-group">
              <div className="form-label-row">
                <label className="form-label">Options</label>
                <div className="form-label-actions">
                  <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select All</button>
                  <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear</button>
                </div>
              </div>
              <div className="column-checklist">
                {options.map(opt => (
                  <label key={opt.value} className="form-check">
                    <input
                      type="checkbox"
                      checked={opt.selected !== false}
                      onChange={() => toggleOption(opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Wait after each selection (ms)</label>
            <input
              type="number"
              className="form-input"
              value={opts.waitAfterSelectMs ?? 1500}
              min={300}
              max={10000}
              step={100}
              onChange={e => updateSelectEach({ waitAfterSelectMs: Number(e.target.value) })}
            />
          </div>

          <div className="form-group">
            <label className="form-label">After each selection, run these scrape steps:</label>

            {(opts.subSteps || []).map(sub => (
              <div key={sub.id} className="sub-step-card">
                <span className="sub-step-label">{sub.label}</span>
                <button
                  className="btn btn-icon btn-icon-delete"
                  onClick={() => removeSubStep(sub.id)}
                  aria-label="Remove sub-step"
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            <button
              className="btn btn-secondary btn-sm mt-8"
              onClick={() => addSubStep('scrape')}
            >
              + Add Sub-Step
            </button>
          </div>
        </>
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
