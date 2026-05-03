import { ensureDebugInit } from '../utils/debugLog';
import type { QueueTask } from '../types/signalr';
import { PREFS_KEY } from '../sidepanel/utils/storage';
import { Scheduler, type PersistedActiveRecord } from '../background/scheduler';
import { initCdpModule } from '../background/cdpInput';
import {
  isTaskNotification,
  isBatchNotification,
  taskIdFromNotificationId,
} from '../background/notifications';
import { createOffscreenManager, type SignalRConfig } from '../background/offscreen';
import { createBadgeManager } from '../background/badge';
import { createSessionPersistence } from '../background/sessionPersistence';
import { createPauseStateManager } from '../background/pauseState';
import { createRemoteTaskRunner, type RemoteTaskRunner } from '../background/remoteTaskRunner';
import { registerMessageRouter } from '../background/messageRouter';

export default defineBackground(() => {
  ensureDebugInit();
  // Hydrates `useRealInput` pref + checks current debugger permission;
  // listens for permission revoke + chrome.debugger.onDetach.
  initCdpModule();
  console.warn('[SW] ✦ background loaded | version:', __APP_VERSION__, '| built:', __BUILD_TIME__);
  const frameRegistry = new Map<number, Map<number, { url: string; isTop: boolean }>>();
  const pendingContinuations = new Map<number, unknown>();
  let lastFocusedTabId: number | null = null;

  // Note: offscreen manager closes over a getter for signalrConfig so it always
  // reads the latest value (signalrConfig is mutated when INIT_SIGNALR arrives
  // from the sidepanel). A snapshot would go stale across SW lifetime.
  const offscreen = createOffscreenManager({ getSignalrConfig: () => signalrConfig });
  const badge = createBadgeManager();
  const pauseState = createPauseStateManager();

  // ── Remote queue state ──
  //
  // Scheduler owns the per-task records (active Map, pending queue, recent
  // history, single-flight `starting` gate). The remote-task runner owns the
  // start/drain/flow-event lifecycle. `pauseState` is the singleton "is the
  // active task paused?" mirror — read here in the message router (for the
  // GET_PAUSE_STATE handshake and the continuation-hold check in
  // tabs.onUpdated) and inside the runner. PR4 will move pause state per-task.

  // Late binding: `runner` is constructed below (after scheduler + persistence,
  // because the runner depends on both). The Scheduler's startTask callback
  // captures the binding lazily — by the time a task is actually dispatched,
  // `runner` has been populated. Cast via `null!` is the simplest escape from
  // TS's strict-init complaint without loosening the file-wide tsconfig.
  let runner: RemoteTaskRunner = null!;

  const scheduler = new Scheduler({
    startTask: (task) => {
      // runner.start handles its own resolver/window-create failures via
      // scheduler.recordStartFailed. The .catch here is a backstop for
      // unforeseen rejections from chrome APIs that escape those handlers —
      // matches HEAD's defensive logging pattern.
      runner.start(task).catch((err) => console.error('[SW] runner.start failed:', err));
    },
    broadcastResumeForDrain: (records) => {
      for (const r of records) {
        console.warn('[SW] RESUME_FOR_DRAIN | taskId:', r.task.id, '| tabId:', r.tabId, '| origin:', r.origin);
        chrome.tabs.sendMessage(r.tabId, {
          type: 'RESUME_FOR_DRAIN',
          payload: { taskId: r.task.id },
        }).catch((err: Error) => {
          console.error('[SW] RESUME_FOR_DRAIN send failed | taskId:', r.task.id, '| err:', err.message);
        });
      }
    },
  });

  const persistence = createSessionPersistence({ scheduler });

  let signalrConfig: SignalRConfig | null = null;

  // PR6 — notification toggles. Hydrated from chrome.storage.local on SW
  // start; updated via SET_BATCH_SETTINGS messages from sidepanel.
  let notifyOnPause = true;
  let notifyOnBatchComplete = true;

  runner = createRemoteTaskRunner({
    scheduler,
    offscreen,
    badge,
    persistence,
    pauseState,
    getNotifyOnPause: () => notifyOnPause,
    getNotifyOnBatchComplete: () => notifyOnBatchComplete,
    setLastFocusedTabId: (id) => { lastFocusedTabId = id; },
    isDebugMode,
  });

  // Badge "!" while any task is paused. Cleared when the last paused task
  // resumes or completes. Badge background uses the warning token from
  // index.css (--warning #F57F17) so the chip is visually consistent.

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

  // PR6 — hydrate notification toggles from chrome.storage.local. Defaults
  // (true/true) apply if storage is empty.
  chrome.storage.local.get(['notifyOnPause', 'notifyOnBatchComplete']).then((data: Record<string, unknown>) => {
    if (typeof data.notifyOnPause === 'boolean') notifyOnPause = data.notifyOnPause;
    if (typeof data.notifyOnBatchComplete === 'boolean') notifyOnBatchComplete = data.notifyOnBatchComplete;
  }).catch(() => {});

  // One-shot cleanup of the pre-PR2 singular key. chrome.storage.session is
  // wiped on browser restart, so this only matters for an in-place extension
  // reload during the upgrade window. Safe to remove this line in PR3+.
  chrome.storage.session.remove('activeRemoteTask').catch(() => {});

  // Debug-mode flag (mirrors the toggle read by scrapingEngine.ts). Read
  // fresh at decision time inside runner.drainNext — caching it at SW
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

  // ── Message routing ──
  //
  // All message handlers live under src/background/messageRouter/. The
  // dispatcher composes them into one map and wires the addListener.
  registerMessageRouter({
    scheduler, offscreen, badge, pauseState, persistence, runner,
    frameRegistry, pendingContinuations,
    getSignalrConfig: () => signalrConfig,
    setSignalrConfig: (v) => { signalrConfig = v; },
    getNotifyOnPause: () => notifyOnPause,
    setNotifyOnPause: (v) => { notifyOnPause = v; },
    getNotifyOnBatchComplete: () => notifyOnBatchComplete,
    setNotifyOnBatchComplete: (v) => { notifyOnBatchComplete = v; },
    getLastFocusedTabId: () => lastFocusedTabId,
  });

  // ── Tab lifecycle ──

  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    const orphaned = scheduler.findByTabId(tabId);
    if (orphaned) {
      runner.relayHubInvocation('SEND_TASK_ERROR', {
        taskId: orphaned.task.id,
        configId: orphaned.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      runner.drainNext(orphaned.task.id, 'failed');
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
        // Pause-resilience: while pauseState is set, the user is still
        // working on the obstacle. The page may have navigated as part of that
        // (e.g. login submit redirect). HOLD the continuation in the map and
        // do NOT deliver — it will be drained by the sidepanel-resume handler
        // when the user clicks Continue.
        const ps = pauseState.get();
        if (ps) {
          console.warn('[SW] tabs.onUpdated — holding continuation (pause active) | tabId:', tabId, '| reason:', ps.reason);
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
          const taskRecord = scheduler.findByTabId(tabId);
          const drainResumedValue = taskRecord?.drainResumed ?? false;
          console.warn('[SW] tabs.onUpdated enriching | tabId:', tabId, '| recordFound:', !!taskRecord, '| recordTaskId:', taskRecord?.task.id, '| drainResumed:', drainResumedValue, '| schedulerActiveCount:', scheduler.getActiveCount());
          const enriched = {
            ...(continuation as Record<string, unknown>),
            drainResumed: drainResumedValue,
          };
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: enriched })
            .then(() => { console.warn('[SW] Continuation delivered to tabId:', tabId); })
            .catch((err: Error) => {
              console.warn('[SW] Continuation delivery failed for tabId:', tabId, '— re-registering for retry | err:', err.message);
              pendingContinuations.set(tabId, continuation);
            });
        }, 600);
      }
    }
  });

  // PR6 — notification click routing. Wrapped in try/catch because some
  // browsers may not have chrome.notifications even with the permission set.
  try {
    chrome.notifications.onClicked.addListener((id) => {
      if (isTaskNotification(id)) {
        const taskId = taskIdFromNotificationId(id);
        if (taskId) {
          const target = scheduler.getActiveTask(taskId);
          if (target) {
            chrome.windows.update(target.windowId, { focused: true, state: 'normal' })
              .catch((err: Error) => console.warn('[notifications] focus failed:', err.message));
          }
        }
        chrome.notifications.clear(id);
        return;
      }
      if (isBatchNotification(id)) {
        chrome.notifications.clear(id);
        return;
      }
    });
  } catch (err) {
    console.warn('[notifications] onClicked listener registration failed:', (err as Error).message);
  }
});
