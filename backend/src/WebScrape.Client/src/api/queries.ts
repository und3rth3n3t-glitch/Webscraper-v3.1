import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { api } from './client';
import type { AccountDto, ApiKeyDto, RunBatchDetailDto, RunItemDto, ScraperConfigDto, TaskDto, WorkerDto } from './types';
import { RUN_POLL_MS, WORKER_POLL_MS } from './constants';
import { allTerminal, isTerminalStatus } from '../utils/runStatus';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<AccountDto | null> => {
      try {
        const { data } = await api.get<AccountDto>('/api/account/me');
        return data;
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => (await api.get<ApiKeyDto[]>('/api/api-keys')).data,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => (await api.get<TaskDto[]>('/api/tasks')).data,
  });
}

export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: async () => (await api.get<WorkerDto[]>('/api/workers')).data,
    refetchInterval: WORKER_POLL_MS,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ['run', id],
    enabled: !!id,
    queryFn: async () => (await api.get<RunItemDto>(`/api/runs/${id}`)).data,
    refetchInterval: (query) => {
      const data = query.state.data as RunItemDto | undefined;
      if (!data) return RUN_POLL_MS;
      return isTerminalStatus(data.status) ? false : RUN_POLL_MS;
    },
  });
}

export function useRunBatch(batchId: string | null | undefined) {
  return useQuery<RunBatchDetailDto>({
    queryKey: ['run-batches', batchId],
    enabled: !!batchId,
    queryFn: async () => (await api.get(`/api/run-batches/${batchId}`)).data,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return RUN_POLL_MS;
      return allTerminal(data.runItems) ? false : RUN_POLL_MS;
    },
  });
}

export function useScraperConfigs() {
  return useQuery({
    queryKey: ['scraper-configs'],
    queryFn: async () => (await api.get<ScraperConfigDto[]>('/api/scraper-configs')).data,
  });
}

export function useScraperConfig(id: string | undefined) {
  return useQuery({
    queryKey: ['scraper-configs', id],
    enabled: !!id,
    queryFn: async () => (await api.get<ScraperConfigDto>(`/api/scraper-configs/${id}`)).data,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ['tasks', id],
    enabled: !!id,
    queryFn: async () => (await api.get<TaskDto>(`/api/tasks/${id}`)).data,
    retry: (failureCount, error) => {
      // Don't retry 4xx (404 deleted task, 403 cross-user) — surface the error fast.
      if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        if (status >= 400 && status < 500) return false;
      }
      return failureCount < 2;
    },
  });
}
