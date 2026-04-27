import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { PaginationControlBanner } from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import type { ScrapeOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function ScrapeWholePageForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();
  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<ScrapeOptions>;

  if (!step) return null;

  const updateOpt = (key: keyof ScrapeOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<ScrapeOptions>);

  const pickPaginationPage = async () => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField('pagination:wholePage');
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const handleSave = () => {
    if (!step.label) {
      updateStep(step.id, { label: 'Scrape whole page' });
    }
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Grab Whole Page</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="Scrape whole page"
        />
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={!!opts.scrollToBottom}
            onChange={e => updateOpt('scrollToBottom', e.target.checked)}
          />
          Scroll to bottom before scraping
        </label>
        <p className="form-hint">Useful for pages with infinite scroll or lazy-loaded content.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={!!opts.expandHidden}
            onChange={e => updateOpt('expandHidden', e.target.checked)}
          />
          Expand hidden sections
        </label>
        <p className="form-hint">Automatically clicks "Show more", accordions, and collapsed sections.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={!!opts.paginate}
            onChange={e => updateOpt('paginate', e.target.checked)}
          />
          Paginate (scrape multiple pages)
        </label>
      </div>

      {opts.paginate && (
        <div className="form-group form-group-indented">
          <PaginationControlBanner
            descriptor={opts.paginationSelector ?? null}
            onPick={pickPaginationPage}
          />
          <label className="form-label mt-8">Max pages</label>
          <input
            type="text"
            className="form-input"
            value={opts.pageCount || ''}
            onChange={e => {
              const val = e.target.value.replace(/[^0-9]/g, '');
              updateOpt('pageCount', val === '' ? 0 : Number(val));
            }}
            placeholder="All"
          />
        </div>
      )}

      <details className="form-group">
        <summary className="form-label" style={{ cursor: 'pointer' }}>Human pacing (advanced)</summary>
        <p className="form-hint">All values in milliseconds (or fraction of viewport for scroll step). Leave blank for sensible defaults.</p>

        <label className="form-label mt-8">Scroll step size (× viewport)</label>
        <input
          type="number"
          step="0.05"
          min="0.1"
          max="1.0"
          className="form-input"
          value={opts.scrollIncrementVh ?? ''}
          placeholder="0.4"
          onChange={(e) => updateOpt('scrollIncrementVh', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between scroll steps (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.scrollDelayMs ?? ''}
          placeholder="700"
          onChange={(e) => updateOpt('scrollDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between pagination clicks (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.paginationDelayMs ?? ''}
          placeholder="1500"
          onChange={(e) => updateOpt('paginationDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between expand-button clicks (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.expandDelayMs ?? ''}
          placeholder="350"
          onChange={(e) => updateOpt('expandDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </details>

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Step
        </button>
      </div>
    </div>
  );
}
