import { describe, it, expect } from 'vitest';
import { scoreMatch, findBestMatch } from '../common/tokenMatcher';

describe('scoreMatch', () => {
  it('returns 0 for empty text', () => {
    expect(scoreMatch('', 'apple')).toBe(0);
  });

  it('returns 0 for empty search term', () => {
    expect(scoreMatch('Apple Inc', '')).toBe(0);
  });

  it('exact match scores high', () => {
    expect(scoreMatch('Apple', 'Apple')).toBeGreaterThan(0.9);
  });

  it('partial token match scores above 0', () => {
    expect(scoreMatch('Apple Inc Revenue', 'Apple')).toBeGreaterThan(0);
  });

  it('non-matching returns 0 or near 0', () => {
    expect(scoreMatch('Microsoft', 'Google')).toBeLessThan(0.1);
  });
});

describe('findBestMatch', () => {
  const elements = [
    { innerText: 'Apple Inc' },
    { innerText: 'Microsoft Corp' },
    { innerText: 'Google LLC' },
  ] as HTMLElement[];

  it('returns null element below threshold', () => {
    const { element } = findBestMatch(elements, 'xyz123', 0.5);
    expect(element).toBeNull();
  });

  it('finds exact match above threshold', () => {
    const { element, text } = findBestMatch(elements, 'Apple', 0.3);
    expect(element).not.toBeNull();
    expect(text).toMatch(/Apple/i);
  });

  it('returns best match among candidates', () => {
    const { text } = findBestMatch(elements, 'Google', 0.3);
    expect(text).toMatch(/Google/i);
  });
});
