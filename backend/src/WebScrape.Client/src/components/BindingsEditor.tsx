import type { StepBindingDto } from '../api/types';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type Props = {
  steps: SetInputStep[];
  loopBlockId: string;
  loopName: string;
  stepBindings: Record<string, StepBindingDto>;
  onChange: (bindings: Record<string, StepBindingDto>) => void;
};

export default function BindingsEditor({ steps, loopBlockId, loopName, stepBindings, onChange }: Props) {
  if (steps.length === 0) {
    return (
      <div className="form-hint">
        This config has no inputs. Loop values will run the scrape, but won't be substituted.
      </div>
    );
  }

  const update = (stepId: string, binding: StepBindingDto) => {
    onChange({ ...stepBindings, [stepId]: binding });
  };

  return (
    <div>
      {steps.length > 1 && (
        <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>
          Other inputs default to Unbound — bind them manually.
        </div>
      )}
      {steps.map((step) => {
        const binding = stepBindings[step.id] ?? { kind: 'unbound' as const };
        return (
          <div key={step.id} className="form-group">
            <label className="form-label">{step.id}</label>
            <select
              className="form-select"
              value={binding.kind}
              onChange={(e) => {
                const kind = e.target.value as 'loopRef' | 'literal' | 'unbound';
                if (kind === 'loopRef') update(step.id, { kind: 'loopRef', loopBlockId });
                else if (kind === 'literal') update(step.id, { kind: 'literal', value: '' });
                else update(step.id, { kind: 'unbound' });
              }}
            >
              <option value="loopRef">Loop value ({loopName}.currentItem)</option>
              <option value="literal">Literal value</option>
              <option value="unbound">Unbound</option>
            </select>
            {binding.kind === 'literal' && (
              <input
                className="form-input"
                placeholder="Static text"
                value={binding.value}
                onChange={(e) => update(step.id, { kind: 'literal', value: e.target.value })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
