import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ConnectionStatus } from '../../types/messages';

interface SettingsState {
  serverUrl: string;
  // jwtToken is NOT persisted in Zustand — loaded/saved via chrome.storage.local separately
  jwtToken: string;
  connected: boolean;
  lastConnectionError: string | null;
  pauseOnCloudflare: boolean;
  mode: 'local' | 'queue';
  workerName: string;
  connectionStatus: ConnectionStatus;

  // PR3 — pre-flight quiet window (ms). Surfaced in settings UI in PR5.
  // Default mirrors PREFLIGHT_QUIET_MS in src/content/scraping/constants.ts.
  // Override consumed by content script in PR4/PR5 (passed via EXECUTE_FLOW).
  batchPreflightQuietMs: number;
  // PR4 — drain-phase parallel cap (max concurrent drain windows). Surfaced
  // in settings UI in PR5. Default mirrors DRAIN_PARALLEL_CAP in
  // src/background/originGate.ts. SW reads via message in PR5; PR4 is
  // hardcoded to the default in the scheduler.
  batchParallelCap: number;

  setConnection: (url: string, token: string) => void;
  setConnected: (connected: boolean, error?: string) => void;
  setPauseOnCloudflare: (v: boolean) => void;
  clearToken: () => void;
  setMode: (mode: 'local' | 'queue') => void;
  setWorkerName: (name: string) => void;
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  setBatchPreflightQuietMs: (ms: number) => void;
  setBatchParallelCap: (cap: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      serverUrl: '',
      jwtToken: '',
      connected: false,
      lastConnectionError: null,
      pauseOnCloudflare: true,
      mode: 'local',
      workerName: 'My Browser',
      connectionStatus: 'idle',
      batchPreflightQuietMs: 5000,
      batchParallelCap: 4,

      setConnection: (serverUrl, jwtToken) =>
        set({ serverUrl, jwtToken, connected: false, lastConnectionError: null }),

      setConnected: (connected, error) =>
        set({ connected, lastConnectionError: error ?? null }),

      setPauseOnCloudflare: (pauseOnCloudflare) => set({ pauseOnCloudflare }),

      clearToken: () => set({ jwtToken: '', connected: false }),

      setMode: (mode) => set({ mode }),

      setWorkerName: (workerName) => set({ workerName }),

      setConnectionStatus: (connectionStatus, error) =>
        set({
          connectionStatus,
          lastConnectionError: error ?? null,
          connected: connectionStatus === 'connected',
        }),

      setBatchPreflightQuietMs: (batchPreflightQuietMs) =>
        set({ batchPreflightQuietMs }),
      setBatchParallelCap: (batchParallelCap) =>
        set({ batchParallelCap }),
    }),
    {
      name: 'bb-settings',
      storage: createJSONStorage(() => localStorage),
      // Exclude jwtToken from localStorage — stored securely in chrome.storage.local
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        pauseOnCloudflare: s.pauseOnCloudflare,
        mode: s.mode,
        workerName: s.workerName,
        batchPreflightQuietMs: s.batchPreflightQuietMs,
        batchParallelCap: s.batchParallelCap,
      }),
    },
  ),
);
