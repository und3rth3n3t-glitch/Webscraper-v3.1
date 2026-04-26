import { useQueueStore } from '../stores/queueStore';
import { onMessage } from './messageDispatcher';
import type { QueueTask, TaskResult } from '../../types/signalr';
import type { ScrapingResult } from '../../types/extraction';

// Wires queue-mode messages (TASK_RECEIVED + FLOW_*) into the queue store.
// Returns a teardown that removes both the raw listener and the dispatcher subs.
export function startQueueDispatcher(): () => void {
  // TASK_RECEIVED is broadcast by the SW (no sender.tab); messageDispatcher's
  // onContentMessage filters those out, so use a raw listener.
  const rawListener = (message: unknown) => {
    const msg = message as { type?: string; payload?: unknown };
    if (msg.type !== 'TASK_RECEIVED') return;
    const task = msg.payload as QueueTask;
    const store = useQueueStore.getState();
    store.addTask(task);
    store.setCurrentTask(task.id);
  };
  chrome.runtime.onMessage.addListener(rawListener);

  // FLOW_* events come from content scripts (sender.tab set) and the
  // dispatcher routes them. Skip events without a taskId — those are local runs.
  const offProgress = onMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as { taskId?: string };
    if (!p.taskId) return;
    useQueueStore.getState().updateTaskStatus(p.taskId, 'running');
  });

  const offComplete = onMessage('FLOW_COMPLETE', (payload) => {
    const p = payload as { taskId?: string; result: ScrapingResult };
    if (!p.taskId) return;
    const result: TaskResult = {
      taskId: p.taskId,
      configId: p.result.configId,
      configName: p.result.configName,
      status: 'success',
      iterations: p.result.iterations,
      totalTimeMs: p.result.totalTimeMs,
      timestamp: p.result.scrapedAt,
    };
    useQueueStore.getState().completeTask(p.taskId, result);
  });

  const offError = onMessage('FLOW_ERROR', (payload) => {
    const p = payload as { taskId?: string; error: string };
    if (!p.taskId) return;
    useQueueStore.getState().failTask(p.taskId, p.error);
  });

  const offPaused = onMessage('FLOW_PAUSED', (payload) => {
    const p = payload as { taskId?: string; reason?: 'cloudflare' | 'awaitUserAction' };
    if (!p.taskId || (p.reason !== 'cloudflare' && p.reason !== 'awaitUserAction')) return;
    useQueueStore.getState().pauseTask(p.taskId, p.reason);
  });

  return () => {
    chrome.runtime.onMessage.removeListener(rawListener);
    offProgress();
    offComplete();
    offError();
    offPaused();
  };
}
