import { DetectionTrigger } from '../types/messages';

export interface PauseInfo {
  reason: 'cloudflare' | 'awaitUserAction';
  message?: string;
  trigger?: DetectionTrigger;
  domain?: string;
}

export interface PauseCopy {
  title: string;
  body: string;
  hint: string | null;
  showSkipButton: boolean;
  triggerLabel: string;
  sanitizedDomain: string;
}

export const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'cookie banners',
  captcha: 'captchas',
  loginWall: 'sign-in prompts',
  customSelector: 'this',
  unconditional: 'this',
};

const CLOUDFLARE_BODY =
  'The site is showing a Cloudflare challenge. Complete it in the page (the scraper will wait) and click Continue when you’re through.';

const AWAIT_HINT =
  'Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you’re ready.';

const FALLBACK_BODY = 'Action needed in your browser.';

// Strip bidi overrides and zero-width directional marks, then clamp length.
// Defends against Unicode spoofing in the Skip button text ("Skip cookies on
// bank.com" being rewritten via RTL override to point at a different host).
// Ranges stripped:
//   ‎-‏  LTR / RTL marks
//   ‪-‮  bidi embedding + override chars
//   ⁦-⁩  bidi isolate chars
export function sanitizeDomain(domain: string | undefined): string {
  if (!domain) return '';
  return domain
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .slice(0, 80);
}

export function derivePauseCopy(info: PauseInfo): PauseCopy {
  const isCloudflare = info.reason === 'cloudflare';
  const sanitizedDomain = sanitizeDomain(info.domain);
  const triggerLabel = info.trigger ? (TRIGGER_LABEL[info.trigger] ?? 'this') : 'this';
  const showSkipButton =
    !isCloudflare && !!info.trigger && !!sanitizedDomain && info.trigger !== DetectionTrigger.CLOUDFLARE;

  return {
    title: isCloudflare ? 'Paused — security check' : 'Paused — action needed',
    body: isCloudflare ? CLOUDFLARE_BODY : (info.message ?? FALLBACK_BODY),
    hint: isCloudflare ? null : AWAIT_HINT,
    showSkipButton,
    triggerLabel,
    sanitizedDomain,
  };
}
