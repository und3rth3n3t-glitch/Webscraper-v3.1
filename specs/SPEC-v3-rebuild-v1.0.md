# SPEC-v3-rebuild-v1.0
## Blueberry Web Scraper V3 — Implementation Spec

---

## Decisions Summary (Stages A–E)

### Stack
- React 18 + Zustand + TypeScript strict
- WXT build system (replaces 4 Vite configs); Chrome + Firefox + Edge
- dependency-cruiser architecture enforcement (carried forward + new rules)
- Build-time theming via `theme.config.ts` per client

### New capabilities
- SignalR-based task queue (extension is a distributed worker)
- Offscreen document holds persistent SignalR WS (Chrome); WXT background page (Firefox)
- AFK execution: user logs in, walks away, extension runs unattended
- Cloudflare/bot detection: pause flow + SignalR notify + auto-detect-cleared (500ms debounce)
- Human replication: Fitts' Law mouse model + noise; `afk: true` suppresses path (no path safer than detectable path)
- Network recording: ES Proxy intercept of fetch/XHR in MAIN world; nonce-based postMessage verification
- 2 new step types: `captureApiCalls`, `awaitUserAction`
- Visual data mapping UI: post-run column rename/reorder/toggle
- API result push: POST `TaskResult` to backend REST
- Session-level pacing: inter-iteration pause + periodic idle

### Security additions
- networkRecorder uses ES Proxy (not direct patch) to avoid native-global detection
- Nonce-based postMessage verification (MAIN → ISOLATED)
- QueueTask shape validation on receipt
- Backend URL `https://` enforcement

### CSS
- App.css split into partials (tokens, layout, buttons, forms, cards, etc.)
- 4 new modifier classes only: `.detection-banner--warning`, `.card--active`, `.form-input--inline`, `.type-badge--await` / `.type-badge--capture`

---

## Step 0: New Repo Bootstrap

```bash
# Create new repo at sibling location to V2
mkdir C:\Users\und3r\blueberry-v3
cd C:\Users\und3r\blueberry-v3
git init
npm create wxt@latest . -- --template react-ts
# When prompted: project name "blueberry-v3", TypeScript, React

# Install dependencies
npm install zustand @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities lucide-react @microsoft/signalr
npm install -D dependency-cruiser vitest @vitest/ui jsdom @testing-library/react

# Create directory structure
mkdir -p src/types src/offscreen src/content/scraping src/content/extraction
mkdir -p src/content/picker src/content/network
mkdir -p src/sidepanel/stores src/sidepanel/views src/sidepanel/components
mkdir -p src/sidepanel/utils src/sidepanel/styles src/themes src/common
mkdir -p specs
```

**First implementation action:** copy this spec file to `specs/SPEC-v3-rebuild-v1.0.md`.

---

## File: `wxt.config.ts`

```typescript
import { defineConfig } from 'wxt';
import { readFileSync } from 'fs';

const themeName = process.env.BLUEBERRY_THEME ?? 'blueberry';

export default defineConfig({
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Blueberry Web Scraper',
    description: 'Record and execute web scraping flows',
    version: '3.0.0',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen'],
    host_permissions: ['<all_urls>'],
    side_panel: { default_path: 'sidepanel/index.html' },
    action: { default_title: 'Open Blueberry Scraper' },
  },

  vite: () => ({
    define: {
      __THEME_NAME__: JSON.stringify(themeName),
    },
  }),
});
```

**Entrypoints** are declared as files/folders under `src/entrypoints/` per WXT convention:
- `src/entrypoints/background.ts` — service worker
- `src/entrypoints/offscreen.html` + `src/entrypoints/offscreen/main.ts`
- `src/entrypoints/content.ts` — ISOLATED world (matches `<all_urls>`, all_frames)
- `src/entrypoints/chart-bridge.ts` — MAIN world (matches `<all_urls>`, all_frames)
- `src/entrypoints/network-recorder.ts` — MAIN world (matches `<all_urls>`, all_frames)
- `src/entrypoints/sidepanel/index.html` + `src/entrypoints/sidepanel/main.tsx`

---

## File: `package.json` (scripts section)

```json
{
  "scripts": {
    "dev": "wxt",
    "dev:chrome": "wxt --browser chrome",
    "dev:firefox": "wxt --browser firefox",
    "build": "wxt build",
    "build:chrome": "wxt build --browser chrome",
    "build:firefox": "wxt build --browser firefox",
    "build:theme": "cross-env BLUEBERRY_THEME=${THEME:-blueberry} wxt build",
    "type-check": "tsc --noEmit",
    "lint": "eslint src/ --ext .ts,.tsx",
    "deps:check": "depcruise src/",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "wxt prepare"
  }
}
```

---

