import { ScraperHubConnection } from './signalrConnection';
import type { SwToOffscreenMessage } from '../types/messages';

const hub = new ScraperHubConnection();

browser.runtime.onMessage.addListener(
  (rawMessage: unknown, _sender, sendResponse) => {
    const message = rawMessage as SwToOffscreenMessage;
    switch (message.type) {
      case 'INIT_SIGNALR': {
        const { serverUrl, token, clientId } = message.payload;
        hub
          .connect(serverUrl, token, clientId)
          .then(() => sendResponse({ ok: true }))
          .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
        return true as const;
      }

      case 'SEND_TASK_PROGRESS':
        hub.invoke('TaskProgress', message.payload).catch(console.error);
        return true as const;

      case 'SEND_TASK_COMPLETE':
        hub.invoke('TaskComplete', message.payload).catch(console.error);
        return true as const;

      case 'SEND_TASK_ERROR':
        hub.invoke('TaskError', message.payload).catch(console.error);
        return true as const;

      case 'SEND_TASK_PAUSED':
        hub.invoke('TaskPaused', message.payload).catch(console.error);
        return true as const;

      case 'GET_CONNECTION_STATUS':
        sendResponse({ connected: hub.isConnected() });
        return true as const;
    }
  },
);
