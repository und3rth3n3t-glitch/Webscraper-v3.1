import { create } from 'zustand';
import { sendToContent } from '../utils/messaging';
import { useConfigStore } from './configStore';

let toastId = 0;

interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

type ActiveTab = 'config' | 'saved' | 'queue' | 'settings';
type TabSwitchReason = 'dirty' | 'picker' | 'running' | null;

interface UiState {
  activeTab: ActiveTab;
  pendingTabSwitch: ActiveTab | null;
  tabSwitchReason: TabSwitchReason;
  isPickerActive: boolean;
  isRunning: boolean;
  savedTabView: string;
  toasts: Toast[];
  pendingPickerStepId: string | null;
  pendingPickerField: string | null;
  // Kept for local-mode (RunProgress.tsx single-task runs). Queue-mode pause
  // state lives in queueStore.pause per PR5. Remove in a future PR when
  // local-mode is also migrated to PauseAlert.
  cloudfarePaused: boolean;
  awaitActionPaused: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null;

  setActiveTab: (tab: ActiveTab) => void;
  requestTabSwitch: (tab: ActiveTab) => void;
  confirmTabSwitch: () => void;
  saveAndSwitchTab: () => Promise<void>;
  discardAndSwitchTab: () => void;
  cancelTabSwitch: () => void;
  setPickerActive: (v: boolean) => void;
  setPendingPickerStepId: (id: string | null) => void;
  setPendingPickerField: (field: string | null) => void;
  setRunning: (v: boolean) => void;
  setSavedTabView: (view: string) => void;
  setCloudflarePaused: (v: boolean) => void;
  setAwaitActionPaused: (v: { message: string; trigger?: import('../../types/messages').DetectionTrigger; domain?: string } | null) => void;
  showToast: (message: string, type?: Toast['type'], duration?: number) => number;
  dismissToast: (id: number) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  activeTab: 'config',
  pendingTabSwitch: null,
  tabSwitchReason: null,
  isPickerActive: false,
  isRunning: false,
  savedTabView: 'LIST',
  toasts: [],
  pendingPickerStepId: null,
  pendingPickerField: null,
  cloudfarePaused: false,
  awaitActionPaused: null,
  setActiveTab: (tab) => set({ activeTab: tab }),

  requestTabSwitch: (tab) => {
    const { isRunning, isPickerActive } = get();
    const reason: TabSwitchReason = isRunning ? 'running' : isPickerActive ? 'picker' : 'dirty';
    set({ pendingTabSwitch: tab, tabSwitchReason: reason });
  },

  confirmTabSwitch: () => {
    const { pendingTabSwitch, isPickerActive } = get();
    if (isPickerActive) {
      sendToContent('CANCEL_PICKER').catch(() => {});
    }
    useConfigStore.getState().newConfig();
    set({
      activeTab: pendingTabSwitch!,
      pendingTabSwitch: null,
      tabSwitchReason: null,
      isPickerActive: false,
      isRunning: false,
    });
  },

  saveAndSwitchTab: async () => {
    const { pendingTabSwitch } = get();
    const configStore = useConfigStore.getState();
    try {
      await configStore.saveCurrentConfig();
      configStore.newConfig();
      set({ activeTab: pendingTabSwitch!, pendingTabSwitch: null, tabSwitchReason: null });
    } catch {
      get().showToast('Failed to save config', 'error');
      set({ pendingTabSwitch: null, tabSwitchReason: null });
    }
  },

  discardAndSwitchTab: () => {
    const { pendingTabSwitch } = get();
    useConfigStore.getState().newConfig();
    set({ activeTab: pendingTabSwitch!, pendingTabSwitch: null, tabSwitchReason: null });
  },

  cancelTabSwitch: () => set({ pendingTabSwitch: null, tabSwitchReason: null }),

  setPickerActive: (v) => set({ isPickerActive: v }),
  setPendingPickerStepId: (id) => set({ pendingPickerStepId: id }),
  setPendingPickerField: (field) => set({ pendingPickerField: field }),
  setRunning: (v) => set({ isRunning: v }),
  setSavedTabView: (view) => set({ savedTabView: view }),
  setCloudflarePaused: (v) => set({ cloudfarePaused: v }),
  setAwaitActionPaused: (v) => set({ awaitActionPaused: v }),
  showToast: (message, type = 'info', duration = 3000) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    if (duration > 0) {
      setTimeout(() => get().dismissToast(id), duration);
    }
    return id;
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
