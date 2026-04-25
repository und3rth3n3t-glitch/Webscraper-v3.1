export type AccountDto = {
  id: string;
  email: string;
  name: string | null;
};

export type ApiKeyDto = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreateApiKeyResponseDto = {
  id: string;
  name: string;
  prefix: string;
  token: string;
};

export type TaskDto = {
  id: string;
  name: string;
  scraperConfigId: string;
  scraperConfigName: string;
  searchTerms: string[];
  createdAt: string;
};

export type WorkerDto = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  extensionVersion: string | null;
};

export type RunStatus = 'pending' | 'sent' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type RunItemDto = {
  id: string;
  taskId: string;
  workerId: string;
  status: RunStatus;
  requestedAt: string;
  sentAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown | null;
  errorMessage: string | null;
  pauseReason: string | null;
  progressPercent: number | null;
  currentTerm: string | null;
  currentStep: string | null;
  phase: string | null;
};

export type CreateRunSuccess = { runItemId: string };

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled'];
