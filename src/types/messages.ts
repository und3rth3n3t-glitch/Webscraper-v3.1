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
  | { type: 'FLOW_PAUSED';            payload: { reason: 'cloudflare'; challengeType: CloudflareChallengeType; taskId?: string } }
  | { type: 'FLOW_PAUSED';            payload: { reason: 'awaitUserAction'; message: string; taskId?: string } }
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
  | { type: 'HIGHLIGHT_ELEMENT';      payload: { descriptor: SelectorDescriptor } }
  | { type: 'UNHIGHLIGHT_ELEMENT' }
  | { type: 'GET_PAGE_INFO' }
  | { type: 'PING' };

// ── SW ↔ Offscreen ────────────────────────────────────────────────────────────

export type SwToOffscreenMessage =
  | { type: 'INIT_SIGNALR';           payload: { serverUrl: string; token: string; clientId: string } }
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
  | { type: 'CONNECTION_STATUS';      payload: { connected: boolean; serverUrl: string | null } };
