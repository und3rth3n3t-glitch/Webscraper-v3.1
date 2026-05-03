import { browser } from 'wxt/browser';
import { dbg } from '../../utils/debugLog';
import type { SignalRConfig } from '../offscreen';
import type { BackgroundContext } from './types';

/** Returns a dispatch function. The function checks each of the four allowlists
 *  in order; if a relay matches, it runs that relay's full body (including any
 *  side-effects like mutating signalrConfig or calling runner.handleFlowEvent)
 *  and returns true (or true-as-const for sidepanelToContent's async-with-sendResponse).
 *  If no relay matches, returns void — dispatcher's listener implicitly returns
 *  undefined and the runtime closes the message channel. */
export function makeRelays(ctx: BackgroundContext) {
  return (
    message: Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
    type: string,
  ): boolean | void => {
    // ── Offscreen → Sidepanel relay ──

    const offscreenToSidepanel = [
      'CONNECTION_READY', 'CONNECTION_LOST', 'CONNECTION_STATUS',
    ];
    if (offscreenToSidepanel.includes(type)) {
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      return;
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
        const cfg = message.payload as SignalRConfig;
        ctx.setSignalrConfig(cfg);
        chrome.storage.session.set({ signalrConfig: cfg }).catch(() => {});
      }
      if (type === 'STOP_SIGNALR') {
        ctx.setSignalrConfig(null);
        chrome.storage.session.remove('signalrConfig').catch(() => {});
      }
      const relay = async () => {
        await ctx.offscreen.ensure();
        await ctx.offscreen.waitForReady();
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
        if (p.taskId) {
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseBefore:', ctx.scheduler.getPhase());
          ctx.scheduler.markPreflightReady(p.taskId);
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseAfter:', ctx.scheduler.getPhase());
        } else {
          console.warn('[SW] FLOW_PREFLIGHT_READY ignored — no taskId');
        }
      }
      if (type === 'FLOW_RESUMED') {
        console.warn('[SW] FLOW_RESUMED relayed | activeTaskId:', ctx.scheduler.getFirstActive()?.task.id);
      }
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });

      // Mirror pause state for sidepanel-only runs. runner.handleFlowEvent
      // below also sets it but only when there is an active queue-mode
      // record. Both paths converge on the same pauseState manager.
      if (type === 'FLOW_PAUSED') {
        const fp = (message.payload ?? {}) as { reason?: string; message?: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string };
        if (fp.reason === 'cloudflare' || fp.reason === 'awaitUserAction') {
          ctx.pauseState.set({
            reason: fp.reason as 'cloudflare' | 'awaitUserAction',
            message: fp.message,
            trigger: fp.trigger,
            domain: fp.domain,
          });
        }
      }
      if (type === 'FLOW_RESUMED') {
        ctx.pauseState.clear();
      }

      ctx.runner.handleFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return;
    }

    // ── Sidepanel → Content routing ──

    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_PAUSE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
    if (sidepanelToContent.includes(type)) {
      const frameId = message.frameId as number | undefined;
      const targetTabId = ctx.getLastFocusedTabId();

      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = (type === 'EXECUTE_FLOW' && targetTabId) ? targetTabId : activeTab?.id;
        if (!tabId) {
          sendResponse({ error: 'No active tab' });
          return;
        }

        if (type === 'START_PICKER') {
          const frames = ctx.frameRegistry.get(tabId);
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
  };
}
