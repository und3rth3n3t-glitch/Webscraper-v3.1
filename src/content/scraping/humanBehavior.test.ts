import { describe, it, expect } from 'vitest';
import { computeScrollIncrement } from './humanBehavior';

describe('computeScrollIncrement', () => {
  it('returns viewport × incrementVh for normal values', () => {
    expect(computeScrollIncrement(800, 0.4)).toBe(320);
    expect(computeScrollIncrement(1000, 0.5)).toBe(500);
  });

  it('clamps incrementVh to [0.1, 1.0]', () => {
    expect(computeScrollIncrement(1000, 0)).toBe(100);   // floor 0.1 × 1000
    expect(computeScrollIncrement(1000, 5)).toBe(1000);  // ceil 1.0 × 1000
  });

  it('clamps the result to [60, 2000] px', () => {
    expect(computeScrollIncrement(100, 0.1)).toBe(60);   // 100 × 0.1 = 10 → floor 60
    expect(computeScrollIncrement(5000, 1.0)).toBe(2000); // ceil 2000
  });
});
