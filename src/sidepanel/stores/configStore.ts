import { create } from 'zustand';
import { generateId } from '../utils/uuid';
import { saveConfig as saveConfigToStorage, migrateConfig, CURRENT_SCHEMA_VERSION } from '../utils/storage';
import { arrayMove } from '@dnd-kit/sortable';
import type {
  ScraperConfig,
  Step,
  StepType,
  DataMapping,
  SetInputOptions,
  ClickOptions,
  BestMatchOptions,
  GoBackOptions,
  ScrapeOptions,
  SelectEachOptions,
  CaptureApiCallsOptions,
  AwaitUserActionOptions,
} from '../../types/config';

type StepOptions =
  | SetInputOptions
  | ClickOptions
  | BestMatchOptions
  | GoBackOptions
  | ScrapeOptions
  | SelectEachOptions
  | CaptureApiCallsOptions
  | AwaitUserActionOptions;

const DEFAULT_STEP_LABELS: Record<StepType, string> = {
  setInput:        'Type search term',
  click:           'Click element',
  bestMatch:       'Best search match',
  goBack:          'Go back',
  scrape:          'Scrape data',
  selectEach:      'Select each option',
  captureApiCalls: 'Capture API calls',
  awaitUserAction: 'Wait for user',
};

export function getDefaultOptions(type: StepType): StepOptions {
  switch (type) {
    case 'setInput':
      return { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, alternateSelector: null } satisfies SetInputOptions;
    case 'click':
      return { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null, alternateSelector: null } satisfies ClickOptions;
    case 'bestMatch':
      return { matchStrictness: 'normal', containerSelector: null, alternateContainerSelector: null, clickableFilter: 'a, button', sameOriginOnly: true, waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies BestMatchOptions;
    case 'goBack':
      return { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null } satisfies GoBackOptions;
    case 'scrape':
      return { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, elements: [] } satisfies ScrapeOptions;
    case 'selectEach':
      return { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } } satisfies SelectEachOptions;
    case 'captureApiCalls':
      return { urlPattern: '', durationMs: 5000, includeResponseBody: true } satisfies CaptureApiCallsOptions;
    case 'awaitUserAction':
      return { message: '' } satisfies AwaitUserActionOptions;
  }
}

function makeStep(type: StepType): Step {
  return {
    id: generateId(),
    type,
    label: DEFAULT_STEP_LABELS[type],
    isSetup: false,
    selector: null,
    elementType: null,
    extra: null,
    options: getDefaultOptions(type),
  } as unknown as Step;
}

interface ConfigState {
  currentConfig: ScraperConfig | null;
  steps: Step[];
  configName: string;
  isDirty: boolean;
  pageUrl: string;
  pageDomain: string;
  domainLocked: boolean;
  draftStep: Step | null;
  editingStepId: string | null;
  cameFromSaved: boolean;
  view: string;
  viewStack: string[];

  setPageInfo: (url: string, domain?: string) => void;
  pushView: (view: string) => void;
  goBack: () => void;
  setView: (view: string) => void;
  addStep: (type: StepType) => Step;
  createDraft: (type: StepType) => Step;
  commitDraft: () => void;
  updateStep: (id: string, changes: Partial<Step>) => void;
  updateStepOptions: (id: string, optionChanges: Partial<StepOptions>) => void;
  deleteStep: (id: string) => void;
  reorderSteps: (activeId: string, overId: string) => void;
  saveCurrentConfig: () => Promise<ScraperConfig>;
  loadConfig: (config: ScraperConfig | Record<string, unknown>) => void;
  newConfig: () => void;
  setConfigName: (name: string) => void;
  setDomainLocked: (v: boolean) => void;
  setEditingStepId: (id: string | null) => void;
  setDataMapping: (mapping: DataMapping) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  currentConfig: null,
  steps: [],
  configName: '',
  isDirty: false,
  pageUrl: '',
  pageDomain: '',
  domainLocked: false,
  draftStep: null,
  editingStepId: null,
  cameFromSaved: false,
  view: 'NO_CONFIG',
  viewStack: [],

  setPageInfo: (url, domain) => {
    set({
      pageUrl: url,
      pageDomain: domain || (() => { try { return new URL(url).hostname; } catch { return url; } })(),
    });
  },

  pushView: (view) => {
    const current = get().view;
    set((s) => ({ viewStack: [...s.viewStack, current], view }));
  },

