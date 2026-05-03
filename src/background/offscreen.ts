import { browser } from 'wxt/browser';

// Same shape used by INIT_SIGNALR message payload. Defined here so background.ts
// can import the type from a single source — owner module of the offscreen doc
// is the right home for this since it's the only thing that re-broadcasts INIT_SIGNALR.
export type SignalRConfig = { serverUrl: string; clientId: string; version: string };

export type OffscreenManager = {
  /** Idempotent: creates the offscreen document if needed. Re-broadcasts INIT_SIGNALR
   *  with the latest stored config once the doc is ready, so a SW-killed-mid-scrape
   *  scenario reconnects without sidepanel involvement. */
  ensure(): Promise<void>;
  /** Resolves when the offscreen doc has signalled OFFSCREEN_READY (or immediately
   *  if it's already ready). */
  waitForReady(): Promise<void>;
  /** Called by the OFFSCREEN_READY message handler to flip the flag and drain
   *  any queued resolvers. Idempotent. */
  markReady(): void;
};

export function createOffscreenManager(deps: {
  getSignalrConfig: () => SignalRConfig | null;
}): OffscreenManager {
  let offscreenCreated = false;
  let offscreenReady = false;
  const offscreenReadyResolvers: Array<() => void> = [];

  function waitForReady(): Promise<void> {
    if (offscreenReady) return Promise.resolve();
    return new Promise(resolve => offscreenReadyResolvers.push(resolve));
  }

  function markReady(): void {
    offscreenReady = true;
    offscreenReadyResolvers.splice(0).forEach(r => r());
  }

  async function ensure(): Promise<void> {
    if (offscreenCreated) return;
    const offscreen = (chrome as unknown as { offscreen?: {
      hasDocument: () => Promise<boolean>;
      createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
      Reason: Record<string, string>;
    } }).offscreen;
    if (!offscreen) return; // Firefox: no offscreen support
    const hasDoc = await offscreen.hasDocument();
    if (!hasDoc) {
      await offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: [offscreen.Reason.BLOBS],
        justification: 'Maintain SignalR WebSocket connection for task queue',
      });
      // After OFFSCREEN_READY fires, auto-reinitialize SignalR if we have stored config.
      // This handles the case where the SW was killed mid-scrape and the offscreen doc
      // was also killed — we need to reconnect before flow events can be relayed.
      const signalrConfig = deps.getSignalrConfig();
      if (signalrConfig) {
        waitForReady().then(() => {
          browser.runtime.sendMessage({
            type: 'INIT_SIGNALR',
            payload: signalrConfig,
            _fromSW: true,
          }).catch(() => {});
        }).catch(() => {});
      }
    } else {
      // SW restarted but offscreen persists — listener is already registered
      markReady();
    }
    offscreenCreated = true;
  }

  return { ensure, waitForReady, markReady };
}
