import { describe, it, expect } from 'vitest';
import { parseExtraSelectors, formatExtraSelectors } from '../sidepanel/utils/parseExtraSelectors';

describe('parseExtraSelectors', () => {
  it('returns empty array for empty string', () => {
    expect(parseExtraSelectors('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseExtraSelectors('   \n\n  \n')).toEqual([]);
  });

  it('parses a single selector', () => {
    expect(parseExtraSelectors('.foo')).toEqual(['.foo']);
  });

  it('parses multiple selectors split by newlines', () => {
    expect(parseExtraSelectors('.foo\n.bar')).toEqual(['.foo', '.bar']);
  });

  it('trims whitespace and drops empty lines', () => {
    expect(parseExtraSelectors('  .foo  \n\n  .bar  ')).toEqual(['.foo', '.bar']);
  });

  it('deduplicates while preserving first-seen order', () => {
    expect(parseExtraSelectors('.foo\n.bar\n.foo\n.baz\n.bar')).toEqual(['.foo', '.bar', '.baz']);
  });

  it('preserves complex selector strings verbatim', () => {
    expect(parseExtraSelectors('div[data-x="1"]:not(.hidden)\n#main > p'))
      .toEqual(['div[data-x="1"]:not(.hidden)', '#main > p']);
  });
});

describe('formatExtraSelectors', () => {
  it('returns empty string for undefined', () => {
    expect(formatExtraSelectors(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(formatExtraSelectors([])).toBe('');
  });

  it('joins with newlines', () => {
    expect(formatExtraSelectors(['.foo', '.bar'])).toBe('.foo\n.bar');
  });

  it('round-trips with parseExtraSelectors', () => {
    const input = ['.foo', '.bar', '.baz'];
    expect(parseExtraSelectors(formatExtraSelectors(input))).toEqual(input);
  });
});
