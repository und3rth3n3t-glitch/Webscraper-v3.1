import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import type { ScrapeOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function ScrapeForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStepOptions, pushView } = useConfigStore();
  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  if (!step) return null;

  const selectMode = (mode: ScrapeOptions['mode']) => {
    updateStepOptions(step.id, { mode } as Partial<ScrapeOptions>);
    pushView(mode === 'wholePage' ? 'SCRAPE_WHOLE_PAGE_FORM' : 'SCRAPE_ELEMENTS_FORM');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Grab Data</h2>
      </div>

      <p className="view-subtitle">What do you want to grab?</p>

      <div className="step-type-menu">
        <button className="step-type-option" onClick={() => selectMode('wholePage')}>
          <div className="step-type-option-title">Whole Page</div>
          <div className="step-type-option-desc">Grab all text, tables, and links from the page</div>
        </button>

        <button className="step-type-option" onClick={() => selectMode('specificElements')}>
          <div className="step-type-option-title">Specific Elements</div>
          <div className="step-type-option-desc">Choose exactly what to grab from the page</div>
        </button>
      </div>
    </div>
  );
}
