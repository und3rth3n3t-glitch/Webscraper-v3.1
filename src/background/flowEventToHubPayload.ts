import type { ScrapingResult } from '../types/extraction';
import type { DataMapping } from '../types/config';
import type { TaskProgress, TaskComplete, TaskError, TaskPaused } from '../types/signalr';

export interface ActiveTaskContext {
  taskId: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  dataMapping?: DataMapping;
}

export type FlowProgressPayload = {
  phase: 'setup' | 'loop';
  stepLabel: string;
  status: string;
  termIndex?: number;
};

export type FlowCompletePayload = { result: ScrapingResult };

export type FlowErrorPayload = { error: string; stepLabel?: string };

export type FlowPausedPayload =
  | { reason: 'cloudflare'; challengeType: string }
  | { reason: 'awaitUserAction'; trigger: 'loginWall' | 'captcha' | 'selector' | 'unconditional'; message: string };

export function mapFlowProgress(
  ctx: ActiveTaskContext,
  payload: FlowProgressPayload,
): TaskProgress {
  const total = Math.max(ctx.searchTerms.length, 1);
  const idx = payload.termIndex ?? 0;
  const completedTerms = idx + (payload.status === 'success' ? 1 : 0);
  const progress = payload.phase === 'setup'
    ? 0
    : Math.min(100, Math.max(0, Math.round((completedTerms / total) * 100)));
  return {
    taskId: ctx.taskId,
    configId: ctx.configId,
    currentTerm: ctx.searchTerms[idx] ?? '',
    currentStep: payload.stepLabel,
    progress,
    phase: payload.phase,
  };
}

export function mapFlowComplete(
  ctx: ActiveTaskContext,
  payload: FlowCompletePayload,
  now: () => string = () => new Date().toISOString(),
): TaskComplete {
  const status: 'success' | 'failed' = payload.result.aborted ? 'failed' : 'success';
  return {
    taskId: ctx.taskId,
    configId: ctx.configId,
    result: {
      taskId: ctx.taskId,
      configId: ctx.configId,
      configName: ctx.configName,
      status,
      iterations: payload.result.iterations,
      dataMapping: ctx.dataMapping,
      totalTimeMs: payload.result.totalTimeMs,
      timestamp: now(),
    },
    completedAt: now(),
  };
}

export function mapFlowError(
  ctx: ActiveTaskContext,
  payload: FlowErrorPayload,
  now: () => string = () => new Date().toISOString(),
): TaskError {
  return {
    taskId: ctx.taskId,
    configId: ctx.configId,
    error: payload.error,
    stepLabel: payload.stepLabel,
    failedAt: now(),
  };
}

export function mapFlowPaused(
  ctx: ActiveTaskContext,
  payload: FlowPausedPayload,
  now: () => string = () => new Date().toISOString(),
): TaskPaused {
  if (payload.reason === 'cloudflare') {
    return {
      taskId: ctx.taskId,
      configId: ctx.configId,
      reason: 'cloudflare',
      challengeType: payload.challengeType,
      pausedAt: now(),
    };
  }
  return {
    taskId: ctx.taskId,
    configId: ctx.configId,
    reason: 'awaitUserAction',
    challengeType: '',
    trigger: payload.trigger,
    message: payload.message,
    pausedAt: now(),
  };
}
