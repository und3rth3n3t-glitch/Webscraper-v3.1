import { describe, it, expect, beforeEach } from 'vitest';
import { resolveWithAlternate } from './elementResolution';
import type { SelectorDescriptor } from '../../types/config';

beforeEach(() => {
  document.body.innerHTML = '';
});

function descriptor(css: string): SelectorDescriptor {
  return { cssSelector: css } as SelectorDescriptor;
}

describe('resolveWithAlternate', () => {
  it('returns primary result when primary resolves', () => {
    document.body.innerHTML = `<button id="p">primary</button><button id="a">alt</button>`;
    const r = resolveWithAlternate(descriptor('#p'), descriptor('#a'));
    expect((r.element as HTMLElement)?.id).toBe('p');
  });

  it('falls back to alternate when primary fails', () => {
    document.body.innerHTML = `<button id="a">alt</button>`;
    const r = resolveWithAlternate(descriptor('#missing'), descriptor('#a'));
    expect((r.element as HTMLElement)?.id).toBe('a');
  });

  it('returns null result when both fail', () => {
    const r = resolveWithAlternate(descriptor('#missing'), descriptor('#alsoMissing'));
    expect(r.element).toBe(null);
    expect(r.confidence).toBe(0);
  });

  it('returns null result when primary fails and alternate is null', () => {
    const r = resolveWithAlternate(descriptor('#missing'), null);
    expect(r.element).toBe(null);
  });
});
