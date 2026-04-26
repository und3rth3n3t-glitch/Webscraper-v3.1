import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateDetectionRules } from '../content/detectionRules';

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
    expect(evaluateDetectionRules({ selector: '#cookie-banner' })).toEqual({ fired: true, trigger: 'selector' });
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
});
