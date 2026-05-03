import type { BackgroundContext, MessageHandler } from './types';

export function authHandlers(_ctx: BackgroundContext): Record<string, MessageHandler> {
  return {
    // Sidepanel: SW-routed authenticated login.
    //
    // Runs in the service worker so credentials:'include' lands the host's
    // session cookie in Chrome's main cookie jar. That jar is shared across
    // all extension contexts (sidepanel, SW, offscreen) — subsequent
    // API_FETCH calls and the offscreen SignalR connection inherit it
    // without needing a bearer token. SHA-512 pre-hash matches what the
    // BBWT3 SPA sends to /api/account/login.
    AUTH_LOGIN: (message, _sender, sendResponse) => {
      const p = (message.payload ?? {}) as { serverUrl: string; email: string; password: string };
      (async () => {
        try {
          const pwBytes = new TextEncoder().encode(p.password);
          const pwHash = await crypto.subtle.digest('SHA-512', pwBytes);
          const pwHex = Array.from(new Uint8Array(pwHash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

          const res = await fetch(`${p.serverUrl}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email: p.email, password: pwHex }),
          });

          if (!res.ok) {
            const code = res.status === 401 ? 'invalid_credentials' : 'login_failed';
            sendResponse({ ok: false, error: code, status: res.status });
            return;
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: 'network_error', message: (err as Error).message });
        }
      })();
      return true;
    },

    // Sidepanel: SW-routed authenticated API fetch.
    //
    // Generic wrapper used by the sidepanel for any host API call that needs
    // the session cookie. The cookie auto-attaches via credentials:'include'
    // because the SW (and Chrome's cookie jar) already holds it from
    // AUTH_LOGIN — no manual cookie forwarding needed.
    API_FETCH: (message, _sender, sendResponse) => {
      const p = (message.payload ?? {}) as {
        serverUrl: string;
        path: string;
        options?: RequestInit;
      };
      (async () => {
        try {
          // BBWT3 enables AutoValidateAntiforgeryTokenAttribute globally, so
          // non-GET requests need the XSRF-TOKEN cookie value mirrored as the
          // X-XSRF-TOKEN header. Mirrors what the host SPA's HttpClient
          // interceptor does. GET requests are not antiforgery-protected.
          const method = (p.options?.method ?? 'GET').toUpperCase();
          const xsrfHeader: Record<string, string> = {};
          if (method !== 'GET' && method !== 'HEAD') {
            try {
              const cookie = await chrome.cookies.get({ url: p.serverUrl, name: 'XSRF-TOKEN' });
              if (cookie?.value) xsrfHeader['X-XSRF-TOKEN'] = decodeURIComponent(cookie.value);
            } catch { /* best effort — backend will 400 if missing and required */ }
          }
          const res = await fetch(`${p.serverUrl}${p.path}`, {
            ...p.options,
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...xsrfHeader,
              ...(p.options?.headers ?? {}),
            },
          });
          if (!res.ok) {
            sendResponse({ ok: false, error: `Request failed: ${res.status}`, status: res.status });
            return;
          }
          // Some endpoints (e.g. logout) return no body. Try JSON first,
          // fall back to null.
          const text = await res.text();
          const data = text ? JSON.parse(text) : null;
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    },
  };
}
