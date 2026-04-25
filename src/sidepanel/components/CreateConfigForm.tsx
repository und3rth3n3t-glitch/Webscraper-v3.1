import { useState } from 'react';
import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';

export default function CreateConfigForm() {
  const { pageDomain, setConfigName, setDomainLocked, saveCurrentConfig, setView } = useConfigStore();
  const { showToast } = useUiStore();
  const [name, setName] = useState('');
  const [lockToDomain, setLockToDomain] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleNext = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Please enter a name for this config.', 'error');
      return;
    }
    setSaving(true);
    try {
      setConfigName(trimmed);
      setDomainLocked(lockToDomain);
      await saveCurrentConfig();
      setView('STEP_LIST');
    } catch (err) {
      showToast(`Failed to create config: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">New Config</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Config name</label>
        <input
          className="form-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Product Price Tracker"
          autoFocus
          onKeyDown={e => e.key === 'Enter' && handleNext()}
        />
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={lockToDomain}
            onChange={e => setLockToDomain(e.target.checked)}
            disabled={!pageDomain}
          />
          Lock to current domain
        </label>
        {pageDomain && (
          <p className="form-hint">This config will only appear when browsing {pageDomain}</p>
        )}
        {!pageDomain && (
          <p className="form-hint">Navigate to a website first to enable domain locking</p>
        )}
      </div>

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full"
          onClick={handleNext}
          disabled={saving}
        >
          {saving ? 'Creating...' : 'Next'}
        </button>
      </div>
    </div>
  );
}