## File: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "types": ["chrome", "wxt/browser"]
  },
  "include": ["src/**/*", ".wxt/types/**/*"]
}
```

---

## File: `.dependency-cruiser.cjs`

```javascript
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── V2 rules (carried forward) ──────────────────────────────
    {
      name: 'no-content-to-sidepanel',
      severity: 'error',
      from: { path: '^src/entrypoints/content|^src/content' },
      to:   { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
    },
    {
      name: 'no-sidepanel-to-content',
      severity: 'error',
      from: { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
      to:   { path: '^src/content|^src/entrypoints/content' },
    },
    {
      name: 'no-content-to-background',
      severity: 'error',
      from: { path: '^src/content|^src/entrypoints/content' },
      to:   { path: '^src/entrypoints/background' },
    },
    {
      name: 'no-sidepanel-to-background',
      severity: 'error',
      from: { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
      to:   { path: '^src/entrypoints/background' },
    },
    {
      name: 'no-background-to-sidepanel',
      severity: 'error',
      from: { path: '^src/entrypoints/background' },
      to:   { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
    },
    {
      name: 'no-background-to-content',
      severity: 'error',
      from: { path: '^src/entrypoints/background' },
      to:   { path: '^src/content|^src/entrypoints/content' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to:   { circular: true },
    },
    {
      name: 'no-store-reverse-imports',
      severity: 'error',
      from: { path: '^src/sidepanel/stores/configStore' },
      to:   { path: '^src/sidepanel/stores/(uiStore|runStore|settingsStore|queueStore|networkRecordStore)' },
    },
    {
      name: 'no-npm-in-content',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { dependencyTypes: ['npm'], pathNot: '^src/types' },
    },
    // ── V3 new rules ────────────────────────────────────────────
    {
      name: 'no-offscreen-to-content',
      severity: 'error',
      from: { path: '^src/entrypoints/offscreen|^src/offscreen' },
      to:   { path: '^src/content' },
    },
    {
      name: 'no-content-to-offscreen',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { path: '^src/offscreen' },
    },
    {
      name: 'no-signalr-in-content',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { path: '@microsoft/signalr' },
    },
    {
      name: 'no-network-recorder-in-isolated',
      severity: 'error',
      from: { path: '^src/content/(scraping|extraction|picker)' },
      to:   { path: '^src/content/network' },
    },
    {
      name: 'no-npm-in-types',
      severity: 'error',
      from: { path: '^src/types' },
      to:   { dependencyTypes: ['npm'] },
    },
    {
      name: 'no-config-store-imports-new-stores',
      severity: 'error',
      from: { path: '^src/sidepanel/stores/configStore' },
      to:   { path: '^src/sidepanel/stores/(settingsStore|queueStore|networkRecordStore)' },
    },
  ],
  options: {
    includeOnly: '^src/',
    doNotFollow: { path: 'node_modules' },
  },
};
```

---

## File: `src/themes/types.ts`

```typescript
export interface ThemeConfig {
  name: string;
  primary: string;
  secondary: string;
  fontFamily: string;
  logo?: string;
}
```

## File: `src/themes/blueberry.ts`

```typescript
import type { ThemeConfig } from './types';

export default {
  name: 'Blueberry',
  primary: '#5F259F',
  secondary: '#BB16A3',
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
} satisfies ThemeConfig;
```

---

## File: `src/types/config.ts`

```typescript
export type WaitMethod = 'fixedDelay' | 'contentChange' | 'elementAppear';

export interface SelectorDescriptor {
  cssSelector: string;
  xpathSelector: string;
  textContent: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  tagName: string;
  attributes: Record<string, string>;
  position: { parentSelector: string | null; childIndex: number };
  frameId: number | null;
  frameSrc: string | null;
  inShadowDom: boolean;
  shadowHostSelector: string | null;
  shadowSelector: string | null;
  _paginationMeta?: { text: string; tagName: string };
}

// ── Base step ─────────────────────────────────────────────────────────────────

export interface BaseStep {
  id: string;
  label: string;
  isSetup: boolean;
  selector: SelectorDescriptor | null;
  elementType: string | null;
  extra: Record<string, unknown> | null;
}

// ── Step option types ─────────────────────────────────────────────────────────

export interface SetInputOptions {
  clearBefore: boolean;
  pressEnterAfter: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  isInitialInput: boolean;
  subsequentSelector: SelectorDescriptor | null;
}

export interface ClickOptions {
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
}

export interface BestMatchOptions {
  matchStrictness: 'loose' | 'normal' | 'strict';
  candidateSource: 'similar' | 'container';
  containerSelector: SelectorDescriptor | null;
  clickableFilter: string;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
}

export interface GoBackOptions {
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
}

export interface ScrapeElementConfig {
  id: string;
  name: string;
  selector: SelectorDescriptor;
  detectedType: string;
  selectMode: 'single' | 'all';
  extra: Record<string, unknown>;
  tableFields: string[];
  excludedColumns: string[];
  dynamicHeaders: boolean;
  excludedColumnIndices: number[];
  paginate: boolean;
  paginationSelector: SelectorDescriptor | null;
  paginationCount: number;
}

export interface ScrapeOptions {
  mode: 'wholePage' | 'specificElements';
  scrollToBottom: boolean;
  expandHidden: boolean;
  paginate: boolean;
  paginationSelector: SelectorDescriptor | null;
  pageCount: number;
  elements: ScrapeElementConfig[];
}

export interface SelectEachOptions {
  selectEachOptions: {
    controlType: 'select' | 'generic' | null;
    controlSelector: SelectorDescriptor | null;
    options: Array<{ value: string; label: string; selected: boolean }>;
    contentAreaSelector: SelectorDescriptor | null;
    subSteps: Step[];
    waitAfterSelectMs: number;
  };
}

export interface CaptureApiCallsOptions {
  urlPattern: string;
  durationMs: number;
  includeResponseBody: boolean;
}

export interface AwaitUserActionOptions {
  message: string;
}

// ── Discriminated step union ──────────────────────────────────────────────────

export interface SetInputStep   extends BaseStep { type: 'setInput';         options: SetInputOptions; }
export interface ClickStep      extends BaseStep { type: 'click';            options: ClickOptions; }
export interface BestMatchStep  extends BaseStep { type: 'bestMatch';        options: BestMatchOptions; }
export interface GoBackStep     extends BaseStep { type: 'goBack';           options: GoBackOptions; }
export interface ScrapeStep     extends BaseStep { type: 'scrape';           options: ScrapeOptions; }
export interface SelectEachStep extends BaseStep { type: 'selectEach';       options: SelectEachOptions; }
export interface CaptureApiCallsStep extends BaseStep { type: 'captureApiCalls'; options: CaptureApiCallsOptions; }
export interface AwaitUserActionStep extends BaseStep { type: 'awaitUserAction'; options: AwaitUserActionOptions; }

export type StepType = Step['type'];

export type Step =
  | SetInputStep
  | ClickStep
  | BestMatchStep
  | GoBackStep
  | ScrapeStep
  | SelectEachStep
  | CaptureApiCallsStep
  | AwaitUserActionStep;

// ── Data mapping ──────────────────────────────────────────────────────────────

export interface MappingColumn {
  id: string;
  originalName: string;
  displayName: string;
  enabled: boolean;
  position: number;
  sourceType: 'scrapeElement' | 'apiCall' | 'computed';
  apiCallId?: string;
}

export interface DataMapping {
  version: 1;
  columns: MappingColumn[];
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ScraperConfig {
  id: string;
  name: string;
  description?: string;
  domain: string;
  domainLocked: boolean;
  url: string;
  steps: Step[];
  dataMapping?: DataMapping;
  schemaVersion: 2;
  createdAt: number;
  updatedAt: number;
}
```

---

## File: `src/types/messages.ts`

```typescript
import type { SelectorDescriptor, Step, ScraperConfig } from './config';
import type { QueueTask, TaskProgress, TaskComplete, TaskError, TaskPaused } from './signalr';
import type { ApiCall, ScrapingResult } from './extraction';

export type CloudflareChallengeType = 'cf-challenge' | 'cf-turnstile' | 'checking-browser';

// ── Content → Sidepanel (via SW relay) ───────────────────────────────────────

export type ContentToSidepanelMessage =
  | { type: 'ELEMENT_PICKED';         payload: { descriptor: SelectorDescriptor; elementType: string; label: string; mode: string; extra: Record<string, unknown> } }
  | { type: 'ELEMENT_HOVER';          payload: { tagName: string; className: string; textSnippet: string } }
  | { type: 'PICKER_CANCELLED' }
  | { type: 'FLOW_PROGRESS';          payload: { phase: 'setup' | 'loop'; stepLabel: string; status: string; termIndex?: number; taskId?: string } }
  | { type: 'FLOW_COMPLETE';          payload: { result: ScrapingResult; taskId?: string } }
  | { type: 'FLOW_ERROR';             payload: { error: string; stepLabel?: string; taskId?: string } }
  | { type: 'CLOUDFLARE_DETECTED';    payload: { challengeType: CloudflareChallengeType; taskId?: string } }
  | { type: 'FLOW_PAUSED';            payload: { reason: 'cloudflare'; challengeType: CloudflareChallengeType; taskId?: string } }
  | { type: 'FLOW_RESUMED' }
  | { type: 'NETWORK_CALL_CAPTURED';  payload: ApiCall }
  | { type: 'PAGE_INFO';              payload: { url: string; title: string } }
  | { type: 'PONG' };

// ── Sidepanel → Content (via SW relay) ───────────────────────────────────────

export type SidepanelToContentMessage =
  | { type: 'START_PICKER';           payload: { stepId: string; field: string; mode?: string } }
  | { type: 'CANCEL_PICKER' }
  | { type: 'EXECUTE_FLOW';           payload: { config: ScraperConfig; searchTerms: string[]; taskId?: string } }
  | { type: 'ABORT_FLOW' }
  | { type: 'RESUME_AFTER_CLOUDFLARE' }
  | { type: 'HIGHLIGHT_ELEMENT';      payload: { descriptor: SelectorDescriptor } }
  | { type: 'UNHIGHLIGHT_ELEMENT' }
  | { type: 'GET_PAGE_INFO' }
  | { type: 'PING' };

// ── SW ↔ Offscreen ────────────────────────────────────────────────────────────

export type SwToOffscreenMessage =
  | { type: 'INIT_SIGNALR';           payload: { serverUrl: string; token: string; clientId: string } }
  | { type: 'SEND_TASK_PROGRESS';     payload: TaskProgress }
  | { type: 'SEND_TASK_COMPLETE';     payload: TaskComplete }
  | { type: 'SEND_TASK_ERROR';        payload: TaskError }
  | { type: 'SEND_TASK_PAUSED';       payload: TaskPaused }
  | { type: 'GET_CONNECTION_STATUS' };

export type OffscreenToSwMessage =
  | { type: 'CONNECTION_READY';       payload: { clientId: string } }
  | { type: 'CONNECTION_LOST';        payload: { error: string } }
  | { type: 'TASK_RECEIVED';          payload: QueueTask }
  | { type: 'RESUME_TASK';            payload: { taskId: string } }
  | { type: 'CANCEL_TASK';            payload: { taskId: string } }
  | { type: 'CONNECTION_STATUS';      payload: { connected: boolean; serverUrl: string | null } };
```

---

## File: `src/types/signalr.ts`

```typescript
import type { ScrapingResult, IterationResult } from './extraction';
import type { DataMapping } from './config';

export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare';
  result?: TaskResult;
  error?: string;
}

export interface TaskProgress {
  taskId: string;
  configId: string;
  currentTerm: string;
  currentStep: string;
  progress: number;
  phase: 'setup' | 'loop';
}

export interface TaskComplete {
  taskId: string;
  configId: string;
  result: TaskResult;
  completedAt: string;
}

export interface TaskError {
  taskId: string;
  configId: string;
  error: string;
  stepLabel?: string;
  failedAt: string;
}

export interface TaskPaused {
  taskId: string;
  configId: string;
  reason: 'cloudflare';
  challengeType: string;
  pausedAt: string;
}

export interface TaskResult {
  taskId: string;
  configId: string;
  configName: string;
  status: 'success' | 'failed' | 'paused';
  iterations: IterationResult[];
  dataMapping?: DataMapping;
  totalTimeMs: number;
  timestamp: string;
}
```

---

## File: `src/types/extraction.ts`

```typescript
export interface ScrapingResult {
  configId: string;
  configName: string;
  scrapedAt: string;
  sourceUrl: string;
  iterations: IterationResult[];
  totalTimeMs: number;
  aborted?: boolean;
}

export interface IterationResult {
  searchTerm: string | null;
  data: Record<string, unknown>[];
  status: 'success' | 'error';
  error?: string;
  pageUrls?: string[];
}

export interface ApiCall {
  id: string;
  url: string;
  method: string;
  statusCode: number;
  responseBodyJson?: unknown;
  capturedAt: string;
}
```

---

## File: `src/types/index.ts`

```typescript
export * from './config';
export * from './messages';
export * from './signalr';
export * from './extraction';
```

---

## File: `src/offscreen/signalrConnection.ts`

```typescript
import * as signalR from '@microsoft/signalr';
import type { QueueTask } from '../types/signalr';

export class ScraperHubConnection {
  private connection: signalR.HubConnection | null = null;
  private clientId = '';

  async connect(serverUrl: string, token: string, clientId: string): Promise<void> {
    this.clientId = clientId;

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(`${serverUrl}/api/scraper-hub`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => {
          if (ctx.previousRetryCount >= 5) return null;
          return Math.min(1000 * Math.pow(2, ctx.previousRetryCount) + Math.random() * 500, 30_000);
        },
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this.connection.on('ReceiveTask', (task: QueueTask) => {
      chrome.runtime.sendMessage({ type: 'TASK_RECEIVED', payload: task });
    });

    this.connection.on('ResumeAfterPause', (taskId: string) => {
      chrome.runtime.sendMessage({ type: 'RESUME_TASK', payload: { taskId } });
    });

    this.connection.on('CancelTask', (taskId: string) => {
      chrome.runtime.sendMessage({ type: 'CANCEL_TASK', payload: { taskId } });
    });

    this.connection.onreconnected(() => {
      this.connection!.invoke('RegisterWorker', this.clientId,
        chrome.runtime.getManifest().version).catch(console.error);
    });

    this.connection.onclose((err) => {
      chrome.runtime.sendMessage({ type: 'CONNECTION_LOST', payload: { error: String(err ?? 'closed') } });
    });

    await this.connection.start();
    await this.connection.invoke('RegisterWorker', clientId, chrome.runtime.getManifest().version);
    chrome.runtime.sendMessage({ type: 'CONNECTION_READY', payload: { clientId } });
  }

  async invoke(method: string, ...args: unknown[]): Promise<void> {
    if (this.connection?.state !== signalR.HubConnectionState.Connected) return;
    await this.connection.invoke(method, ...args);
  }

  isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  disconnect(): void {
    this.connection?.stop();
  }
}
```

---

## File: `src/offscreen/messageHandler.ts`

```typescript
import { ScraperHubConnection } from './signalrConnection';
import type { SwToOffscreenMessage } from '../types/messages';

const hub = new ScraperHubConnection();

browser.runtime.onMessage.addListener(
  (message: SwToOffscreenMessage, _sender, sendResponse) => {
    switch (message.type) {
      case 'INIT_SIGNALR': {
        const { serverUrl, token, clientId } = message.payload;
        hub.connect(serverUrl, token, clientId)
          .then(() => sendResponse({ ok: true }))
          .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
        return true; // async
      }

      case 'SEND_TASK_PROGRESS':
        hub.invoke('TaskProgress', message.payload).catch(console.error);
        break;

      case 'SEND_TASK_COMPLETE':
        hub.invoke('TaskComplete', message.payload).catch(console.error);
        break;

      case 'SEND_TASK_ERROR':
        hub.invoke('TaskError', message.payload).catch(console.error);
        break;

      case 'SEND_TASK_PAUSED':
        hub.invoke('TaskPaused', message.payload).catch(console.error);
        break;

      case 'GET_CONNECTION_STATUS':
        sendResponse({ connected: hub.isConnected() });
        break;
    }
  }
);
```

---

## File: `src/entrypoints/offscreen.html`

```html
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Blueberry Offscreen</title></head>
  <body>
    <script type="module" src="./offscreen/main.ts"></script>
  </body>
</html>
```

## File: `src/entrypoints/offscreen/main.ts`

```typescript
import '../../offscreen/messageHandler';
// messageHandler registers the runtime.onMessage listener — nothing else needed.
```

---

## File: `src/content/cloudflareDetector.ts`

```typescript
export type CloudflareChallengeType = 'cf-challenge' | 'cf-turnstile' | 'checking-browser';

export interface CloudflareChallenge {
  detected: boolean;
  type: CloudflareChallengeType | null;
}

const CF_PATTERNS: Array<{ type: CloudflareChallengeType; detect: () => boolean }> = [
  {
    type: 'cf-challenge',
    detect: () => document.querySelector('#challenge-form') !== null,
  },
  {
    type: 'cf-turnstile',
    detect: () => document.querySelector('.cf-turnstile[data-sitekey]') !== null,
  },
  {
    type: 'checking-browser',
    detect: () =>
      (document.title.includes('Just a moment') ||
       (document.body?.textContent ?? '').includes('Checking your browser before accessing')),
  },
];

export function detectCloudflareChallenge(): CloudflareChallenge {
  for (const p of CF_PATTERNS) {
    if (p.detect()) return { detected: true, type: p.type };
  }
  return { detected: false, type: null };
}

/**
 * Polls every intervalMs. Resolves when the challenge disappears.
 * Returns a cancel function.
 */
export function waitForChallengeToClear(
  intervalMs = 800,
  minDebounceMs = 500,
): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let clearTime: number | null = null;

  const promise = new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (cancelled) { clearInterval(id); return; }

      const { detected } = detectCloudflareChallenge();
      if (!detected) {
        if (clearTime === null) clearTime = Date.now();
        // Debounce: must be clear for minDebounceMs before resolving
        if (Date.now() - clearTime >= minDebounceMs) {
          clearInterval(id);
          resolve();
        }
      } else {
        clearTime = null; // reset if challenge reappears
      }
    }, intervalMs);
  });

  return { promise, cancel: () => { cancelled = true; } };
}
```

---

## File: `src/content/network/networkRecorder.ts`

This runs in MAIN world. Communicates to ISOLATED world via postMessage.

```typescript
// Nonce injected by ISOLATED world at startup via window.__bb_nonce
declare const __bb_nonce: string;

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
  private originalFetch = window.fetch;
  private originalXhrOpen = XMLHttpRequest.prototype.open;
  private originalXhrSend = XMLHttpRequest.prototype.send;

  start(urlPattern?: string): void {
    if (this.active) return;
    this.active = true;
    this.pattern = urlPattern ? new RegExp(urlPattern) : null;
    this.patchFetch();
    this.patchXhr();
  }

  stop(): void {
    this.active = false;
    // Restore fetch via Proxy — no need to unpatch, just gate on this.active
  }

  private emit(call: RecordedApiCall): void {
    if (!this.active) return;
    if (this.pattern && !this.pattern.test(call.url)) return;
    window.postMessage({ type: '__bb_network_event', nonce: __bb_nonce, call }, '*');
  }

  private patchFetch(): void {
    const self = this;
    const original = this.originalFetch;

    const proxy = new Proxy(original, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        const req = args[0];
        const url = typeof req === 'string' ? req : req instanceof URL ? req.toString() : (req as Request).url;
        const method = (req instanceof Request ? req.method : 'GET').toUpperCase();

        return Reflect.apply(target, thisArg, args).then(async (response: Response) => {
          if (self.active) {
            const clone = response.clone();
            const ct = clone.headers.get('content-type') ?? '';
            if (ct.includes('application/json')) {
              clone.json().then((body: unknown) => {
                self.emit({
                  id: crypto.randomUUID(),
                  url,
                  method,
                  statusCode: response.status,
                  responseBodyJson: body,
                  capturedAt: new Date().toISOString(),
                });
              }).catch(() => { /* non-JSON */ });
            }
          }
          return response;
        });
      },
    });

    // Forge toString so detection scripts see native code
    (proxy as unknown as { toString: () => string }).toString = () => 'function fetch() { [native code] }';
    window.fetch = proxy;
  }

  private patchXhr(): void {
    const self = this;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { __bb_method?: string; __bb_url?: string },
      method: string,
      url: string,
      ...rest: unknown[]
    ) {
      this.__bb_method = method.toUpperCase();
      this.__bb_url = url;
      return self.originalXhrOpen.call(this, method, url, ...(rest as [boolean?, string?, string?]));
    };

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { __bb_method?: string; __bb_url?: string },
      ...args: unknown[]
    ) {
      this.addEventListener('load', function () {
        if (!self.active) return;
        const ct = this.getResponseHeader('content-type') ?? '';
        if (!ct.includes('application/json')) return;
        try {
          const body: unknown = JSON.parse(this.responseText);
          self.emit({
            id: crypto.randomUUID(),
            url: this.__bb_url ?? '',
            method: this.__bb_method ?? 'GET',
            statusCode: this.status,
            responseBodyJson: body,
            capturedAt: new Date().toISOString(),
          });
        } catch { /* malformed JSON */ }
      });
      return self.originalXhrSend.call(this, ...(args as [Document | XMLHttpRequestBodyInit | null | undefined]));
    };
  }
}

