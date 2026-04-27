import { describe, it, expect } from 'vitest';
import { mergeProgress } from './queueProgress';

describe('mergeProgress', () => {
  it('accepts the first event when prior is null', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: 0 }))
      .toEqual({ stepLabel: 'Click', termIndex: 0 });
  });

  it('replaces step within the same term', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: 'Extract', termIndex: 0 }))
      .toEqual({ stepLabel: 'Extract', termIndex: 0 });
  });

  it('drops empty stepLabel within the same term (no flicker)', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: '', termIndex: 0 }))
      .toBeNull();
  });

  it('replaces both at a term boundary even if stepLabel is empty', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: '', termIndex: 1 }))
      .toEqual({ stepLabel: '', termIndex: 1 });
  });

  it('replaces both at a term boundary with non-empty stepLabel', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: 'Extract', termIndex: 1 }))
      .toEqual({ stepLabel: 'Extract', termIndex: 1 });
  });

  it('accepts undefined termIndex (setup phase)', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: undefined }))
      .toEqual({ stepLabel: 'Click', termIndex: undefined });
  });

  it('drops payload with non-string stepLabel', () => {
    expect(mergeProgress(null, { stepLabel: 42, termIndex: 0 })).toBeNull();
  });

  it('drops payload with negative termIndex', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: -1 })).toBeNull();
  });

  it('drops payload with non-integer termIndex', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: 1.5 })).toBeNull();
  });

  it('caps stepLabel at 200 characters', () => {
    const long = 'x'.repeat(500);
    const result = mergeProgress(null, { stepLabel: long, termIndex: 0 });
    expect(result?.stepLabel.length).toBe(200);
    expect(result?.termIndex).toBe(0);
  });
});
