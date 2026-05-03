import type { BackgroundContext, MessageHandler } from './types';

export function snapshotHandlers(ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    GET_PAUSE_STATE: (_message, _sender, sendResponse) => {
      // Property name `pauseState` shadows the local variable in the value
      // position — JS-legal, just looks like a self-reference.
      sendResponse({ pauseState: ctx.pauseState.get() });
    },

    GET_QUEUE_SNAPSHOT: (_message, _sender, sendResponse) => {
      sendResponse({
        active: ctx.runner.snapshotActive(),
        pending: [...ctx.scheduler.getPendingTasks()],
        recent: [...ctx.scheduler.getRecent()],
      });
      return true;
    },
  };
}
