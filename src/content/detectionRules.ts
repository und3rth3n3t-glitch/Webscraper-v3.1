import { detectCloudflareChallenge } from './cloudflareDetector';
import type { DetectionRules } from '../types/config';

export type DetectionTrigger = 'loginWall' | 'captcha' | 'selector' | 'unconditional';

export interface DetectionResult {
  fired: boolean;
  trigger: DetectionTrigger;
}

const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]';

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.offsetParent === null && getComputedStyle(html).position !== 'fixed') return false;
  const rect = html.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function loginWallFires(): boolean {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
  return inputs.some(isVisible);
}

function captchaFires(): boolean {
  if (detectCloudflareChallenge().detected) return true;
  return document.querySelector(CAPTCHA_SELECTOR) !== null;
}

function selectorFires(selector: string): boolean {
  try {
    return document.querySelector(selector) !== null;
  } catch {
    return false;
  }
}

/**
 * Evaluates detection rules against the current document.
 * Returns `{ fired: true, trigger }` for the first rule that matches
 * (deterministic order: loginWall → captcha → selector).
 * If no rules are provided, returns `{ fired: true, trigger: 'unconditional' }`
 * to preserve M1 back-compat (a hard pause).
 * If rules are provided but none fire, returns `{ fired: false, trigger: 'unconditional' }`.
 */
export function evaluateDetectionRules(rules?: DetectionRules): DetectionResult {
  if (!rules || (rules.loginWall === undefined && rules.captcha === undefined && rules.selector === undefined)) {
    return { fired: true, trigger: 'unconditional' };
  }
  if (rules.loginWall && loginWallFires()) return { fired: true, trigger: 'loginWall' };
  if (rules.captcha && captchaFires()) return { fired: true, trigger: 'captcha' };
  if (rules.selector && selectorFires(rules.selector)) return { fired: true, trigger: 'selector' };
  return { fired: false, trigger: 'unconditional' };
}
