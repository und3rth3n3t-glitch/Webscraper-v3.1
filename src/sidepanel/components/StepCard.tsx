import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { useConfigStore } from '../stores/configStore';
import type { Step } from '../../types/config';

const TYPE_LABELS: Record<string, string> = {
  setInput:        'Type Text',
  click:           'Click',
  bestMatch:       'Best Match',
  goBack:          'Go Back',
  scrape:          'Grab Data',
  selectEach:      'Loop Through',
  captureApiCalls: 'Capture API Calls',
  awaitUserAction: 'Await User Action',
};

const TYPE_BADGE_CLASS: Record<string, string> = {
  captureApiCalls: 'type-badge--capture',
  awaitUserAction: 'type-badge--await',
};

interface Props {
  step: Step;
  index: number;
}

export default function StepCard({ step, index }: Props) {
  const { deleteStep, setEditingStepId, pushView } = useConfigStore();
  const [confirming, setConfirming] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const typeLabel = TYPE_LABELS[step.type] || step.type;
  const badgeClass = TYPE_BADGE_CLASS[step.type];

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`list-card step-card ${isDragging ? 'step-card-dragging' : ''}`}
      >
        <span className="step-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
          <GripVertical size={14} />
        </span>

        <span className="step-number">{index + 1}</span>

        <div className="step-card-body">
          <div className="step-card-label">{step.label || typeLabel}</div>
          {badgeClass && (
            <span className={`type-badge ${badgeClass}`}>{typeLabel}</span>
          )}
        </div>

        <div className="step-card-actions">
          <button
            className="btn btn-icon btn-icon-edit"
            onClick={() => {
              setEditingStepId(step.id);
              pushView('EDIT_STEP');
            }}
            title="Edit step"
            aria-label="Edit step"
          >
            <Pencil size={14} />
          </button>
          <button
            className="btn btn-icon btn-icon-delete"
            onClick={() => setConfirming(true)}
            title="Delete step"
            aria-label="Delete step"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Delete Step"
          message={`Delete "${step.label || typeLabel}"? This cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={() => { deleteStep(step.id); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
