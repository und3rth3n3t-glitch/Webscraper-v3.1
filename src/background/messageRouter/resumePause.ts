import { browser } from 'wxt/browser';
import { attachIfNeeded as cdpAttach } from '../cdpInput';
import { taskNotificationId } from '../notifications';
import type { BackgroundContext } from './types';

/** RESUME_AFTER_PAUSE handler: runs pre-relay work (clear pause state, drain held
 *  continuations, route to specific task tab when a taskId matches an active record),
 *  THEN intentionally returns control to the dispatcher so the sidepanelToContent
 *  allowlist can also relay the message to whatever live content script is listening
 *  on the active tab. The dispatcher is responsible for invoking this BEFORE its
 *  directHandlers/relays sequence. */
export function makeResumeAfterPauseHandler(ctx: BackgroundContext) {
  return (message: Record<string, unknown>): void => {
    const ps = ctx.pauseState.get();
    const wasPaused = ps !== null;
    const resumePayload = (message.payload ?? {}) as { taskId?: string; markAsFalseAlarm?: boolean };

    // Capture false-alarm signal BEFORE clearing pauseState.
    // Cloudflare cannot be marked as false alarm (UI doesn't expose the button).
    if (
      resumePayload.markAsFalseAlarm
      && ps?.reason === 'awaitUserAction'
      && ps?.trigger
      && ps?.domain
    ) {
      const { domain, trigger } = ps;
      // Async fire-and-forget; don't block the resume on storage write.
      import('../../sidepanel/utils/detectionMemory').then(({ addIgnoredTrigger }) => {
        addIgnoredTrigger(domain, trigger).catch((err) => {
          console.error('[SW] addIgnoredTrigger failed:', err);
        });
        console.warn('[SW] markAsFalseAlarm recorded | domain:', domain, '| trigger:', trigger);
      });
    }

    ctx.pauseState.clear();
    // Clear pause UI signals: drop this taskId from the paused set, refresh
    // badge (clears if no other pauses), and clear any pending notification
    // for this task. Safe to call when no notification was fired — clear()
    // is idempotent.
    if (resumePayload.taskId) {
      ctx.badge.markUnpaused(resumePayload.taskId);
      chrome.notifications.clear(taskNotificationId(resumePayload.taskId)).catch(() => {});
      // Notify the sidepanel so it clears the ribbon regardless of which
      // surface (in-page banner or sidepanel button) triggered the resume.
      chrome.runtime.sendMessage({ type: 'TASK_RESUMED', payload: { taskId: resumePayload.taskId } }).catch(() => {});
    }
    console.warn('[SW] sidepanel resume | type: RESUME_AFTER_PAUSE | taskId:', resumePayload.taskId, '| wasPaused:', wasPaused, '| markAsFalseAlarm:', resumePayload.markAsFalseAlarm);

    // PR5 — per-task routing. If a taskId is present, route to that task's
    // tab directly (bypasses active-tab assumption, supports multiple
    // simultaneously paused tasks). Falls through to active-tab routing
    // when taskId is absent (sidepanel-mode runs without a queue task).
    if (resumePayload.taskId) {
      const target = ctx.scheduler.getActiveTask(resumePayload.taskId);
      if (target) {
        browser.tabs.sendMessage(target.tabId, {
          type: 'RESUME_AFTER_PAUSE',
          payload: resumePayload,
        }).catch((err: Error) => console.warn('[SW] per-task resume sendMessage failed:', err.message));

        cdpAttach(target.tabId).catch(() => { /* best effort */ });

        // Drain any held continuation for that specific tab (pause-driven nav).
        const continuation = ctx.pendingContinuations.get(target.tabId);
        if (continuation) {
          ctx.pendingContinuations.delete(target.tabId);
          console.warn('[SW] resume — draining held continuation | tabId:', target.tabId);
          setTimeout(() => {
            const enriched = {
              ...(continuation as Record<string, unknown>),
              drainResumed: ctx.scheduler.findByTabId(target.tabId)?.drainResumed ?? false,
            };
            browser.tabs.sendMessage(target.tabId, { type: 'EXECUTE_FLOW', payload: enriched })
              .then(() => console.warn('[SW] held continuation delivered | tabId:', target.tabId))
              .catch((err: Error) => {
                console.warn('[SW] held continuation delivery failed | tabId:', target.tabId, '— re-registering | err:', err.message);
                ctx.pendingContinuations.set(target.tabId, continuation);
              });
          }, 300);
        }
        return; // handled — do not fall through to active-tab routing
      }
      console.warn('[SW] RESUME_AFTER_PAUSE — no active task for taskId:', resumePayload.taskId);
      // No matching task — fall through to active-tab routing as a fallback.
    }

    // Legacy / sidepanel-mode path: route to active tab.
    browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
      const tabId = activeTab?.id;
      if (!tabId) return;
      const continuation = ctx.pendingContinuations.get(tabId);
      if (continuation) {
        ctx.pendingContinuations.delete(tabId);
        console.warn('[SW] resume — draining held continuation | tabId:', tabId);
        setTimeout(() => {
          const enriched = {
            ...(continuation as Record<string, unknown>),
            drainResumed: ctx.scheduler.findByTabId(tabId)?.drainResumed ?? false,
          };
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: enriched })
            .then(() => console.warn('[SW] held continuation delivered | tabId:', tabId))
            .catch((err: Error) => {
              console.warn('[SW] held continuation delivery failed | tabId:', tabId, '— re-registering | err:', err.message);
              ctx.pendingContinuations.set(tabId, continuation);
            });
        }, 300);
      }
    }).catch(() => { /* ignore */ });
    // Fall through to sidepanelToContent routing for the live content script.
  };
}
