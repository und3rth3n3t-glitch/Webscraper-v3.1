export type CloudflareChallengeType = 'cf-challenge' | 'cf-turnstile' | 'checking-browser';

export interface CloudflareChallenge {
  detected: boolean;
  type: CloudflareChallengeType | null;
}

const CF_PATTERNS: Array<{ type: CloudflareChallengeType; detect: () => boolean }> = [
  {
    type: 'cf-challenge',
    detect: () => document.querySelector('#challenge-form') !== null,
  },
  {
    type: 'cf-turnstile',
    detect: () => document.querySelector('.cf-turnstile[data-sitekey]') !== null,
  },
  {
    type: 'checking-browser',
    detect: () =>
      document.title.includes('Just a moment') ||
      (document.body?.textContent ?? '').includes('Checking your browser before accessing'),
  },
];

export function detectCloudflareChallenge(): CloudflareChallenge {
  for (const p of CF_PATTERNS) {
    if (p.detect()) return { detected: true, type: p.type };
  }
  return { detected: false, type: null };
}

/**
 * Polls until the challenge disappears. Returns a cancel function.
 * Debounces: challenge must be gone for minDebounceMs before resolving.
 */
export function waitForChallengeToClear(
  intervalMs = 800,
  minDebounceMs = 500,
): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let clearTime: number | null = null;

  const promise = new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (cancelled) {
        clearInterval(id);
        return;
      }
      const { detected } = detectCloudflareChallenge();
      if (!detected) {
        if (clearTime === null) clearTime = Date.now();
        if (Date.now() - clearTime >= minDebounceMs) {
          clearInterval(id);
          resolve();
        }
      } else {
        clearTime = null;
      }
    }, intervalMs);
  });

  return { promise, cancel: () => { cancelled = true; } };
}
