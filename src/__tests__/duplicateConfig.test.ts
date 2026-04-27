import { describe, it, expect } from 'vitest';
import type { ScraperConfig } from '../types/config';

// Mirror of the duplicate logic in ConfigList.handleDuplicate. Kept inline rather
// than extracted so the component stays self-contained; this test is the contract.
function makeDuplicate(config: ScraperConfig, newId: string, now: number): ScraperConfig {
  return {
    ...config,
    id: newId,
    name: `${config.name} (copy)`,
    createdAt: now,
    updatedAt: now,
    shared: false,
    lastSyncedAt: null,
    dirty: false,
  };
}

describe('makeDuplicate', () => {
  it('strips sync metadata', () => {
    const original: ScraperConfig = {
      id: 'orig',
      name: 'Wikipedia',
      domain: 'en.wikipedia.org',
      domainLocked: true,
      url: '',
      steps: [],
      schemaVersion: 4,
      createdAt: 1,
      updatedAt: 2,
      shared: true,
      lastSyncedAt: '2026-04-26T10:00:00Z',
      dirty: true,
    };
    const copy = makeDuplicate(original, 'new', 100);
    expect(copy.id).toBe('new');
    expect(copy.shared).toBe(false);
    expect(copy.lastSyncedAt).toBeNull();
    expect(copy.dirty).toBe(false);
    expect(copy.name).toBe('Wikipedia (copy)');
  });
});
