import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sidepanel/utils/storage', () => ({
  saveConfig: vi.fn(),
  migrateConfig: (c: unknown) => c,
  CURRENT_SCHEMA_VERSION: 4,
}));

const mockPushIfDirty = vi.fn();
vi.mock('../sidepanel/stores/syncStore', () => ({
  useSyncStore: { getState: () => ({ pushIfDirty: mockPushIfDirty }) },
}));

vi.mock('../sidepanel/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ serverUrl: 'http://localhost:5082', jwtToken: 'tok', connectionStatus: 'connected' }),
  },
}));

import { useConfigStore } from '../sidepanel/stores/configStore';

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({
    steps: [],
    configName: 'Test',
    pageDomain: 'example.com',
    pageUrl: 'https://example.com',
    domainLocked: true,
    currentConfig: null,
  });
});

describe('saveCurrentConfig auto-push', () => {
  it('pushes when shared + connected', async () => {
    useConfigStore.setState({
      currentConfig: { id: 'c1', name: 'Test', shared: true, lastSyncedAt: '2026-04-26T10:00:00Z' } as never,
    });
    await useConfigStore.getState().saveCurrentConfig();
    expect(mockPushIfDirty).toHaveBeenCalledWith('http://localhost:5082', 'tok', 'c1');
  });

  it('does not push when not shared', async () => {
    useConfigStore.setState({
      currentConfig: { id: 'c1', name: 'Test', shared: false, lastSyncedAt: null } as never,
    });
    await useConfigStore.getState().saveCurrentConfig();
    expect(mockPushIfDirty).not.toHaveBeenCalled();
  });
});
