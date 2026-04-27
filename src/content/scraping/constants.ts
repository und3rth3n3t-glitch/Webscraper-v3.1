// ── Pre-flight quiet timer ──
//
// Default duration (ms) of the watchdog-quiet window before a task is
// considered pre-flight ready (auth/cloudflare/cookie/captcha gates cleared
// and page stable). Reset on every detector fire; restarted after every
// Continue click. PR4/PR5 will read an override from the settings store
// (`batchPreflightQuietMs`); PR3 ships the constant only.
export const PREFLIGHT_QUIET_MS = 5000;
