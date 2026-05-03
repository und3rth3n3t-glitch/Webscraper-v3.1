import type { BackgroundContext, MessageHandler } from './types';

export function lifecycleHandlers(ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    OFFSCREEN_READY: () => {
      ctx.offscreen.markReady();
    },

    __SW_LOG__: (message) => {
      console.warn('[page]', message.payload);
    },

    REGISTER_CONTINUATION: (message, sender) => {
      const tabId = sender.tab?.id;
      if (tabId) {
        const p = message.payload as Record<string, unknown>;
        console.warn('[SW] REGISTER_CONTINUATION tabId:', tabId, '| startTermIndex:', p.startTermIndex, '| startLoopStepIndex:', p.startLoopStepIndex, '| searchTerms:', p.searchTerms);
        ctx.pendingContinuations.set(tabId, message.payload);
      }
    },

    CANCEL_CONTINUATION: (_message, sender) => {
      const tabId = sender.tab?.id;
      if (tabId) {
        const had = ctx.pendingContinuations.has(tabId);
        ctx.pendingContinuations.delete(tabId);
        console.warn('[SW] CANCEL_CONTINUATION | tabId:', tabId, '| hadEntry:', had);
      } else {
        console.warn('[SW] CANCEL_CONTINUATION received with no sender.tab.id');
      }
    },

    // Frame registration.
    FRAME_REGISTER: (_message, sender) => {
      const cs = sender;
      const tabId = cs.tab?.id;
      if (!tabId) return;
      if (!ctx.frameRegistry.has(tabId)) ctx.frameRegistry.set(tabId, new Map());
      ctx.frameRegistry.get(tabId)!.set(cs.frameId ?? 0, {
        url: cs.url ?? '',
        isTop: (cs.frameId ?? 0) === 0,
      });
    },
  };
}
