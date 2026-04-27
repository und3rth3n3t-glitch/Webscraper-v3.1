import { create } from 'zustand';
import { pingContentScript, sendToContent } from '../utils/messaging';
import type { ScrapingResult } from '../../types/extraction';

interface ProgressEntry {
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  message: string | null;
  stepLabel: string | null;
}

interface LogEntry {
  time: string;
  message: string;
}

interface RunState {
  isRunning: boolean;
  taskId: string | null;
  searchTerms: (string | null)[];
  progress: ProgressEntry[];
  logEntries: LogEntry[];
  results: ScrapingResult | null;
  error: string | null;
  runContext: 'config' | 'saved';

  startRun: (terms: (string | null)[]) => void;
  stopRun: () => void;
  setTaskId: (id: string | null) => void;
  updateProgress: (termIndex: number, updates: Partial<ProgressEntry>) => void;
  appendLog: (message: string) => void;
  setResults: (results: ScrapingResult) => void;
  setError: (error: string) => void;
  launchRun: (context?: 'config' | 'saved') => Promise<void>;
  executeRun: (terms: (string | null)[], taskId?: string) => Promise<void>;
  navigateRun: (view: string) => Promise<void>;
  goBackFromRun: () => Promise<void>;
}

export const useRunStore = create<RunState>((set, get) => ({
  isRunning: false,
  taskId: null,
  searchTerms: [],
  progress: [],
  logEntries: [],
  results: null,
  error: null,
  runContext: 'config',

  startRun: (terms) => {
    const effectiveTerms = terms.length > 0 ? terms : [null];
    set({
      isRunning: true,
      searchTerms: effectiveTerms,
      progress: effectiveTerms.map(() => ({ status: 'pending', message: null, stepLabel: null })),
      logEntries: [],
      results: null,
      error: null,
    });
  },

  stopRun: () => set({ isRunning: false }),
  setTaskId: (id) => set({ taskId: id }),

  updateProgress: (termIndex, updates) =>
    set((s) => ({
      progress: s.progress.map((p, i) => (i === termIndex ? { ...p, ...updates } : p)),
    })),

  appendLog: (message) => {
    const time = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    set((s) => ({
      logEntries: [...s.logEntries.slice(-200), { time, message }],
    }));
  },

  setResults: (results) => set({ results, isRunning: false }),
  setError: (error) => set({ error, isRunning: false }),

  launchRun: async (context = 'config') => {
    const { useConfigStore } = await import('./configStore');
    const { useUiStore } = await import('./uiStore');
    const { steps } = useConfigStore.getState();
    const { showToast } = useUiStore.getState();

    if (steps.length === 0) {
      showToast('Add at least one step before running.', 'error');
      return;
    }
    if (!steps.some((s) => s.type === 'scrape' || s.type === 'selectEach')) {
      showToast('Add a Scrape step to collect data.', 'error');
      return;
    }
    if (!steps.some((s) => !s.isSetup)) {
      showToast('Move at least one step to the Loop section.', 'error');
      return;
    }

    try {
      await pingContentScript();
    } catch {
      showToast("Navigate to a website first. The scraper can't run on browser pages.", 'error');
      return;
    }

    set({ runContext: context });

    const needsSearchTerms = steps.some(
      (s) => !s.isSetup && (
        s.type === 'setInput' ||
        s.type === 'bestMatch' ||
        (s.type === 'navigateTo' && (s.options as { url?: string }).url?.includes('{searchTerm}'))
      ),
    );
    if (needsSearchTerms) {
      await get().navigateRun('SEARCH_VAR_INPUT');
    } else {
      await get().executeRun([]);
    }
  },

  executeRun: async (terms, taskId) => {
    const { useConfigStore } = await import('./configStore');
    const { useUiStore } = await import('./uiStore');
    const { currentConfig, configName, steps } = useConfigStore.getState();
    const { showToast } = useUiStore.getState();

    get().startRun(terms);
    set({ taskId: taskId ?? null });
    await get().navigateRun('RUNNING');

    const config = {
      id: currentConfig?.id || 'draft',
      name: configName || 'Untitled',
      steps,
    };

    try {
      await sendToContent('EXECUTE_FLOW', { config, searchTerms: terms, taskId });
    } catch (err) {
      showToast(`Failed to start: ${(err as Error).message}`, 'error');
    }
  },

  navigateRun: async (view) => {
    const context = get().runContext;
    if (context === 'saved') {
      const { useUiStore } = await import('./uiStore');
      useUiStore.getState().setSavedTabView(view);
    } else {
      const { useConfigStore } = await import('./configStore');
      if (view === 'SEARCH_VAR_INPUT') {
        useConfigStore.getState().pushView(view);
      } else {
        useConfigStore.getState().setView(view);
      }
    }
  },

  goBackFromRun: async () => {
    const context = get().runContext;
    if (context === 'saved') {
      const { useUiStore } = await import('./uiStore');
      useUiStore.getState().setSavedTabView('LIST');
    } else {
      const { useConfigStore } = await import('./configStore');
      useConfigStore.getState().setView('STEP_LIST');
    }
  },
}));
