import { describe, expect, it } from 'vitest';
import { disambiguate, slugify } from './slugify';

describe('slugify', () => {
  it('lowercases and replaces spaces', () => expect(slugify('Sex Persons')).toBe('sex_persons'));
  it('handles newline dot composite headers', () => expect(slugify('England\nCountry.count')).toBe('england_country_count'));
  it('replaces % with pct', () => expect(slugify('England\nCountry.%')).toBe('england_country_pct'));
  it('strips Nunjucks metacharacters', () => expect(slugify('}}{{evil}}')).toBe('evil'));
  it('strips HTML tags', () => expect(slugify('<script>alert(1)</script>')).toBe('script_alert_1_script'));
  it('returns col for empty input', () => expect(slugify('')).toBe('col'));
  it('returns col for whitespace-only', () => expect(slugify('   ')).toBe('col'));
  it('prefixes digit-starting slugs', () => expect(slugify('123abc')).toMatch(/^_/));
  it('truncates to 64 chars', () => expect(slugify('a'.repeat(200))).toHaveLength(64));
  it('leaves ONS codes safe', () => expect(slugify('E12000004')).toBe('e12000004'));
  it('replaces currency symbols', () => expect(slugify('£1234')).toBe('gbp_1234'));
});

describe('disambiguate', () => {
  it('returns base when not in set', () => expect(disambiguate('foo', new Set())).toBe('foo'));
  it('appends _2 on first collision', () => expect(disambiguate('foo', new Set(['foo']))).toBe('foo_2'));
  it('increments until clear', () => expect(disambiguate('foo', new Set(['foo', 'foo_2', 'foo_3']))).toBe('foo_4'));
});
