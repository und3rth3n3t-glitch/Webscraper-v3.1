import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { api } from './client';
import type { AccountDto, ApiKeyDto, RunItemDto, TaskDto, WorkerDto } from './types';
import { TERMINAL_STATUSES } from './types';

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
    refetchInterval: 5000,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ['run', id],
    enabled: !!id,
    queryFn: async () => (await api.get<RunItemDto>(`/api/runs/${id}`)).data,
    refetchInterval: (query) => {
      const data = query.state.data as RunItemDto | undefined;
      if (!data) return 1000;
      return TERMINAL_STATUSES.includes(data.status) ? false : 1000;
    },
  });
}
