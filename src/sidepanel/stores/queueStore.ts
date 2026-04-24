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

export const useQueueStore = create<QueueState>((set) => ({
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
