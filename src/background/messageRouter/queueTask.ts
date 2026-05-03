import { browser } from 'wxt/browser';
import type { QueueTask } from '../../types/signalr';
import { getAllConfigs } from '../../sidepanel/utils/storage';
import { originOf } from '../originOf';
import { taskNotificationId } from '../notifications';
import type { BackgroundContext, MessageHandler } from './types';

export function queueTaskHandlers(ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    // Inbound queue task: start or queue it.
    TASK_RECEIVED: (message) => {
      const task = message.payload as QueueTask;
      // Resolve origin async so the same-origin gate has data to work with
      // during drain. Tasks without a resolvable URL get null origin and
      // are treated as ungated.
      void (async () => {
        let origin: string | null = null;
        try {
          if (task.inlineConfig?.url) {
            origin = originOf(task.inlineConfig.url);
          } else {
            const localConfigs = await getAllConfigs();
            const cfg = localConfigs.find((c) => c.id === task.configId);
            if (cfg?.url) origin = originOf(cfg.url);
          }
        } catch {
          // resolution failure → null origin, no gate
        }
        ctx.scheduler.enqueueTask(task, origin);
      })();
    },

    // Server-initiated task control (handled directly — no sidepanel required).
    RESUME_TASK: (message) => {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? ctx.scheduler.getActiveTask(taskId) : ctx.scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_PAUSE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_PAUSE failed:', err));
        ctx.pauseState.clear();
        ctx.badge.markUnpaused(target.task.id);
        chrome.notifications.clear(taskNotificationId(target.task.id)).catch(() => {});
        chrome.runtime.sendMessage({ type: 'TASK_RESUMED', payload: { taskId: target.task.id } }).catch(() => {});
      }
    },

    CANCEL_TASK: (message) => {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? ctx.scheduler.getActiveTask(taskId) : ctx.scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      } else if (taskId) {
        // May still be in pending — drop it without starting.
        ctx.scheduler.cancelPending(taskId);
      }
    },
  };
}
