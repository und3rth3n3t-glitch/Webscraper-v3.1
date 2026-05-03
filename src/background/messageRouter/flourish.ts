import type { BackgroundContext, MessageHandler } from './types';

export function flourishHandlers(_ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    // Fetch Flourish data (needs SW fetch origin).
    FETCH_FLOURISH_DATA: (message, _sender, sendResponse) => {
      const payload = message.payload as { visualizationId?: string } | undefined;
      const vizId = payload?.visualizationId;
      if (!vizId || !/^\d+$/.test(vizId)) {
        sendResponse({ error: 'Invalid visualization ID' });
        return true;
      }
      fetch(`https://public.flourish.studio/visualisation/${vizId}/visualisation.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => sendResponse({ data }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    },
  };
}
