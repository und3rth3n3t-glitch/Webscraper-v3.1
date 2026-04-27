import type { ScraperConfig } from '../../types/config';

export interface ServerScraperConfig {
  id: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  updatedAt: string;
  shared: boolean;
  lastSyncedAt: string | null;
  originClientId: string | null;
  originWorkerName: string | null;
}

export type PushResult =
  | { outcome: 'created'; config: ServerScraperConfig }
  | { outcome: 'updated'; config: ServerScraperConfig }
  | { outcome: 'conflict'; current: ServerScraperConfig }
  | { outcome: 'error'; error: string };

export async function pullSharedConfigs(
  serverUrl: string,
  token: string,
): Promise<ServerScraperConfig[]> {
  const resp = await fetch(`${serverUrl}/api/scraper-configs?shared=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Pull failed: HTTP ${resp.status}`);
  return resp.json() as Promise<ServerScraperConfig[]>;
}

export async function pushConfig(
  serverUrl: string,
  token: string,
  config: ScraperConfig,
): Promise<PushResult> {
  // Strip extension-only storage metadata from the blob stored on the server.
  const { shared: _s, lastSyncedAt: _ls, dirty: _d, ...configPayload } = config;
  const body = {
    suggestedId: config.id,
    name: config.name,
    domain: config.domain,
    configJson: configPayload,
    schemaVersion: config.schemaVersion,
    shared: true,
  };

  if (!config.lastSyncedAt) {
    // First share: POST to create
    const resp = await fetch(`${serverUrl}/api/scraper-configs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    // 409: server has a config at this suggestedId with mismatched content — treat as conflict
    if (resp.status === 409) {
      const current = await resp.json() as ServerScraperConfig;
      return { outcome: 'conflict', current };
    }
    if (!resp.ok) return { outcome: 'error', error: `HTTP ${resp.status}` };
    // 200 (idempotent) and 201 (created) both return the entity in the body — same handling
    return { outcome: 'created', config: await resp.json() as ServerScraperConfig };
  }

  // Subsequent push: PUT with If-Match
  const resp = await fetch(`${serverUrl}/api/scraper-configs/${config.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'If-Match': config.lastSyncedAt,
    },
    body: JSON.stringify({ ...body, suggestedId: undefined }),
  });

  if (resp.status === 412) {
    const current = await resp.json() as ServerScraperConfig;
    return { outcome: 'conflict', current };
  }
  if (!resp.ok) return { outcome: 'error', error: `HTTP ${resp.status}` };
  return { outcome: 'updated', config: await resp.json() as ServerScraperConfig };
}

export async function recordSubscription(
  serverUrl: string,
  token: string,
  configId: string,
): Promise<void> {
  // Best-effort: ignore failures
  fetch(`${serverUrl}/api/scraper-configs/${configId}/subscribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}
