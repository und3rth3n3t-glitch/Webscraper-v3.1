import type { SelectorDescriptor } from './config';
import type { QueueTask, TaskProgress, TaskComplete, TaskError, TaskPaused } from './signalr';
import type { ApiCall, ScrapingResult } from './extraction';

export type CloudflareChallengeType = 'cf-challenge' | 'cf-turnstile' | 'checking-browser';

// ── Content → Sidepanel (via SW relay) ───────────────────────────────────────

export type ContentToSidepanelMessage =
  | { type: 'ELEMENT_PICKED';         payload: { descriptor: SelectorDescriptor; elementType: string; label: string; mode: string; extra: Record<string, unknown> } }
  | { type: 'ELEMENT_HOVER';          payload: { tagName: string; className: string; textSnippet: string } }
  | { type: 'PICKER_CANCELLED' }
  | { type: 'FLOW_PROGRESS';          payload: { phase: 'setup' | 'loop'; stepLabel: string; status: string; termIndex?: number; taskId?: string } }
  | { type: 'FLOW_COMPLETE';          payload: { result: ScrapingResult; taskId?: string } }
  | { type: 'FLOW_ERROR';             payload: { error: string; stepLabel?: string; taskId?: string } }
  | { type: 'CLOUDFLARE_DETECTED';    payload: { challengeType: CloudflareChallengeType; taskId?: string } }
  | { type: 'FLOW_PAUSED';            payload:
        | { reason: 'cloudflare'; challengeType?: CloudflareChallengeType; taskId?: string }
        | { reason: 'awaitUserAction'; trigger: DetectionTrigger; message: string; domain: string; taskId?: string } }
  | { type: 'FLOW_RESUMED' }
  | { type: 'NETWORK_CALL_CAPTURED';  payload: ApiCall }
  | { type: 'PAGE_INFO';              payload: { url: string; title: string } }
  | { type: 'PONG' };

// ── Sidepanel → Content (via SW relay) ───────────────────────────────────────

export type SidepanelToContentMessage =
  | { type: 'START_PICKER';           payload: { stepId: string; field: string; mode?: string } }
  | { type: 'CANCEL_PICKER' }
  | { type: 'EXECUTE_FLOW';           payload: { config: import('./config').ScraperConfig; searchTerms: string[]; taskId?: string } }
  | { type: 'ABORT_FLOW' }
  | { type: 'RESUME_AFTER_CLOUDFLARE' }
  | { type: 'RESUME_AFTER_PAUSE';     payload?: { markAsFalseAlarm?: boolean } }
  | { type: 'HIGHLIGHT_ELEMENT';      payload: { descriptor: SelectorDescriptor } }
  | { type: 'UNHIGHLIGHT_ELEMENT' }
  | { type: 'GET_PAGE_INFO' }
  | { type: 'PING' };

// ── SW ↔ Offscreen ────────────────────────────────────────────────────────────

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type SwToOffscreenMessage =
  | { type: 'INIT_SIGNALR';           payload: { serverUrl: string; token: string; clientId: string; version: string } }
  | { type: 'STOP_SIGNALR' }
  | { type: 'SEND_TASK_PROGRESS';     payload: TaskProgress }
  | { type: 'SEND_TASK_COMPLETE';     payload: TaskComplete }
  | { type: 'SEND_TASK_ERROR';        payload: TaskError }
  | { type: 'SEND_TASK_PAUSED';       payload: TaskPaused }
  | { type: 'GET_CONNECTION_STATUS' };

export type OffscreenToSwMessage =
  | { type: 'CONNECTION_READY';       payload: { clientId: string } }
  | { type: 'CONNECTION_LOST';        payload: { error: string } }
  | { type: 'TASK_RECEIVED';          payload: QueueTask }
  | { type: 'RESUME_TASK';            payload: { taskId: string } }
  | { type: 'CANCEL_TASK';            payload: { taskId: string } }
  | { type: 'CONNECTION_STATUS';      payload: { status: ConnectionStatus; error?: string } };

// ── Typed string constants (replace magic literals in content/SW code) ────────

export const MessageType = {
  EXECUTE_FLOW: 'EXECUTE_FLOW',
  FLOW_PROGRESS: 'FLOW_PROGRESS',
  FLOW_COMPLETE: 'FLOW_COMPLETE',
  FLOW_ERROR: 'FLOW_ERROR',
  FLOW_PAUSED: 'FLOW_PAUSED',
  FLOW_RESUMED: 'FLOW_RESUMED',
  FLOW_PREFLIGHT_READY: 'FLOW_PREFLIGHT_READY',
  FORCE_PREFLIGHT_READY: 'FORCE_PREFLIGHT_READY',
  RESUME_FOR_DRAIN: 'RESUME_FOR_DRAIN',
  RESUME_AFTER_PAUSE: 'RESUME_AFTER_PAUSE',
  REGISTER_CONTINUATION: 'REGISTER_CONTINUATION',
  CANCEL_CONTINUATION: 'CANCEL_CONTINUATION',
} as const;
export type MessageType = typeof MessageType[keyof typeof MessageType];

// FLOW_PAUSED.payload.reason — wire protocol; existing dispatcher only
// recognises these two. Do not add new values without updating the dispatcher.
export const PauseReason = {
  CLOUDFLARE: 'cloudflare',
  AWAIT_USER_ACTION: 'awaitUserAction',
} as const;
export type PauseReason = typeof PauseReason[keyof typeof PauseReason];

// Detector trigger detail (carried in FLOW_PAUSED.payload.trigger when
// reason === 'awaitUserAction'). Independent of the protocol reason.
export const DetectionTrigger = {
  CLOUDFLARE: 'cloudflare',
  LOGIN_WALL: 'loginWall',
  CAPTCHA: 'captcha',
  COOKIE_BANNER: 'cookieBanner',
  CUSTOM_SELECTOR: 'customSelector',
  UNCONDITIONAL: 'unconditional',
} as const;
export type DetectionTrigger = typeof DetectionTrigger[keyof typeof DetectionTrigger];
