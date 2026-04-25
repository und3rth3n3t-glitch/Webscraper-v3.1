import { useState, useMemo } from 'react';
import PickedElementPreview from './PickedElementPreview';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import type { StepCondition, SelectorDescriptor } from '../../types/config';

interface Props {
  stepId: string;
}

type ConditionMode =
  | 'always'
  | 'urlMatches'
  | 'urlNotMatches'
  | 'elementPresent'
  | 'elementAbsent';

function modeFromCondition(c: StepCondition | null | undefined): ConditionMode {
  if (!c) return 'always';
  if (c.kind === 'urlMatches')     return c.negate ? 'urlNotMatches'   : 'urlMatches';
  if (c.kind === 'elementPresent') return c.negate ? 'elementAbsent'   : 'elementPresent';
  return 'always';
}

function conditionFromMode(
  mode: ConditionMode,
  prev: StepCondition | null | undefined,
): StepCondition | null {
  switch (mode) {
    case 'always':
      return null;
    case 'urlMatches':
      return { kind: 'urlMatches', pattern: prev?.kind === 'urlMatches' ? prev.pattern : '' };
    case 'urlNotMatches':
      return { kind: 'urlMatches', pattern: prev?.kind === 'urlMatches' ? prev.pattern : '', negate: true };
    case 'elementPresent':
      return { kind: 'elementPresent', selector: prev?.kind === 'elementPresent' ? prev.selector : (null as unknown as SelectorDescriptor) };
    case 'elementAbsent':
      return { kind: 'elementPresent', selector: prev?.kind === 'elementPresent' ? prev.selector : (null as unknown as SelectorDescriptor), negate: true };
  }
}

export default function StepConditionEditor({ stepId }: Props) {
  const { steps, draftStep, updateStep, pageUrl } = useConfigStore();
  const step = steps.find((s) => s.id === stepId) || (draftStep?.id === stepId ? draftStep : null);
  const [expanded, setExpanded] = useState(!!step?.condition);

  const cond = step?.condition ?? null;

  const livePreview = useMemo(() => {
    if (cond?.kind !== 'urlMatches') return null;
    const url = pageUrl || '';
    if (!cond.pattern) return null;
    try {
      const matches = new RegExp(cond.pattern).test(url);
      const effective = cond.negate ? !matches : matches;
      return { ok: effective, url, error: null as string | null };
    } catch (e) {
      return { ok: false, url, error: (e as Error).message };
    }
  }, [cond, pageUrl]);

  if (!step) return null;

  const mode = modeFromCondition(cond);
  const summary =
    mode === 'always'         ? 'Always run' :
    mode === 'urlMatches'     ? `Only if URL matches: ${(cond as { pattern: string }).pattern || '(empty)'}` :
    mode === 'urlNotMatches'  ? `Only if URL does NOT match: ${(cond as { pattern: string }).pattern || '(empty)'}` :
    mode === 'elementPresent' ? 'Only if element exists' :
                                'Only if element does NOT exist';

  const setMode = (next: ConditionMode) => {
    updateStep(step.id, { condition: conditionFromMode(next, cond) });
    if (next !== 'always') setExpanded(true);
  };

  const setPattern = (pattern: string) => {
    if (cond?.kind !== 'urlMatches') return;
    updateStep(step.id, { condition: { ...cond, pattern } });
  };

  const handlePickConditionElement = async () => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField('condition');
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  return (
    <div className="form-group">
      <label className="form-label" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        Run condition <span className="form-hint" style={{ marginLeft: 8 }}>{summary}</span>
      </label>

      {expanded && (
        <>
          <select
            className="form-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as ConditionMode)}
          >
            <option value="always">Always run</option>
            <option value="urlMatches">Only if URL matches</option>
            <option value="urlNotMatches">Only if URL does NOT match</option>
            <option value="elementPresent">Only if element exists</option>
            <option value="elementAbsent">Only if element does NOT exist</option>
          </select>

          {mode === 'always' && (
            <p className="form-hint">By default this step runs every time. Add a condition to skip it on specific pages.</p>
          )}

          {(mode === 'urlMatches' || mode === 'urlNotMatches') && cond?.kind === 'urlMatches' && (
            <div className="form-group form-group-indented">
              <label className="form-label">URL pattern (regex)</label>
              <input
                className="form-input"
                value={cond.pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="e.g. /wiki/.*\(disambiguation\)$"
              />
              {livePreview && (
                <p className="form-hint">
                  {livePreview.error
                    ? `✗ Invalid pattern: ${livePreview.error}`
                    : livePreview.ok
                      ? `✓ Matches current page`
                      : `✗ Does not match current page`}
                  <br />
                  <span style={{ opacity: 0.7 }}>{livePreview.url.length > 80 ? livePreview.url.substring(0, 80) + '…' : livePreview.url}</span>
                </p>
              )}
            </div>
          )}

          {(mode === 'elementPresent' || mode === 'elementAbsent') && cond?.kind === 'elementPresent' && (
            <div className="form-group form-group-indented">
              <label className="form-label">Element to check for</label>
              <PickedElementPreview
                selector={cond.selector ?? null}
                onRepick={handlePickConditionElement}
              />
              {!cond.selector && (
                <button className="btn btn-secondary btn-full mt-8" onClick={handlePickConditionElement}>
                  Pick Element
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
