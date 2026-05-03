import { browser } from 'wxt/browser';
import { dbg } from '../utils/debugLog';
import { mergeProgress } from '../utils/queueProgress';
import type { QueueTask } from '../types/signalr';
import type { DetectionTrigger } from '../types/messages';
import { getAllConfigs, saveConfig } from '../sidepanel/utils/storage';
import { resolveQueueTask, ConfigNotFoundError } from './remoteTaskHandler';
import {
  mapFlowProgress, mapFlowComplete, mapFlowError, mapFlowPaused,
  type ActiveTaskContext, type FlowProgressPayload, type FlowCompletePayload,
  type FlowErrorPayload, type FlowPausedPayload,
} from './flowEventToHubPayload';
import { originOf } from './originOf';
import {
  attachIfNeeded as cdpAttach,
  detach as cdpDetach,
} from './cdpInput';
import {
  notifyTaskPaused,
  notifyBatchComplete,
  taskNotificationId,
} from './notifications';
import type { Scheduler } from './scheduler';
import type { OffscreenManager } from './offscreen';
import type { BadgeManager } from './badge';
import type { SessionPersistence } from './sessionPersistence';
import type { PauseStateManager } from './pauseState';

export type RemoteTaskRunner = {
  /** Snapshot the currently-active task with derived status (for sidepanel handshake). */
  snapshotActive(): QueueTask | null;
  /** Start a queue task (called by Scheduler.startTask config callback). */
  start(task: QueueTask): Promise<void>;
  /** Mark a task as drained (success or failure), close its window, fire batch-complete if applicable. */
  drainNext(taskId: string, completedStatus?: 'completed' | 'failed'): void;
  /** Process a FLOW_* event from the content script. */
  handleFlowEvent(type: string, payload: Record<string, unknown>): void;
  /** Relay a SEND_TASK_* invocation to the offscreen-doc SignalR connection. */
  relayHubInvocation(type: string, payload: unknown): void;
};

