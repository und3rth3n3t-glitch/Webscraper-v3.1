const PREFS_KEY = 'blueberry_scraper_prefs';
const PREF_NAME = 'debug';

let cached = false;
let initialised = false;

export async function ensureDebugInit(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = (result[PREFS_KEY] as Record<string, unknown>) || {};
    cached = !!prefs[PREF_NAME];
  } catch { /* keep default false */ }

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(PREFS_KEY in changes)) return;
      const newPrefs = (changes[PREFS_KEY].newValue as Record<string, unknown>) || {};
      cached = !!newPrefs[PREF_NAME];
    });
  } catch { /* not all contexts have storage.onChanged */ }
}

export function dbg(...args: unknown[]): void {
  if (cached) console.log(...args);
}
