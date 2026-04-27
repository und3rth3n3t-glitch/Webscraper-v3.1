import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { api } from './client';
import type { AccountDto, ApiKeyDto, PagedResultDto, RunBatchDetailDto, RunBatchListItemDto, RunBatchListQuery, RunItemDto, RunListItemDto, RunListQuery, ScraperConfigDto, ScraperConfigSubscriberDto, TaskDto, WorkerDto } from './types';
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

export function useScraperConfigSubscribers(id: string | undefined) {
  return useQuery({
    queryKey: ['scraper-config-subscribers', id],
    enabled: !!id,
    queryFn: async () => (await api.get<ScraperConfigSubscriberDto[]>(`/api/scraper-configs/${id}/subscribers`)).data,
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

function paramsOf(q: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  return sp;
}

export function useRunsList(query: RunListQuery) {
  return useQuery({
    queryKey: ['runs', query],
    queryFn: async (): Promise<PagedResultDto<RunListItemDto>> => {
      const sp = paramsOf(query as Record<string, unknown>);
      return (await api.get<PagedResultDto<RunListItemDto>>(`/api/runs?${sp.toString()}`)).data;
    },
    refetchInterval: shouldPollRunsList(query) ? RUN_POLL_MS : false,
  });
}

function shouldPollRunsList(q: RunListQuery): boolean {
  if (!q.status) return true;
  return !['completed', 'failed', 'cancelled'].includes(q.status);
}

export function useRunBatchesList(query: RunBatchListQuery) {
  return useQuery({
    queryKey: ['run-batches-list', query],
    queryFn: async (): Promise<PagedResultDto<RunBatchListItemDto>> => {
      const sp = paramsOf(query as Record<string, unknown>);
      return (await api.get<PagedResultDto<RunBatchListItemDto>>(`/api/run-batches?${sp.toString()}`)).data;
    },
    refetchInterval: WORKER_POLL_MS,
  });
}

export function useRecentRunsForTask(taskId: string | undefined, limit: number = 5) {
  return useQuery({
    queryKey: ['recent-runs', taskId, limit],
    enabled: !!taskId,
    queryFn: async (): Promise<RunListItemDto[]> => {
      const sp = paramsOf({ taskId, page: 1, pageSize: limit });
      const data = (await api.get<PagedResultDto<RunListItemDto>>(`/api/runs?${sp.toString()}`)).data;
      return data.items;
    },
    staleTime: 10_000,
  });
}
