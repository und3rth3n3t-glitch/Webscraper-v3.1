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

export interface InputSlot {
  id: string;
  key: string;
  label: string;
}

// ── Step conditions ───────────────────────────────────────────────────────────

export type StepCondition =
  | { kind: 'urlMatches';     pattern: string;              negate?: boolean }
  | { kind: 'elementPresent'; selector: SelectorDescriptor; negate?: boolean };

// ── Base step ─────────────────────────────────────────────────────────────────

export interface BaseStep {
  id: string;
  label: string;
  isSetup: boolean;
  selector: SelectorDescriptor | null;
  elementType: string | null;
  extra: Record<string, unknown> | null;
  condition?: StepCondition | null;
}

// ── Step option types ─────────────────────────────────────────────────────────

export interface SetInputOptions {
  clearBefore: boolean;
  pressEnterAfter: boolean;
  waitMethod: WaitMethod;
  waitAfterMs: number;
  isInitialInput: boolean;
  alternateSelector: SelectorDescriptor | null;
  // Server-set at populate time; takes precedence over searchTerm at runtime.
  literalValue?: string;
  // Extension manual multi-column: which input slot's value to type (undefined = use searchTerm).
  inputKey?: string;
}

export interface ClickOptions {
  waitMethod: WaitMethod;
  waitAfterMs: number;
  waitForSelector: SelectorDescriptor | null;
  alternateSelector: SelectorDescriptor | null;
}

export interface BestMatchOptions {
  matchStrictness: 'loose' | 'normal' | 'strict';
  containerSelector: SelectorDescriptor | null;
  alternateContainerSelector: SelectorDescriptor | null;
  clickableFilter: string;
  sameOriginOnly: boolean;
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
  outputKey?: string;
  columnOverrides?: ColumnOverride[];
}

export type ColumnType = 'text' | 'number' | 'percent' | 'currency' | 'date' | 'boolean';

export interface ColumnOverride {
  flatKey: string;
  type: ColumnType;
}

export interface ScrapeOptions {
  mode: 'wholePage' | 'specificElements';
  scrollToBottom: boolean;
  expandHidden: boolean;
  paginate: boolean;
  paginationSelector: SelectorDescriptor | null;
  pageCount: number;
  scrollIncrementVh?: number;     // 0.1–1.0, default 0.4
  scrollDelayMs?: number;         // ms, default 700
  paginationDelayMs?: number;     // ms, default 1500
  expandDelayMs?: number;         // ms, default 350
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

export interface DetectionRules {
  loginWall?: boolean;
  captcha?: boolean;
  cookieBanner?: boolean;
  selector?: string;
  extraSelectors?: string[];
}

export interface AutoDetectConfig {
  cloudflare?: boolean;
  loginWall?: boolean;
  captcha?: boolean;
  cookieBanner?: boolean;
  extraSelectors?: string[];
}

export interface AwaitUserActionOptions {
  message: string;
  detectionRules?: DetectionRules;
}

export interface NavigateToOptions {
  url: string;
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
export interface NavigateToStep extends BaseStep { type: 'navigateTo'; options: NavigateToOptions; }

export type StepType = Step['type'];

export type Step =
  | SetInputStep
  | ClickStep
  | BestMatchStep
  | GoBackStep
  | ScrapeStep
  | SelectEachStep
  | CaptureApiCallsStep
  | AwaitUserActionStep
  | NavigateToStep;

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
  autoDetect?: AutoDetectConfig;
  inputSlots?: InputSlot[];
  schemaVersion: 3 | 4 | 5;
  createdAt: number;
  updatedAt: number;
  shared?: boolean;
  lastSyncedAt?: string | null;
  dirty?: boolean;
}
