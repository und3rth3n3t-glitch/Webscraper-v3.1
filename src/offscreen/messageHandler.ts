import { ScraperHubConnection } from './signalrConnection';
import type { SwToOffscreenMessage } from '../types/messages';
import { dbg, ensureDebugInit } from '../utils/debugLog';

const hub = new ScraperHubConnection();
ensureDebugInit();

// Notify the SW that this context is ready to receive messages.
browser.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

browser.runtime.onMessage.addListener(
  (rawMessage: unknown, _sender, sendResponse) => {
    const message = rawMessage as SwToOffscreenMessage & { _fromSW?: boolean };
    dbg('[Offscreen] Got message', message.type, 'fromSW=', !!message._fromSW);
    // Ignore direct broadcasts from the sidepanel — only process messages
    // tagged by the SW relay to avoid double hub.connect() from the broadcast.
    if (!message._fromSW) return;
    switch (message.type) {
      case 'INIT_SIGNALR': {
        const { serverUrl, token, clientId, version } = message.payload;
        hub
          .connect(serverUrl, token, clientId, version)
          .then(() => sendResponse({ ok: true }))
          .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
        return true as const;
      }

      case 'STOP_SIGNALR': {
        hub
          .disconnect()
          .then(() => sendResponse({ ok: true }))
          .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
        return true as const;
      }

      case 'SEND_TASK_PROGRESS':
        hub.invoke('TaskProgress', message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'SEND_TASK_COMPLETE':
        hub.invoke('TaskComplete', message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'SEND_TASK_ERROR':
        hub.invoke('TaskError', message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'SEND_TASK_PAUSED':
        hub.invoke('TaskPaused', message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'GET_CONNECTION_STATUS':
        sendResponse({ status: hub.getStatus() });
        return;
    }
  },
);
