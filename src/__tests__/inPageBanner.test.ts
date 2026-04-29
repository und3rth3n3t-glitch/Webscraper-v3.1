import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  showInPageBanner,
  hideInPageBanner,
  __testInternals,
} from '../content/pause/inPageBanner';
import { DetectionTrigger } from '../types/messages';

const sendMessageMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  sendMessageMock.mockClear();
  // Stub the browser global used by the banner.
  (globalThis as unknown as { browser: unknown }).browser = {
    runtime: { sendMessage: sendMessageMock },
  };
  // Ensure each test starts unmounted.
  hideInPageBanner();
});

afterEach(() => {
  hideInPageBanner();
});

function getShadowRoot(): ShadowRoot {
  const m = __testInternals.current;
  if (!m) throw new Error('banner not mounted');
  return m.shadow;
}

describe('inPageBanner', () => {
  it('mounts a single host element on show', () => {
    showInPageBanner({
      configName: 'Acme',
      taskId: 'task-1',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'Sign in.' },
    });
    expect(document.querySelectorAll('bb-pause-banner').length).toBe(1);
  });

  it('is idempotent across repeated show calls', () => {
    const opts = {
      configName: 'Acme',
      taskId: 'task-1',
      pause: { reason: 'awaitUserAction' as const, trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'Sign in.' },
    };
    showInPageBanner(opts);
    showInPageBanner(opts);
    expect(document.querySelectorAll('bb-pause-banner').length).toBe(1);
  });

  it('replaces content when shown with different args', () => {
    showInPageBanner({
      configName: 'Acme',
      taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'M1' },
    });
    showInPageBanner({
      configName: 'Beta',
      taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'M2' },
    });
    expect(getShadowRoot().textContent).toContain('Beta');
    expect(getShadowRoot().textContent).toContain('M2');
    expect(getShadowRoot().textContent).not.toContain('M1');
  });

  it('hide removes the host element', () => {
    showInPageBanner({
      configName: 'A', taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'X' },
    });
    hideInPageBanner();
    expect(document.querySelectorAll('bb-pause-banner').length).toBe(0);
    expect(__testInternals.current).toBeNull();
  });

  it('Continue click sends RESUME_AFTER_PAUSE with markAsFalseAlarm: false', () => {
    showInPageBanner({
      configName: 'A', taskId: 'task-xyz',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'X' },
    });
    const btn = getShadowRoot().querySelector('button')! as HTMLButtonElement;
    btn.click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'RESUME_AFTER_PAUSE',
      payload: { taskId: 'task-xyz', markAsFalseAlarm: false },
    });
  });

  it('Skip click sends markAsFalseAlarm: true', () => {
    showInPageBanner({
      configName: 'A', taskId: 'task-xyz',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'X' },
    });
    const buttons = getShadowRoot().querySelectorAll('button');
    expect(buttons.length).toBe(2);
    (buttons[1] as HTMLButtonElement).click();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'RESUME_AFTER_PAUSE',
      payload: { taskId: 'task-xyz', markAsFalseAlarm: true },
    });
  });

  it('Cloudflare pause hides Skip button', () => {
    showInPageBanner({
      configName: 'A', taskId: 't',
      pause: { reason: 'cloudflare' },
    });
    expect(getShadowRoot().querySelectorAll('button').length).toBe(1);
  });

  it('awaitUserAction without domain hides Skip button', () => {
    showInPageBanner({
      configName: 'A', taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, message: 'X' },
    });
    expect(getShadowRoot().querySelectorAll('button').length).toBe(1);
  });

  it('renders configName as textContent (no HTML execution)', () => {
    showInPageBanner({
      configName: '<img src=x onerror=alert(1)>',
      taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'X' },
    });
    expect(getShadowRoot().querySelector('img')).toBeNull();
    expect(getShadowRoot().textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('no-op in subframes (window !== window.top)', () => {
    const originalTop = (window as Window & { top: Window }).top;
    Object.defineProperty(window, 'top', { value: {} as Window, configurable: true });
    showInPageBanner({
      configName: 'A', taskId: 't',
      pause: { reason: 'awaitUserAction', trigger: DetectionTrigger.LOGIN_WALL, domain: 'a.test', message: 'X' },
    });
    expect(document.querySelectorAll('bb-pause-banner').length).toBe(0);
    Object.defineProperty(window, 'top', { value: originalTop, configurable: true });
  });
});
