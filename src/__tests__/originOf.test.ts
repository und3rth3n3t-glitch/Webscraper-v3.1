import { describe, it, expect } from 'vitest';
import { originOf } from '../background/originOf';

describe('originOf', () => {
  it('returns origin for a normal https URL', () => {
    expect(originOf('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('returns origin including explicit port', () => {
    expect(originOf('http://localhost:5082/api')).toBe('http://localhost:5082');
  });

  it('returns null for null / undefined / empty', () => {
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('://broken')).toBeNull();
  });
});
