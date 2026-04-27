import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectCookieBanner } from '../content/cookieBannerDetector';

function setHtml(html: string): void {
  document.body.innerHTML = html;
}

function stubVisibleAll(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body; } });
  (HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ width: 100, height: 50, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 50, toJSON: () => ({}) } as DOMRect);
}

beforeEach(() => {
  setHtml('');
  stubVisibleAll();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('detectCookieBanner', () => {
  it('returns false on empty page', () => {
    expect(detectCookieBanner()).toBe(false);
  });

  it('detects OneTrust banner by id', () => {
    setHtml('<div id="onetrust-banner-sdk">Accept cookies</div>');
    expect(detectCookieBanner()).toBe(true);
  });

  it('detects Quantcast container by id', () => {
    setHtml('<div id="qc-cmp2-container">Privacy choices</div>');
    expect(detectCookieBanner()).toBe(true);
  });

  it('detects role=dialog with cookies keyword', () => {
    setHtml('<div role="dialog">We use cookies on this site...</div>');
    expect(detectCookieBanner()).toBe(true);
  });

  it('detects role=alertdialog with consent keyword', () => {
    setHtml('<div role="alertdialog">Privacy preferences and consent</div>');
    expect(detectCookieBanner()).toBe(true);
  });

  it('does not match unrelated dialogs', () => {
    setHtml('<div role="dialog">Newsletter signup</div>');
    expect(detectCookieBanner()).toBe(false);
  });

  it('does not match plain text containing the word cookie', () => {
    setHtml('<p>Recipe: chocolate chip cookies</p>');
    expect(detectCookieBanner()).toBe(false);
  });
});
