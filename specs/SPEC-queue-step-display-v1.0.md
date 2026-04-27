# SPEC-queue-step-display-v1.0

**Status**: Implementation-ready.

---

## Context

The queue's "in progress" card today shows only the config name, term-count meta, and a broken `— running...` suffix (gated on `runStore.isRunning`, which never becomes true for remote tasks — pre-existing bug noted in SPEC-queue-rehydration-v1.0).

The `FLOW_PROGRESS` event already carries the data we need (`stepLabel`, `termIndex`), but `queueDispatcher` throws everything away except the task ID, and the SW doesn't cache it — so even a fix that reads the live event would go blank on sidepanel reopen.

**This spec adds**:
1. A `progress?: { stepLabel; termIndex? }` field on `QueueTask`.
2. A merge helper (`mergeProgress`) that handles term boundaries, empty step labels, and untrusted payload validation — duplicated *via shared util* in the live dispatcher and the SW cache.
3. SW-side caching of `lastProgress` on `activeRemoteTask`, surfaced through `buildSnapshotActiveTask` so sidepanel reopen mid-task picks it up.
4. A new step-label line in the active queue card, reusing the `.run-term-step` style from `RunProgress.tsx`.
5. Removal of the dead `isRunning` suffix and unused `useRunStore` import in `QueueView.tsx`.

### What this spec does NOT do

- Show progress on completed/failed cards (e.g., "Failed at: <step>"). Out of scope.
- Surface `phase` or `status` from the FLOW_PROGRESS payload — `stepLabel` is sufficient for the card.
- Add a separate `progressByTaskId` map. The field lives on `QueueTask`, matching the existing `pausedReason` precedent.
- Refactor `RunProgress.tsx`. Its FLOW_PROGRESS handler stays as-is.

---

## File 1 — `src/utils/queueProgress.ts` (NEW)

Create the file with this exact content:

```ts
export interface ProgressInfo {
  stepLabel: string;
  termIndex?: number;
}

const STEP_LABEL_MAX = 200;

export function mergeProgress(
  prior: ProgressInfo | null,
  payload: { stepLabel?: unknown; termIndex?: unknown },
): ProgressInfo | null {
  if (typeof payload.stepLabel !== 'string') return null;
  if (payload.termIndex !== undefined) {
    if (!Number.isInteger(payload.termIndex) || (payload.termIndex as number) < 0) return null;
  }
  const stepLabel = payload.stepLabel.length > STEP_LABEL_MAX
    ? payload.stepLabel.slice(0, STEP_LABEL_MAX)
    : payload.stepLabel;
  const termIndex = payload.termIndex as number | undefined;

  // Same term, empty step label: keep prior (avoids flicker at term-loop boundaries).
  if (prior && stepLabel === '' && prior.termIndex === termIndex) return null;
  return { stepLabel, termIndex };
}
```

---

## File 2 — `src/utils/queueProgress.test.ts` (NEW)

Create the file with this exact content:

```ts
import { describe, it, expect } from 'vitest';
import { mergeProgress } from './queueProgress';

describe('mergeProgress', () => {
  it('accepts the first event when prior is null', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: 0 }))
      .toEqual({ stepLabel: 'Click', termIndex: 0 });
  });

  it('replaces step within the same term', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: 'Extract', termIndex: 0 }))
      .toEqual({ stepLabel: 'Extract', termIndex: 0 });
  });

  it('drops empty stepLabel within the same term (no flicker)', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: '', termIndex: 0 }))
      .toBeNull();
  });

  it('replaces both at a term boundary even if stepLabel is empty', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: '', termIndex: 1 }))
      .toEqual({ stepLabel: '', termIndex: 1 });
  });

  it('replaces both at a term boundary with non-empty stepLabel', () => {
    expect(mergeProgress({ stepLabel: 'Click', termIndex: 0 }, { stepLabel: 'Extract', termIndex: 1 }))
      .toEqual({ stepLabel: 'Extract', termIndex: 1 });
  });

  it('accepts undefined termIndex (setup phase)', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: undefined }))
      .toEqual({ stepLabel: 'Click', termIndex: undefined });
  });

  it('drops payload with non-string stepLabel', () => {
    expect(mergeProgress(null, { stepLabel: 42, termIndex: 0 })).toBeNull();
  });

  it('drops payload with negative termIndex', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: -1 })).toBeNull();
  });

  it('drops payload with non-integer termIndex', () => {
    expect(mergeProgress(null, { stepLabel: 'Click', termIndex: 1.5 })).toBeNull();
  });

  it('caps stepLabel at 200 characters', () => {
    const long = 'x'.repeat(500);
    const result = mergeProgress(null, { stepLabel: long, termIndex: 0 });
    expect(result?.stepLabel.length).toBe(200);
    expect(result?.termIndex).toBe(0);
  });
});
```

---

## File 3 — `src/types/signalr.ts`

Add `progress?` to the `QueueTask` interface.

