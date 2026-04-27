import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateDetectionRules, runDetectorWatchdog } from '../content/detectionRules';
import { DetectionTrigger } from '../types/messages';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('evaluateDetectionRules', () => {
  beforeEach(() => {
    document.title = '';
    document.body.innerHTML = '';
  });

  it('with no rules returns unconditional fire (back-compat)', () => {
    expect(evaluateDetectionRules()).toEqual({ fired: true, trigger: 'unconditional' });
    expect(evaluateDetectionRules({})).toEqual({ fired: true, trigger: 'unconditional' });
  });

  it('loginWall fires when password input is visible', () => {
    setBody('<input type="password" style="width:200px;height:20px" />');
    // Force layout — jsdom returns 0,0 by default; stub getBoundingClientRect.
    const input = document.querySelector('input')!;
    input.getBoundingClientRect = () => ({ width: 200, height: 20, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) });
    Object.defineProperty(input, 'offsetParent', { get: () => document.body });
    expect(evaluateDetectionRules({ loginWall: true })).toEqual({ fired: true, trigger: 'loginWall' });
  });

  it('loginWall does not fire when password input is absent', () => {
    setBody('<input type="text" />');
    expect(evaluateDetectionRules({ loginWall: true })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('captcha fires for cloudflare challenge form', () => {
    setBody('<form id="challenge-form"></form>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for recaptcha iframe', () => {
    setBody('<iframe src="https://www.google.com/recaptcha/api2/anchor?..."></iframe>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for hcaptcha iframe', () => {
    setBody('<iframe src="https://newassets.hcaptcha.com/captcha/..."></iframe>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha fires for any element with data-sitekey', () => {
    setBody('<div data-sitekey="abc123"></div>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: true, trigger: 'captcha' });
  });

  it('captcha does not fire on plain page', () => {
    setBody('<p>nothing here</p>');
    expect(evaluateDetectionRules({ captcha: true })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('selector fires when present', () => {
    setBody('<div id="cookie-banner"></div>');
    expect(evaluateDetectionRules({ selector: '#cookie-banner' })).toEqual({ fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR });
  });

  it('selector does not fire when absent', () => {
    expect(evaluateDetectionRules({ selector: '#missing' })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('malformed selector is treated as not firing (no throw)', () => {
    expect(() => evaluateDetectionRules({ selector: '>><<' })).not.toThrow();
    expect(evaluateDetectionRules({ selector: '>><<' })).toEqual({ fired: false, trigger: 'unconditional' });
  });

  it('multiple rules: first match wins in deterministic order', () => {
    setBody(`
      <input type="password" id="pw" />
      <form id="challenge-form"></form>
      <div id="cookie-banner"></div>
    `);
    const input = document.querySelector('input')!;
    input.getBoundingClientRect = () => ({ width: 200, height: 20, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) });
    Object.defineProperty(input, 'offsetParent', { get: () => document.body });
    expect(
      evaluateDetectionRules({ loginWall: true, captcha: true, selector: '#cookie-banner' })
    ).toEqual({ fired: true, trigger: 'loginWall' });
  });

  it('cookieBanner fires when banner present', () => {
    setBody('<div id="onetrust-banner-sdk">Accept cookies</div>');
    const el = document.querySelector('#onetrust-banner-sdk')!;
    Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => document.body });
    (el as HTMLElement).getBoundingClientRect = () => ({ width: 100, height: 50, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 50, toJSON: () => ({}) } as DOMRect);
    expect(evaluateDetectionRules({ cookieBanner: true })).toEqual({ fired: true, trigger: DetectionTrigger.COOKIE_BANNER });
  });

  it('extraSelectors fires when matching element present', () => {
    setBody('<div class="custom-block">Blocked</div>');
    expect(evaluateDetectionRules({ extraSelectors: ['.custom-block'] })).toEqual({ fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR });
  });

  it('extraSelectors empty does not gate the pause (unconditional back-compat)', () => {
    setBody('');
    expect(evaluateDetectionRules({ extraSelectors: [] })).toEqual({ fired: true, trigger: DetectionTrigger.UNCONDITIONAL });
  });
});

// ── runDetectorWatchdog ───────────────────────────────────────────────────────

function stubVisible(el: Element): void {
  Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => document.body });
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 200, height: 20, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) } as DOMRect),
  });
}

describe('runDetectorWatchdog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = '';
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body; } });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true, value() { return { width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50 } as DOMRect; },
    });
  });

  it('returns no fire on clean page', () => {
    expect(runDetectorWatchdog()).toEqual({ fired: false, trigger: DetectionTrigger.UNCONDITIONAL });
  });

  it('detects cloudflare via challenge form', () => {
    document.body.innerHTML = '<form id="challenge-form"></form>';
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.CLOUDFLARE });
  });

  it('detects login wall via password input', () => {
    document.body.innerHTML = '<input type="password" />';
    stubVisible(document.querySelector('input')!);
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.LOGIN_WALL });
  });

  it('detects cookie banner', () => {
    document.body.innerHTML = '<div id="onetrust-banner-sdk">Cookies</div>';
    stubVisible(document.querySelector('#onetrust-banner-sdk')!);
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.COOKIE_BANNER });
  });

  it('cloudflare wins over loginWall (priority order)', () => {
    document.body.innerHTML = '<form id="challenge-form"><input type="password"/></form>';
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.CLOUDFLARE });
  });

  it('respects autoDetect.cloudflare = false', () => {
    document.body.innerHTML = '<form id="challenge-form"></form>';
    expect(runDetectorWatchdog({ cloudflare: false })).toEqual({ fired: false, trigger: DetectionTrigger.UNCONDITIONAL });
  });

  it('fires on extraSelectors match', () => {
    document.body.innerHTML = '<div class="custom-block">Blocked</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.custom-block'] }))
      .toEqual({ fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR });
  });

  it('skips extraSelectors when list is empty', () => {
    document.body.innerHTML = '<div></div>';
    expect(runDetectorWatchdog({ extraSelectors: [] })).toEqual({ fired: false, trigger: DetectionTrigger.UNCONDITIONAL });
  });
});
