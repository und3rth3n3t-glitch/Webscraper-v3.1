import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./elementResolution', () => ({
  resolveElement: vi.fn(),
  resolveWithAlternate: vi.fn(),
}));

import { resolveElement } from './elementResolution';
import { evaluateCondition } from './scrapingEngine';
import type { StepCondition } from '../../types/config';

const resolveElementMock = resolveElement as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolveElementMock.mockReset();
  Object.defineProperty(window, 'location', {
    value: { href: 'https://example.com/page?x=1' },
    writable: true,
  });
});

describe('evaluateCondition', () => {
  it('returns true when URL pattern matches', () => {
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'example\\.com' };
    expect(evaluateCondition(cond)).toBe(true);
  });

  it('returns false when URL pattern does not match', () => {
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'nope\\.test' };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('flips result when negate is true', () => {
    const cond: StepCondition = { kind: 'urlMatches', pattern: 'example', negate: true };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('returns false when regex pattern is invalid (fail-closed)', () => {
    const cond: StepCondition = { kind: 'urlMatches', pattern: '[unclosed' };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('returns true when elementPresent resolves with confidence > 0', () => {
    resolveElementMock.mockReturnValue({ element: {} as Element, confidence: 0.5, strategy: 'css' });
    const cond: StepCondition = {
      kind: 'elementPresent',
      selector: { cssSelector: '.x' } as never,
    };
    expect(evaluateCondition(cond)).toBe(true);
  });

  it('returns false when elementPresent resolves with confidence 0', () => {
    resolveElementMock.mockReturnValue({ element: null, confidence: 0, strategy: 'none' });
    const cond: StepCondition = {
      kind: 'elementPresent',
      selector: { cssSelector: '.x' } as never,
    };
    expect(evaluateCondition(cond)).toBe(false);
  });

  it('flips elementPresent result when negate is true', () => {
    resolveElementMock.mockReturnValue({ element: null, confidence: 0, strategy: 'none' });
    const cond: StepCondition = {
      kind: 'elementPresent',
      selector: { cssSelector: '.x' } as never,
      negate: true,
    };
    expect(evaluateCondition(cond)).toBe(true);
  });
});
