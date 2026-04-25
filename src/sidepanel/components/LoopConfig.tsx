import { Type, MousePointerClick, Database, Repeat2, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import BackButton from './BackButton';
import Tooltip from './Tooltip';
import { useConfigStore } from '../stores/configStore';
import type { Step } from '../../types/config';

const STEP_ICONS: Record<string, LucideIcon> = {
  setInput:   Type,
  click:      MousePointerClick,
  scrape:     Database,
  selectEach: Repeat2,
};

export default function LoopConfig() {
  const { steps, updateStep, goBack } = useConfigStore();

  const setupSteps = steps.filter(s => s.isSetup);
  const loopSteps = steps.filter(s => !s.isSetup);

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Configure Loop</h2>
      </div>

      <p className="view-subtitle">
        Choose which steps run once (setup) vs. for each search term (loop).
      </p>

      <section className="list-card loop-section">
        <div className="loop-section-header">
          <h3 className="loop-section-title">Setup Steps</h3>
          <Tooltip text="Setup steps run once at the start. Use these for things like accepting cookie banners or navigating to a search page." />
        </div>
        <p className="loop-section-hint">Run once at the beginning</p>

        {setupSteps.length === 0 && (
          <p className="empty-hint">No setup steps. Toggle steps below to mark them as setup.</p>
        )}

        {setupSteps.map(step => (
          <StepToggleRow
            key={step.id}
            step={step}
            onToggle={() => updateStep(step.id, { isSetup: false })}
          />
        ))}
      </section>

      <section className="list-card loop-section">
        <div className="loop-section-header">
          <h3 className="loop-section-title">Loop Steps</h3>
          <Tooltip text="Loop steps repeat for each search term you provide." />
        </div>
        <p className="loop-section-hint">Run for each search term</p>

        {loopSteps.length === 0 && (
          <p className="empty-hint">All steps are in Setup. Move at least one step here for the scraper to loop.</p>
        )}

        {loopSteps.map(step => (
          <StepToggleRow
            key={step.id}
            step={step}
            isLoop
            onToggle={() => updateStep(step.id, { isSetup: true })}
          />
        ))}
      </section>

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={goBack}>
          Done
        </button>
      </div>
    </div>
  );
}

interface StepToggleRowProps {
  step: Step;
  onToggle: () => void;
  isLoop?: boolean;
}

function StepToggleRow({ step, onToggle, isLoop }: StepToggleRowProps) {
  const Icon = STEP_ICONS[step.type] || Database;
  return (
    <div className="step-toggle-row">
      <span className="step-toggle-icon"><Icon size={14} /></span>
      <span className="step-toggle-label">{step.label || step.type}</span>
      <button
        className="btn btn-ghost btn-sm"
        onClick={onToggle}
        title={isLoop ? 'Move to Setup' : 'Move to Loop'}
      >
        <ArrowRight size={12} />
        {isLoop ? 'Setup' : 'Loop'}
      </button>
    </div>
  );
}
