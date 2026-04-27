import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './client';
import type { AccountDto, ApiKeyDto, BatchDispatchResultDto, CreateApiKeyResponseDto, CreateBatchDto, CreateScraperConfigDto, ExpansionPreviewDto, SaveTaskDto, ScraperConfigDto, TaskDto } from './types';

export function useLogin() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: async (body: { email: string; password: string }) =>
      (await api.post<AccountDto>('/api/account/login', body)).data,
    onSuccess: (data) => {
      qc.setQueryData(['me'], data);
      nav('/tasks', { replace: true });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: async () => {
      await api.post('/api/account/logout');
    },
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.removeQueries();
      nav('/login', { replace: true });
    },
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string }) =>
      (await api.post<CreateApiKeyResponseDto>('/api/api-keys', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/api-keys/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useRenameApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await api.patch<ApiKeyDto>(`/api/api-keys/${id}`, { name })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function usePopulateTask() {
  return useMutation({
    mutationFn: async (taskId: string): Promise<ExpansionPreviewDto> =>
      (await api.post(`/api/tasks/${taskId}/populate`)).data,
  });
}

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateBatchDto): Promise<BatchDispatchResultDto> =>
      (await api.post('/api/runs/batch', body)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['workers'] }); },
  });
}

export function useCreateScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateScraperConfigDto) =>
      (await api.post<ScraperConfigDto>('/api/scraper-configs', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-configs'] }),
  });
}

export function useUpdateScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: CreateScraperConfigDto }) =>
      (await api.put<ScraperConfigDto>(`/api/scraper-configs/${id}`, body)).data,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['scraper-configs'] });
      qc.invalidateQueries({ queryKey: ['scraper-configs', vars.id] });
    },
  });
}

export function useDeleteScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/scraper-configs/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-configs'] }),
  });
}

export function useSaveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: SaveTaskDto }): Promise<TaskDto> => {
      if (id) {
        return (await api.put<TaskDto>(`/api/tasks/${id}`, body)).data;
      }
      return (await api.post<TaskDto>('/api/tasks', body)).data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      if (vars.id) qc.invalidateQueries({ queryKey: ['tasks', vars.id] });
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      await api.post(`/api/runs/${runId}/cancel`);
    },
    onSuccess: (_data, runId) => {
      qc.invalidateQueries({ queryKey: ['run', runId] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/tasks/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
