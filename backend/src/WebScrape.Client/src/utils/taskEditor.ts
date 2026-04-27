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
): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  let firstBound = false;
  for (const step of steps) {
    if (!firstBound && innermostLoopBlockId) {
      result[step.id] = { kind: 'loopRef', loopBlockId: innermostLoopBlockId };
      firstBound = true;
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}
