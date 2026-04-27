import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getApiToken, setApiToken, clearApiToken } from '../sidepanel/utils/storage';

type Store = Record<string, unknown>;

function mockStorage(): Store {
  const store: Store = {};
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Store = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (obj: Store) => { Object.assign(store, obj); }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        }),
      },
    },
  } as unknown as typeof browser;
  return store;
}

describe('api token shim (bb_jwt → bb_api_token)', () => {
  beforeEach(() => {
    mockStorage();
  });

  it('returns null when neither key is set', async () => {
    expect(await getApiToken()).toBeNull();
  });

  it('reads from the new key when present', async () => {
    await browser.storage.local.set({ bb_api_token: 'wsk_new' });
    expect(await getApiToken()).toBe('wsk_new');
  });

  it('migrates from the legacy key on read and clears the old one', async () => {
    await browser.storage.local.set({ bb_jwt: 'wsk_legacy' });

    expect(await getApiToken()).toBe('wsk_legacy');

    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBe('wsk_legacy');
    expect(after.bb_jwt).toBeUndefined();
  });

  it('prefers the new key over the legacy one if both somehow exist', async () => {
    await browser.storage.local.set({ bb_api_token: 'wsk_new', bb_jwt: 'wsk_legacy' });
    expect(await getApiToken()).toBe('wsk_new');
  });

  it('setApiToken writes to the new key and clears the legacy one', async () => {
    await browser.storage.local.set({ bb_jwt: 'wsk_legacy' });
    await setApiToken('wsk_replacement');

    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBe('wsk_replacement');
    expect(after.bb_jwt).toBeUndefined();
  });

  it('clearApiToken removes both keys', async () => {
    await browser.storage.local.set({ bb_api_token: 'a', bb_jwt: 'b' });
    await clearApiToken();
    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBeUndefined();
    expect(after.bb_jwt).toBeUndefined();
  });
});
