import { create } from 'zustand';
import { getAllConfigs, saveConfig, migrateConfig } from '../utils/storage';
import {
  pullSharedConfigs,
  pushConfig,
  recordSubscription,
  type ServerScraperConfig,
} from '../utils/syncClient';
import type { ScraperConfig } from '../../types/config';

export interface ConflictState {
  localConfig: ScraperConfig;
  serverConfig: ServerScraperConfig;
}

interface SyncState {
  syncing: boolean;
  lastSyncError: string | null;
  conflicts: Record<string, ConflictState>;
  pushingIds: Set<string>;
  version: number;

  pullSharedConfigs: (serverUrl: string, token: string) => Promise<void>;
  pushIfDirty: (serverUrl: string, token: string, configId: string) => Promise<void>;
  resolveConflict: (choice: 'mine' | 'theirs', serverUrl: string, token: string, configId: string) => Promise<void>;
  dismissConflict: (configId: string) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncing: false,
  lastSyncError: null,
  conflicts: {},
  pushingIds: new Set(),
  version: 0,

  pullSharedConfigs: async (serverUrl, token) => {
    if (get().syncing) return; // concurrency guard
    set({ syncing: true, lastSyncError: null });
    try {
      const serverConfigs = await pullSharedConfigs(serverUrl, token);
      const localConfigs = await getAllConfigs();
      const localById = new Map(localConfigs.map((c) => [c.id, c]));

      let touched = false;
      for (const sc of serverConfigs) {
        const local = localById.get(sc.id);
        const serverUpdatedMs = new Date(sc.updatedAt).getTime();
        const localSyncedMs = local?.lastSyncedAt ? new Date(local.lastSyncedAt).getTime() : 0;
        const serverIsNewer = serverUpdatedMs > localSyncedMs;

        if (!local) {
          const imported = serverToLocal(sc);
          await saveConfig(imported);
          recordSubscription(serverUrl, token, sc.id);
          touched = true;
        } else if (serverIsNewer && !local.dirty) {
          const serverSteps = Array.isArray((sc.configJson as Record<string, unknown>)?.steps)
            ? ((sc.configJson as { steps: unknown[] }).steps).length : 0;
          const localSteps = local.steps?.length ?? 0;
          if (serverSteps < localSteps) {
            // Server has fewer steps than local — likely stale data. Raise conflict
            // instead of silently overwriting good local steps with a bad server version.
            set((s) => ({
              conflicts: { ...s.conflicts, [sc.id]: { localConfig: local, serverConfig: sc } },
            }));
          } else {
            const updated = serverToLocal(sc, local);
            await saveConfig(updated);
            recordSubscription(serverUrl, token, sc.id);
            touched = true;
          }
        } else if (serverIsNewer && local.dirty) {
          set((s) => ({
            conflicts: { ...s.conflicts, [sc.id]: { localConfig: local, serverConfig: sc } },
          }));
        }
      }

      // Push any dirty shared configs that are not in conflict.
      const { conflicts } = get();
      const updatedLocal = await getAllConfigs();
      for (const c of updatedLocal) {
        if (c.shared && c.dirty && !conflicts[c.id]) {
          await get().pushIfDirty(serverUrl, token, c.id);
        }
      }

      if (touched) bumpVersion(set);
    } catch (err) {
      set({ lastSyncError: (err as Error).message });
    } finally {
      set({ syncing: false });
    }
  },

  pushIfDirty: async (serverUrl, token, configId) => {
    if (get().pushingIds.has(configId)) return; // in-flight guard
    set((s) => {
      const next = new Set(s.pushingIds);
      next.add(configId);
      return { pushingIds: next };
    });

    try {
      const configs = await getAllConfigs();
      const config = configs.find((c) => c.id === configId);
      if (!config || !config.dirty) return;

      const result = await pushConfig(serverUrl, token, config);

      if (result.outcome === 'created' || result.outcome === 'updated') {
        const synced: ScraperConfig = {
          ...config,
          id: result.config.id,
          lastSyncedAt: result.config.updatedAt,
          dirty: false,
          shared: true,
        };
        // Defensive: only fires on cross-user GUID collision (server idempotency
        // handles the same-user case). Documented for future audit (FUTURE E.3).
        if (result.config.id !== config.id) {
          const { deleteConfig } = await import('../utils/storage');
          await deleteConfig(config.id);
        }
        await saveConfig(synced);
        recordSubscription(serverUrl, token, result.config.id);
        bumpVersion(set);
      } else if (result.outcome === 'conflict') {
        set((s) => ({
          conflicts: { ...s.conflicts, [configId]: { localConfig: config, serverConfig: result.current } },
        }));
      } else {
        set({ lastSyncError: result.error });
      }
    } finally {
      set((s) => {
        const next = new Set(s.pushingIds);
        next.delete(configId);
        return { pushingIds: next };
      });
    }
  },

  resolveConflict: async (choice, serverUrl, token, configId) => {
    const cs = get().conflicts[configId];
    if (!cs) return;

    if (choice === 'theirs') {
      const imported = serverToLocal(cs.serverConfig, cs.localConfig);
      await saveConfig(imported);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
      bumpVersion(set);
      return;
    }

    const localWithServerEtag: ScraperConfig = {
      ...cs.localConfig,
      lastSyncedAt: cs.serverConfig.updatedAt,
    };
    const result = await pushConfig(serverUrl, token, localWithServerEtag);

    if (result.outcome === 'updated') {
      const synced: ScraperConfig = {
        ...cs.localConfig,
        lastSyncedAt: result.config.updatedAt,
        dirty: false,
      };
      await saveConfig(synced);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
      bumpVersion(set);
    } else if (result.outcome === 'conflict') {
      set((s) => ({
        conflicts: { ...s.conflicts, [configId]: { localConfig: cs.localConfig, serverConfig: result.current } },
      }));
    } else {
      set({ lastSyncError: (result as { error?: string }).error ?? 'Push failed' });
    }
  },

  dismissConflict: (configId) => {
    set((s) => {
      const { [configId]: _, ...rest } = s.conflicts;
      return { conflicts: rest };
    });
  },
}));

function bumpVersion(set: (partial: Partial<SyncState> | ((s: SyncState) => Partial<SyncState>)) => void) {
  set((s) => ({ version: s.version + 1 }));
}

function serverToLocal(sc: ServerScraperConfig, existing?: ScraperConfig): ScraperConfig {
  const blob = migrateConfig(sc.configJson as Record<string, unknown>);
  const base = blob ?? {} as ScraperConfig;
  return {
    ...base,
    id: sc.id,
    name: sc.name,
    domain: sc.domain,
    shared: true,
    lastSyncedAt: sc.updatedAt,
    dirty: false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: new Date(sc.updatedAt).getTime(),
  } as ScraperConfig;
}
