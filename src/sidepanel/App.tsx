import { useEffect } from 'react';
import Header from './components/Header';
import TabBar from './components/TabBar';
import Toast from './components/Toast';
import WelcomeSheet from './components/WelcomeSheet';
import StorageFooter from './components/StorageFooter';
import ConfigTab from './components/ConfigTab';
import SavedConfigsTab from './components/SavedConfigsTab';
import QueueView from './components/QueueView';
import APISettingsView from './components/APISettingsView';
import ConfirmDialog from './components/ConfirmDialog';
import DomainBadge from './components/DomainBadge';
import CloudflarePauseAlert from './components/CloudflarePauseAlert';
import AwaitActionPauseAlert from './components/AwaitActionPauseAlert';
import { useUiStore } from './stores/uiStore';
import { useConfigStore } from './stores/configStore';
import { useSettingsStore } from './stores/settingsStore';
import { useSyncStore } from './stores/syncStore';
import { getPageInfo } from './utils/messaging';
import { getApiToken } from './utils/storage';
import { startDispatcher } from './utils/messageDispatcher';
import { startQueueDispatcher } from './utils/queueDispatcher';
import type { ConnectionStatus } from '../types/messages';

export default function App() {
  useEffect(() => { startDispatcher(); }, []);

  useEffect(() => {
    const { serverUrl, mode, workerName } = useSettingsStore.getState();
    browser.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' })
      .then(async (res: unknown) => {
        const r = res as { status?: ConnectionStatus };
        const status = r?.status ?? 'idle';
        useSettingsStore.getState().setConnectionStatus(status);

        const pauseRes = await browser.runtime.sendMessage({ type: 'GET_PAUSE_STATE' }).catch(() => null);
        const ps = (pauseRes as { pauseState?: { reason: string; message?: string } } | null)?.pauseState;
        if (ps?.reason === 'cloudflare') {
          useUiStore.getState().setCloudflarePaused(true);
        } else if (ps?.reason === 'awaitUserAction') {
          useUiStore.getState().setAwaitActionPaused({ message: ps.message ?? 'Action needed in your browser.' });
        }

        if (status === 'idle' && mode === 'queue' && serverUrl) {
          const token = await getApiToken().catch(() => null);
          if (token) {
            await browser.runtime.sendMessage({
              type: 'INIT_SIGNALR',
              payload: {
                serverUrl,
                token,
                clientId: workerName || 'My Browser',
                version: chrome.runtime.getManifest().version,
              },
            });
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // CONNECTION_STATUS comes from the offscreen document (not a tab), so it must
    // be caught with a raw listener — onMessage/onContentMessage filters for sender.tab.
    const listener = (message: unknown) => {
      const msg = message as { type?: string; payload?: unknown };
      if (msg.type === 'CONNECTION_STATUS') {
        const payload = msg.payload as { status: ConnectionStatus; error?: string };
        useSettingsStore.getState().setConnectionStatus(payload.status, payload.error);
        if (payload.status === 'connected') {
          const { serverUrl, jwtToken } = useSettingsStore.getState();
          useSyncStore.getState().pullSharedConfigs(serverUrl, jwtToken);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const { connectionStatus, serverUrl, jwtToken } = useSettingsStore.getState();
      if (connectionStatus !== 'connected') return;
      void useSyncStore.getState().pullSharedConfigs(serverUrl, jwtToken);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => startQueueDispatcher(), []);

  useEffect(() => {
    return useSyncStore.subscribe((state, prev) => {
      if (state.lastSyncError && state.lastSyncError !== prev.lastSyncError) {
        useUiStore.getState().showToast(`Sync failed: ${state.lastSyncError}`, 'error');
      }
    });
  }, []);

  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const pendingTabSwitch = useUiStore((s) => s.pendingTabSwitch);
  const tabSwitchReason = useUiStore((s) => s.tabSwitchReason);
  const confirmTabSwitch = useUiStore((s) => s.confirmTabSwitch);
  const saveAndSwitchTab = useUiStore((s) => s.saveAndSwitchTab);
  const discardAndSwitchTab = useUiStore((s) => s.discardAndSwitchTab);
  const cancelTabSwitch = useUiStore((s) => s.cancelTabSwitch);
  const cloudfarePaused = useUiStore((s) => s.cloudfarePaused);

  const isDirty = useConfigStore((s) => s.isDirty);
  const isPickerActive = useUiStore((s) => s.isPickerActive);
  const isRunning = useUiStore((s) => s.isRunning);
  const setPageInfo = useConfigStore((s) => s.setPageInfo);

  useEffect(() => {
    const applyTabUrl = (tab: chrome.tabs.Tab) => {
      if (!tab?.url) return;
      try { setPageInfo(tab.url, new URL(tab.url).hostname); } catch { /* ignore */ }
    };

    getPageInfo().then((info) => {
      if (info) setPageInfo(info.url as string, (info.domain as string) || new URL(info.url as string).hostname);
    }).catch(() => {});

    const handleActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        applyTabUrl(tab);
      });
    };

    const handleUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.status !== 'complete') return;
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab && tab.id === tabId) applyTabUrl(tab);
      });
    };

    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [setPageInfo]);

  function handleTabClick(tab: typeof activeTab) {
    if (tab === activeTab) return;
    if (isPickerActive || isRunning) {
      useUiStore.getState().requestTabSwitch(tab);
      return;
    }
    if (isDirty) {
      useUiStore.getState().requestTabSwitch(tab);
      return;
    }
    if (activeTab === 'config') {
      const { view } = useConfigStore.getState();
      if (view !== 'NO_CONFIG') useConfigStore.getState().newConfig();
    }
    setActiveTab(tab);
  }

  const dialogProps =
    tabSwitchReason === 'dirty'
      ? {
          title: 'Unsaved changes',
          message: 'You have unsaved changes. Save them before switching?',
          confirmLabel: 'Save & Switch',
          confirmVariant: 'primary' as const,
          secondaryLabel: 'Discard & Switch',
          onConfirm: saveAndSwitchTab,
          onSecondary: discardAndSwitchTab,
          onCancel: cancelTabSwitch,
        }
      : tabSwitchReason === 'running'
      ? {
          title: 'Stop scraper?',
          message: 'A scrape is currently running. Stop it and switch tabs?',
          confirmLabel: 'Stop & Switch',
          confirmVariant: 'danger' as const,
          onConfirm: confirmTabSwitch,
          onCancel: cancelTabSwitch,
        }
      : {
          title: 'Cancel element selection?',
          message: 'You are currently picking an element. Cancel and switch tabs?',
          confirmLabel: 'Cancel & Switch',
          confirmVariant: 'danger' as const,
          onConfirm: confirmTabSwitch,
          onCancel: cancelTabSwitch,
        };

  return (
    <div className="app">
      <Header />
      <TabBar activeTab={activeTab} onTabClick={handleTabClick} />
      <DomainBadge />
      {cloudfarePaused && <CloudflarePauseAlert />}
      <AwaitActionPauseAlert />

      <div className="app-content">
        {activeTab === 'config' ? <ConfigTab /> :
         activeTab === 'saved' ? <SavedConfigsTab /> :
         activeTab === 'queue' ? <QueueView /> :
         <APISettingsView />}
      </div>

      <StorageFooter />
      <WelcomeSheet />
      <Toast />

      {pendingTabSwitch && <ConfirmDialog {...dialogProps} />}
    </div>
  );
}
