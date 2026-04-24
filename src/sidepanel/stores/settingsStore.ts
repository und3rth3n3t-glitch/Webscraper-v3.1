import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SettingsState {
  serverUrl: string;
  // jwtToken is NOT persisted in Zustand — loaded/saved via chrome.storage.local separately
  jwtToken: string;
  connected: boolean;
  lastConnectionError: string | null;
  pauseOnCloudflare: boolean;

  setConnection: (url: string, token: string) => void;
  setConnected: (connected: boolean, error?: string) => void;
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
      // Exclude jwtToken from localStorage — stored securely in chrome.storage.local
      partialize: (s) => ({ serverUrl: s.serverUrl, pauseOnCloudflare: s.pauseOnCloudflare }),
    },
  ),
);
