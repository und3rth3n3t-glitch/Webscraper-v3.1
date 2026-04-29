import type { QueueTask } from '../types/signalr';
import type { ScraperConfig } from '../types/config';

export class ConfigNotFoundError extends Error {
  constructor(public readonly configId: string) {
    super(`Config "${configId}" not found locally and no inline config provided`);
    this.name = 'ConfigNotFoundError';
  }
}

export interface ResolvedTask {
  config: ScraperConfig;
  searchTerms: string[];
  inputRows?: Record<string, string>[];
  taskId: string;
  configId: string;
  configName: string;
}

export function resolveQueueTask(
  task: QueueTask,
  localConfigs: ScraperConfig[],
): ResolvedTask {
  const localConfig = localConfigs.find((c) => c.id === task.configId);
  // Prefer inlineConfig (has baked literalValues) but fall back to local if
  // the server DB has a stale empty-step version of the config.
  const config = (task.inlineConfig?.steps?.length ? task.inlineConfig : null) ?? localConfig;
  if (!config) throw new ConfigNotFoundError(task.configId);
  return {
    config,
    searchTerms: task.searchTerms,
    inputRows: task.inputRows,
    taskId: task.id,
    configId: task.configId,
    configName: task.configName,
  };
}
