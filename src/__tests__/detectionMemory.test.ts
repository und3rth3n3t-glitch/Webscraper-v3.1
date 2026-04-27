import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getDetectionMemory,
  getIgnoredTriggers,
  addIgnoredTrigger,
  removeIgnoredTrigger,
  clearDomainMemory,
  DETECTION_MEMORY_KEY,
} from '../sidepanel/utils/detectionMemory';
import { DetectionTrigger } from '../types/messages';

// Minimal in-memory storage mock.
let storage: Record<string, unknown> = {};

beforeEach(() => {
  storage = {};
  // @ts-expect-error — test override
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (kv: Record<string, unknown>) => { Object.assign(storage, kv); }),
      },
    },
  };
});

describe('detectionMemory', () => {
  it('returns empty memory when storage is empty', async () => {
    expect(await getDetectionMemory()).toEqual({});
  });

  it('returns empty triggers list for unknown domain', async () => {
    expect(await getIgnoredTriggers('example.com')).toEqual([]);
  });

  it('adds a trigger for a domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
  });

  it('does not duplicate triggers', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
  });

  it('keeps multiple triggers per domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    const triggers = await getIgnoredTriggers('example.com');
    expect(triggers.sort()).toEqual([DetectionTrigger.CAPTCHA, DetectionTrigger.COOKIE_BANNER].sort());
  });

  it('isolates triggers per domain', async () => {
    await addIgnoredTrigger('a.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('b.com', DetectionTrigger.CAPTCHA);
    expect(await getIgnoredTriggers('a.com')).toEqual([DetectionTrigger.COOKIE_BANNER]);
    expect(await getIgnoredTriggers('b.com')).toEqual([DetectionTrigger.CAPTCHA]);
  });

  it('removes a single trigger', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    await removeIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    expect(await getIgnoredTriggers('example.com')).toEqual([DetectionTrigger.CAPTCHA]);
  });

  it('removes the domain entry when the last trigger is removed', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await removeIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    const memory = await getDetectionMemory();
    expect(memory['example.com']).toBeUndefined();
  });

  it('clearDomainMemory removes the entire domain', async () => {
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    await addIgnoredTrigger('example.com', DetectionTrigger.CAPTCHA);
    await clearDomainMemory('example.com');
    const memory = await getDetectionMemory();
    expect(memory['example.com']).toBeUndefined();
  });

  it('updates updatedAt on add', async () => {
    const before = Date.now();
    await addIgnoredTrigger('example.com', DetectionTrigger.COOKIE_BANNER);
    const memory = await getDetectionMemory();
    expect(memory['example.com'].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('storage key is exported for cache wiring', () => {
    expect(DETECTION_MEMORY_KEY).toBe('blueberry_detection_memory');
  });
});
