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
