import { dbg, ensureDebugInit } from '../utils/debugLog';
import { mergeProgress } from '../utils/queueProgress';
import type { QueueTask } from '../types/signalr';
import { getAllConfigs, saveConfig, PREFS_KEY } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from '../background/remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from '../background/flowEventToHubPayload';
import { Scheduler, type PersistedActiveRecord } from '../background/scheduler';
import { originOf } from '../background/originOf';

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
  //
  // Scheduler owns the per-task records (active Map, pending queue, recent
  // history, single-flight `starting` gate). `activePauseState` is kept as a
  // thin singleton mirror for the App.tsx GET_PAUSE_STATE handshake, the
  // continuation-hold check in tabs.onUpdated, and sidepanel-only-mode runs
  // (which bypass the scheduler). PR4 will move pause state per-task.

  const scheduler = new Scheduler({
    startTask: (task) => {
      // startRemoteTask handles its own resolver/window-create failures via
      // scheduler.recordStartFailed. The .catch here is a backstop for
      // unforeseen rejections from chrome APIs that escape those handlers —
      // matches HEAD's defensive logging pattern.
      startRemoteTask(task).catch((err) => console.error('[SW] startRemoteTask failed:', err));
    },
  });

  let activePauseState: {
    reason: 'cloudflare' | 'awaitUserAction';
    message?: string;
    trigger?: import('../types/messages').DetectionTrigger;
    domain?: string;
  } | null = null;
  type SignalRConfig = { serverUrl: string; token: string; clientId: string; version: string };
  let signalrConfig: SignalRConfig | null = null;

  function persistActive(): void {
    chrome.storage.session.set({ activeRemoteTasks: scheduler.serializeActive() }).catch(() => {});
  }

  function persistRecent(): void {
    chrome.storage.session.set({ recentRemoteTasks: scheduler.getRecent() }).catch(() => {});
  }

  // Restore state from session storage on SW restart (state is lost when SW is killed by Chrome).
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTasks', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (Array.isArray(data.activeRemoteTasks)) {
      scheduler.restoreActive(data.activeRemoteTasks as PersistedActiveRecord[]);
    }
    if (Array.isArray(data.recentRemoteTasks)) {
      scheduler.setRecent(data.recentRemoteTasks as QueueTask[]);
    }
  }).catch(() => {});

  // One-shot cleanup of the pre-PR2 singular key. chrome.storage.session is
  // wiped on browser restart, so this only matters for an in-place extension
  // reload during the upgrade window. Safe to remove this line in PR3+.
  chrome.storage.session.remove('activeRemoteTask').catch(() => {});

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

  function buildSnapshotActiveTask(): QueueTask | null {
    const r = scheduler.getFirstActive();
    if (!r) return null;
    return {
      ...r.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
      progress: r.lastProgress,
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
      scheduler.recordStartFailed(task.id);
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
      scheduler.recordStartFailed(task.id);
      return;
    }

    // Register early so tabs.onRemoved during page load can identify the task.
    scheduler.recordStarted(task.id, task, {
      tabId: tab.id,
      windowId: win.id,
      origin: originOf(resolved.config.url),
      resolvedDataMapping: resolved.config.dataMapping,
    });
    persistActive();
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
      drainNextRemoteTask(resolved.taskId, 'failed');
    });
  }

  // PR2: now requires the taskId — we no longer have a hidden singleton to drain.
  // Callers that previously called drainNextRemoteTask() with no args (catastrophic
  // failures during start) now use scheduler.recordStartFailed instead, since at
  // start-time there is no scheduler record yet to remove.
  function drainNextRemoteTask(taskId: string, completedStatus: 'completed' | 'failed' = 'failed'): void {
    activePauseState = null;
    const closing = scheduler.endTask(taskId);
    if (!closing) {
      // No record — nothing to clean up. tryStartNext is already a no-op when
      // active < cap and pending is empty, so we don't need to call it here.
      return;
    }
    scheduler.pushRecent({ ...closing.task, status: completedStatus, pausedReason: undefined });
    persistActive();
    persistRecent();

    const closingWindowId = closing.windowId;
    const closingTaskId = closing.task.id;
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

  function handleRemoteFlowEvent(type: string, payload: Record<string, unknown>): void {
    const taskId = payload?.taskId as string | undefined;
    if (!taskId) {
      // Sidepanel-mode runs (no taskId) — handled elsewhere or not relevant
      // to the queue path. Silently ignore.
      return;
    }
    const record = scheduler.getActiveTask(taskId);
    if (!record) {
      console.warn('[SW] handleRemoteFlowEvent: no record for taskId', taskId, 'dropping', type);
      return;
    }

    const ctx: ActiveTaskContext = {
      taskId: record.task.id,
      configId: record.task.configId,
      configName: record.task.configName,
      searchTerms: record.task.searchTerms,
      dataMapping: record.resolvedDataMapping,
    };

    switch (type) {
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        const merged = mergeProgress(record.lastProgress ?? null, {
          stepLabel: (payload as Record<string, unknown>).stepLabel,
          termIndex: (payload as Record<string, unknown>).termIndex,
        });
        if (merged) {
          scheduler.setProgress(taskId, merged);
          persistActive();
        }
        return;
      }
      case 'FLOW_COMPLETE': {
        const fp = payload as unknown as FlowCompletePayload;
        console.warn('[SW] FLOW_COMPLETE | taskId:', record.task.id, '| aborted:', fp.result?.aborted, '| iterations:', fp.result?.iterations?.length, '| totalTimeMs:', fp.result?.totalTimeMs);
        const hubPayload = mapFlowComplete(ctx, fp);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNextRemoteTask(taskId, 'completed');
        return;
      }
      case 'FLOW_ERROR': {
        const fe = payload as unknown as FlowErrorPayload;
        console.warn('[SW] FLOW_ERROR | taskId:', record.task.id, '| error:', fe.error);
        const hubPayload = mapFlowError(ctx, fe);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNextRemoteTask(taskId, 'failed');
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        console.warn('[SW] FLOW_PAUSED | taskId:', record.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message, '| trigger:', flowPayload.trigger, '| domain:', flowPayload.domain);
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        activePauseState = {
          reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
          message: flowPayload.message,
          trigger: flowPayload.trigger,
          domain: flowPayload.domain,
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
      scheduler.enqueueTask(task);
      return;
    }

    // ── Server-initiated task control (handled directly — no sidepanel required) ──

    if (type === 'RESUME_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_CLOUDFLARE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_CLOUDFLARE failed:', err));
        activePauseState = null;
      }
      return;
    }

    // Sidepanel-driven resume. Intercept BEFORE the sidepanelToContent routing
    // below so we can (1) clear activePauseState atomically and (2) drain any
    // held continuation that's been waiting because the page navigated during
    // the pause. The interceptor doesn't consume the message — it falls through
    // to the routing block, which forwards to the live content script (if one
    // is still listening). If the content script is dead (page navigated), the
    // drained continuation re-delivers EXECUTE_FLOW.
    if (type === 'RESUME_AFTER_PAUSE' || type === 'RESUME_AFTER_CLOUDFLARE') {
      const wasPaused = activePauseState !== null;
      const resumePayload = (message.payload ?? {}) as { markAsFalseAlarm?: boolean };

      // Capture false-alarm signal BEFORE clearing activePauseState.
      // Cloudflare cannot be marked as false alarm (UI doesn't expose the button).
      if (
        resumePayload.markAsFalseAlarm
        && type === 'RESUME_AFTER_PAUSE'
        && activePauseState?.reason === 'awaitUserAction'
        && activePauseState?.trigger
        && activePauseState?.domain
      ) {
        const { domain, trigger } = activePauseState;
        // Async fire-and-forget; don't block the resume on storage write.
        import('../sidepanel/utils/detectionMemory').then(({ addIgnoredTrigger }) => {
          addIgnoredTrigger(domain, trigger).catch((err) => {
            console.error('[SW] addIgnoredTrigger failed:', err);
          });
          console.warn('[SW] markAsFalseAlarm recorded | domain:', domain, '| trigger:', trigger);
        });
      }

      activePauseState = null;
      console.warn('[SW] sidepanel resume | type:', type, '| wasPaused:', wasPaused, '| markAsFalseAlarm:', resumePayload.markAsFalseAlarm);

      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = activeTab?.id;
        if (!tabId) return;
        const continuation = pendingContinuations.get(tabId);
        if (continuation) {
          pendingContinuations.delete(tabId);
          console.warn('[SW] resume — draining held continuation | tabId:', tabId);
          setTimeout(() => {
            browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: continuation })
              .then(() => console.warn('[SW] held continuation delivered | tabId:', tabId))
              .catch((err: Error) => {
                console.warn('[SW] held continuation delivery failed | tabId:', tabId, '— re-registering | err:', err.message);
                pendingContinuations.set(tabId, continuation);
              });
          }, 300);
        }
      }).catch(() => { /* ignore */ });

      // Fall through to sidepanelToContent routing so the live content script
      // (if any) also receives the resume signal and its waitForResumeSignal
      // promise resolves.
    }

    if (type === 'CANCEL_TASK') {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      } else if (taskId) {
        // May still be in pending — drop it without starting.
        scheduler.cancelPending(taskId);
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
        pending: [...scheduler.getPendingTasks()],
        recent: [...scheduler.getRecent()],
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
      'FLOW_PREFLIGHT_READY',
      'NETWORK_CALL_CAPTURED', 'PAGE_INFO',
      'SCAN_PROGRESS', 'SCAN_COMPLETE', 'SCAN_ERROR',
    ];
    if (contentToSidepanel.includes(type)) {
      if (type === 'FLOW_PREFLIGHT_READY') {
        const p = (message.payload ?? {}) as { taskId?: string };
        const record = p.taskId ? scheduler.getActiveTask(p.taskId) : undefined;
        console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| recordKnown:', !!record);
        // PR4 will transition the task in the scheduler here. PR3 just logs
        // and falls through to the relay — sidepanel can already subscribe
        // (PR5) without further wiring.
      }
      if (type === 'FLOW_RESUMED') {
        console.warn('[SW] FLOW_RESUMED relayed | activeTaskId:', scheduler.getFirstActive()?.task.id);
      }
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });

      // Mirror pause state into activePauseState for sidepanel-only runs.
      // handleRemoteFlowEvent below also sets it but only when there is an active
      // queue-mode record. Both paths converge on the same activePauseState.
      if (type === 'FLOW_PAUSED') {
        const fp = (message.payload ?? {}) as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        if (fp.reason === 'cloudflare' || fp.reason === 'awaitUserAction') {
          activePauseState = {
            reason: fp.reason as 'cloudflare' | 'awaitUserAction',
            message: fp.message,
            trigger: fp.trigger,
            domain: fp.domain,
          };
        }
      }
      if (type === 'FLOW_RESUMED') {
        activePauseState = null;
      }

      handleRemoteFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return;
    }

    // ── Sidepanel → Content routing ──

    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_CLOUDFLARE', 'RESUME_AFTER_PAUSE',
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
    const orphaned = scheduler.findByTabId(tabId);
    if (orphaned) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: orphaned.task.id,
        configId: orphaned.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      drainNextRemoteTask(orphaned.task.id, 'failed');
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
        // Pause-resilience: while activePauseState is set, the user is still
        // working on the obstacle. The page may have navigated as part of that
        // (e.g. login submit redirect). HOLD the continuation in the map and
        // do NOT deliver — it will be drained by the sidepanel-resume handler
        // when the user clicks Continue.
        if (activePauseState) {
          console.warn('[SW] tabs.onUpdated — holding continuation (pause active) | tabId:', tabId, '| reason:', activePauseState.reason);
          return;
        }

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