// Global instance — ISOLATED world starts/stops via window.__bb_recorder
const recorder = new NetworkRecorder();
(window as Window & { __bb_recorder?: NetworkRecorder }).__bb_recorder = recorder;
```

**ISOLATED world listener** (add to `src/content/index.ts`):

```typescript
// Generate nonce; pass to MAIN world at startup
const BB_NONCE = crypto.randomUUID();
(window as Window & { __bb_nonce?: string }).__bb_nonce = BB_NONCE;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== '__bb_network_event') return;
  if (event.data?.nonce !== BB_NONCE) return; // reject spoofed messages
  chrome.runtime.sendMessage({ type: 'NETWORK_CALL_CAPTURED', payload: event.data.call });
});
```

---

## File: `src/content/scraping/humanBehavior.ts` — Fitts' Law additions

Port all V2 exports unchanged. Add/replace the following:

```typescript
interface Point { x: number; y: number }

interface MousePathOptions {
  afk?: boolean;       // true = AFK run, suppress path entirely
  durationMs?: number; // total movement time (default 400–700ms random)
}

/**
 * Simulate human mouse movement from current position to element.
 * In afk mode: suppresses all mousemove events (no path is safer than a detectable one).
 * In interactive mode: Fitts' Law model with Gaussian noise.
 */
