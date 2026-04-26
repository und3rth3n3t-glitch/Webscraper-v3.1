import type { IterationResult } from './extraction';
import type { DataMapping, ScraperConfig } from './config';

export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction';
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}

export interface TaskProgress {
  taskId: string;
  configId: string;
  currentTerm: string;
  currentStep: string;
  progress: number;
  phase: 'setup' | 'loop';
}

export interface TaskComplete {
  taskId: string;
  configId: string;
  result: TaskResult;
  completedAt: string;
}

export interface TaskError {
  taskId: string;
  configId: string;
  error: string;
  stepLabel?: string;
  failedAt: string;
}

export interface TaskPaused {
  taskId: string;
  configId: string;
  reason: 'cloudflare' | 'awaitUserAction';
  challengeType: string;
  trigger?: 'loginWall' | 'captcha' | 'selector' | 'unconditional';
  message?: string;
  pausedAt: string;
}

export interface TaskResult {
  taskId: string;
  configId: string;
  configName: string;
  status: 'success' | 'failed' | 'paused';
  iterations: IterationResult[];
  dataMapping?: DataMapping;
  totalTimeMs: number;
  timestamp: string;
}
