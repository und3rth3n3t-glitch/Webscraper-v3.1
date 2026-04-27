import { useRef } from 'react';
import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import type { StepType } from '../../types/config';

interface StepOption {
  type: StepType;
  label: string;
  description: string;
}

const STEP_TYPES: StepOption[] = [
  { type: 'setInput',        label: 'Type Text',         description: 'Fill in a search box, form field, or text input' },
  { type: 'click',           label: 'Click',              description: 'Tap a button, link, or anything on the page' },
  { type: 'bestMatch',       label: 'Best Search Match',  description: 'Auto-click the result that best matches your search term' },
  { type: 'goBack',          label: 'Go Back',            description: 'Return to the previous page using browser history' },
  { type: 'navigateTo',      label: 'Go to URL',          description: 'Open a specific page (e.g. before scraping starts)' },
  { type: 'scrape',          label: 'Grab Data',          description: 'Copy text, numbers, or info from the page' },
  { type: 'selectEach',      label: 'Loop Through',       description: 'Repeat for each option in a dropdown or tab' },
  { type: 'captureApiCalls', label: 'Capture API Calls',  description: 'Record network requests made by the page' },
  { type: 'awaitUserAction', label: 'Await User Action',  description: 'Pause and wait for you to do something on the page' },
];

const FORM_MAP: Record<StepType, string> = {
  setInput:        'SET_INPUT_FORM',
  click:           'CLICK_FORM',
  bestMatch:       'BEST_MATCH_FORM',
  goBack:          'GO_BACK_FORM',
  navigateTo:      'NAVIGATE_TO_FORM',
  scrape:          'SCRAPE_FORM',
  selectEach:      'SELECT_EACH_FORM',
  captureApiCalls: 'CAPTURE_API_CALLS_FORM',
  awaitUserAction: 'AWAIT_USER_ACTION_FORM',
};

export default function AddStepMenu() {
  const { createDraft, pushView } = useConfigStore();
  const pending = useRef(false);

  const handleSelect = (type: StepType) => {
    if (pending.current) return;
    pending.current = true;
    createDraft(type);
    pushView(FORM_MAP[type]);
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Add a Step</h2>
      </div>

      <p className="view-subtitle">Pick an action for this step</p>

      <div className="step-type-menu">
        {STEP_TYPES.map((item) => (
          <button
            key={item.type}
            className="step-type-option"
            onClick={() => handleSelect(item.type)}
          >
            <div className="step-type-option-title">{item.label}</div>
            <div className="step-type-option-desc">{item.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
