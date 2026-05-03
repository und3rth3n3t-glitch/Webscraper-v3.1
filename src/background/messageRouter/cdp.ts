import {
  dispatchClick as cdpDispatchClick,
  dispatchMouseMove as cdpDispatchMouseMove,
  dispatchType as cdpDispatchType,
  dispatchPressKey as cdpDispatchPressKey,
} from '../cdpInput';
import type { BackgroundContext, MessageHandler } from './types';

export function cdpHandlers(_ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    CDP_CLICK: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; x: number; y: number };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: 'no-tabId' });
        return true;
      }
      cdpDispatchClick(tabId, p.x, p.y)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_MOUSE_MOVE: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; x: number; y: number };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: 'no-tabId' });
        return true;
      }
      cdpDispatchMouseMove(tabId, p.x, p.y)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_TYPE: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; text: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.text) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchType(tabId, p.text)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_PRESS_KEY: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; key: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.key) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchPressKey(tabId, p.key)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },
  };
}