export function createRemoteTaskRunner(deps: {
  scheduler: Scheduler;
  offscreen: OffscreenManager;
  badge: BadgeManager;
  persistence: SessionPersistence;
  pauseState: PauseStateManager;
  getNotifyOnPause: () => boolean;
  getNotifyOnBatchComplete: () => boolean;
  setLastFocusedTabId: (id: number | null) => void;
  isDebugMode: () => Promise<boolean>;
}): RemoteTaskRunner {
  // PR6 — accumulated stats for the current batch. Reset on transition to
  // idle (after firing the batch-complete notification). Counts FLOW_COMPLETE
  // as succeeded; FLOW_ERROR and tab-closed-mid-task as failed.
  const batchStats = { total: 0, succeeded: 0, failed: 0 };

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
      await deps.offscreen.ensure();
      await deps.offscreen.waitForReady();
      dbg('[SW] relayHubInvocation sending:', type);
      const resp = await browser.runtime.sendMessage({ type, payload, _fromSW: true });
      dbg('[SW] relayHubInvocation sent ok:', type);
    };
    send().catch((err) => console.error('[SW] Failed to relay hub invocation:', type, err));
  }

  function snapshotActive(): QueueTask | null {
    const r = deps.scheduler.getFirstActive();
    if (!r) return null;
    const ps = deps.pauseState.get();
    return {
      ...r.task,
      status: ps ? 'paused' : 'running',
      pausedReason: ps?.reason,
      progress: r.lastProgress,
    };
  }

  async function start(task: QueueTask): Promise<void> {
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
      deps.scheduler.recordStartFailed(task.id);
      return;
    }

    // Cascade: each new task window opens at a 40px staircase offset so
    // no window is ever fully occluded by another. Chrome's occlusion
    // detection freezes tabs that are 100% covered for a few seconds;
    // a sliver of visible pixels is enough to keep them running.
    const offset = deps.scheduler.getActiveCount() * 40;
    const win = await browser.windows.create({
      url: resolved.config.url,
      focused: true,
      left: 100 + offset,
      top: 50 + offset,
      width: 1280,
      height: 800,
    });
    const tab = win?.tabs?.[0];
    if (!tab?.id || !win?.id) {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: task.id,
        configId: task.configId,
        error: "Couldn't open a window for the task",
        failedAt: new Date().toISOString(),
      });
      deps.scheduler.recordStartFailed(task.id);
      return;
    }

    // Register early so tabs.onRemoved during page load can identify the task.
    deps.scheduler.recordStarted(task.id, task, {
      tabId: tab.id,
      windowId: win.id,
      origin: originOf(resolved.config.url),
      resolvedDataMapping: resolved.config.dataMapping,
    });
    deps.persistence.persistActive();
    deps.setLastFocusedTabId(tab.id);

    // CDP attach (best-effort; falls through to synthetic if pref off
    // or permission missing). Detached on FLOW_PAUSED + flow end.
    await cdpAttach(tab.id).catch((err: Error) => {
      console.warn('[SW] cdpAttach failed (synthetic fallback):', err.message);
    });

    await waitForTabComplete(tab.id);

    console.warn('[SW] Sending initial EXECUTE_FLOW | taskId:', resolved.taskId, '| searchTerms:', resolved.searchTerms);
    browser.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_FLOW',
      payload: {
        config: resolved.config,
        searchTerms: resolved.searchTerms,
        inputRows: resolved.inputRows,
        taskId: resolved.taskId,
        drainResumed: false, // initial send — task just started
      },
    }).catch((err: Error) => {
      relayHubInvocation('SEND_TASK_ERROR', {
        taskId: resolved.taskId,
        configId: resolved.configId,
        error: `Couldn't dispatch task to page: ${err.message}`,
        failedAt: new Date().toISOString(),
      });
      drainNext(resolved.taskId, 'failed');
    });
  }

  // PR2: now requires the taskId — we no longer have a hidden singleton to drain.
  // Callers that previously called drainNext() with no args (catastrophic
  // failures during start) now use scheduler.recordStartFailed instead, since at
  // start-time there is no scheduler record yet to remove.
  function drainNext(taskId: string, completedStatus: 'completed' | 'failed' = 'failed'): void {
    deps.pauseState.clear();
    // Symmetric cleanup: a task that ends (completed, failed, or window
    // closed) cannot be in a paused state any more.
    deps.badge.markUnpaused(taskId);
    chrome.notifications.clear(taskNotificationId(taskId)).catch(() => {});
    // PR6-fix — capture the scheduler phase BEFORE endTask runs (which may
    // transition us to idle). The previous prevSchedulerPhase tracker
    // started at 'idle' and never saw the intermediate preflight/drain
    // states, so the batch-complete check always failed.
    const phaseBefore = deps.scheduler.getPhase();
    const closing = deps.scheduler.endTask(taskId);
    if (!closing) {
      // No record — nothing to clean up. tryStartNext is already a no-op when
      // active < cap and pending is empty, so we don't need to call it here.
      return;
    }
    cdpDetach(closing.tabId).catch(() => { /* best effort */ });
    deps.scheduler.pushRecent({ ...closing.task, status: completedStatus, pausedReason: undefined });
    deps.persistence.persistActive();
    deps.persistence.persistRecent();

    // PR6 — accumulate batch stats for the eventual batch-complete notification.
    batchStats.total++;
    if (completedStatus === 'completed') batchStats.succeeded++;
    else batchStats.failed++;

    // PR6 — detect batch-complete: this endTask transitioned us out of
    // active work (any non-idle phase → idle). Fire notification + reset.
    const phaseAfter = deps.scheduler.getPhase();
    if (phaseAfter === 'idle' && phaseBefore !== 'idle' && batchStats.total > 0) {
      console.warn('[SW] batch complete | stats:', batchStats, '| notifyOnBatchComplete:', deps.getNotifyOnBatchComplete());
      if (deps.getNotifyOnBatchComplete()) {
        notifyBatchComplete({ ...batchStats });
      }
      batchStats.total = 0;
      batchStats.succeeded = 0;
      batchStats.failed = 0;
    }

    const closingWindowId = closing.windowId;
    const closingTaskId = closing.task.id;
    deps.isDebugMode().then((debug) => {
      if (debug) {
        console.warn('[SW] DEBUG mode — leaving task window open | windowId:', closingWindowId, '| taskId:', closingTaskId);
      } else {
        browser.windows.remove(closingWindowId).catch(() => {});
      }
    }).catch(() => {
      browser.windows.remove(closingWindowId).catch(() => {});
    });
  }

  function handleFlowEvent(type: string, payload: Record<string, unknown>): void {
    const taskId = payload?.taskId as string | undefined;
    if (!taskId) {
      // Sidepanel-mode runs (no taskId) — handled elsewhere or not relevant
      // to the queue path. Silently ignore.
      return;
    }
    const record = deps.scheduler.getActiveTask(taskId);
    if (!record) {
      console.warn('[SW] handleFlowEvent: no record for taskId', taskId, 'dropping', type);
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
          deps.scheduler.setProgress(taskId, merged);
          deps.persistence.persistActive();
        }
        return;
      }
      case 'FLOW_COMPLETE': {
        const fp = payload as unknown as FlowCompletePayload;
        console.warn('[SW] FLOW_COMPLETE | taskId:', record.task.id, '| aborted:', fp.result?.aborted, '| iterations:', fp.result?.iterations?.length, '| totalTimeMs:', fp.result?.totalTimeMs);
        const hubPayload = mapFlowComplete(ctx, fp);
        relayHubInvocation('SEND_TASK_COMPLETE', hubPayload);
        drainNext(taskId, 'completed');
        return;
      }
      case 'FLOW_ERROR': {
        const fe = payload as unknown as FlowErrorPayload;
        console.warn('[SW] FLOW_ERROR | taskId:', record.task.id, '| error:', fe.error);
        const hubPayload = mapFlowError(ctx, fe);
        relayHubInvocation('SEND_TASK_ERROR', hubPayload);
        drainNext(taskId, 'failed');
        return;
      }
      case 'FLOW_PAUSED': {
        const flowPayload = payload as { reason?: string; message?: string; trigger?: DetectionTrigger; domain?: string };
        console.warn('[SW] FLOW_PAUSED | taskId:', record.task.id, '| reason:', flowPayload.reason, '| message:', flowPayload.message, '| trigger:', flowPayload.trigger, '| domain:', flowPayload.domain);
        if (flowPayload.reason !== 'cloudflare' && flowPayload.reason !== 'awaitUserAction') return;
        deps.pauseState.set({
          reason: flowPayload.reason as 'cloudflare' | 'awaitUserAction',
          message: flowPayload.message,
          trigger: flowPayload.trigger,
          domain: flowPayload.domain,
        });
        // Detach CDP during user-solves-the-challenge phase so the page's
        // iframe (e.g. Cloudflare) doesn't fingerprint our debugger while
        // the user is genuinely solving. Re-attached on RESUME_AFTER_PAUSE.
        cdpDetach(record.tabId).catch(() => { /* best effort */ });
        const hubPayload = mapFlowPaused(ctx, payload as unknown as FlowPausedPayload);
        relayHubInvocation('SEND_TASK_PAUSED', hubPayload);

        // Badge "!" + taskbar attention as persistent / OS-level signals.
        // Survive notification suppression (Focus Assist) and unfocused
        // task windows.
        deps.badge.markPaused(record.task.id);
        chrome.windows.update(record.windowId, { drawAttention: true }).catch(() => {});

        // Fire a Chrome notification when:
        //   - notifyOnPause toggle is on
        //   - the focused window is NOT this task's window
        // (Previously also gated on phase === 'drain'; relaxed because new
        // task windows open `focused: true` then immediately lose focus to
        // the next window in a parallel batch — preflight pauses on
        // already-backgrounded windows now notify correctly.)
        if (deps.getNotifyOnPause()) {
          const target = record;
          chrome.windows.getLastFocused().then((focusedWindow) => {
            if (!focusedWindow || focusedWindow.id !== target.windowId) {
              const msg = flowPayload.message ?? 'Action needed in your browser.';
              notifyTaskPaused(target, msg);
            }
          }).catch(() => { /* getLastFocused failed — skip notification */ });
        }
        return;
      }
    }
  }

  return { snapshotActive, start, drainNext, handleFlowEvent, relayHubInvocation };
}
