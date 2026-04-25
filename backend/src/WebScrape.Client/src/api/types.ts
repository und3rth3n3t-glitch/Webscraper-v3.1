// Mirrors backend DTOs. Update in same PR as backend DTO changes.
// Source files:
//   backend/src/WebScrape.Data/Dto/AccountDtos.cs
//   backend/src/WebScrape.Data/Dto/ApiKeyDto.cs
//   backend/src/WebScrape.Data/Dto/ScraperConfigDto.cs
//   backend/src/WebScrape.Data/Dto/TaskDto.cs
//   backend/src/WebScrape.Data/Dto/TaskBlockDto.cs
//   backend/src/WebScrape.Data/Dto/ValidationErrorDto.cs
//   backend/src/WebScrape.Data/Dto/WorkerDto.cs
//   backend/src/WebScrape.Data/Dto/RunItemDto.cs
//   backend/src/WebScrape.Data/Enums/BlockType.cs, BindingKind.cs, RunItemStatus.cs

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

export type ScraperConfigDto = {
  id: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateScraperConfigDto = {
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
};

export type DeleteConfigConflictDto = {
  code: 'CONFIG_REFERENCED';
  referencingTaskCount: number;
  error: string;
};

export const BlockType = {
  Loop: 'loop',
  Scrape: 'scrape',
} as const;
export type BlockType = (typeof BlockType)[keyof typeof BlockType];

export const BindingKind = {
  Literal: 'literal',
  LoopRef: 'loopRef',
  Unbound: 'unbound',
} as const;
export type BindingKind = (typeof BindingKind)[keyof typeof BindingKind];

export type LoopBlockConfigDto = {
  name: string;
  values: string[];
};

export type StepBindingDto =
  | { kind: 'literal'; value: string }
  | { kind: 'loopRef'; loopBlockId: string }
  | { kind: 'unbound' };

export type ScrapeBlockConfigDto = {
  scraperConfigId: string;
  stepBindings: Record<string, StepBindingDto>;
};

export type TaskBlockTreeDto = {
  id: string;
  parentBlockId: string | null;
  blockType: BlockType;
  orderIndex: number;
  loop?: LoopBlockConfigDto | null;
  scrape?: ScrapeBlockConfigDto | null;
};

export type SaveTaskDto = {
  name: string;
  blocks: TaskBlockTreeDto[];
};

export type ValidationErrorDto = {
  code: string;
  blockId?: string | null;
  loopBlockId?: string | null;
  scraperConfigId?: string | null;
  stepId?: string | null;
  message?: string | null;
};

export type TaskDto = {
  id: string;
  name: string;
  searchTerms: string[];
  blocks: TaskBlockTreeDto[];
  createdAt: string;
};

export type WorkerDto = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  extensionVersion: string | null;
};

export const RunItemStatus = {
  Pending: 'pending',
  Sent: 'sent',
  Running: 'running',
  Paused: 'paused',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type RunStatus = (typeof RunItemStatus)[keyof typeof RunItemStatus];

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
  iterationLabel: string | null;
};

export const TERMINAL_STATUSES: RunStatus[] = [
  RunItemStatus.Completed,
  RunItemStatus.Failed,
  RunItemStatus.Cancelled,
];

// ── M2.3 expansion + batch ─────────────────────────────────────────────────

export type ExpandedItemDto = {
  scrapeBlockId: string;
  scraperConfigId: string;
  configName: string;
  assignments: Record<string, string>;
  iterationLabel: string;
};

export type ExpansionWarningDto = {
  code: string;
  blockId?: string | null;
  scraperConfigId?: string | null;
  stepId?: string | null;
};

export type ExpansionPreviewDto = {
  count: number;
  items: ExpandedItemDto[];
  warnings: ExpansionWarningDto[];
};

export type CreateBatchDto = { taskId: string; workerId: string };

export type BatchDispatchResultDto = {
  batchId: string;
  dispatchedCount: number;
  failedCount: number;
};

export type RunBatchDetailDto = {
  id: string;
  taskId: string;
  taskName: string;
  workerId: string;
  workerName: string;
  createdAt: string;
  runItems: RunItemDto[];
};
