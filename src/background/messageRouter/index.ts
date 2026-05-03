import { browser } from 'wxt/browser';
import type { BackgroundContext } from './types';
import { authHandlers } from './auth';
import { queueTaskHandlers } from './queueTask';
import { snapshotHandlers } from './snapshot';
import { settingsHandlers } from './settings';
import { cdpHandlers } from './cdp';
import { lifecycleHandlers } from './lifecycle';
import { flourishHandlers } from './flourish';
import { makeResumeAfterPauseHandler } from './resumePause';
import { makeRelays } from './relays';

export function registerMessageRouter(ctx: BackgroundContext): void {
  const directHandlers = {
    ...authHandlers(ctx),
    ...queueTaskHandlers(ctx),
    ...snapshotHandlers(ctx),
    ...settingsHandlers(ctx),
    ...cdpHandlers(ctx),
    ...lifecycleHandlers(ctx),
    ...flourishHandlers(ctx),
  };

  const handleResumeAfterPause = makeResumeAfterPauseHandler(ctx);
  const handleRelays = makeRelays(ctx);

  browser.runtime.onMessage.addListener((
    rawMessage: unknown,
    rawSender: unknown,
    sendResponse: (r: unknown) => void,
  ) => {
    const message = rawMessage as Record<string, unknown>;
    const sender = rawSender as chrome.runtime.MessageSender;
    const type = message.type as string;

    // RESUME_AFTER_PAUSE special: runs its full body (pre-relay work + per-task-tab
    // routing when a target matches), then explicitly falls through so the
    // sidepanelToContent allowlist below can deliver the message to the live
    // content script on the active tab. Kept outside directHandlers because that
    // map's contract is "handler runs, dispatch ends" — RESUME_AFTER_PAUSE breaks
    // that contract by design.
    if (type === 'RESUME_AFTER_PAUSE') {
      handleResumeAfterPause(message);
      // intentional fallthrough
    }

    // Direct dispatch. Map entries handle the bulk of message types — see
    // `directHandlers` declaration above. Anything not matched here continues
    // on to the allowlist-based relay sections below.
    const handler = directHandlers[type];
    if (handler) return handler(message, sender, sendResponse);

    return handleRelays(message, sender, sendResponse, type);
  });
}
