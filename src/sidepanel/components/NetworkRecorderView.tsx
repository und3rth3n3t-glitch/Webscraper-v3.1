import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { useNetworkRecordStore } from '../stores/networkRecordStore';
import type { CaptureApiCallsOptions } from '../../types/config';

interface Props {
  editingStepId?: string;
}

export default function NetworkRecorderView({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();
  const calls = useNetworkRecordStore(s => s.calls);

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<CaptureApiCallsOptions>;

  if (!step) return null;

  const updateOpt = (key: keyof CaptureApiCallsOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<CaptureApiCallsOptions>);

  const handleSave = () => {
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  const METHOD_COLORS: Record<string, string> = {
    GET: 'type-badge',
    POST: 'type-badge--capture',
    PUT: 'type-badge--capture',
    PATCH: 'type-badge--capture',
    DELETE: 'type-badge--await',
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Capture API Calls</h2>
      </div>

      <p className="view-subtitle">
        Record network requests made by the page during a set window. Useful for capturing JSON data loaded in the background.
      </p>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Capture product API response"
        />
      </div>

      <div className="form-group">
        <label className="form-label">URL pattern (optional)</label>
        <input
          className="form-input"
          value={opts.urlPattern || ''}
          onChange={e => updateOpt('urlPattern', e.target.value)}
          placeholder="e.g. /api/products or leave blank for all"
        />
        <p className="form-hint">Only capture requests whose URL contains this pattern.</p>
      </div>

      <div className="form-group">
        <label className="form-label">Capture duration (ms)</label>
        <input
          type="number"
          className="form-input"
          value={opts.durationMs ?? 5000}
          min={500}
          max={60000}
          step={500}
          onChange={e => updateOpt('durationMs', Number(e.target.value))}
        />
        <p className="form-hint">How long to listen for network requests.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={opts.includeResponseBody !== false}
            onChange={e => updateOpt('includeResponseBody', e.target.checked)}
          />
          Include response body
        </label>
        <p className="form-hint">Capture the JSON response data (not just the URL).</p>
      </div>

      {calls.length > 0 && (
        <div className="form-group">
          <label className="form-label">Captured calls (live preview)</label>
          <div className="network-calls-list">
            {calls.map(call => (
              <div key={call.id} className="network-call-row">
                <label className="form-check">
                  <input type="checkbox" checked readOnly />
                  <span className={`type-badge ${METHOD_COLORS[call.method] || 'type-badge'}`}>
                    {call.method}
                  </span>
                  <span className="network-call-url" title={call.url}>
                    {call.url.length > 60 ? `…${call.url.slice(-57)}` : call.url}
                  </span>
                  <span className="meta-badge">{call.statusCode}</span>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Step
        </button>
      </div>
    </div>
  );
}
