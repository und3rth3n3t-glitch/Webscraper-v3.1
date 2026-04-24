import { validateBackendUrl } from './validateBackendUrl';
import type { TaskResult } from '../../types/signalr';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function postTaskResult(
  serverUrl: string,
  token: string,
  result: TaskResult,
): Promise<void> {
  const validation = validateBackendUrl(serverUrl);
  if (!validation.valid) throw new ApiClientError(validation.error!);

  const res = await fetch(`${serverUrl}/api/scraper/results`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(result),
  });

  if (res.status === 401) throw new ApiClientError('Access denied. Check your token.');
  if (!res.ok) throw new ApiClientError(`Server returned ${res.status}.`);
}

export async function testConnection(serverUrl: string, token: string): Promise<void> {
  const validation = validateBackendUrl(serverUrl);
  if (!validation.valid) throw new ApiClientError(validation.error!);

  const res = await fetch(`${serverUrl}/api/scraper-hub/negotiate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) throw new ApiClientError('Access denied. Check your token.');
  if (!res.ok) throw new ApiClientError("Couldn't connect. Check the URL and token.");
}
