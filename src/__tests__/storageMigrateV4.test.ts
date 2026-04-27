import { describe, it, expect } from 'vitest';
import { migrateConfig } from '../sidepanel/utils/storage';

describe('migrateConfig v3→v4', () => {
  const v3Config = {
    id: 'abc',
    name: 'Test',
    domain: 'example.com',
    url: 'https://example.com',
    domainLocked: false,
    steps: [],
    schemaVersion: 3,
    createdAt: 1000,
    updatedAt: 2000,
  };

  it('migrates v3 config to v4 with safe defaults for sync fields', () => {
    const result = migrateConfig(v3Config);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(4);
    expect(result!.shared).toBe(false);
    expect(result!.lastSyncedAt).toBeNull();
    expect(result!.dirty).toBe(false);
  });

  it('preserves existing sync fields on re-migration', () => {
    const v4Config = {
      ...v3Config,
      schemaVersion: 4,
      shared: true,
      lastSyncedAt: '2026-04-26T10:00:00.0000000+00:00',
      dirty: true,
    };
    const result = migrateConfig(v4Config as never);
    expect(result).not.toBeNull();
    expect(result!.shared).toBe(true);
    expect(result!.lastSyncedAt).toBe('2026-04-26T10:00:00.0000000+00:00');
    expect(result!.dirty).toBe(true);
  });

  it('preserves existing steps and data on migration', () => {
    const result = migrateConfig({
      ...v3Config,
      steps: [{ id: 's1', type: 'click', label: 'Click', isSetup: false, selector: null, elementType: null, extra: null, options: { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } }],
    });
    expect(result!.steps).toHaveLength(1);
  });
});
