import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './client';
import type { AccountDto, CreateApiKeyResponseDto, CreateRunSuccess } from './types';

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

export function useStartRun() {
  const nav = useNavigate();
  return useMutation({
    mutationFn: async (body: { taskId: string; workerId: string }) =>
      (await api.post<CreateRunSuccess>('/api/runs', body)).data,
    onSuccess: (data) => nav(`/runs/${data.runItemId}`),
  });
}
