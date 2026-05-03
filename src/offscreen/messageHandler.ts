import { ScraperHubConnection } from './signalrConnection';
import type { SwToOffscreenMessage } from '../types/messages';
import { dbg, ensureDebugInit } from '../utils/debugLog';
import { HubServerMethods } from './hubMethodNames';

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
        const { serverUrl, clientId, version } = message.payload;
        hub
          .connect(serverUrl, clientId, version)
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
        // Progress is high-frequency, fire-and-forget is acceptable.
        hub.invoke(HubServerMethods.TaskProgress, message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'SEND_TASK_COMPLETE':
        // AWAIT the invoke. The SW relays this then immediately closes the scrape window
        // (drainNextRemoteTask), which can drop the SignalR connection. If we ack the SW
        // BEFORE the invoke flushes, the backend's HandleDisconnectAsync sees an in-flight
        // RunItem and force-marks it Failed before TaskComplete arrives. Awaiting forces
        // the SW to wait until the message is actually on the wire (and the server has
        // ack'd) before tearing down the window.
        hub.invoke(HubServerMethods.TaskComplete, message.payload)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => { console.error(err); sendResponse({ ok: false, error: err.message }); });
        return true as const;

      case 'SEND_TASK_ERROR':
        // Same race as TaskComplete — await before acking.
        hub.invoke(HubServerMethods.TaskError, message.payload)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => { console.error(err); sendResponse({ ok: false, error: err.message }); });
        return true as const;

      case 'SEND_TASK_PAUSED':
        hub.invoke(HubServerMethods.TaskPaused, message.payload).catch(console.error);
        sendResponse({ ok: true });
        return;

      case 'GET_CONNECTION_STATUS':
        sendResponse({ status: hub.getStatus() });
        return;
    }
  },
);