export async function moveMouseToElement(
  element: HTMLElement,
  opts: MousePathOptions = {},
): Promise<void> {
  if (opts.afk) return; // AFK: skip path, just click

  const rect = element.getBoundingClientRect();
  const target: Point = {
    x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
    y: rect.top  + rect.height * (0.3 + Math.random() * 0.4),
  };

  // Estimate origin as a random viewport position (simulating prior cursor location)
  const origin: Point = {
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
  };

  const duration = opts.durationMs ?? (400 + Math.random() * 300);
  await fittsMousePath(origin, target, duration);
}

async function fittsMousePath(from: Point, to: Point, durationMs: number): Promise<void> {
  const STEPS = 25;
  const NOISE_PX = 3; // Gaussian noise amplitude

  // Control points for primary arc (offset perpendicular to direction)
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const perp = { x: -dy * 0.2, y: dx * 0.2 }; // 20% perpendicular offset

  const cp1: Point = { x: from.x + dx * 0.3 + perp.x, y: from.y + dy * 0.3 + perp.y };
  const cp2: Point = { x: from.x + dx * 0.7 + perp.x, y: from.y + dy * 0.7 + perp.y };

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;

    // Ease-in-out velocity: peaks at t=0.65 (Fitts' Law — faster across, slow near target)
    const eased = easeInOutFitts(t);

    // Cubic bezier position
    const pos = cubicBezier(from, cp1, cp2, to, eased);

    // Add Gaussian noise (Box-Muller)
    const noise = gaussianNoise(NOISE_PX);
    pos.x += noise.x;
    pos.y += noise.y;

    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true,
      clientX: pos.x, clientY: pos.y,
    }));

    // Variable step delay — slows near target (correction phase)
    const stepDelay = (durationMs / STEPS) * (1 + (t > 0.8 ? (t - 0.8) * 3 : 0));
    await delay(stepDelay);
  }

  // Correction sub-movement: 1–2 small jitters near target (humans zero in)
  const corrections = 1 + Math.floor(Math.random() * 2);
  for (let c = 0; c < corrections; c++) {
    const jitter = gaussianNoise(2);
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true,
      clientX: to.x + jitter.x, clientY: to.y + jitter.y,
    }));
    await delay(30 + Math.random() * 40);
  }
}

