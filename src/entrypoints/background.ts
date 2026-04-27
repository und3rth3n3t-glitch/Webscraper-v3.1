import { dbg, ensureDebugInit } from '../utils/debugLog';
import { mergeProgress } from '../utils/queueProgress';
import type { QueueTask } from '../types/signalr';
import type { DataMapping } from '../types/config';
import { getAllConfigs, saveConfig, PREFS_KEY } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from '../background/flowEventToHubPayload';

export default defineBackground(() => {
  ensureDebugInit();
  console.warn('[SW] ✦ background loaded | version:', __APP_VERSION__, '| built:', __BUILD_TIME__);
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

  const RECENT_TASKS_CAP = 20;
  let activeRemoteTask: { task: QueueTask; tabId: number; windowId: number; resolvedDataMapping?: DataMapping; lastProgress?: { stepLabel: string; termIndex?: number } } | null = null;
  let recentRemoteTasks: QueueTask[] = [];
  let isStartingTask = false;
  const pendingRemoteTasks: QueueTask[] = [];
  let activePauseState: { reason: 'cloudflare' | 'awaitUserAction'; message?: string } | null = null;
  type SignalRConfig = { serverUrl: string; token: string; clientId: string; version: string };
  let signalrConfig: SignalRConfig | null = null;

  // Restore state from session storage on SW restart (state is lost when SW is killed by Chrome).
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTask', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (data.activeRemoteTask) activeRemoteTask = data.activeRemoteTask as typeof activeRemoteTask;
    if (data.recentRemoteTasks) recentRemoteTasks = data.recentRemoteTasks as QueueTask[];
  }).catch(() => {});

  // Debug-mode flag (mirrors the toggle read by scrapingEngine.ts). Read
  // fresh at decision time inside drainNextRemoteTask — caching it at SW
  // startup races with FLOW_COMPLETE on a freshly woken SW.
  async function isDebugMode(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(PREFS_KEY);
      const prefs = (result[PREFS_KEY] as Record<string, unknown> | undefined) || {};
      return !!prefs.debug;
    } catch {
      return false;
    }
  }

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
      // After OFFSCREEN_READY fires, auto-reinitialize SignalR if we have stored config.
      // This handles the case where the SW was killed mid-scrape and the offscreen doc
      // was also killed — we need to reconnect before flow events can be relayed.
      if (signalrConfig) {
        waitForOffscreenReady().then(() => {
          browser.runtime.sendMessage({
            type: 'INIT_SIGNALR',
            payload: signalrConfig,
            _fromSW: true,
          }).catch(() => {});
        }).catch(() => {});
      }
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
      dbg('[SW] relayHubInvocation sending:', type);
      const resp = await browser.runtime.sendMessage({ type, payload, _fromSW: true });
      dbg('[SW] relayHubInvocation sent ok:', type);
    };
    send().catch((err) => console.error('[SW] Failed to relay hub invocation:', type, err));
  }

  function pushToRecent(task: QueueTask): void {
    const idx = recentRemoteTasks.findIndex((t) => t.id === task.id);
    if (idx !== -1) recentRemoteTasks.splice(idx, 1);
    recentRemoteTasks.unshift(task);
    if (recentRemoteTasks.length > RECENT_TASKS_CAP) recentRemoteTasks.length = RECENT_TASKS_CAP;
    chrome.storage.session.set({ recentRemoteTasks }).catch(() => {});
  }

  function buildSnapshotActiveTask(): QueueTask | null {
    if (!activeRemoteTask) return null;
    return {
      ...activeRemoteTask.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
      progress: activeRemoteTask.lastProgress,
    };
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

    const win = await browser.windows.create({ url: resolved.config.url, focused: true, state: 'maximized' });
    const tab = win?.tabs?.[0];
    if (!tab?.id || !win?.id) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: "Couldn't open a window for the task",
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
      return;
    }

    activeRemoteTask = {
      task: { ...task, status: 'running' },
      tabId: tab.id,
      windowId: win.id,
      resolvedDataMapping: resolved.config.dataMapping,
    };
    isStartingTask = false;
    chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
    lastFocusedTabId = tab.id;

    await waitForTabComplete(tab.id);

    console.warn('[SW] Sending initial EXECUTE_FLOW | taskId:', resolved.taskId, '| searchTerms:', resolved.searchTerms);
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

  function drainNextRemoteTask(completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closingWindowId = activeRemoteTask?.windowId;
    const closingTaskId = activeRemoteTask?.task.id;
    if (activeRemoteTask) {
      pushToRecent({ ...activeRemoteTask.task, status: completedStatus, pausedReason: undefined });
    }
    activeRemoteTask = null;
    isStartingTask = false;
    chrome.storage.session.remove('activeRemoteTask').catch(() => {});

    if (closingWindowId) {
      isDebugMode().then((debug) => {
        if (debug) {
          console.warn('[SW] DEBUG mode — leaving task window open | windowId:', closingWindowId, '| taskId:', closingTaskId);
        } else {
          browser.windows.remove(closingWindowId).catch(() => {});
        }
      }).catch(() => {
        browser.windows.remove(closingWindowId).catch(() => {});
      });
    }

    const next = pendingRemoteTasks.shift();
    if (next) {
      isStartingTask = true;
      startRemoteTask(next).catch((err) => console.error('[SW] Failed to start queued task:', err));
    }
  }

  function handleRemoteFlowEvent(type: string, payload: Record<string, unknown>): void {
    if (!activeRemoteTask) {
      console.warn('[SW] handleRemoteFlowEvent: no activeRemoteTask, dropping', type);
      return;
    }
    if (payload?.taskId !== activeRemoteTask.task.id) {
      console.warn('[SW] handleRemoteFlowEvent: taskId mismatch — got', payload?.taskId, 'expected', activeRemoteTask.task.id, 'dropping', type);
      return;
    }

    const ctx: ActiveTaskContext = {
      taskId: activeRemoteTask.task.id,
      configId: activeRemoteTask.task.configId,
      configName: activeRemoteTask.task.configName,
      searchTerms: activeRemoteTask.task.searchTerms,
      dataMapping: activeRemoteTask.resolvedDataMapping,
    };

    switch (type) {
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        const merged = mergeProgress(activeRemoteTask.lastProgress ?? null, {
          stepLabel: (payload as Record<string, unknown>).stepLabel,
          termIndex: (payload as Record<string, unknown>).termIndex,
        });
        if (merged) {
          activeRemoteTask.lastProgress = merged;
          chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
        }
        return;
      }
      case 'FLOW_COMPLETE': {
        const fp = payload as unknown as FlowCompletePayload;
        console.warn('[SW] FLOW_COMPLETE | taskId:', activeRemoteTask.task.id, '| aborted:', fp.result?.aborted, '| iterations:', fp.result?.iterations?.length, '| totalTimeMs:', fp.result?.totalTimeMs);
        const hubPayload = mapFlowComplete(ctx, fp);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNextRemoteTask('completed');
        return;
      }
      case 'FLOW_ERROR': {
        const fe = payload as unknown as FlowErrorPayload;
        console.warn('[SW] FLOW_ERROR | taskId:', activeRemoteTask.task.id, '| error:', fe.error);
        const hubPayload = mapFlowError(ctx, fe);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNextRemoteTask();
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string; message?: string };
        console.warn('[SW] FLOW_PAUSED | taskId:', activeRemoteTask.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message);
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        activePauseState = {
          reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
          message: flowPayload.message,
        };
        const hubPayload = mapFlowPaused(ctx, payload as unknown as FlowPausedPayload);
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

    if (type === '__SW_LOG__') {
      console.warn('[page]', message.payload);
      return;
    }

    if (type === 'REGISTER_CONTINUATION') {
      const tabId = sender.tab?.id;
      if (tabId) {
        const p = message.payload as Record<string, unknown>;
        console.warn('[SW] REGISTER_CONTINUATION tabId:', tabId, '| startTermIndex:', p.startTermIndex, '| startLoopStepIndex:', p.startLoopStepIndex, '| searchTerms:', p.searchTerms);
        pendingContinuations.set(tabId, message.payload);
      }
      return;
    }

    if (type === 'CANCEL_CONTINUATION') {
      const tabId = sender.tab?.id;
      if (tabId) {
        const had = pendingContinuations.has(tabId);
        pendingContinuations.delete(tabId);
        console.warn('[SW] CANCEL_CONTINUATION | tabId:', tabId, '| hadEntry:', had);
      } else {
        console.warn('[SW] CANCEL_CONTINUATION received with no sender.tab.id');
      }
      return;
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
      if (!tabId) return;
      if (!frameRegistry.has(tabId)) frameRegistry.set(tabId, new Map());
      frameRegistry.get(tabId)!.set(cs.frameId ?? 0, {
        url: cs.url ?? '',
        isTop: (cs.frameId ?? 0) === 0,
      });
      return;
    }

    // ── Inbound queue task: start or queue it ──

    if (type === 'TASK_RECEIVED') {
      const task = message.payload as QueueTask;
      if (activeRemoteTask || isStartingTask) {
        pendingRemoteTasks.push(task);
      } else {
        isStartingTask = true;
        startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
      }
      return;
    }

    // ── Server-initiated task control (handled directly — no sidepanel required) ──

    if (type === 'RESUME_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.task.id)) {
        browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'RESUME_AFTER_CLOUDFLARE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_CLOUDFLARE failed:', err));
        activePauseState = null;
      }
      return;
    }

    if (type === 'CANCEL_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      if (activeRemoteTask && (!taskId || taskId === activeRemoteTask.task.id)) {
        browser.tabs.sendMessage(activeRemoteTask.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      }
      return;
    }

    // ── Offscreen → Sidepanel relay ──

    const offscreenToSidepanel = [
      'CONNECTION_READY', 'CONNECTION_LOST', 'CONNECTION_STATUS',
    ];
    if (offscreenToSidepanel.includes(type)) {
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      return;
    }

    if (type === 'GET_PAUSE_STATE') {
      sendResponse({ pauseState: activePauseState });
      return;
    }

    if (type === 'GET_QUEUE_SNAPSHOT') {
      sendResponse({
        active: buildSnapshotActiveTask(),
        pending: [...pendingRemoteTasks],
        recent: [...recentRemoteTasks],
      });
      return true;
    }

    // ── Sidepanel → Offscreen relay ──

    const sidepanelToOffscreen = [
      'INIT_SIGNALR', 'STOP_SIGNALR',
      'SEND_TASK_PROGRESS', 'SEND_TASK_COMPLETE',
      'SEND_TASK_ERROR', 'SEND_TASK_PAUSED', 'GET_CONNECTION_STATUS',
    ];
    if (sidepanelToOffscreen.includes(type)) {
      // Messages from relayHubInvocation already carry _fromSW and go directly
      // to the offscreen; don't re-relay them or we create an infinite loop.
      if (message._fromSW) return;
      dbg('[SW] Relaying to offscreen:', type);
      if (type === 'INIT_SIGNALR') {
        signalrConfig = message.payload as SignalRConfig;
        chrome.storage.session.set({ signalrConfig }).catch(() => {});
      }
      if (type === 'STOP_SIGNALR') {
        signalrConfig = null;
        chrome.storage.session.remove('signalrConfig').catch(() => {});
      }
      const relay = async () => {
        await ensureOffscreen();
        await waitForOffscreenReady();
        // Tag the relay so the offscreen can ignore direct sidepanel broadcasts
        // of the same message (runtime.sendMessage is a broadcast to all contexts).
        return browser.runtime.sendMessage({ ...(message as object), _fromSW: true });
      };
      relay()
        .then((response) => {
          dbg('[SW] Relay response for', type, response);
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
      if (type === 'FLOW_RESUMED') {
        console.warn('[SW] FLOW_RESUMED relayed | activeTaskId:', activeRemoteTask?.task.id);
      }
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      handleRemoteFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return;
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
  });

  // ── Tab lifecycle ──

  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    if (activeRemoteTask && activeRemoteTask.tabId === tabId) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: activeRemoteTask.task.id,
        configId: activeRemoteTask.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask();
    }
  });

  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string; url?: string }) => {
    if (changeInfo.status === 'loading') {
      frameRegistry.delete(tabId);
    }
    if (changeInfo.status === 'complete') {
      const continuation = pendingContinuations.get(tabId);
      if (continuation) {
        const cp = continuation as Record<string, unknown>;
        // Capture tab URL at fire time so we can correlate with the content
        // script's view of where it is when its waitAfterAction returns.
        browser.tabs.get(tabId).then((t) => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| tabUrl:', t.url, '| changeInfoUrl:', changeInfo.url, '| startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex, '| searchTerms:', cp.searchTerms, '| previousIterations.length:', Array.isArray(cp.previousIterations) ? (cp.previousIterations as unknown[]).length : 'n/a');
        }).catch(() => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| (tab.get failed) | startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex);
        });
        // Delete immediately so that a second 'complete' event firing before the
        // setTimeout resolves (e.g. redirect then page-load) does NOT double-fire
        // EXECUTE_FLOW. If delivery actually fails we re-add so the next 'complete'
        // can retry — this preserves the redirect-retry behaviour without double-fire.
        pendingContinuations.delete(tabId);
        setTimeout(() => {
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
            .then(() => { console.warn('[SW] Continuation delivered to tabId:', tabId); })
            .catch((err: Error) => {
              console.warn('[SW] Continuation delivery failed for tabId:', tabId, '— re-registering for retry | err:', err.message);
              pendingContinuations.set(tabId, continuation);
            });
        }, 600);
      }
    }
  });
});
