import type { QueueTask } from '../types/signalr';
import { getAllConfigs, saveConfig } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from '../background/flowEventToHubPayload';

export default defineBackground(() => {
  const frameRegistry = new Map<number, Map<number, { url: string; isTop: boolean }>>();
  const pendingContinuations = new Map<number, unknown>();
  let lastFocusedTabId: number | null = null;
  let offscreenCreated = false;
  let offscreenReady = false;
  const offscreenReadyResolvers: Array<() => void> = [];

  function waitForOffscreenReady(): Promise<void> {
    if (offscreenReady) return Promise.resolve();
    return new Promise(resolve => offscreenReadyResolvers.push(resolve));
  }

  // ── Remote queue state ──

  let activeRemoteTask: (ActiveTaskContext & { tabId: number }) | null = null;
  const pendingRemoteTasks: QueueTask[] = [];

  // ── Offscreen document (Chrome-only) ──

  async function ensureOffscreen(): Promise<void> {
    if (offscreenCreated) return;
    const offscreen = (chrome as unknown as { offscreen?: {
      hasDocument: () => Promise<boolean>;
      createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
      Reason: Record<string, string>;
    } }).offscreen;
    if (!offscreen) return; // Firefox: no offscreen support
    const hasDoc = await offscreen.hasDocument();
    if (!hasDoc) {
      await offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: [offscreen.Reason.BLOBS],
        justification: 'Maintain SignalR WebSocket connection for task queue',
      });
      // offscreenReady will be set when OFFSCREEN_READY arrives from the new document
    } else {
      // SW restarted but offscreen persists — listener is already registered
      offscreenReady = true;
      offscreenReadyResolvers.splice(0).forEach(r => r());
    }
    offscreenCreated = true;
  }

  // ── Install: inject content scripts into existing tabs ──

  browser.runtime.onInstalled.addListener(async () => {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url?.startsWith('http') || !tab.id) continue;
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content-scripts/content.js'],
        });
      } catch { /* tab may not be scriptable */ }
    }
  });

  // ── Side panel: open on action click (Chrome-only) ──

  browser.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;
    try {
      await (chrome.sidePanel as { open: (opts: { tabId: number }) => Promise<void> }).open({ tabId: tab.id });
    } catch (err) {
      console.error('[SW] Failed to open side panel:', err);
    }
  });

  // ── Track focused tab ──

  browser.tabs.onActivated.addListener(({ tabId }: { tabId: number }) => {
    lastFocusedTabId = tabId;
  });

  // ── Remote task helpers ──

  function waitForTabComplete(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (id === tabId && changeInfo.status === 'complete') {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(listener);
      browser.tabs.get(tabId).then((t) => {
        if (t.status === 'complete') {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }).catch(() => { /* tab gone */ });
    });
  }

  function relayHubInvocation(type: string, payload: unknown): void {
    const send = async () => {
      await ensureOffscreen();
      await waitForOffscreenReady();
      // Same _fromSW tag the sidepanel relay uses — offscreen filters out
      // anything missing this flag (see messageHandler.ts).
      await browser.runtime.sendMessage({ type, payload, _fromSW: true });
    };
    send().catch((err) => console.error('[SW] Failed to relay hub invocation:', err));
  }

  async function startRemoteTask(task: QueueTask): Promise<void> {
    let resolved;
    try {
      const localConfigs = await getAllConfigs();
      resolved = resolveQueueTask(task, localConfigs);

      // Persist inline config if it isn't local yet — first-run cache.
      if (task.inlineConfig && !localConfigs.some((c) => c.id === task.configId)) {
        await saveConfig(task.inlineConfig);
      }
    } catch (err) {
      const message = err instanceof ConfigNotFoundError ? err.message : (err as Error).message;
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: message,
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
      return;
    }

    const tab = await browser.tabs.create({ url: resolved.config.url, active: true });
    if (!tab.id) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: "Couldn't open a tab for the task",
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
      return;
    }

    activeRemoteTask = {
      tabId: tab.id,
      taskId: resolved.taskId,
      configId: resolved.configId,
      configName: resolved.configName,
      searchTerms: resolved.searchTerms,
      dataMapping: resolved.config.dataMapping,
    };
    lastFocusedTabId = tab.id;

    await waitForTabComplete(tab.id);

    browser.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_FLOW',
      payload: {
        config: resolved.config,
        searchTerms: resolved.searchTerms,
        taskId: resolved.taskId,
      },
    }).catch((err: Error) => {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: resolved.taskId,
        configId: resolved.configId,
        error: `Couldn't dispatch task to page: ${err.message}`,
        failedAt: new Date().toISOString(),
      });
      activeRemoteTask = null;
      drainNextRemoteTask();
    });
  }

  function drainNextRemoteTask(): void {
    activeRemoteTask = null;
    const next = pendingRemoteTasks.shift();
    if (next) {
      startRemoteTask(next).catch((err) => console.error('[SW] Failed to start queued task:', err));
    }
  }

  function handleRemoteFlowEvent(type: string, payload: Record<string, unknown>): void {
    if (!activeRemoteTask || payload?.taskId !== activeRemoteTask.taskId) return;

    switch (type) {
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(activeRemoteTask, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        return;
      }
      case 'FLOW_COMPLETE': {
        const hubPayload = mapFlowComplete(activeRemoteTask, payload as unknown as FlowCompletePayload);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNextRemoteTask();
        return;
      }
      case 'FLOW_ERROR': {
        const hubPayload = mapFlowError(activeRemoteTask, payload as unknown as FlowErrorPayload);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNextRemoteTask();
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string };
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        const hubPayload = mapFlowPaused(activeRemoteTask, payload as unknown as FlowPausedPayload);
        relayHubInvocation('SEND_TASK_PAUSED', hubPayload);
        return;
      }
    }
  }

  // ── Message routing ──

  browser.runtime.onMessage.addListener((
    rawMessage: unknown,
    rawSender: unknown,
    sendResponse: (r: unknown) => void,
  ) => {
    const message = rawMessage as Record<string, unknown>;
    const sender = rawSender as chrome.runtime.MessageSender;
    const type = message.type as string;

    if (type === 'OFFSCREEN_READY') {
      offscreenReady = true;
      offscreenReadyResolvers.splice(0).forEach(r => r());
      return;
    }

    if (type === 'REGISTER_CONTINUATION') {
      const tabId = sender.tab?.id;
      if (tabId) pendingContinuations.set(tabId, message.payload);
      return true as const;
    }

    if (type === 'CANCEL_CONTINUATION') {
      const tabId = sender.tab?.id;
      if (tabId) pendingContinuations.delete(tabId);
      return true as const;
    }

    // ── Fetch Flourish data (needs SW fetch origin) ──

    if (type === 'FETCH_FLOURISH_DATA') {
      const payload = message.payload as { visualizationId?: string } | undefined;
      const vizId = payload?.visualizationId;
      if (!vizId || !/^\d+$/.test(vizId)) {
        sendResponse({ error: 'Invalid visualization ID' });
        return true;
      }
      fetch(`https://public.flourish.studio/visualisation/${vizId}/visualisation.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => sendResponse({ data }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    }

    // ── Frame registration ──

    if (type === 'FRAME_REGISTER') {
      const cs = sender as chrome.runtime.MessageSender;
      const tabId = cs.tab?.id;
      if (!tabId) return true as const;
      if (!frameRegistry.has(tabId)) frameRegistry.set(tabId, new Map());
      frameRegistry.get(tabId)!.set(cs.frameId ?? 0, {
        url: cs.url ?? '',
        isTop: (cs.frameId ?? 0) === 0,
      });
      return true as const;
    }

    // ── Inbound queue task: start or queue it ──

    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      if (activeRemoteTask) {
        pendingRemoteTasks.push(task);
      } else {
        startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
      }
      return true as const;
    }

    // ── Offscreen → Sidepanel relay ──

    const offscreenToSidepanel = [
      'RESUME_TASK', 'CANCEL_TASK', 'CONNECTION_READY', 'CONNECTION_LOST',
      'CONNECTION_STATUS',
    ];
    if (offscreenToSidepanel.includes(type)) {
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      return true as const;
    }

    // ── Sidepanel → Offscreen relay ──

    const sidepanelToOffscreen = [
      'INIT_SIGNALR', 'STOP_SIGNALR',
      'SEND_TASK_PROGRESS', 'SEND_TASK_COMPLETE',
      'SEND_TASK_ERROR', 'SEND_TASK_PAUSED', 'GET_CONNECTION_STATUS',
    ];
    if (sidepanelToOffscreen.includes(type)) {
      console.log('[SW] Relaying to offscreen:', type);
      const relay = async () => {
        await ensureOffscreen();
        await waitForOffscreenReady();
        // Tag the relay so the offscreen can ignore direct sidepanel broadcasts
        // of the same message (runtime.sendMessage is a broadcast to all contexts).
        return browser.runtime.sendMessage({ ...(message as object), _fromSW: true });
      };
      relay()
        .then((response) => {
          console.log('[SW] Relay response for', type, response);
          sendResponse(response);
        })
        .catch((err: Error) => {
          console.error('[SW] Offscreen relay error:', err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }

    // ── Content → Sidepanel relay (also taps queue mode forwarding) ──

    const contentToSidepanel = [
      'ELEMENT_PICKED', 'ELEMENT_HOVER', 'PICKER_CANCELLED', 'PONG',
      'FLOW_PROGRESS', 'FLOW_COMPLETE', 'FLOW_ERROR',
      'CLOUDFLARE_DETECTED', 'FLOW_PAUSED', 'FLOW_RESUMED',
      'NETWORK_CALL_CAPTURED', 'PAGE_INFO',
      'SCAN_PROGRESS', 'SCAN_COMPLETE', 'SCAN_ERROR',
    ];
    if (contentToSidepanel.includes(type)) {
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      handleRemoteFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return true as const;
    }

    // ── Sidepanel → Content routing ──

    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_CLOUDFLARE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
    if (sidepanelToContent.includes(type)) {
      const frameId = message.frameId as number | undefined;
      const targetTabId = lastFocusedTabId;

      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = (type === 'EXECUTE_FLOW' && targetTabId) ? targetTabId : activeTab?.id;
        if (!tabId) {
          sendResponse({ error: 'No active tab' });
          return;
        }

        if (type === 'START_PICKER') {
          const frames = frameRegistry.get(tabId);
          if (frames && frames.size > 0) {
            for (const [fId] of frames) {
              browser.tabs.sendMessage(tabId, message, { frameId: fId }).catch(() => {});
            }
          } else {
            browser.tabs.sendMessage(tabId, message).catch(() => {});
          }
          sendResponse({ ok: true });
        } else {
          const opts = frameId !== null && frameId !== undefined ? { frameId } : {};
          chrome.tabs.sendMessage(tabId, message, opts, (response: unknown) => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response);
            }
          });
        }
      });
      return true as const;
    }

    return true as const;
  });

  // ── Tab lifecycle ──

  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    if (activeRemoteTask && activeRemoteTask.tabId === tabId) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: activeRemoteTask.taskId,
        configId: activeRemoteTask.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
    }
  });

  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === 'loading') {
      frameRegistry.delete(tabId);
    }
    if (changeInfo.status === 'complete') {
      const continuation = pendingContinuations.get(tabId);
      if (continuation) {
        // Do NOT delete before sending — keep it so that if the tab is mid-redirect
        // and the content script isn't ready yet (sendMessage rejects), the next
        // 'complete' event will retry. Delete only on confirmed delivery.
        setTimeout(() => {
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
            .then(() => pendingContinuations.delete(tabId))
            .catch(() => {}); // retry on next 'complete'
        }, 600);
      }
    }
  });
});