function easeInOutFitts(t: number): number {
  // Skewed ease — peak velocity at ~65% of path
  if (t < 0.65) return (t / 0.65) * (t / 0.65) * 0.65;
  return 0.65 + (1 - Math.pow(1 - (t - 0.65) / 0.35, 2)) * 0.35;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt**3 * p0.x + 3 * mt**2 * t * p1.x + 3 * mt * t**2 * p2.x + t**3 * p3.x,
    y: mt**3 * p0.y + 3 * mt**2 * t * p1.y + 3 * mt * t**2 * p2.y + t**3 * p3.y,
  };
}

function gaussianNoise(amplitude: number): Point {
  // Box-Muller transform
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return { x: z * amplitude, y: z * amplitude };
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

**Update `naturalClick`** to accept `afk` option:

```typescript
export async function naturalClick(element: HTMLElement, opts: { afk?: boolean } = {}): Promise<void> {
  await moveMouseToElement(element, { afk: opts.afk ?? false });
  // ... rest of V2 naturalClick body unchanged (strip target/rel, dispatch events)
}
```

---

## File: `src/content/scraping/scrapingEngine.ts` — key additions

Port V2 `executeFlow` entirely. Add the following changes on top of the port:

**1. Accept `taskId` and AFK flag:**
```typescript
export async function executeFlow(params: {
  config: ScraperConfig;
  searchTerms: string[];
  taskId?: string;
  afk?: boolean;          // true when called from queue (not user-triggered)
  startTermIndex?: number;
  startLoopStepIndex?: number;
  previousIterations?: IterationResult[];
}): Promise<ScrapingResult>
```

**2. Cloudflare pause/resume after every navigation step (`click`, `bestMatch`, `goBack`):**
```typescript
// After executing a navigation step:
const challenge = detectCloudflareChallenge();
if (challenge.detected && challenge.type) {
  // Notify sidepanel
  chrome.runtime.sendMessage({
    type: 'FLOW_PAUSED',
    payload: { reason: 'cloudflare', challengeType: challenge.type, taskId: params.taskId },
  });

  // Wait for challenge to clear automatically OR for RESUME_AFTER_CLOUDFLARE message
  await Promise.race([
    waitForChallengeToClear().promise,
    waitForResumeSignal(),
  ]);

  chrome.runtime.sendMessage({ type: 'FLOW_RESUMED' });
}
```

```typescript
// waitForResumeSignal — resolves when RESUME_AFTER_CLOUDFLARE received
function waitForResumeSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (msg: { type: string }) => {
      if (msg.type === 'RESUME_AFTER_CLOUDFLARE') {
        chrome.runtime.onMessage.removeListener(handler);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
  });
}
```

**3. Session-level pacing between iterations:**
```typescript
// After each iteration completes, before starting the next:
const INTER_ITERATION_PAUSE_MS = 2000 + Math.random() * 6000; // 2–8s
await delay(INTER_ITERATION_PAUSE_MS);

// Every 25 iterations, take a longer idle pause
if (termIndex > 0 && termIndex % 25 === 0) {
  const IDLE_PAUSE_MS = 15_000 + Math.random() * 45_000; // 15–60s
  await delay(IDLE_PAUSE_MS);
}
```

**4. Pass `afk` to `naturalClick` in all step executors:**
```typescript
await naturalClick(element, { afk: params.afk ?? false });
```

---

## Content scripts — straight port instructions

The following 8 V2 files require TypeScript conversion only. No logic changes.
Copy from V2, rename `.js` → `.ts`, fix all TypeScript errors:

| V2 path | V3 path |
|---|---|
| `src/content/paginationHandler.js` | `src/content/scraping/paginationHandler.ts` |
| `src/content/tableExtractor.js` | `src/content/extraction/tableExtractor.ts` |
| `src/content/chartExtractor.js` | `src/content/extraction/chartExtractor.ts` |
| `src/content/svgValueEngine.js` | `src/content/extraction/svgValueEngine.ts` |
| `src/content/domUtils.js` | `src/content/extraction/domUtils.ts` |
| `src/content/elementPicker.js` | `src/content/picker/elementPicker.ts` |
| `src/content/chartBridge.js` | `src/entrypoints/chart-bridge.ts` |
| `src/content/tokenMatcher.js` | `src/common/tokenMatcher.ts` |

**`elementResolution.ts`** (was `selectorEngine.js`) — port + 2 targeted changes:
1. `SelectorDescriptor` uses the typed interface from `src/types/config.ts`
2. Text similarity: replace character-overlap algorithm with token-based:
```typescript
// Replace existing textSimilarity() body with:
function textSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union; // Jaccard similarity
}
```
3. Frame support in `resolveElement`: if `descriptor.frameId !== null`, use that frameId in the containing `chrome.tabs.sendMessage` call (handled in service worker routing, not in the content script itself — the content script only runs in its own frame).

---

## File: `src/sidepanel/stores/settingsStore.ts`

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SettingsState {
  serverUrl: string;
  jwtToken: string;
  connected: boolean;
  lastConnectionError: string | null;
  pauseOnCloudflare: boolean;

  setConnection: (url: string, token: string) => void;
  setConnected: (v: boolean, error?: string) => void;
  setPauseOnCloudflare: (v: boolean) => void;
  clearToken: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      serverUrl: '',
      jwtToken: '',
      connected: false,
      lastConnectionError: null,
      pauseOnCloudflare: true,

      setConnection: (serverUrl, jwtToken) =>
        set({ serverUrl, jwtToken, connected: false, lastConnectionError: null }),

      setConnected: (connected, error) =>
        set({ connected, lastConnectionError: error ?? null }),

      setPauseOnCloudflare: (pauseOnCloudflare) => set({ pauseOnCloudflare }),

      clearToken: () => set({ jwtToken: '', connected: false }),
    }),
    {
      name: 'bb-settings',
      storage: createJSONStorage(() => localStorage),
      // Never persist jwtToken to localStorage — store in chrome.storage.local instead
      partialize: (s) => ({ serverUrl: s.serverUrl, pauseOnCloudflare: s.pauseOnCloudflare }),
    },
  ),
);
```

**Note on JWT storage:** `jwtToken` is NOT persisted in Zustand's persist middleware (excluded via `partialize`). Load/save it separately via `chrome.storage.local` in the API settings screen:

```typescript
// On settings mount — load token from chrome.storage.local
const { jwtToken } = await chrome.storage.local.get('bb_jwt');
useSettingsStore.getState().setConnection(serverUrl, jwtToken ?? '');

