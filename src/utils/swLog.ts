function serialize(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

// Logs locally (page console) AND forwards to the SW console via runtime.sendMessage.
// SW logs survive window close, so this lets us inspect content-script state
// even when the task window is torn down before we can open DevTools.
export function swLog(...args: unknown[]): void {
  console.warn(...args);
  try {
    const msg = args.map(serialize).join(' ');
    browser.runtime.sendMessage({ type: '__SW_LOG__', payload: msg }).catch(() => {});
  } catch { /* extension context may be invalidated */ }
}
