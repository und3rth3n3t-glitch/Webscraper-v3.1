import type { DetectionTrigger } from '../types/messages';

// Owns the singleton "is the active task currently paused?" record. Used by
// (a) the GET_PAUSE_STATE handshake from the sidepanel, (b) the continuation
// hold check in tabs.onUpdated, (c) sidepanel-only-mode runs that bypass the
// scheduler, and (d) the remote-task runner. Lives in its own module because
// it's read/written from both inside and outside the runner cluster — burying
// it in either side would create awkward back-references.

export type ActivePauseState = {
  reason: 'cloudflare' | 'awaitUserAction';
  message?: string;
  trigger?: DetectionTrigger;
  domain?: string;
} | null;

export type PauseStateManager = {
  /** Returns the current state — null when no task is paused. */
  get(): ActivePauseState;
  /** Replaces state with a new pause record. */
  set(state: NonNullable<ActivePauseState>): void;
  /** Clears state to null. */
  clear(): void;
};

export function createPauseStateManager(): PauseStateManager {
  let state: ActivePauseState = null;
  return {
    get: () => state,
    set: (s) => { state = s; },
    clear: () => { state = null; },
  };
}
