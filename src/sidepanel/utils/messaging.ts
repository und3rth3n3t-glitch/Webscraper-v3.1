export function sendToContent(type: string, payload: Record<string, unknown> = {}, frameId: number | null = null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const msg: Record<string, unknown> = { type, payload };
    if (frameId !== null) msg.frameId = frameId;

    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

export async function pingContentScript(): Promise<boolean> {
  try {
    const resp = await Promise.race([
      sendToContent('PING'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    return !!resp;
  } catch {
    return false;
  }
}

export async function getPageInfo(): Promise<{ url: string; title: string; domain: string } | null> {
  try {
    const resp = await sendToContent('GET_PAGE_INFO') as { payload?: { url: string; title: string; domain: string } };
    return resp?.payload || null;
  } catch {
    return null;
  }
}

export function onContentMessage(
  handler: (message: Record<string, unknown>, sender: chrome.runtime.MessageSender) => void,
): () => void {
  const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (sender.tab) {
      handler(message as Record<string, unknown>, sender);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function collectFrameResponses(
  type: string,
  { errorType, debounceMs = 1500, timeoutMs = 10_000 }: { errorType?: string; debounceMs?: number; timeoutMs?: number } = {},
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const results: unknown[] = [];
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      clearTimeout(debounce);
      clearTimeout(hard);
      stop();
      resolve(results);
    };

    const hard = setTimeout(finish, timeoutMs);

    const stop = onContentMessage((msg) => {
      if (msg.type === type) {
        results.push(msg.payload);
        clearTimeout(debounce);
        debounce = setTimeout(finish, debounceMs);
      } else if (errorType && msg.type === errorType && !debounce) {
        debounce = setTimeout(finish, debounceMs);
      }
    });
  });
}
