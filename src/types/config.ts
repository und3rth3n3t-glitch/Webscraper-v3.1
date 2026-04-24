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
