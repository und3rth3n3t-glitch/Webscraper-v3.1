import axios, { AxiosError } from 'axios';
import type { QueryClient } from '@tanstack/react-query';

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';
const UNSAFE = new Set(['post', 'put', 'patch', 'delete']);

function readCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export const api = axios.create({
  baseURL: '/',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toLowerCase();
  if (UNSAFE.has(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) config.headers.set(CSRF_HEADER, token);
  }
  return config;
});

let queryClient: QueryClient | null = null;
export function setQueryClient(c: QueryClient) {
  queryClient = c;
}

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && queryClient) {
      queryClient.setQueryData(['me'], null);
    }
    return Promise.reject(err);
  }
);

export async function ensureCsrfCookie(): Promise<void> {
  if (!readCookie(CSRF_COOKIE)) {
    try {
      await api.get('/api/account/csrf');
    } catch {
      // ignore — login will surface real errors
    }
  }
}
