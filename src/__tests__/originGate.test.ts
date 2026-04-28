import { describe, it, expect } from 'vitest';
import { canStartInDrain, DRAIN_PARALLEL_CAP } from '../background/originGate';

describe('canStartInDrain', () => {
  it('exports a positive default cap', () => {
    expect(DRAIN_PARALLEL_CAP).toBeGreaterThanOrEqual(1);
  });

  it('blocks when running count meets cap', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://b.test']), 4, 4)).toBe(false);
  });

  it('blocks when origin already running', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://a.test']), 1, 4)).toBe(false);
  });

  it('allows when origin not running and under cap', () => {
    expect(canStartInDrain('https://a.test', new Set(['https://b.test']), 2, 4)).toBe(true);
  });

  it('null origin is never gated by origin (cap still applies)', () => {
    expect(canStartInDrain(null, new Set(['https://a.test']), 1, 4)).toBe(true);
    expect(canStartInDrain(null, new Set(), 4, 4)).toBe(false);
  });

  it('cap of zero blocks everything', () => {
    expect(canStartInDrain('https://a.test', new Set(), 0, 0)).toBe(false);
  });

  it('cap of one allows exactly one task', () => {
    expect(canStartInDrain('https://a.test', new Set(), 0, 1)).toBe(true);
    expect(canStartInDrain('https://a.test', new Set(), 1, 1)).toBe(false);
  });
});