**Before** ([signalr.ts:4-18](src/types/signalr.ts#L4-L18)):

```ts
export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction';
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}
```

**After**:

```ts
export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  iterationLabel?: string;
  iterationAssignments?: Record<string, string>;
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare' | 'awaitUserAction';
  progress?: { stepLabel: string; termIndex?: number };
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;
}
```

No other changes to this file.

---

## File 4 — `src/sidepanel/stores/queueStore.ts`

### 4a. Extend `QueueState` interface

Add `setTaskProgress` to the interface (after `removeTask`, before `seedFromSnapshot`):

```ts
interface QueueState {
  tasks: QueueTask[];
  currentTaskId: string | null;
  stats: QueueStats;

  addTask: (task: QueueTask) => void;
  setCurrentTask: (taskId: string | null) => void;
  updateTaskStatus: (taskId: string, status: QueueTask['status']) => void;
  setTaskProgress: (taskId: string, progress: { stepLabel: string; termIndex?: number }) => void;
  completeTask: (taskId: string, result: TaskResult) => void;
  failTask: (taskId: string, error: string) => void;
  pauseTask: (taskId: string, reason: QueueTask['pausedReason']) => void;
  resumeTask: (taskId: string) => void;
  clearCompleted: () => void;
  clearPending: () => void;
  removeTask: (taskId: string) => void;
  seedFromSnapshot: (snapshot: { active: QueueTask | null; pending: QueueTask[]; recent: QueueTask[] }) => void;
}
```

### 4b. Add the action

Insert immediately after the `updateTaskStatus` action:

```ts
  setTaskProgress: (taskId, progress) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, progress } : t)),
    })),
```

No `recompute(tasks)` — progress doesn't affect counts.

---

## File 5 — `src/sidepanel/utils/queueDispatcher.ts`

### 5a. Add import

After the existing `import type` lines, add:

```ts
import { mergeProgress } from '../../utils/queueProgress';
```

### 5b. Replace the `FLOW_PROGRESS` handler

**Before** ([queueDispatcher.ts:32-36](src/sidepanel/utils/queueDispatcher.ts#L32-L36)):

```ts
  const offProgress = onMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as { taskId?: string };
    if (!p.taskId) return;
    useQueueStore.getState().updateTaskStatus(p.taskId, 'running');
  });
```

**After**:

```ts
  const offProgress = onMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as { taskId?: string; stepLabel?: unknown; termIndex?: unknown };
    if (!p.taskId) return;
    const store = useQueueStore.getState();
    store.updateTaskStatus(p.taskId, 'running');
    const prior = store.tasks.find((t) => t.id === p.taskId)?.progress ?? null;
    const merged = mergeProgress(prior, { stepLabel: p.stepLabel, termIndex: p.termIndex });
    if (merged) store.setTaskProgress(p.taskId, merged);
  });
```

No other changes to this file.

---

## File 6 — `src/entrypoints/background.ts`

### 6a. Add import

After the existing `import type { DataMapping }` line:

```ts
import { mergeProgress } from '../utils/queueProgress';
```

### 6b. Extend `activeRemoteTask` type

**Before** ([background.ts:29](src/entrypoints/background.ts#L29)):

```ts
  let activeRemoteTask: { task: QueueTask; tabId: number; windowId: number; resolvedDataMapping?: DataMapping } | null = null;
```

**After**:

```ts
  let activeRemoteTask: { task: QueueTask; tabId: number; windowId: number; resolvedDataMapping?: DataMapping; lastProgress?: { stepLabel: string; termIndex?: number } } | null = null;
```

### 6c. Update `buildSnapshotActiveTask`

**Before** ([background.ts:165-172](src/entrypoints/background.ts#L165-L172)):

```ts
  function buildSnapshotActiveTask(): QueueTask | null {
    if (!activeRemoteTask) return null;
    return {
      ...activeRemoteTask.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
    };
  }
```

**After**:

```ts
  function buildSnapshotActiveTask(): QueueTask | null {
    if (!activeRemoteTask) return null;
    return {
      ...activeRemoteTask.task,
      status: activePauseState ? 'paused' : 'running',
      pausedReason: activePauseState?.reason,
      progress: activeRemoteTask.lastProgress,
    };
  }
```

### 6d. Update `FLOW_PROGRESS` case in `handleRemoteFlowEvent`

**Before** (the `case 'FLOW_PROGRESS':` block inside `handleRemoteFlowEvent`):

```ts
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        return;
      }
```

**After**:

```ts
      case 'FLOW_PROGRESS': {
        const hubPayload = mapFlowProgress(ctx, payload as unknown as FlowProgressPayload);
        relayHubInvocation('SEND_TASK_PROGRESS', hubPayload);
        const merged = mergeProgress(activeRemoteTask.lastProgress ?? null, {
          stepLabel: (payload as Record<string, unknown>).stepLabel,
          termIndex: (payload as Record<string, unknown>).termIndex,
        });
        if (merged) {
          activeRemoteTask.lastProgress = merged;
          chrome.storage.session.set({ activeRemoteTask }).catch(() => {});
        }
        return;
      }
```

No other changes to this file. The session-storage write reuses the existing `activeRemoteTask` key — no schema change to the persisted shape beyond the new optional sub-field.

---

## File 7 — `src/sidepanel/components/QueueView.tsx`

### 7a. Remove the dead `useRunStore` usage

**Delete line 3**:

```ts
import { useRunStore } from '../stores/runStore';
```

**Delete from line 20** (the `isRunning` destructure):

```ts
  const { isRunning } = useRunStore();
```

### 7b. Add `stepLine` helper

Add immediately after the `statusDot` function (before `export default function QueueView()`):

```ts
function stepLine(task: QueueTask): string {
  if (!task.progress) return '';
  const { stepLabel, termIndex } = task.progress;
  const total = task.searchTerms.length;
  const showTermPrefix = total > 1 && !task.iterationLabel && termIndex !== undefined;
  if (!showTermPrefix) return stepLabel;
  const display = Math.min(termIndex + 1, total);
  const prefix = `Term ${display} of ${total}`;
  return stepLabel ? `${prefix} · ${stepLabel}` : prefix;
}
```

### 7c. Replace the active card body

**Before** ([QueueView.tsx:71-77](src/sidepanel/components/QueueView.tsx#L71-L77)):

```tsx
          <div className="card-body">
            <p className="text-sm text-light">
              {taskLabel(currentTask) ?? 'Batch task'}
              {currentTask.status === 'paused' && ' — waiting for Cloudflare challenge'}
              {isRunning && currentTask.status === 'running' && ' — running...'}
            </p>
          </div>
```

**After**:

```tsx
          <div className="card-body">
            <p className="text-sm text-light">
              {taskLabel(currentTask) ?? 'Batch task'}
              {currentTask.status === 'paused' && ' — waiting for Cloudflare challenge'}
            </p>
            {currentTask.status === 'running' && stepLine(currentTask) && (
              <span className="run-term-step">{stepLine(currentTask)}</span>
            )}
          </div>
```

(Calling `stepLine` twice is fine — it's a pure ~6-line function on a small object. Avoids introducing a `useMemo`.)

No other changes to this file.

---

## Verification

### Type-check, build, tests, lint

```bash
npx tsc --noEmit
npx vitest run src/utils/queueProgress.test.ts
npx eslint src
npx wxt build
```

`tsc` should report **only the pre-existing baseline errors** documented in SPEC-queue-rehydration-v1.0 (none of which are introduced by this spec). `vitest` should pass all 10 new cases. `eslint` and `wxt build` should pass clean.

### Manual test cases

| # | Scenario | Expected |
|---|---|---|
| 1 | Multi-term batch (≥3 terms) running | Active card shows `Term N of M · <step label>`, updates as steps progress |
| 2 | Single-term batch | Active card shows just the step label, no `Term 1 of 1` prefix |
| 3 | Sidepanel **closed** when task starts → open mid-task | Step line populated immediately from snapshot |
| 4 | Term boundary (between terms) | Brief `Term N of M` with no step suffix; resolves on next event |
| 5 | First moment of task (before first FLOW_PROGRESS) | No step line rendered (just the existing meta line) |
| 6 | Task gets paused (Cloudflare) | Step line **not shown**; meta line shows `— waiting for Cloudflare challenge` |
| 7 | Task resumes from pause | Step line returns; shows the next step |
| 8 | Task completes | Card moves to "Completed" section; no step line there |
| 9 | Task fails | Card moves to "Completed" section showing error; no step line there |
| 10 | Long step label (>50 chars) | Wraps inside the card; no overflow |

### Regression check

- Local (non-queue) scrape: `RunProgress.tsx` still shows step labels (unchanged code path).
- Snapshot rehydration from SPEC-queue-rehydration-v1.0 still works for the active task, with `progress` now also surviving the round-trip.
- `RESUME_TASK` / `CANCEL_TASK` from hub still function (no touched code in those paths).

---

## Architecture notes

**Why a shared `mergeProgress` util when Stage B initially said "duplicate"?**
Two reasons changed the calculus: (1) the merge has non-obvious branches (term-boundary reset, empty-string handling, untrusted-input validation) that benefit from unit-test coverage; (2) duplication of validation logic is exactly the kind of code where the two copies will silently drift. Extracting costs one tiny file and one import on each side.

**Why store `progress` on `QueueTask` rather than a parallel `progressByTaskId` map?**
Matches the existing `pausedReason` precedent on the same shape. Keeping all per-task runtime state in one place means render code does one lookup, not two, and removal/cleanup happens automatically when the task is removed from the store.

**Why no `useMemo` for `stepLine`?**
The component re-renders only on store changes (via Zustand selector). `stepLine` is a synchronous string assembly over a small object. The re-renders are infrequent enough that memoisation adds more cognitive cost than it saves.

**Known follow-up (out of scope)**
Failed cards in the "Completed" section could show "Failed at: <stepLabel>" using the cached `progress` field (which we don't clear). Pre-existing card markup just shows the error string today; intentional minimum-scope deferral.
