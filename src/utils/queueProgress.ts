export interface ProgressInfo {
  stepLabel: string;
  termIndex?: number;
}

const STEP_LABEL_MAX = 200;

export function mergeProgress(
  prior: ProgressInfo | null,
  payload: { stepLabel?: unknown; termIndex?: unknown },
): ProgressInfo | null {
  if (typeof payload.stepLabel !== 'string') return null;
  if (payload.termIndex !== undefined) {
    if (!Number.isInteger(payload.termIndex) || (payload.termIndex as number) < 0) return null;
  }
  const stepLabel = payload.stepLabel.length > STEP_LABEL_MAX
    ? payload.stepLabel.slice(0, STEP_LABEL_MAX)
    : payload.stepLabel;
  const termIndex = payload.termIndex as number | undefined;

  // Same term, empty step label: keep prior (avoids flicker at term-loop boundaries).
  if (prior && stepLabel === '' && prior.termIndex === termIndex) return null;
  return { stepLabel, termIndex };
}
