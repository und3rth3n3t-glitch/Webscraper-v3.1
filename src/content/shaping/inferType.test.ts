import { describe, expect, it } from 'vitest';
import { inferType, parseValue } from './inferType';

describe('inferType', () => {
  it('infers number from plain decimals', () => expect(inferType(['100.0', '56.2']).type).toBe('number'));
  it('infers number with thousands', () => {
    const r = inferType(['56,490,048', '4,880,054']);
    expect(r.type).toBe('number');
    expect(r.format?.thousands).toBe(',');
  });
  it('infers percent', () => expect(inferType(['45.2%', '100.0%']).type).toBe('percent'));
  it('infers currency', () => {
    const r = inferType(['£1,234', '£5,678']);
    expect(r.type).toBe('currency');
    expect(r.format?.symbol).toBe('£');
  });
  it('infers boolean', () => expect(inferType(['Yes', 'No', 'Yes']).type).toBe('boolean'));
  it('infers ISO date', () => expect(inferType(['2024-01-15', '2023-06-01']).type).toBe('date'));
  it('returns text for ONS geography codes', () => expect(inferType(['E12000004', 'E12000005']).type).toBe('text'));
  it('returns text for leading-zero values', () => expect(inferType(['01234', '00789']).type).toBe('text'));
  it('returns text for header denylist match', () => expect(inferType(['123', '456'], ['area_code']).type).toBe('text'));
  it('stays numeric when ONS suppression markers mixed in', () => expect(inferType(['100.0', 'c', '56.2', ':']).type).toBe('number'));
  it('returns text for all-null markers', () => expect(inferType(['N/A', '—', '']).type).toBe('text'));
  it('skips inference for over-length cells', () => expect(inferType(['a'.repeat(1025)]).type).toBe('text'));
  it('ties (50/50) go to text', () => {
    const half = Array(5).fill('123').concat(Array(5).fill('abc'));
    expect(inferType(half).type).toBe('text');
  });
});

describe('parseValue', () => {
  it('parses number with thousands', () => expect(parseValue('56,490,048', 'number', { thousands: ',' })).toBe(56490048));
  it('parses percent', () => expect(parseValue('45.2%', 'percent')).toBe(45.2));
  it('returns null for ONS suppression markers', () => expect(parseValue('c', 'number')).toBeNull());
  it('parses boolean yes', () => expect(parseValue('Yes', 'boolean')).toBe(true));
  it('parses boolean no', () => expect(parseValue('No', 'boolean')).toBe(false));
  it('returns string for text type', () => expect(parseValue('hello', 'text')).toBe('hello'));
});
