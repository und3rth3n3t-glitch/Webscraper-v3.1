import { describe, it, expect } from 'vitest';
import { migrateConfig } from './storage';

describe('migrateConfig — v2 → v3 (alternate selector rename)', () => {
  it('renames subsequentSelector → alternateSelector on setInput steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x',
      name: 'n',
      domain: '',
      url: '',
      domainLocked: false,
      steps: [{
        id: 's1',
        type: 'setInput',
        label: '',
        isSetup: false,
        selector: null,
        elementType: null,
        extra: null,
        options: { subsequentSelector: { cssSelector: '#alt' }, clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false },
      }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    expect(migrated).not.toBeNull();
    const opts = migrated!.steps[0].options as unknown as Record<string, unknown>;
    expect(opts.alternateSelector).toEqual({ cssSelector: '#alt' });
    expect('subsequentSelector' in opts).toBe(false);
  });

  it('defaults alternateSelector to null on setInput when no subsequentSelector', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'setInput', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as unknown as Record<string, unknown>;
    expect(opts.alternateSelector).toBe(null);
  });

  it('defaults alternateSelector to null on click steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'click', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as unknown as Record<string, unknown>;
    expect(opts.alternateSelector).toBe(null);
  });

  it('defaults alternateContainerSelector to null on bestMatch steps', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'bestMatch', options: {} }],
    };
    const migrated = migrateConfig(legacy as Record<string, unknown>);
    const opts = migrated!.steps[0].options as unknown as Record<string, unknown>;
    expect(opts.alternateContainerSelector).toBe(null);
  });

  it('is a no-op on already-v3 configs', () => {
    const v3 = {
      schemaVersion: 3,
      id: 'x', name: 'n', domain: '', url: '', domainLocked: false,
      steps: [{ id: 's1', type: 'setInput', options: { alternateSelector: null } }],
    };
    const migrated = migrateConfig(v3 as Record<string, unknown>);
    expect((migrated!.steps[0].options as unknown as Record<string, unknown>).alternateSelector).toBe(null);
    expect((migrated!.steps[0].options as unknown as Record<string, unknown>).subsequentSelector).toBeUndefined();
  });
});