// On save — write token to chrome.storage.local
await chrome.storage.local.set({ bb_jwt: token });
```

---

## File: `src/sidepanel/stores/queueStore.ts`

```typescript
import { create } from 'zustand';
import type { QueueTask, TaskResult } from '../../types/signalr';

interface QueueStats {
  total: number;
  pending: number;
  completed: number;
  failed: number;
}

interface QueueState {
  tasks: QueueTask[];
  currentTaskId: string | null;
  stats: QueueStats;

  addTask: (task: QueueTask) => void;
  setCurrentTask: (taskId: string | null) => void;
  updateTaskStatus: (taskId: string, status: QueueTask['status']) => void;
  completeTask: (taskId: string, result: TaskResult) => void;
  failTask: (taskId: string, error: string) => void;
  pauseTask: (taskId: string, reason: QueueTask['pausedReason']) => void;
  resumeTask: (taskId: string) => void;
  clearCompleted: () => void;
}

const ZERO_STATS: QueueStats = { total: 0, pending: 0, completed: 0, failed: 0 };

function recompute(tasks: QueueTask[]): QueueStats {
  return tasks.reduce(
    (acc, t) => ({
      total: acc.total + 1,
      pending: acc.pending + (t.status === 'pending' ? 1 : 0),
      completed: acc.completed + (t.status === 'completed' ? 1 : 0),
      failed: acc.failed + (t.status === 'failed' ? 1 : 0),
    }),
    ZERO_STATS,
  );
}

