import { detectCloudflareChallenge } from './cloudflareDetector';
import { detectCookieBanner } from './cookieBannerDetector';
import { isVisible } from './visibility';
import { DetectionTrigger } from '../types/messages';
import type { DetectionRules, AutoDetectConfig } from '../types/config';

export interface DetectionResult {
  fired: boolean;
  trigger: DetectionTrigger;
}

const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]';

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

function extraSelectorsFire(selectors: string[]): boolean {
  return selectors.some(selectorFires);
}

// Empty rules preserve M1 back-compat (unconditional pause).
export function evaluateDetectionRules(rules?: DetectionRules): DetectionResult {
  if (!rules || (
    rules.loginWall === undefined &&
    rules.captcha === undefined &&
    rules.cookieBanner === undefined &&
    rules.selector === undefined &&
    (rules.extraSelectors === undefined || rules.extraSelectors.length === 0)
  )) {
    return { fired: true, trigger: DetectionTrigger.UNCONDITIONAL };
  }
  if (rules.loginWall && loginWallFires()) return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  if (rules.captcha && captchaFires()) return { fired: true, trigger: DetectionTrigger.CAPTCHA };
  if (rules.cookieBanner && detectCookieBanner()) return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
  if (rules.selector && selectorFires(rules.selector)) return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
  if (rules.extraSelectors && extraSelectorsFire(rules.extraSelectors)) {
    return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}

export interface WatchdogResult {
  fired: boolean;
  trigger: DetectionTrigger;
}

// Detector priority (first match wins):
//   cloudflare → loginWall → captcha → cookieBanner → extraSelectors
// Each detector disabled via `cfg.{name} === false`; default-on otherwise.
export function runDetectorWatchdog(cfg?: AutoDetectConfig): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;

  if (enabled('cloudflare') && detectCloudflareChallenge().detected) {
    return { fired: true, trigger: DetectionTrigger.CLOUDFLARE };
  }
  if (enabled('loginWall') && loginWallFires()) {
    return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  }
  // When cloudflare is explicitly disabled, don't let its detection leak through captchaFires().
  const captchaFired = enabled('captcha') && (
    enabled('cloudflare') ? captchaFires() : document.querySelector(CAPTCHA_SELECTOR) !== null
  );
  if (captchaFired) {
    return { fired: true, trigger: DetectionTrigger.CAPTCHA };
  }
  if (enabled('cookieBanner') && detectCookieBanner()) {
    return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
  }
  const extras = cfg?.extraSelectors ?? [];
  if (extras.length > 0 && extraSelectorsFire(extras)) {
    return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}
