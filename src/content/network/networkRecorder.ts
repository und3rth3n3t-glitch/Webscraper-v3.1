// Runs in MAIN world. Communicates to ISOLATED world via postMessage + nonce.
// Nonce is set on window.__bb_nonce by the ISOLATED content script at startup.

export interface RecordedApiCall {
  id: string;
  url: string;
  method: string;
  statusCode: number;
  responseBodyJson?: unknown;
  capturedAt: string;
}

class NetworkRecorder {
  private active = false;
  private pattern: RegExp | null = null;
  private readonly originalFetch = window.fetch;
  private readonly originalXhrOpen = XMLHttpRequest.prototype.open;
  private readonly originalXhrSend = XMLHttpRequest.prototype.send;

  start(urlPattern?: string): void {
    if (this.active) return;
    this.active = true;
    this.pattern = urlPattern ? new RegExp(urlPattern) : null;
    this.patchFetch();
    this.patchXhr();
  }

  stop(): void {
    this.active = false;
  }

  private getNonce(): string {
    return (window as Window & { __bb_nonce?: string }).__bb_nonce ?? '';
  }

  private emit(call: RecordedApiCall): void {
    if (!this.active) return;
    if (this.pattern && !this.pattern.test(call.url)) return;
    window.postMessage({ type: '__bb_network_event', nonce: this.getNonce(), call }, '*');
  }

  private patchFetch(): void {
    const self = this;
    const original = this.originalFetch;

    const proxy = new Proxy(original, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        const req = args[0];
        const url =
          typeof req === 'string'
            ? req
            : req instanceof URL
              ? req.toString()
              : (req as Request).url;
        const method = (req instanceof Request ? req.method : 'GET').toUpperCase();

        return Reflect.apply(target, thisArg, args).then(async (response: Response) => {
          if (self.active) {
            const clone = response.clone();
            const ct = clone.headers.get('content-type') ?? '';
            if (ct.includes('application/json')) {
              clone
                .json()
                .then((body: unknown) => {
                  self.emit({
                    id: crypto.randomUUID(),
                    url,
                    method,
                    statusCode: response.status,
                    responseBodyJson: body,
                    capturedAt: new Date().toISOString(),
                  });
                })
                .catch(() => { /* non-JSON or read error */ });
            }
          }
          return response;
        });
      },
    });

    // Forge toString so bot-detection scripts see native code signature
    Object.defineProperty(proxy, 'toString', {
      value: () => 'function fetch() { [native code] }',
      configurable: true,
    });

    window.fetch = proxy;
  }

  private patchXhr(): void {
    const self = this;

    type XhrWithMeta = XMLHttpRequest & { __bb_method?: string; __bb_url?: string };

    XMLHttpRequest.prototype.open = function (
      this: XhrWithMeta,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      this.__bb_method = method.toUpperCase();
      this.__bb_url = url.toString();
      return self.originalXhrOpen.call(this, method, url, async !== undefined ? async : true, username ?? null, password ?? null);
    };

    XMLHttpRequest.prototype.send = function (
      this: XhrWithMeta,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      this.addEventListener('load', function (this: XhrWithMeta) {
        if (!self.active) return;
        const ct = this.getResponseHeader('content-type') ?? '';
        if (!ct.includes('application/json')) return;
        try {
          const parsed: unknown = JSON.parse(this.responseText);
          self.emit({
            id: crypto.randomUUID(),
            url: this.__bb_url ?? '',
            method: this.__bb_method ?? 'GET',
            statusCode: this.status,
            responseBodyJson: parsed,
            capturedAt: new Date().toISOString(),
          });
        } catch { /* malformed JSON */ }
      });
      return self.originalXhrSend.call(this, body);
    };
  }
}

const recorder = new NetworkRecorder();
(window as Window & { __bb_recorder?: NetworkRecorder }).__bb_recorder = recorder;

// Listen for start/stop commands from ISOLATED world (sent by scrapingEngine)
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as { type?: string; nonce?: string; urlPattern?: string } | null;
  if (!msg || typeof msg.type !== 'string') return;

  const expectedNonce = (window as Window & { __bb_nonce?: string }).__bb_nonce;
  if (!expectedNonce || msg.nonce !== expectedNonce) return;

  if (msg.type === '__bb_start_recording') {
    recorder.start(msg.urlPattern);
  } else if (msg.type === '__bb_stop_recording') {
    recorder.stop();
  }
});
