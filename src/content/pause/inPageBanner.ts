import { derivePauseCopy, type PauseInfo } from '../../common/pauseCopy';

export interface InPageBannerOpts {
  configName: string;
  taskId: string;
  pause: PauseInfo;
}

const HOST_TAG = 'bb-pause-banner';

interface MountedState {
  host: HTMLElement;
  shadow: ShadowRoot;
  contentRoot: HTMLDivElement;
}

let mounted: MountedState | null = null;

// Test-only handle. Production code should not read this. Tests use it to
// inspect the closed shadow root.
export const __testInternals: { current: MountedState | null } = { current: null };

const TOKENS_CSS = `
  /* Mirrors src/sidepanel/styles/index.css tokens — keep in sync. */
  :host {
    --bb-warning-light: #FFF8E1;
    --bb-warning: #F57F17;
    --bb-text-dark: #474747;
    --bb-text-light: #969696;
    --bb-purple-primary: #5F259F;
    --bb-bg-light: #F5F3F7;
    --bb-bg-hover: #EDE8F2;
    --bb-border: #E0D8E8;
    --bb-radius-sm: 4px;
    --bb-spacing-xs: 4px;
    --bb-spacing-sm: 8px;
    --bb-spacing-md: 12px;
    --bb-spacing-lg: 16px;
    --bb-font-size-xs: 11px;
    --bb-font-size-sm: 12px;
    --bb-font-size-base: 13px;
    all: initial;
  }
`;

const BANNER_CSS = `
  .root {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    background: var(--bb-warning-light);
    border-bottom: 3px solid var(--bb-warning);
    padding: var(--bb-spacing-sm) var(--bb-spacing-md);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    display: flex;
    gap: var(--bb-spacing-md);
    align-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--bb-text-dark);
    font-size: var(--bb-font-size-base);
    line-height: 1.4;
  }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 600; color: var(--bb-text-dark); margin-right: var(--bb-spacing-xs); }
  .message { font-size: var(--bb-font-size-sm); }
  .hint {
    margin-top: var(--bb-spacing-xs);
    font-size: var(--bb-font-size-xs);
    color: var(--bb-text-light);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--bb-spacing-xs);
    align-items: stretch;
    flex-shrink: 0;
  }
  button {
    background: var(--bb-bg-light);
    color: var(--bb-purple-primary);
    border: 1px solid var(--bb-border);
    border-radius: var(--bb-radius-sm);
    padding: var(--bb-spacing-xs) var(--bb-spacing-sm);
    font-size: var(--bb-font-size-xs);
    font-family: inherit;
    cursor: pointer;
    line-height: 1.4;
  }
  button:hover { background: var(--bb-bg-hover); }
  @media (max-width: 640px) {
    .root { flex-direction: column; align-items: stretch; }
    .actions { flex-direction: row; }
  }
`;

function buildSheet(): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(TOKENS_CSS + BANNER_CSS);
  return sheet;
}

function sendResume(taskId: string, markAsFalseAlarm: boolean): void {
  try {
    browser.runtime.sendMessage({
      type: 'RESUME_AFTER_PAUSE',
      payload: { taskId, markAsFalseAlarm },
    }).catch(() => { /* extension context may be invalidated */ });
  } catch {
    /* extension context may be invalidated */
  }
}

function renderInto(contentRoot: HTMLDivElement, opts: InPageBannerOpts): void {
  // Clear previous content (idempotent re-render).
  while (contentRoot.firstChild) contentRoot.removeChild(contentRoot.firstChild);

  const copy = derivePauseCopy(opts.pause);

  const root = document.createElement('div');
  root.className = 'root';

  const body = document.createElement('div');
  body.className = 'body';

  const titleLine = document.createElement('div');
  const titleStrong = document.createElement('strong');
  titleStrong.className = 'title';
  titleStrong.textContent = `${opts.configName}: ${copy.title}`;
  const messageSpan = document.createElement('span');
  messageSpan.className = 'message';
  messageSpan.textContent = copy.body;
  titleLine.appendChild(titleStrong);
  titleLine.appendChild(messageSpan);
  body.appendChild(titleLine);

  if (copy.hint) {
    const hintP = document.createElement('div');
    hintP.className = 'hint';
    hintP.textContent = copy.hint;
    body.appendChild(hintP);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.textContent = 'Continue';
  continueBtn.addEventListener('click', () => {
    hideInPageBanner();
    sendResume(opts.taskId, false);
  });
  actions.appendChild(continueBtn);

  if (copy.showSkipButton) {
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = `Skip ${copy.triggerLabel} on this site`;
    skipBtn.title = `Stop pausing for ${copy.triggerLabel} on ${copy.sanitizedDomain}`;
    skipBtn.addEventListener('click', () => {
      hideInPageBanner();
      sendResume(opts.taskId, true);
    });
    actions.appendChild(skipBtn);
  }

  root.appendChild(body);
  root.appendChild(actions);
  contentRoot.appendChild(root);
}

export function showInPageBanner(opts: InPageBannerOpts): void {
  // Top frame only — iframes don't get their own banner.
  if (window !== window.top) return;
  // Skip non-document contexts (defensive — content script shouldn't run here anyway).
  if (typeof document === 'undefined' || !document.documentElement) return;

  if (mounted) {
    renderInto(mounted.contentRoot, opts);
    return;
  }

  const host = document.createElement(HOST_TAG);
  // Style the host minimally — actual UI lives in the shadow root.
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;';

  const shadow = host.attachShadow({ mode: 'closed' });
  // Use adoptedStyleSheets so host CSP `style-src` does not block us.
  try {
    shadow.adoptedStyleSheets = [buildSheet()];
  } catch {
    // Fallback for environments without constructable stylesheets (e.g. some
    // older jsdom versions in tests). Inline <style> as a last resort.
    const style = document.createElement('style');
    style.textContent = TOKENS_CSS + BANNER_CSS;
    shadow.appendChild(style);
  }

  const contentRoot = document.createElement('div');
  shadow.appendChild(contentRoot);
  document.documentElement.appendChild(host);

  mounted = { host, shadow, contentRoot };
  __testInternals.current = mounted;

  renderInto(contentRoot, opts);
}

export function hideInPageBanner(): void {
  if (!mounted) return;
  try {
    mounted.host.remove();
  } catch { /* host already detached */ }
  mounted = null;
  __testInternals.current = null;
}
