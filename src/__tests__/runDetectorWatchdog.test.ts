import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDetectorWatchdog } from '../content/detectionRules';
import { DetectionTrigger } from '../types/messages';

// Mock the detector primitives so we control which fires.
vi.mock('../content/cloudflareDetector', () => ({
  detectCloudflareChallenge: vi.fn(() => ({ detected: false })),
  waitForChallengeToClear: vi.fn(),
}));

vi.mock('../content/cookieBannerDetector', () => ({
  detectCookieBanner: vi.fn(() => false),
}));

vi.mock('../content/visibility', () => ({
  isVisible: vi.fn(() => true),
}));

import { detectCloudflareChallenge } from '../content/cloudflareDetector';
import { detectCookieBanner } from '../content/cookieBannerDetector';

describe('runDetectorWatchdog — mode: all (default)', () => {
  beforeEach(() => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: false });
    vi.mocked(detectCookieBanner).mockReturnValue(false);
    document.body.innerHTML = '';
  });

  it('returns no-fire when nothing matches', () => {
    expect(runDetectorWatchdog()).toEqual({ fired: false, trigger: DetectionTrigger.UNCONDITIONAL });
  });

  it('fires on cloudflare when detected', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.CLOUDFLARE });
  });

  it('fires on loginWall when password input visible', () => {
    document.body.innerHTML = '<input type="password" />';
    expect(runDetectorWatchdog()).toEqual({ fired: true, trigger: DetectionTrigger.LOGIN_WALL });
  });

  it('fires on cookieBanner in mode=all', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog(undefined, 'all')).toEqual({ fired: true, trigger: DetectionTrigger.COOKIE_BANNER });
  });

  it('fires on extraSelectors when present', () => {
    document.body.innerHTML = '<div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] })).toEqual({
      fired: true,
      trigger: DetectionTrigger.CUSTOM_SELECTOR,
    });
  });

  it('respects per-config disable for cookieBanner', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog({ cookieBanner: false })).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('respects per-config disable for cloudflare', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog({ cloudflare: false })).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });
});

describe('runDetectorWatchdog — mode: confirmedOnly', () => {
  beforeEach(() => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: false });
    vi.mocked(detectCookieBanner).mockReturnValue(false);
    document.body.innerHTML = '';
  });

  it('still fires on cloudflare', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CLOUDFLARE,
    });
  });

  it('still fires on loginWall', () => {
    document.body.innerHTML = '<input type="password" />';
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.LOGIN_WALL,
    });
  });

  it('still fires on extraSelectors', () => {
    document.body.innerHTML = '<div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] }, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CUSTOM_SELECTOR,
    });
  });

  it('SUPPRESSES cookieBanner detection even when match exists', () => {
    vi.mocked(detectCookieBanner).mockReturnValue(true);
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('SUPPRESSES captcha detection even when match exists', () => {
    document.body.innerHTML = '<iframe src="https://www.google.com/recaptcha/foo"></iframe>';
    expect(runDetectorWatchdog(undefined, 'confirmedOnly')).toEqual({
      fired: false,
      trigger: DetectionTrigger.UNCONDITIONAL,
    });
  });

  it('priority: cloudflare beats both speculative and confirmed siblings', () => {
    vi.mocked(detectCloudflareChallenge).mockReturnValue({ detected: true });
    document.body.innerHTML = '<input type="password" /><div class="paywall">x</div>';
    expect(runDetectorWatchdog({ extraSelectors: ['.paywall'] }, 'confirmedOnly')).toEqual({
      fired: true,
      trigger: DetectionTrigger.CLOUDFLARE,
    });
  });
});
