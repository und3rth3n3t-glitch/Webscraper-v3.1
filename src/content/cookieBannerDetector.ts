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

const ROLE_DIALOG_KEYWORDS = ['cookie', 'consent', 'gdpr', 'privacy preferences'];

function matchesIdSelector(): boolean {
  for (const sel of ID_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return true;
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
  return matchesIdSelector() || matchesRoleDialogKeyword();
}