  goBack: () => {
    const { viewStack } = get();
    if (viewStack.length === 0) return;
    const prev = viewStack[viewStack.length - 1];
    set((s) => ({ view: prev, viewStack: s.viewStack.slice(0, -1) }));
  },

  setView: (view) => set({ view, viewStack: [] }),

  addStep: (type) => {
    const step = makeStep(type);
    set((s) => ({ steps: [...s.steps, step], draftStep: step, isDirty: true }));
    return step;
  },

  createDraft: (type) => {
    const step = makeStep(type);
    set({ draftStep: step });
    return step;
  },

  commitDraft: () => {
    const { draftStep } = get();
    if (!draftStep) return;
    set((s) => ({ steps: [...s.steps, draftStep], draftStep: null, isDirty: true }));
  },

  updateStep: (id, changes) => {
    set((s) => {
      const steps = s.steps.map((st) => st.id === id ? { ...st, ...changes } : st) as Step[];
      const draftStep = s.draftStep?.id === id ? { ...s.draftStep, ...changes } as Step : s.draftStep;
      return { steps, draftStep, isDirty: true };
    });
  },

  updateStepOptions: (id, optionChanges) => {
    set((s) => {
      const updater = (st: Step): Step =>
        st.id === id
          ? { ...st, options: { ...(st.options as unknown as Record<string, unknown>), ...optionChanges } } as Step
          : st;
      return {
        steps: s.steps.map(updater),
        draftStep: s.draftStep?.id === id ? updater(s.draftStep) : s.draftStep,
        isDirty: true,
      };
    });
  },

  deleteStep: (id) => {
    set((s) => ({ steps: s.steps.filter((st) => st.id !== id), isDirty: true }));
  },

  reorderSteps: (activeId, overId) => {
    set((s) => {
      const oldIndex = s.steps.findIndex((st) => st.id === activeId);
      const newIndex = s.steps.findIndex((st) => st.id === overId);
      if (oldIndex === -1 || newIndex === -1) return {};
      return { steps: arrayMove(s.steps, oldIndex, newIndex), isDirty: true };
    });
  },

  saveCurrentConfig: async () => {
    const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked } = get();
    const config: ScraperConfig = {
      id: currentConfig?.id || generateId(),
      name: configName || 'Untitled Config',
      domain: domainLocked ? pageDomain : '',
      domainLocked,
      url: pageUrl,
      steps,
      dataMapping: currentConfig?.dataMapping,
      schemaVersion: CURRENT_SCHEMA_VERSION as 4,
      createdAt: currentConfig?.createdAt || Date.now(),
      updatedAt: Date.now(),
      shared: currentConfig?.shared ?? false,
      lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
    };

    if (config.shared) {
      config.dirty = true;
    }

    await saveConfigToStorage(config);
    set({ currentConfig: config, isDirty: false });

    // Auto-push when shared + connected. Fire-and-forget; pushIfDirty handles its
    // own errors and dirty flag. Imported lazily to avoid a circular dependency.
    if (config.shared) {
      const { useSettingsStore } = await import('./settingsStore');
      const { useSyncStore } = await import('./syncStore');
      const { serverUrl, jwtToken, connectionStatus } = useSettingsStore.getState();
      if (connectionStatus === 'connected') {
        void useSyncStore.getState().pushIfDirty(serverUrl, jwtToken, config.id);
      }
    }

    return config;
  },

  loadConfig: (config) => {
    const safe = migrateConfig(config as Record<string, unknown>) || config as ScraperConfig;
    set({
      currentConfig: safe,
      steps: safe.steps || [],
      configName: safe.name,
      domainLocked: safe.domainLocked ?? !!(safe.domain),
      isDirty: false,
      view: 'STEP_LIST',
      viewStack: [],
      draftStep: null,
      cameFromSaved: true,
    });
  },

  newConfig: () => {
    set({
      currentConfig: null,
      steps: [],
      configName: '',
      domainLocked: false,
      isDirty: false,
      view: 'NO_CONFIG',
      viewStack: [],
      draftStep: null,
      cameFromSaved: false,
    });
  },

  setConfigName: (name) => set({ configName: name, isDirty: true }),
  setDomainLocked: (v) => set({ domainLocked: v, isDirty: true }),
  setEditingStepId: (id) => set({ editingStepId: id }),
  setDataMapping: (mapping) => set((s) => ({
    currentConfig: s.currentConfig ? { ...s.currentConfig, dataMapping: mapping } : null,
    isDirty: true,
  })),
}));