export const useQueueStore = create<QueueState>((set, get) => ({
  tasks: [],
  currentTaskId: null,
  stats: ZERO_STATS,

  addTask: (task) =>
    set((s) => {
      const tasks = [...s.tasks, task];
      return { tasks, stats: recompute(tasks) };
    }),

  setCurrentTask: (currentTaskId) => set({ currentTaskId }),

  updateTaskStatus: (taskId, status) =>
    set((s) => {
      const tasks = s.tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
      return { tasks, stats: recompute(tasks) };
    }),

  completeTask: (taskId, result) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'completed' as const, result } : t,
      );
      return { tasks, currentTaskId: null, stats: recompute(tasks) };
    }),

  failTask: (taskId, error) =>
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' as const, error } : t,
      );
      return { tasks, currentTaskId: null, stats: recompute(tasks) };
    }),

  pauseTask: (taskId, reason) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'paused' as const, pausedReason: reason } : t,
      ),
    })),

  resumeTask: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'running' as const, pausedReason: undefined } : t,
      ),
    })),

  clearCompleted: () =>
    set((s) => {
      const tasks = s.tasks.filter((t) => t.status !== 'completed');
      return { tasks, stats: recompute(tasks) };
    }),
}));
```

---

## File: `src/sidepanel/stores/networkRecordStore.ts`

```typescript
import { create } from 'zustand';
import type { ApiCall } from '../../types/extraction';

interface NetworkRecordState {
  calls: ApiCall[];
  activeStepId: string | null;
  isRecording: boolean;

  startRecording: (stepId: string) => void;
  stopRecording: () => void;
  addCall: (call: ApiCall) => void;
  clearCalls: () => void;
}

export const useNetworkRecordStore = create<NetworkRecordState>((set) => ({
  calls: [],
  activeStepId: null,
  isRecording: false,

  startRecording: (stepId) => set({ activeStepId: stepId, isRecording: true, calls: [] }),
  stopRecording: () => set({ isRecording: false }),
  addCall: (call) => set((s) => ({ calls: [...s.calls, call] })),
  clearCalls: () => set({ calls: [] }),
}));
```

---

## File: `src/sidepanel/utils/validateBackendUrl.ts`

```typescript
export interface UrlValidation {
  valid: boolean;
  error?: string;
}

export function validateBackendUrl(raw: string): UrlValidation {
  if (!raw.trim()) return { valid: false, error: 'Enter a backend URL.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'That doesn\'t look like a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, error: 'URL must start with https://' };
  }
  return { valid: true };
}
```

---

## File: `src/sidepanel/utils/apiClient.ts`

```typescript
import { validateBackendUrl } from './validateBackendUrl';
import type { TaskResult } from '../../types/signalr';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function postTaskResult(
  serverUrl: string,
  token: string,
  result: TaskResult,
): Promise<void> {
  const validation = validateBackendUrl(serverUrl);
  if (!validation.valid) throw new ApiClientError(validation.error!);

  // Never log token
  const res = await fetch(`${serverUrl}/api/scraper/results`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(result),
  });

  if (res.status === 401) throw new ApiClientError('Access denied. Check your token.');
  if (!res.ok) throw new ApiClientError(`Server returned ${res.status}.`);
}

export async function testConnection(serverUrl: string, token: string): Promise<void> {
  const validation = validateBackendUrl(serverUrl);
  if (!validation.valid) throw new ApiClientError(validation.error!);

  const res = await fetch(`${serverUrl}/api/scraper-hub/negotiate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) throw new ApiClientError('Access denied. Check your token.');
  if (!res.ok) throw new ApiClientError(`Couldn't connect. Check the URL and token.`);
}
```

---

## File: `src/sidepanel/utils/dataMapperUtils.ts`

```typescript
import type { DataMapping, MappingColumn } from '../../types/config';

/** Detect column names from an array of result objects. */
export function detectColumns(data: Record<string, unknown>[]): MappingColumn[] {
  if (data.length === 0) return [];

  const nameCounts = new Map<string, number>();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
  }

  // Sort by frequency descending, then alphabetically
  const names = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  // Deduplicate: if same displayName would result, suffix with _2, _3, etc.
  const seen = new Map<string, number>();
  return names.map((name, i) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const displayName = count > 1 ? `${name}_${count}` : name;
    return {
      id: crypto.randomUUID(),
      originalName: name,
      displayName,
      enabled: true,
      position: i,
      sourceType: 'scrapeElement',
    } satisfies MappingColumn;
  });
}

/** Apply a DataMapping to an array of result objects. */
export function applyMapping(
  data: Record<string, unknown>[],
  mapping: DataMapping,
): Record<string, unknown>[] {
  const active = [...mapping.columns]
    .filter((c) => c.enabled)
    .sort((a, b) => a.position - b.position);

  return data.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of active) {
      if (col.originalName in row) {
        out[col.displayName] = row[col.originalName];
      }
    }
    return out;
  });
}

/** Build a default DataMapping from detected columns. */
export function buildDefaultMapping(data: Record<string, unknown>[]): DataMapping {
  return { version: 1, columns: detectColumns(data) };
}
```

---

## Service worker — key V3 additions

Port all V2 service-worker logic unchanged. Add:

**1. Offscreen document management:**
```typescript
let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;
  const existing = await chrome.offscreen.hasDocument?.() ?? false;
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Maintain SignalR WebSocket connection for task queue',
    });
  }
  offscreenCreated = true;
}
```

**2. Route offscreen ↔ sidepanel messages in the SW message handler:**
```typescript
// Messages from offscreen → forward to sidepanel
case 'TASK_RECEIVED':
case 'RESUME_TASK':
case 'CANCEL_TASK':
case 'CONNECTION_READY':
case 'CONNECTION_LOST': {
  // Broadcast to all extension pages (sidepanel will handle)
  chrome.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
  break;
}

