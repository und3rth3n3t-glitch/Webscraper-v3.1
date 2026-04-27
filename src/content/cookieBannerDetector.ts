import { isVisible } from './visibility';

const ID_SELECTORS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#cookieyes',
  '#CybotCookiebotDialog',
  '#qc-cmp2-container',
  '#truste-consent-track',
  '[data-testid="cookie-banner"]',
  '[data-testid="consent-banner"]',
  '[data-cy="cookie-banner"]',
];

// Iframes used by consent management platforms to host their dialog UI.
// These are sandboxed so their inner DOM is inaccessible — we detect the
// iframe element itself instead.
//
// Quantcast intentionally NOT listed: the same domain serves CMP iframes AND
// ad/analytics iframes. We can't tell them apart by URL alone, so leaving it
// out avoids ad-driven false positives. If a Quantcast-hosted CMP becomes a
// problem in practice, add it back gated by a size threshold.
const CONSENT_IFRAME_SELECTORS = [
  'iframe[id^="sp_message_iframe"]',    // Sourcepoint (Guardian, Times, etc.)
  'iframe[src*="sourcepoint.com"]',
  'iframe[src*="consentframework.com"]',
  'iframe[src*="cookielaw.org"]',       // OneTrust CDN
  'iframe[src*="onetrust.com"]',
  'iframe[src*="usercentrics"]',
  'iframe[src*="didomi.io"]',
  'iframe[title*="cookie" i]',          // Accessibility-labelled consent iframes
  'iframe[title*="consent" i]',
  'iframe[title*="privacy" i]',
];

// Minimum iframe size to count as a consent dialog. Tracking pixels and
// 1×1 analytics iframes match SP/CMP URL patterns sometimes — exclude them.
const MIN_CONSENT_IFRAME_W = 200;
const MIN_CONSENT_IFRAME_H = 100;

const ROLE_DIALOG_KEYWORDS = ['cookie', 'consent', 'gdpr', 'privacy preferences'];

function matchesIdSelector(): boolean {
  for (const sel of ID_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return true;
  }
  return false;
}

function matchesConsentIframe(): boolean {
  for (const sel of CONSENT_IFRAME_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || !isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= MIN_CONSENT_IFRAME_W && rect.height >= MIN_CONSENT_IFRAME_H) {
      return true;
    }
  }
  return false;
}

function matchesRoleDialogKeyword(): boolean {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'));
  for (const d of dialogs) {
    if (!isVisible(d)) continue;
    const text = (d.textContent ?? '').toLowerCase();
    if (ROLE_DIALOG_KEYWORDS.some(k => text.includes(k))) return true;
  }
  return false;
}

export function detectCookieBanner(): boolean {
  return matchesIdSelector() || matchesConsentIframe() || matchesRoleDialogKeyword();
}
