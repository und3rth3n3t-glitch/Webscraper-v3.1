import type { Scheduler } from './scheduler';

export type SessionPersistence = {
  persistActive(): void;
  persistRecent(): void;
};

export function createSessionPersistence(deps: { scheduler: Scheduler }): SessionPersistence {
  function persistActive(): void {
    chrome.storage.session.set({ activeRemoteTasks: deps.scheduler.serializeActive() }).catch(() => {});
  }

  function persistRecent(): void {
    chrome.storage.session.set({ recentRemoteTasks: deps.scheduler.getRecent() }).catch(() => {});
  }

  return { persistActive, persistRecent };
}
