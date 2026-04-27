import { useState } from 'react';
import { Play } from 'lucide-react';
import BackButton from './BackButton';
import ConfirmDialog from './ConfirmDialog';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import StepCard from './StepCard';
import Tooltip from './Tooltip';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { useRunStore } from '../stores/runStore';

export default function StepList() {
  const {
    steps,
    reorderSteps,
    configName,
    isDirty,
    pageDomain,
    pushView,
    saveCurrentConfig,
    setConfigName,
    cameFromSaved,
  } = useConfigStore();
  const { showToast, setActiveTab } = useUiStore();
  const [showTestPrompt, setShowTestPrompt] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const setupSteps = steps.filter(s => s.isSetup);
  const loopSteps = steps.filter(s => !s.isSetup);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      reorderSteps(String(active.id), String(over!.id));
    }
  };

  const handleSave = async () => {
    try {
      await saveCurrentConfig();
      showToast('Config saved!', 'success');
    } catch (err) {
      showToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleRun = () => {
    if (useConfigStore.getState().isDirty) {
      setShowTestPrompt(true);
    } else {
      useRunStore.getState().launchRun('config');
    }
  };

  const handleSaveAndTest = async () => {
    setShowTestPrompt(false);
    try {
      await saveCurrentConfig();
      showToast('Config saved!', 'success');
    } catch (err) {
      showToast(`Save failed: ${(err as Error).message}`, 'error');
      return;
    }
    useRunStore.getState().launchRun('config');
  };

  const handleTestWithoutSaving = () => {
    setShowTestPrompt(false);
    useRunStore.getState().launchRun('config');
  };

  if (steps.length === 0) {
    return (
      <div className="view">
        <div className="view-header-row">
          {cameFromSaved && <BackButton onClick={() => setActiveTab('saved')} />}
          <input
            className="form-input-title"
            value={configName}
            onChange={e => setConfigName(e.target.value)}
            placeholder="Config name"
          />
          {isDirty && <span className="dirty-indicator" title="Unsaved changes">●</span>}
        </div>
        <p className="view-subtitle">Add steps to build your scraping flow.</p>
        <button
          className="btn btn-primary btn-full mt-8"
          onClick={() => pushView('ADD_STEP_MENU')}
        >
          + Add First Step
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="view">
        <div className="view-header-row">
          {cameFromSaved && <BackButton onClick={() => setActiveTab('saved')} />}
          <input
            className="form-input-title"
            value={configName}
            onChange={e => setConfigName(e.target.value)}
            placeholder={pageDomain || 'Config name'}
          />
          {isDirty && <span className="dirty-indicator" title="Unsaved changes">●</span>}
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>

            {setupSteps.length > 0 && (
              <section className="step-section">
                <div className="step-section-header">
                  <span className="step-section-title">Setup Steps</span>
                  <Tooltip text="Setup steps run once at the start. Use these for accepting cookie banners, logging in, or navigating to the right page." />
                </div>
                <p className="step-section-hint">Run once at the beginning</p>
                {setupSteps.map((step, i) => (
                  <StepCard key={step.id} step={step} index={i} />
                ))}
              </section>
            )}

            <section className="step-section">
              <div className="step-section-header">
                <span className="step-section-title">Loop Steps</span>
                <Tooltip text="Loop steps repeat for each search term you provide." />
              </div>
              <p className="step-section-hint">Run for each search term</p>
              {loopSteps.length === 0 && (
                <p className="empty-hint">No loop steps yet.</p>
              )}
              {loopSteps.map((step, i) => (
                <StepCard key={step.id} step={step} index={setupSteps.length + i} />
              ))}
            </section>

          </SortableContext>
        </DndContext>

        <button
          className="btn btn-secondary btn-full mt-8"
          onClick={() => pushView('ADD_STEP_MENU')}
        >
          + Add Step
        </button>

        <button
          className="btn btn-secondary btn-full mt-4"
          onClick={() => pushView('LOOP_CONFIG')}
        >
          Configure Loop
        </button>

        <button
          className="btn btn-secondary btn-full mt-4"
          onClick={() => pushView('DETECTION_SETTINGS')}
        >
          Detection Settings
        </button>

        <div className="step-list-actions">
          <button className="btn btn-secondary" onClick={handleSave}>
            Save
          </button>
          <button className="btn btn-primary" onClick={handleRun}>
            <Play size={12} /> Run
          </button>
        </div>
      </div>

      {showTestPrompt && (
        <ConfirmDialog
          title="Unsaved Changes"
          message="You have unsaved changes. Would you like to save before testing?"
          confirmLabel="Save & Test"
          secondaryLabel="Test Without Saving"
          onConfirm={handleSaveAndTest}
          onSecondary={handleTestWithoutSaving}
          onCancel={() => setShowTestPrompt(false)}
        />
      )}
    </>
  );
}
