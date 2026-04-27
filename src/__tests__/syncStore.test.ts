import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage
vi.mock('../sidepanel/utils/storage', () => ({
  getAllConfigs: vi.fn(),
  saveConfig: vi.fn(),
  deleteConfig: vi.fn(),
  migrateConfig: (c: unknown) => c,
}));

// Mock syncClient
vi.mock('../sidepanel/utils/syncClient', () => ({
  pullSharedConfigs: vi.fn(),
  pushConfig: vi.fn(),
  recordSubscription: vi.fn(),
}));

import { useSyncStore } from '../sidepanel/stores/syncStore';
import * as storage from '../sidepanel/utils/storage';
import * as syncClient from '../sidepanel/utils/syncClient';

const SERVER_URL = 'http://localhost:5082';
const TOKEN = 'test-token';

const makeLocalConfig = (overrides = {}) => ({
  id: 'config-1',
  name: 'Test Config',
  domain: 'example.com',
  shared: true,
  dirty: false,
  lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
  updatedAt: new Date('2026-04-26T10:00:00Z').getTime(),
  createdAt: 0,
  schemaVersion: 4 as const,
  steps: [],
  url: '',
  domainLocked: false,
  ...overrides,
});

const makeServerConfig = (overrides = {}) => ({
  id: 'config-1',
  name: 'Test Config',
  domain: 'example.com',
  configJson: { steps: [], name: 'Test Config', domain: 'example.com', url: '', domainLocked: false, schemaVersion: 4 },
  schemaVersion: 4,
  updatedAt: '2026-04-26T10:00:00.0000000+00:00',
  shared: true,
  lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
  originClientId: null,
  originWorkerName: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.setState({ syncing: false, lastSyncError: null, conflicts: {}, pushingIds: new Set(), version: 0 });
});

describe('pullSharedConfigs', () => {
  it('silently overwrites when server is newer and local is clean', async () => {
    const localConfig = makeLocalConfig({ lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00' });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00', name: 'Server Name' });

    vi.mocked(storage.getAllConfigs).mockResolvedValue([localConfig as never]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', dirty: false, lastSyncedAt: serverConfig.updatedAt }),
    );
    expect(useSyncStore.getState().conflicts).toEqual({});
  });

  it('sets conflict state when server is newer and local is dirty', async () => {
    const localConfig = makeLocalConfig({
      dirty: true,
      lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00',
    });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00' });

    vi.mocked(storage.getAllConfigs).mockResolvedValue([localConfig as never]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    const state = useSyncStore.getState();
    expect(state.conflicts['config-1']).toBeDefined();
    expect(storage.saveConfig).not.toHaveBeenCalled();
  });

  it('imports new server config when not present locally', async () => {
    const serverConfig = makeServerConfig();

    vi.mocked(storage.getAllConfigs).mockResolvedValue([]);
    vi.mocked(syncClient.pullSharedConfigs).mockResolvedValue([serverConfig]);
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', shared: true, dirty: false }),
    );
  });
});

describe('pushIfDirty in-flight guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({
      syncing: false,
      lastSyncError: null,
      conflicts: {},
      pushingIds: new Set(),
      version: 0,
    });
  });

  it('no-ops when configId is already in pushingIds', async () => {
    useSyncStore.setState({ pushingIds: new Set(['config-1']) });
    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(syncClient.pushConfig).not.toHaveBeenCalled();
  });

  it('clears pushingIds on success', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true, lastSyncedAt: null }) as never]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'created',
      config: { id: 'config-1', name: 'Test Config', domain: 'example.com', configJson: {}, schemaVersion: 4, updatedAt: '2026-04-26T11:00:00Z', shared: true, lastSyncedAt: '2026-04-26T11:00:00Z', originClientId: null, originWorkerName: null },
    });

    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().pushingIds.has('config-1')).toBe(false);
  });

  it('clears pushingIds on error', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true }) as never]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({ outcome: 'error', error: 'HTTP 500' });

    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().pushingIds.has('config-1')).toBe(false);
    expect(useSyncStore.getState().lastSyncError).toBe('HTTP 500');
  });

  it('bumps version on successful push', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true, lastSyncedAt: null }) as never]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'created',
      config: { id: 'config-1', name: 'Test Config', domain: 'example.com', configJson: {}, schemaVersion: 4, updatedAt: '2026-04-26T11:00:00Z', shared: true, lastSyncedAt: '2026-04-26T11:00:00Z', originClientId: null, originWorkerName: null },
    });

    const before = useSyncStore.getState().version;
    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().version).toBe(before + 1);
  });
});

describe('pullSharedConfigs concurrency guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({ syncing: false, version: 0, pushingIds: new Set(), conflicts: {} });
  });

  it('no-ops when already syncing', async () => {
    useSyncStore.setState({ syncing: true });
    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);
    expect(syncClient.pullSharedConfigs).not.toHaveBeenCalled();
  });
});

describe('resolveConflict', () => {
  const setupConflict = () => {
    const localConfig = makeLocalConfig({ dirty: true, lastSyncedAt: '2026-04-26T09:00:00.0000000+00:00', name: 'Local Name' });
    const serverConfig = makeServerConfig({ updatedAt: '2026-04-26T10:00:00.0000000+00:00', name: 'Server Name' });
    useSyncStore.setState({ conflicts: { 'config-1': { localConfig: localConfig as never, serverConfig } } });
    return { localConfig, serverConfig };
  };

  it("resolveConflict('theirs') overwrites local with server version", async () => {
    setupConflict();
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().resolveConflict('theirs', SERVER_URL, TOKEN, 'config-1');

    expect(storage.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'config-1', dirty: false, shared: true }),
    );
    expect(useSyncStore.getState().conflicts['config-1']).toBeUndefined();
  });

  it("resolveConflict('mine') pushes local with server etag as If-Match", async () => {
    const { serverConfig } = setupConflict();
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'updated',
      config: { ...serverConfig, updatedAt: '2026-04-26T11:00:00.0000000+00:00' },
    });
    vi.mocked(storage.saveConfig).mockResolvedValue([]);

    await useSyncStore.getState().resolveConflict('mine', SERVER_URL, TOKEN, 'config-1');

    expect(syncClient.pushConfig).toHaveBeenCalledWith(
      SERVER_URL,
      TOKEN,
      expect.objectContaining({ lastSyncedAt: serverConfig.updatedAt }),
    );
    expect(useSyncStore.getState().conflicts['config-1']).toBeUndefined();
  });
});
