import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PauseAlert from '../sidepanel/components/PauseAlert';
import { useQueueStore } from '../sidepanel/stores/queueStore';
import { DetectionTrigger } from '../types/messages';
import type { QueueTask } from '../types/signalr';

function makePausedTask(overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    id: 'task-1',
    configId: 'cfg-1',
    configName: 'Acme search',
    searchTerms: ['x'],
    priority: 0,
    createdAt: new Date(0).toISOString(),
    status: 'paused',
    pause: {
      reason: 'awaitUserAction',
      message: 'Sign in to continue.',
      trigger: DetectionTrigger.LOGIN_WALL,
      domain: 'acme.test',
    },
    ...overrides,
  };
}

describe('PauseAlert', () => {
  beforeEach(() => {
    useQueueStore.setState({
      tasks: [makePausedTask()],
      currentTaskId: 'task-1',
      stats: { total: 1, pending: 0, completed: 0, failed: 0 },
    });
    // Stub chrome.runtime.sendMessage so the sendToContent helper resolves cleanly.
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: (_msg: unknown, cb?: (resp: unknown) => void) => { cb?.(undefined); },
        lastError: undefined,
      },
    };
  });

  it('renders configName as title prefix', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByText(/Acme search:/)).toBeTruthy();
  });

  it('renders the pause message verbatim for awaitUserAction', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByText('Sign in to continue.')).toBeTruthy();
  });

  it('shows Skip button for awaitUserAction with trigger + domain', () => {
    render(<PauseAlert task={useQueueStore.getState().tasks[0]} />);
    expect(screen.getByRole('button', { name: /Skip sign-in prompts on this site/ })).toBeTruthy();
  });

  it('hides Skip button for cloudflare reason', () => {
    const task = makePausedTask({ pause: { reason: 'cloudflare' } });
    useQueueStore.setState({ tasks: [task] });
    render(<PauseAlert task={task} />);
    expect(screen.queryByRole('button', { name: /^Skip/ })).toBeNull();
  });

  it('Continue click resumes task in store', () => {
    const task = useQueueStore.getState().tasks[0];
    render(<PauseAlert task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useQueueStore.getState().tasks[0].status).toBe('running');
    expect(useQueueStore.getState().tasks[0].pause).toBeUndefined();
  });

  it('returns null when task has no pause info', () => {
    const task = makePausedTask({ pause: undefined });
    const { container } = render(<PauseAlert task={task} />);
    expect(container.firstChild).toBeNull();
  });
});
