import { useQueueStore } from '../stores/queueStore';
import { useUiStore } from '../stores/uiStore';
import { onMessage } from './messageDispatcher';
import { mergeProgress } from '../../utils/queueProgress';
import type { QueueTask, TaskResult, QueueSnapshot } from '../../types/signalr';
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

  browser.runtime.sendMessage({ type: 'GET_QUEUE_SNAPSHOT' })
    .then((resp: unknown) => {
      const snapshot = resp as QueueSnapshot | null;
      if (snapshot) useQueueStore.getState().seedFromSnapshot(snapshot);
    })
    .catch(() => { /* SW may not be running yet — no-op */ });

  // FLOW_* events come from content scripts (sender.tab set) and the
  // dispatcher routes them. Skip events without a taskId — those are local runs.
  const offProgress = onMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as { taskId?: string; stepLabel?: unknown; termIndex?: unknown };
    if (!p.taskId) return;
    const store = useQueueStore.getState();
    store.updateTaskStatus(p.taskId, 'running');
    const prior = store.tasks.find((t) => t.id === p.taskId)?.progress ?? null;
    const merged = mergeProgress(prior, { stepLabel: p.stepLabel, termIndex: p.termIndex });
    if (merged) store.setTaskProgress(p.taskId, merged);
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
    const p = payload as { taskId?: string; reason?: 'cloudflare' | 'awaitUserAction'; message?: string };
    if (!p.taskId || (p.reason !== 'cloudflare' && p.reason !== 'awaitUserAction')) return;
    useQueueStore.getState().pauseTask(p.taskId, p.reason);
    if (p.reason === 'cloudflare') {
      useUiStore.getState().setCloudflarePaused(true);
    } else {
      useUiStore.getState().setAwaitActionPaused({ message: p.message ?? 'Action needed in your browser.' });
    }
  });

  const offResumed = onMessage('FLOW_RESUMED', () => {
    useUiStore.getState().setCloudflarePaused(false);
    useUiStore.getState().setAwaitActionPaused(null);
  });

  return () => {
    chrome.runtime.onMessage.removeListener(rawListener);
    offProgress();
    offComplete();
    offError();
    offPaused();
    offResumed();
  };
}
