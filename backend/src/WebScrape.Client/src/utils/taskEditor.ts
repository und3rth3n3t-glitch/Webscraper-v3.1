import type { StepBindingDto } from '../api/types';

export type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

export function parseSetInputSteps(configJson: unknown): SetInputStep[] {
  try {
    const obj = configJson as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) return [];
    return obj.steps.filter(
      (s): s is SetInputStep =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>).type === 'setInput' &&
        typeof (s as Record<string, unknown>).id === 'string',
    );
  } catch {
    return [];
  }
}

export function autoBindSteps(
  steps: SetInputStep[],
  innermostLoopBlockId: string | null,
  loopColumns: string[] = [],
): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  const isMultiColumn = loopColumns.length > 0 && !!innermostLoopBlockId;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (isMultiColumn) {
      const col = loopColumns[i];
      result[step.id] = col
        ? { kind: 'loopRef', loopBlockId: innermostLoopBlockId!, column: col }
        : { kind: 'unbound' };
    } else if (i === 0 && innermostLoopBlockId) {
      result[step.id] = { kind: 'loopRef', loopBlockId: innermostLoopBlockId };
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}
