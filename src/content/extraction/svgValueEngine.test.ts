import { describe, it, expect } from 'vitest';
import { parseAxisLabel } from './svgValueEngine';

describe('parseAxisLabel', () => {
  it('parses plain integers', () => {
    expect(parseAxisLabel('0')).toEqual({ value: 0, isPercent: false });
    expect(parseAxisLabel('100')).toEqual({ value: 100, isPercent: false });
    expect(parseAxisLabel('-5')).toEqual({ value: -5, isPercent: false });
  });

  it('parses decimals', () => {
    expect(parseAxisLabel('1.5')).toEqual({ value: 1.5, isPercent: false });
    expect(parseAxisLabel('-0.25')).toEqual({ value: -0.25, isPercent: false });
  });

  it('parses magnitude suffixes', () => {
    expect(parseAxisLabel('100k')).toEqual({ value: 100_000, isPercent: false });
    expect(parseAxisLabel('1.5M')).toEqual({ value: 1_500_000, isPercent: false });
    expect(parseAxisLabel('2B')).toEqual({ value: 2_000_000_000, isPercent: false });
    expect(parseAxisLabel('100 k')).toEqual({ value: 100_000, isPercent: false });
  });

  it('parses percent labels', () => {
    expect(parseAxisLabel('5%')).toEqual({ value: 5, isPercent: true });
    expect(parseAxisLabel('0.5%')).toEqual({ value: 0.5, isPercent: true });
  });

  it('strips leading currency symbols', () => {
    expect(parseAxisLabel('$5')).toEqual({ value: 5, isPercent: false });
    expect(parseAxisLabel('£100k')).toEqual({ value: 100_000, isPercent: false });
  });

  it('strips comma thousand-separators', () => {
    expect(parseAxisLabel('1,000')).toEqual({ value: 1000, isPercent: false });
    expect(parseAxisLabel('1,234,567')).toEqual({ value: 1_234_567, isPercent: false });
  });

  it('handles unit-suffix labels (was failing pre-fix)', () => {
    expect(parseAxisLabel('0 °C')).toEqual({ value: 0, isPercent: false });
    expect(parseAxisLabel('25 mm')).toEqual({ value: 25, isPercent: false });
    expect(parseAxisLabel('100 USD')).toEqual({ value: 100, isPercent: false });
    expect(parseAxisLabel('1.5 km')).toEqual({ value: 1.5, isPercent: false });
    expect(parseAxisLabel('-10 lbs')).toEqual({ value: -10, isPercent: false });
  });

  it('does not misread "mm" as million suffix', () => {
    expect(parseAxisLabel('25 mm')).toEqual({ value: 25, isPercent: false });
    // "25mm" (no space) — strict regex fails ("mm" doesn't match a single magnitude
    // letter), permissive regex requires whitespace before the unit, so the input
    // is rejected. This is acceptable: ambiguous, and chart axes typically use a
    // space.
    expect(parseAxisLabel('25mm')).toBe(null);
  });

  it('returns null for non-numeric labels', () => {
    expect(parseAxisLabel('abc')).toBe(null);
    expect(parseAxisLabel('')).toBe(null);
    expect(parseAxisLabel('   ')).toBe(null);
  });
});
