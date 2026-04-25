import { describe, it, expect } from 'vitest';
import { statusLabel } from './runStatus';
import { RunItemStatus } from '../api/types';

describe('statusLabel', () => {
  it('maps every RunItemStatus value to a non-empty string', () => {
    for (const status of Object.values(RunItemStatus)) {
      const label = statusLabel(status);
      expect(label, `expected non-empty label for status "${status}"`).toBeTruthy();
      expect(typeof label).toBe('string');
    }
  });

  it('falls through to the raw status for unknown values', () => {
    const unknown = 'totally-unknown' as never;
    expect(statusLabel(unknown)).toBe('totally-unknown');
  });
});
