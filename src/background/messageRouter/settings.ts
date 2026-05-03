import type { BackgroundContext, MessageHandler } from './types';

export function settingsHandlers(ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    SET_BATCH_SETTINGS: (message) => {
      const p = (message.payload ?? {}) as {
        drainParallelCap?: number;
        preflightQuietMs?: number;
        notifyOnPause?: boolean;
        notifyOnBatchComplete?: boolean;
      };
      if (typeof p.drainParallelCap === 'number') {
        ctx.scheduler.setDrainParallelCap(p.drainParallelCap);
        console.warn('[SW] batch settings | drainParallelCap:', p.drainParallelCap);
      }
      if (typeof p.preflightQuietMs === 'number') {
        chrome.storage.local.set({ batchPreflightQuietMs: p.preflightQuietMs }).catch(() => {});
      }
      if (typeof p.notifyOnPause === 'boolean') {
        ctx.setNotifyOnPause(p.notifyOnPause);
        chrome.storage.local.set({ notifyOnPause: p.notifyOnPause }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnPause:', p.notifyOnPause);
      }
      if (typeof p.notifyOnBatchComplete === 'boolean') {
        ctx.setNotifyOnBatchComplete(p.notifyOnBatchComplete);
        chrome.storage.local.set({ notifyOnBatchComplete: p.notifyOnBatchComplete }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnBatchComplete:', p.notifyOnBatchComplete);
      }
    },
  };
}
