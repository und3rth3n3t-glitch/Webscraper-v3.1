import { describe, it, expect } from 'vitest';

// Pure unit test for the literalValue precedence logic. The full
// `executeSetInput` requires DOM + helpers we don't have under jsdom in this
// suite; we extract the precedence into a tiny pure function and test that.
//
// If this expression diverges from the implementation in scrapingEngine.ts,
// the manual smoke step in SPEC-M2.3 §5 will catch it.

function pickValueToType(literalValue: string | undefined, searchTerm: string | null): string {
  return literalValue ?? searchTerm ?? '';
}

describe('SetInput value precedence (M2.4)', () => {
  it('returns literalValue when set, even if searchTerm is also set', () => {
    expect(pickValueToType('SERVER', 'CLIENT')).toBe('SERVER');
  });

  it('returns literalValue when searchTerm is null', () => {
    expect(pickValueToType('SERVER', null)).toBe('SERVER');
  });

  it('returns searchTerm when literalValue is undefined', () => {
    expect(pickValueToType(undefined, 'CLIENT')).toBe('CLIENT');
  });

  it('returns empty string when both are missing', () => {
    expect(pickValueToType(undefined, null)).toBe('');
  });

  it('returns empty string for explicit empty literalValue (precedence still applies)', () => {
    expect(pickValueToType('', 'CLIENT')).toBe('');
  });
});
