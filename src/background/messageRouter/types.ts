import type { Scheduler } from '../scheduler';
import type { OffscreenManager, SignalRConfig } from '../offscreen';
import type { BadgeManager } from '../badge';
import type { PauseStateManager } from '../pauseState';
import type { SessionPersistence } from '../sessionPersistence';
import type { RemoteTaskRunner } from '../remoteTaskRunner';

/** Direct-match handler signature. Sync handlers return void; async sendResponse
 *  handlers return true to keep the message channel open (Chrome runtime contract). */
export type MessageHandler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

/** Everything a handler may need from the SW lifetime. Manager objects are
 *  constructed once at SW boot; mutable lets are exposed via getter/setter
 *  pairs so handlers see live values, not snapshots taken at handler-build time. */
export interface BackgroundContext {
  // Manager objects (factory-built at SW boot)
  scheduler: Scheduler;
  offscreen: OffscreenManager;
  badge: BadgeManager;
  pauseState: PauseStateManager;
  persistence: SessionPersistence;
  runner: RemoteTaskRunner;

  // Maps (mutated in place)
  frameRegistry: Map<number, Map<number, { url: string; isTop: boolean }>>;
  pendingContinuations: Map<number, unknown>;

  // Mutable lets exposed via getter/setter pairs
  getSignalrConfig(): SignalRConfig | null;
  setSignalrConfig(v: SignalRConfig | null): void;

  getNotifyOnPause(): boolean;
  setNotifyOnPause(v: boolean): void;

  getNotifyOnBatchComplete(): boolean;
  setNotifyOnBatchComplete(v: boolean): void;

  /** Read-only — lastFocusedTabId is set by tabs.onActivated and runner.start; only read by handlers. */
  getLastFocusedTabId(): number | null;
}
