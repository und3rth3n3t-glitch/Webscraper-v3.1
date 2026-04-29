import { describe, it, expect } from 'vitest';
import { derivePauseCopy, sanitizeDomain, TRIGGER_LABEL } from '../common/pauseCopy';
import { DetectionTrigger } from '../types/messages';

describe('sanitizeDomain', () => {
  it('passes through plain domains', () => {
    expect(sanitizeDomain('acme.test')).toBe('acme.test');
  });
  it('strips ASCII control chars', () => {
    expect(sanitizeDomain('ab.test')).toBe('ab.test');
  });
  it('strips bidi override chars', () => {
    expect(sanitizeDomain('bank‮evil.com')).toBe('bankevil.com');
  });
  it('strips zero-width LTR/RTL marks', () => {
    expect(sanitizeDomain('a‎b.test')).toBe('ab.test');
  });
  it('clamps to 80 chars', () => {
    const long = 'a'.repeat(120) + '.test';
    expect(sanitizeDomain(long).length).toBe(80);
  });
  it('returns empty for undefined / empty', () => {
    expect(sanitizeDomain(undefined)).toBe('');
    expect(sanitizeDomain('')).toBe('');
  });
});

describe('derivePauseCopy', () => {
  it('Cloudflare → security check title, no skip, no hint', () => {
    const copy = derivePauseCopy({ reason: 'cloudflare' });
    expect(copy.title).toBe('Paused — security check');
    expect(copy.hint).toBeNull();
    expect(copy.showSkipButton).toBe(false);
    expect(copy.body).toMatch(/Cloudflare/);
  });

  it('awaitUserAction with login wall + domain → action needed, skip visible', () => {
    const copy = derivePauseCopy({
      reason: 'awaitUserAction',
      trigger: DetectionTrigger.LOGIN_WALL,
      domain: 'acme.test',
      message: 'Sign in to continue.',
    });
    expect(copy.title).toBe('Paused — action needed');
    expect(copy.body).toBe('Sign in to continue.');
    expect(copy.hint).not.toBeNull();
    expect(copy.showSkipButton).toBe(true);
    expect(copy.triggerLabel).toBe(TRIGGER_LABEL[DetectionTrigger.LOGIN_WALL]);
    expect(copy.sanitizedDomain).toBe('acme.test');
  });

  it('awaitUserAction missing trigger → no skip', () => {
    const copy = derivePauseCopy({ reason: 'awaitUserAction', message: 'X', domain: 'a.test' });
    expect(copy.showSkipButton).toBe(false);
  });

  it('awaitUserAction missing domain → no skip', () => {
    const copy = derivePauseCopy({
      reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, message: 'X',
    });
    expect(copy.showSkipButton).toBe(false);
  });

  it('awaitUserAction missing message → fallback body', () => {
    const copy = derivePauseCopy({
      reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test',
    });
    expect(copy.body).toBe('Action needed in your browser.');
  });

  it('unknown trigger → triggerLabel "this"', () => {
    const copy = derivePauseCopy({
      reason: 'awaitUserAction',
      trigger: 'somethingElse' as DetectionTrigger,
      domain: 'a.test',
      message: 'X',
    });
    expect(copy.triggerLabel).toBe('this');
  });
});
