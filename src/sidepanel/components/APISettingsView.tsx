import { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { testConnection } from '../utils/apiClient';
import { validateBackendUrl } from '../utils/validateBackendUrl';
import { getPrefs, setPref } from '../utils/storage';

export default function APISettingsView() {
  const { serverUrl, jwtToken, connected, setConnection, setConnected } = useSettingsStore();
  const { showToast } = useUiStore();

  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [testing, setTesting] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);

  // Load saved token from chrome.storage.local on mount
  useEffect(() => {
    const { serverUrl: url, setConnection: connect } = useSettingsStore.getState();
    browser.storage.local.get('bb_jwt').then((result: Record<string, unknown>) => {
      const saved = result['bb_jwt'] as string | undefined;
      if (saved) {
        setTokenDraft(saved);
        connect(url, saved);
      }
    }).catch(() => {});

    getPrefs().then((prefs) => {
      setDebugEnabled(!!prefs.debug);
    }).catch(() => {});
  }, []);

  const toggleDebug = async (next: boolean) => {
    setDebugEnabled(next);
    try {
      await setPref('debug', next);
    } catch {
      showToast("Couldn't save debug preference.", 'error');
      setDebugEnabled(!next);
    }
  };

  const urlValidation = validateBackendUrl(urlDraft);

  const handleSave = async () => {
    if (!urlValidation.valid) {
      showToast(urlValidation.error!, 'error');
      return;
    }
    try {
      await browser.storage.local.set({ bb_jwt: tokenDraft });
      setConnection(urlDraft, tokenDraft);
      showToast('Settings saved.', 'success');
    } catch {
      showToast("Couldn't save settings.", 'error');
    }
  };

  const handleTest = async () => {
    if (!urlValidation.valid) {
      showToast(urlValidation.error!, 'error');
      return;
    }
    setTesting(true);
    try {
      await testConnection(urlDraft, tokenDraft);
      setConnected(true);
      showToast('Connected!', 'success');
    } catch (err) {
      setConnected(false, (err as Error).message);
      showToast((err as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="view settings-view">
      <div className="view-header-row">
        <h2 className="view-title">Backend Settings</h2>
      </div>

      <div className="connection-status-row">
        <span className={connected ? 'status-dot status-dot-success' : 'status-dot status-dot-error'} />
        <span className="text-sm">{connected ? 'Connected' : 'Not connected'}</span>
      </div>

      <div className="form-group">
        <label className="form-label">Backend URL</label>
        <input
          className={`form-input${urlDraft && !urlValidation.valid ? ' form-input-error' : ''}`}
          type="url"
          value={urlDraft}
          onChange={e => setUrlDraft(e.target.value)}
          placeholder="https://your-backend.example.com"
          autoComplete="off"
        />
        {urlDraft && !urlValidation.valid && (
          <p className="form-error">{urlValidation.error}</p>
        )}
        <p className="form-hint">The URL of your ASP.NET Core backend.</p>
      </div>

      <div className="form-group">
        <label className="form-label">API token</label>
        <input
          className="form-input"
          type="password"
          value={tokenDraft}
          onChange={e => setTokenDraft(e.target.value)}
          placeholder="Paste your JWT token here"
          autoComplete="new-password"
        />
        <p className="form-hint">Your token is stored securely and never synced.</p>
      </div>

      <div className="form-actions">
        <button
          className="btn btn-secondary"
          onClick={handleTest}
          disabled={testing || !urlValidation.valid}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!urlValidation.valid}
        >
          Save
        </button>
      </div>

      {jwtToken && (
        <div className="form-group">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              useSettingsStore.getState().clearToken();
              setTokenDraft('');
              browser.storage.local.remove('bb_jwt').catch(() => {});
            }}
          >
            Clear saved token
          </button>
        </div>
      )}

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={debugEnabled}
            onChange={(e) => toggleDebug(e.target.checked)}
          />
          Show debug info in scrape output
        </label>
        <p className="form-hint">Developer option — adds saved selector descriptors and other diagnostic fields when chart scrapes fail. Useful when reporting an issue or troubleshooting selector resolution.</p>
      </div>
    </div>
  );
}
