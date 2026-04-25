import { useState } from 'react';
import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';

export default function SaveConfigForm() {
  const { configName, setConfigName, saveCurrentConfig, goBack } = useConfigStore();
  const { showToast } = useUiStore();
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!configName.trim()) {
      showToast('Please enter a name for this config.', 'error');
      return;
    }
    setSaving(true);
    try {
      await saveCurrentConfig();
      showToast('Config saved!', 'success');
      goBack();
    } catch (err) {
      showToast(`Couldn't save config: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Save Config</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Config name</label>
        <input
          className="form-input"
          value={configName}
          onChange={e => setConfigName(e.target.value)}
          placeholder="e.g. Product Price Tracker"
          autoFocus
          onKeyDown={e => e.key === 'Enter' && handleSave()}
        />
      </div>

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save Config'}
        </button>
      </div>
    </div>
  );
}
