import type { StepBindingDto } from '../api/types';
import type { LoopAncestor } from '../utils/taskTree';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type Props = {
  steps: SetInputStep[];
  loopAncestors: LoopAncestor[];
  stepBindings: Record<string, StepBindingDto>;
  onChange: (bindings: Record<string, StepBindingDto>) => void;
};

function selectValue(binding: StepBindingDto): string {
  if (binding.kind === 'loopRef') {
    return binding.column
      ? `loopRef:${binding.loopBlockId}:${binding.column}`
      : `loopRef:${binding.loopBlockId}`;
  }
  return binding.kind;
}

function bindingFromSelect(value: string): StepBindingDto {
  if (value.startsWith('loopRef:')) {
    const rest = value.slice('loopRef:'.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx !== -1) {
      const loopBlockId = rest.slice(0, colonIdx);
      const column = rest.slice(colonIdx + 1);
      return { kind: 'loopRef', loopBlockId, column };
    }
    return { kind: 'loopRef', loopBlockId: rest };
  }
  if (value === 'literal') return { kind: 'literal', value: '' };
  return { kind: 'unbound' };
}

export default function BindingsEditor({ steps, loopAncestors, stepBindings, onChange }: Props) {
  if (steps.length === 0) {
    return (
      <div className="form-hint">
        This config has no inputs. Loop values will run the scrape, but won't be substituted.
      </div>
    );
  }

  if (loopAncestors.length === 0) {
    return (
      <div className="form-hint">
        This scrape has no parent loops. Add a loop ancestor to bind values.
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
              value={selectValue(binding)}
              onChange={(e) => update(step.id, bindingFromSelect(e.target.value))}
            >
              {loopAncestors.map((a) => {
                if (a.columns.length > 0) {
                  return a.columns.map((col) => (
                    <option key={`${a.id}:${col}`} value={`loopRef:${a.id}:${col}`}>
                      {a.name} → {col}
                    </option>
                  ));
                }
                return (
                  <option key={a.id} value={`loopRef:${a.id}`}>
                    Loop value ({a.name}.currentItem)
                  </option>
                );
              })}
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
