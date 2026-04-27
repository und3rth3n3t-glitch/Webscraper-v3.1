import { detectCloudflareChallenge } from './cloudflareDetector';
import { detectCookieBanner } from './cookieBannerDetector';
import { isVisible } from './visibility';
import { DetectionTrigger } from '../types/messages';
import type { DetectionRules, AutoDetectConfig } from '../types/config';
import { initDetectionMemoryCache, getCachedIgnoredTriggers } from './detectionMemoryCache';

// Initialise once per content-script lifetime.
initDetectionMemoryCache();

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

export type WatchdogMode = 'all' | 'confirmedOnly';

// Detector priority (first match wins):
//   cloudflare → loginWall → [captcha → cookieBanner] → extraSelectors
// Each detector disabled via `cfg.{name} === false`; default-on otherwise.
//
// Two tiers:
//   - "confirmed" (cloudflare, loginWall, extraSelectors): run on cold-start
//     and after navigation. These genuinely block content.
//   - "speculative" (captcha, cookieBanner): only run after a step has failed.
//     They often false-positive (cookie banner that doesn't actually block,
//     captcha widget in a non-blocking footer). Demoting them here cuts the
//     false-positive rate dramatically without losing real blockers — if a
//     banner DOES block a step, the post-failure watchdog catches it.
export function runDetectorWatchdog(
  cfg?: AutoDetectConfig,
  mode: WatchdogMode = 'all',
): WatchdogResult {
  const enabled = (k: keyof AutoDetectConfig): boolean => cfg?.[k] !== false;
  const ignored = new Set(getCachedIgnoredTriggers(window.location.hostname));
  const notIgnored = (t: DetectionTrigger): boolean => !ignored.has(t);

  if (enabled('cloudflare') && notIgnored(DetectionTrigger.CLOUDFLARE) && detectCloudflareChallenge().detected) {
    return { fired: true, trigger: DetectionTrigger.CLOUDFLARE };
  }
  if (enabled('loginWall') && notIgnored(DetectionTrigger.LOGIN_WALL) && loginWallFires()) {
    return { fired: true, trigger: DetectionTrigger.LOGIN_WALL };
  }

  if (mode === 'all') {
    const captchaFired = enabled('captcha') && notIgnored(DetectionTrigger.CAPTCHA) && (
      enabled('cloudflare') ? captchaFires() : document.querySelector(CAPTCHA_SELECTOR) !== null
    );
    if (captchaFired) {
      return { fired: true, trigger: DetectionTrigger.CAPTCHA };
    }
    if (enabled('cookieBanner') && notIgnored(DetectionTrigger.COOKIE_BANNER) && detectCookieBanner()) {
      return { fired: true, trigger: DetectionTrigger.COOKIE_BANNER };
    }
  }

  if (notIgnored(DetectionTrigger.CUSTOM_SELECTOR)) {
    const extras = cfg?.extraSelectors ?? [];
    if (extras.length > 0 && extraSelectorsFire(extras)) {
      return { fired: true, trigger: DetectionTrigger.CUSTOM_SELECTOR };
    }
  }
  return { fired: false, trigger: DetectionTrigger.UNCONDITIONAL };
}
