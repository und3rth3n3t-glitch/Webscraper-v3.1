import { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { testConnection } from '../utils/apiClient';
import { validateBackendUrl } from '../utils/validateBackendUrl';
import { getPrefs, setPref, getApiToken, setApiToken, clearApiToken } from '../utils/storage';

type StatusToken = 'success' | 'error' | 'pending' | 'running';

function statusDescriptor(
  status: ReturnType<typeof useSettingsStore.getState>['connectionStatus'],
  error: string | null,
): { dot: StatusToken; text: string } {
  switch (status) {
    case 'connected':     return { dot: 'success', text: 'Connected' };
    case 'connecting':    return { dot: 'running', text: 'Connecting…' };
    case 'reconnecting':  return { dot: 'running', text: 'Reconnecting…' };
    case 'error':         return { dot: 'error',   text: error ? `Couldn't connect: ${error}` : "Couldn't connect" };
    case 'idle':
    default:              return { dot: 'pending', text: 'Not connected' };
  }
}

export default function APISettingsView() {
  const {
    serverUrl, jwtToken, mode, workerName, connectionStatus, lastConnectionError,
    setConnection, setConnected, setMode, setWorkerName,
  } = useSettingsStore();
  const { showToast } = useUiStore();

  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [workerNameDraft, setWorkerNameDraft] = useState(workerName);
  const [modeDraft, setModeDraft] = useState<'local' | 'queue'>(mode);
  const batchPreflightQuietMs = useSettingsStore((s) => s.batchPreflightQuietMs);
  const batchParallelCap = useSettingsStore((s) => s.batchParallelCap);
  const setBatchPreflightQuietMs = useSettingsStore((s) => s.setBatchPreflightQuietMs);
  const setBatchParallelCap = useSettingsStore((s) => s.setBatchParallelCap);
  const notifyOnPause = useSettingsStore((s) => s.notifyOnPause);
  const notifyOnBatchComplete = useSettingsStore((s) => s.notifyOnBatchComplete);
  const setNotifyOnPause = useSettingsStore((s) => s.setNotifyOnPause);
  const setNotifyOnBatchComplete = useSettingsStore((s) => s.setNotifyOnBatchComplete);

  const [preflightQuietDraft, setPreflightQuietDraft] = useState(String(batchPreflightQuietMs));
  const [parallelCapDraft, setParallelCapDraft] = useState(String(batchParallelCap));

  const [testing, setTesting] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [mouseVisible, setMouseVisible] = useState(false);
  const [typingVisible, setTypingVisible] = useState(false);
  const [clearVisible, setClearVisible] = useState(false);
  const [humanizeScroll, setHumanizeScroll] = useState(true);
  const [useRealInput, setUseRealInput] = useState(false);

  useEffect(() => {
    const { serverUrl: url, setConnection: connect } = useSettingsStore.getState();
    getApiToken().then((saved) => {
      if (saved) {
        setTokenDraft(saved);
        connect(url, saved);
      }
    }).catch(() => {});

    getPrefs().then((prefs) => {
      setDebugEnabled(!!prefs.debug);
      setMouseVisible(!!prefs.humanizeMouseVisible);
      setTypingVisible(!!prefs.humanizeTypingVisible);
      setClearVisible(!!prefs.humanizeClearVisible);
      // Default true if pref absent — preserves existing behaviour.
      setHumanizeScroll(typeof prefs.humanizeScroll === 'boolean' ? prefs.humanizeScroll : true);
      setUseRealInput(!!prefs.useRealInput);
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

  const toggleMouseVisible = async (next: boolean) => {
    setMouseVisible(next);
    try {
      await setPref('humanizeMouseVisible', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setMouseVisible(!next);
    }
  };

  const toggleTypingVisible = async (next: boolean) => {
    setTypingVisible(next);
    try {
      await setPref('humanizeTypingVisible', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setTypingVisible(!next);
    }
  };

  const toggleClearVisible = async (next: boolean) => {
    setClearVisible(next);
    try {
      await setPref('humanizeClearVisible', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setClearVisible(!next);
    }
  };

  const toggleHumanizeScroll = async (next: boolean) => {
    setHumanizeScroll(next);
    try {
      await setPref('humanizeScroll', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setHumanizeScroll(!next);
    }
  };

  const toggleUseRealInput = async (next: boolean): Promise<void> => {
    if (next) {
      // Turning ON requires a one-time permission grant. Must be called
      // from a user-gesture handler (this onChange qualifies).
      let granted: boolean;
      try {
        granted = await chrome.permissions.request({ permissions: ['debugger'] });
      } catch (err) {
        showToast(`Couldn't request permission: ${(err as Error).message}`, 'error');
        return;
      }
      if (!granted) {
        showToast('Permission denied — falling back to synthetic input.', 'warning');
        return;
      }
    } else {
      // Turning OFF revokes the permission. Best effort.
      try {
        await chrome.permissions.remove({ permissions: ['debugger'] });
      } catch { /* ignore */ }
    }
    setUseRealInput(next);
    try {
      await setPref('useRealInput', next);
    } catch {
      showToast("Couldn't save preference.", 'error');
      setUseRealInput(!next);
    }
  };

  const toggleNotifyOnPause = (next: boolean): void => {
    setNotifyOnPause(next);
    browser.runtime.sendMessage({
      type: 'SET_BATCH_SETTINGS',
      payload: { notifyOnPause: next },
    }).catch(() => { /* SW asleep — best effort */ });
  };

  const toggleNotifyOnBatchComplete = (next: boolean): void => {
    setNotifyOnBatchComplete(next);
    browser.runtime.sendMessage({
      type: 'SET_BATCH_SETTINGS',
      payload: { notifyOnBatchComplete: next },
    }).catch(() => { /* SW asleep — best effort */ });
  };

  const urlValidation = validateBackendUrl(urlDraft);

  const handleSave = async () => {
    if (!urlValidation.valid) {
      showToast(urlValidation.error!, 'error');
      return;
    }
    const trimmedName = workerNameDraft.trim();
    if (modeDraft === 'queue' && !trimmedName) {
      showToast('Pick a worker name before turning on Queue mode.', 'error');
      return;
    }
    try {
      await setApiToken(tokenDraft);
      setConnection(urlDraft, tokenDraft);
      setMode(modeDraft);
      setWorkerName(trimmedName || 'My Browser');

      if (modeDraft === 'queue') {
        if (!tokenDraft) {
          showToast('Paste an access token before turning on Queue mode.', 'error');
          return;
        }
        await browser.runtime.sendMessage({
          type: 'INIT_SIGNALR',
          payload: {
            serverUrl: urlDraft,
            token: tokenDraft,
            clientId: trimmedName || 'My Browser',
            version: chrome.runtime.getManifest().version,
          },
        });
      } else {
        await browser.runtime.sendMessage({ type: 'STOP_SIGNALR' });
      }

      const quietMs = Number.parseInt(preflightQuietDraft, 10);
      const cap = Number.parseInt(parallelCapDraft, 10);
      if (Number.isFinite(quietMs) && quietMs >= 1000) setBatchPreflightQuietMs(quietMs);
      if (Number.isFinite(cap) && cap >= 1 && cap <= 16) setBatchParallelCap(cap);

      browser.runtime.sendMessage({
        type: 'SET_BATCH_SETTINGS',
        payload: {
          drainParallelCap: Number.isFinite(cap) && cap >= 1 ? cap : batchParallelCap,
          preflightQuietMs: Number.isFinite(quietMs) && quietMs >= 1000 ? quietMs : batchPreflightQuietMs,
        },
      }).catch(() => { /* SW may not be ready yet — non-fatal */ });

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

  const status = statusDescriptor(connectionStatus, lastConnectionError);

  return (
    <div className="view settings-view">
      <div className="view-header-row">
        <h2 className="view-title">Backend Settings</h2>
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
        <label className="form-label">Access token</label>
        <input
          className="form-input"
          type="password"
          value={tokenDraft}
          onChange={e => setTokenDraft(e.target.value)}
          placeholder="wsk_…"
          autoComplete="new-password"
        />
        <p className="form-hint">
          Paste the access token from your backend&apos;s API Keys page. It&apos;s stored locally and never synced.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label">Worker name</label>
        <input
          className="form-input"
          type="text"
          value={workerNameDraft}
          onChange={e => setWorkerNameDraft(e.target.value)}
          placeholder="Office laptop"
          autoComplete="off"
        />
        <p className="form-hint">What this browser shows up as in your backend (e.g. &ldquo;Office laptop&rdquo;).</p>
      </div>

      <div className="form-group">
        <label className="form-label">Mode</label>
        <div className="radio-pill-group" role="radiogroup" aria-label="Mode">
          <label className={`radio-pill${modeDraft === 'local' ? ' radio-pill-active' : ''}`}>
            <input
              type="radio"
              name="ws-mode"
              value="local"
              checked={modeDraft === 'local'}
              onChange={() => setModeDraft('local')}
            />
            Local
          </label>
          <label className={`radio-pill${modeDraft === 'queue' ? ' radio-pill-active' : ''}`}>
            <input
              type="radio"
              name="ws-mode"
              value="queue"
              checked={modeDraft === 'queue'}
              onChange={() => setModeDraft('queue')}
            />
            Queue
          </label>
        </div>
        <p className="form-hint">Local runs jobs you trigger here. Queue listens for jobs sent from your backend.</p>
      </div>

      {modeDraft === 'queue' && (
        <div className="connection-status-row">
          <span className={`status-dot ${status.dot}`} />
          <span className="text-sm">{status.text}</span>
        </div>
      )}

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
              clearApiToken().catch(() => {});
              browser.runtime.sendMessage({ type: 'STOP_SIGNALR' }).catch(() => {});
            }}
          >
            Clear saved token
          </button>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Parallel scrape windows</label>
        <input
          className="form-input"
          type="number"
          min={1}
          max={16}
          value={parallelCapDraft}
          onChange={(e) => setParallelCapDraft(e.target.value)}
          placeholder="4"
        />
        <p className="form-hint">
          How many tasks run side-by-side once authentication is sorted. Bumping this above 4 can trip rate limits on busy sites.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label">Wait for page to settle</label>
        <input
          className="form-input"
          type="number"
          min={1000}
          step={500}
          value={preflightQuietDraft}
          onChange={(e) => setPreflightQuietDraft(e.target.value)}
          placeholder="5000"
        />
        <p className="form-hint">
          How long (in milliseconds) the scraper waits with no detection before marking a task ready. Default 5000ms is right for most sites.
        </p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={notifyOnPause}
            onChange={(e) => toggleNotifyOnPause(e.target.checked)}
          />
          Notify when a scrape pauses for action
        </label>
        <p className="form-hint">Shows a Chrome notification when a draining task needs your attention and you're not on its window.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={notifyOnBatchComplete}
            onChange={(e) => toggleNotifyOnBatchComplete(e.target.checked)}
          />
          Notify when a batch finishes
        </label>
        <p className="form-hint">Shows a Chrome notification with the result count when a batch ends.</p>
      </div>

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

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={mouseVisible}
            onChange={(e) => toggleMouseVisible(e.target.checked)}
          />
          Show synthetic mouse cursor
        </label>
        <p className="form-hint">Draws a small dot on the page so you can see where the automation is moving. Cosmetic only — does not change what the site sees.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={typingVisible}
            onChange={(e) => toggleTypingVisible(e.target.checked)}
          />
          Type one character at a time
        </label>
        <p className="form-hint">Slower, more human-looking typing. Some sites with aggressive autocomplete can steal focus mid-type — turn this off if a search field stops accepting your text.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={clearVisible}
            onChange={(e) => toggleClearVisible(e.target.checked)}
          />
          Humanize input clearing
        </label>
        <p className="form-hint">Selects the existing text and presses Delete instead of wiping the field instantly. Turn on if a site flags the snap-clear as automated.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={humanizeScroll}
            onChange={(e) => toggleHumanizeScroll(e.target.checked)}
          />
          Humanize scrolling
        </label>
        <p className="form-hint">Slow, eased scrolling that mimics a real reader. Turn off for faster test runs — note: very long lazy-load pages may load less content.</p>
      </div>

      <div className="form-group">
        <label className="form-check">
          <input
            type="checkbox"
            checked={useRealInput}
            onChange={(e) => toggleUseRealInput(e.target.checked)}
          />
          Use real input events (more stealthy)
        </label>
        <p className="form-hint">
          Asks for permission to use Chrome's debugging API to send real mouse and keyboard events.
          Sites that look at <code>event.isTrusted</code> won't see them as automated.
          A yellow "Chrome is being controlled by automated test software" bar appears on scrape windows
          while running. Turn off any time to revoke permission.
        </p>
      </div>
    </div>
  );
}