// Messages from sidepanel → forward to offscreen
case 'INIT_SIGNALR':
case 'SEND_TASK_PROGRESS':
case 'SEND_TASK_COMPLETE':
case 'SEND_TASK_ERROR':
case 'SEND_TASK_PAUSED': {
  await ensureOffscreen();
  chrome.runtime.sendMessage(message).catch(console.error);
  break;
}
```

**3. Multi-tab task routing** — tasks execute in the most recently focused tab:
```typescript
let lastFocusedTabId: number | null = null;
chrome.tabs.onActivated.addListener(({ tabId }) => { lastFocusedTabId = tabId; });

// When routing EXECUTE_FLOW for a queue task, use lastFocusedTabId
```

---

## CSS additions — `src/sidepanel/styles/`

Split V2's `App.css` into the following files. No token or class name changes — mechanical split only:

```
styles/
  index.css          (imports all partials in order)
  tokens.css         (:root variables)
  reset.css          (base resets, html/body)
  layout.css         (.app, .header, .tab-bar, .view, .view-header)
  buttons.css        (.btn and all variants)
  forms.css          (.form-group, .form-input, .form-check etc.)
  cards.css          (.card, .list-card, .step-card, .config-card etc.)
  banners.css        (.detection-banner and type variants)
  modals.css         (.modal-overlay, .modal-box etc.)
  toasts.css         (.toast and variants)
  progress.css       (.progress-bar, .status-dot etc.)
  badges.css         (.type-badge, .meta-badge, .domain-badge)
  queue.css          (NEW — queue view classes)
  data-mapping.css   (NEW — data mapping classes)
  api-settings.css   (NEW — settings view classes)
  utilities.css      (.flex, .gap-*, .text-*, .truncate etc.)
```

**New classes to add** (4 modifiers + 2 badge variants):

```css
/* banners.css */
.detection-banner--warning {
  background: var(--warning-light);
  border-color: var(--warning);
  color: var(--text-dark);
}

/* cards.css */
.card--active {
  border-left: 3px solid var(--purple-primary);
  background: var(--purple-bg);
}

/* forms.css */
.form-input--inline {
  width: auto;
  min-width: 8rem;
  display: inline-block;
}

/* queue.css */
.status-dot--paused {
  background: var(--warning);
}

/* badges.css */
.type-badge--await {
  background: var(--info-light);
  color: var(--purple-primary);
}
.type-badge--capture {
  background: var(--bg-light);
  color: var(--text-dark);
}
```

---

## New view components — structure

These components follow existing V2 patterns. Structure only — implement using existing classes per Stage C:

**`QueueView.tsx`** — renders: connection status row (`.status-dot` + text), current task card (`.card.card--active` + `.run-progress-bar-wrap`), pending list (`.list-card` per task), completed list, stats row (utilities).

**`APISettingsView.tsx`** — renders: two `.form-group` fields (URL + password token), `.btn.btn-secondary` test button, inline success/error feedback using existing `.toast` pattern.

**`DataMappingView.tsx`** — renders: two-column `.flex.gap-lg` layout. Left: list of `.step-card` rows with inner flex (`.form-check` toggle + `GripVertical` icon + original name + `.form-input.form-input--inline`). Right: `<pre className="json-preview">` live preview.

**`NetworkRecorderView.tsx`** — renders: `.form-group` URL pattern input, list of `.list-card` rows (`.form-check` checkbox + method `.type-badge` + truncated URL + `.meta-badge` status code).

**`AwaitUserActionForm.tsx`** — `.form-group` with `.form-textarea` for the user message. Identical pattern to existing step forms.

**`CloudflarePauseAlert.tsx`** — `.detection-banner.detection-banner--warning` at top of sidepanel content area. Text + `.btn.btn-secondary` Resume button. Conditionally rendered when `uiStore.cloudfarePaused === true`.

---

## Store changes — V2 ports

**`configStore.ts`** — add to config save/load:
- `dataMapping?: DataMapping` field on `ScraperConfig`
- Step defaults for `captureApiCalls` and `awaitUserAction` in `getDefaultOptions()`
- `schemaVersion: 2` — migration handles V1 → V2 (adds `dataMapping: undefined` to all existing configs)

**`uiStore.ts`** — add:
- `activeTab` gains `'queue'` and `'settings'` as valid values
- `cloudfarePaused: boolean` state + `setCloudflarePaused(v: boolean)` action

**`runStore.ts`** — add:
- `taskId: string | null` state (set when run originates from queue)
- Pass `taskId` through to content script `EXECUTE_FLOW` message

---

## Verification commands

```bash
# Run in order — all must pass before marking phase complete
npm run type-check
npm run lint
npm run deps:check
npm test
npm run build:chrome
npm run build:firefox
BLUEBERRY_THEME=blueberry npm run build:chrome   # confirm theme build works
```

## Manual test steps

See Stage E for full list. Priority order for smoke testing each phase:

1. **Phase 1 (foundation):** `type-check` + `deps:check` pass
2. **Phase 2 (offscreen):** Settings tab → enter URL + token → "Test connection" succeeds → Queue tab shows connected
3. **Phase 3 (content ports):** Existing V2 scrape config runs correctly end-to-end
4. **Phase 4 (cloudflare):** Navigate to `https://nowsecure.nl/` → cloudflare banner appears → auto-clears
5. **Phase 5 (network recording):** `captureApiCalls` step records calls on any REST/GraphQL page
6. **Phase 6 (data mapping):** Run scrape → "Map output" → rename column → save → re-run → output matches
7. **Phase 7 (queue):** Angular app pushes task → extension executes → result posted to backend
8. **Phase 8 (theming):** `BLUEBERRY_THEME=blueberry npm run build:chrome` → load → brand intact

---

## Spec storage

Copy this file to `specs/SPEC-v3-rebuild-v1.0.md` in the new V3 repo as the first implementation step.
