import { describe, it, expect } from 'vitest';

// Unit-testable surface is small: the CDP module's externally observable
// behaviour is largely chrome.debugger calls (not testable in jsdom). We
// test only the pure helpers — keyCodeForKey / codeForKey — by
// re-importing them. They're not exported in the spec; expose them as
// internal helpers via a separate `cdpKeyMap.ts` if the test demands.
//
// For PR-Bot1 the smoke test plan covers behavioural verification.
// This file is a placeholder asserting the module loads cleanly in a
// jsdom environment without throwing.

describe('cdpInput', () => {
  it('imports without throwing', async () => {
    // Stub chrome global so the module's initialiser doesn't reference
    // undefined APIs. We don't need it to actually do anything.
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } },
      permissions: { contains: () => Promise.resolve(false), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
      debugger: { onDetach: { addListener: () => {} } },
    };
    const mod = await import('../background/cdpInput');
    expect(typeof mod.attachIfNeeded).toBe('function');
    expect(typeof mod.detach).toBe('function');
    expect(typeof mod.dispatchClick).toBe('function');
    expect(typeof mod.dispatchType).toBe('function');
    expect(typeof mod.dispatchPressKey).toBe('function');
    expect(typeof mod.isCdpEnabled).toBe('function');
    expect(typeof mod.initCdpModule).toBe('function');
  });

  it('isCdpEnabled returns false before init', async () => {
    const mod = await import('../background/cdpInput');
    expect(mod.isCdpEnabled()).toBe(false);
  });
});
