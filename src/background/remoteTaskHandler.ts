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
  taskId: string;
  configId: string;
  configName: string;
}

export function resolveQueueTask(
  task: QueueTask,
  localConfigs: ScraperConfig[],
): ResolvedTask {
  const config = task.inlineConfig ?? localConfigs.find((c) => c.id === task.configId);
  if (!config) throw new ConfigNotFoundError(task.configId);
  return {
    config,
    searchTerms: task.searchTerms,
    taskId: task.id,
    configId: task.configId,
    configName: task.configName,
  };
}
