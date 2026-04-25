# SPEC-M2.6 — Task editor (frontend-only)

> **Implementing agent**: Sonnet. **Reference**: [step-8-all-misty-nygaard.md](c:\Users\und3r\.claude\plans\step-8-all-misty-nygaard.md). All Stage A–E decisions for M2.6 live there; this spec is Stage F only.

## Context

M2.5 (Configs page) shipped + smoke-tested 2026-04-25. The M2 backend spine is complete: `TaskBlock`/`RunBatch` schema, full Task CRUD (`TasksController`), `IQueueExpansionService` + `LoopBlockExpander` + `ScrapeBlockExpander`, batch dispatch (`POST /api/runs/batch`), populate-preview (`POST /api/tasks/{id}/populate`), `/api/run-batches/{id}` polling. All wire-shape DTOs already exist in `types.ts`. The hooks `usePopulateTask`, `useCreateBatch`, `useRunBatch`, `useScraperConfigs` already exist.

The gap is the frontend task editor. `/tasks` is still the M1 list-with-run-button page. There is no `/tasks/new`, no `/tasks/:id/edit`, no bindings UI, no populate-preview UI, no batch-run trigger. M2.6 wires the frontend through to the existing backend.

## Scope

| In | Out (deferred to M3) |
|---|---|
| Tasks list rewrite: `+ New task`, `Edit`, `Delete`, `Run batch…` per card | Nested loop blocks (loop inside a loop) |
| Task editor at `/tasks/new` + `/tasks/:id/edit` | Multi-scrape tasks (>1 scrape leaf per task) |
| Populate-preview modal → worker selector → batch dispatch | Drag-drop tree reorder, add/remove block nodes |
| Run-batch detail page at `/run-batches/:id` (polled) | Frontend unit tests (deferred to M2.7 polish) |
| | Any backend code change |

## Files

### Backend: zero changes

Verify with: `dotnet test backend/tests/WebScrape.Tests/WebScrape.Tests.csproj` — must stay 75/75 green.

### Frontend modified

| File | Change |
|---|---|
| [backend/src/WebScrape.Client/src/App.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\App.tsx) | Add 3 routes + 2 imports |
| [backend/src/WebScrape.Client/src/api/queries.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\queries.ts) | Add `useTask(id)` |
| [backend/src/WebScrape.Client/src/api/mutations.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\mutations.ts) | Add `useSaveTask`, `useDeleteTask` |
| [backend/src/WebScrape.Client/src/pages/Tasks.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\pages\Tasks.tsx) | Full rewrite |

### Frontend new

| File | Purpose |
|---|---|
| `backend/src/WebScrape.Client/src/pages/TaskEditor.tsx` | Create / edit editor — two-column layout |
| `backend/src/WebScrape.Client/src/pages/RunBatchDetail.tsx` | Polled run-batch detail table |
| `backend/src/WebScrape.Client/src/components/BindingsEditor.tsx` | `setInput` step bindings sub-panel |
| `backend/src/WebScrape.Client/src/components/PopulatePreviewModal.tsx` | Expand preview → worker pick → dispatch |

---

## Decisions deviating from the plan

| # | Decision | Rationale |
|---|---|---|
| 1 | **Run-batch detail "Iteration" column shows `currentTerm`, not `iterationLabel`.** | `RunItemDto` in the backend does not expose `IterationLabel` (the field exists in the `run_items` table and the `RunItem` entity, but `AutoMapperProfile` does not map it, and `RunItemDto.cs` doesn't declare it). This is a zero-backend-changes milestone; adding the field is deferred to M2.7 polish. The column shows `currentTerm ?? '—'`. |
| 2 | **Tasks list derives `scraperConfigName` on the frontend, not via the legacy `TaskDto.scraperConfigName`.** | [TaskService.SaveAsync:90](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\TaskService.cs#L90) sets the deprecated `TaskEntity.ScraperConfigId = null` for new tasks and never backfills it from the scrape block. `AutoMapperProfile` derives `TaskDto.scraperConfigName` from `t.ScraperConfig?.Name ?? ""`, so any task created via the M2.6 editor has an empty `scraperConfigName`. Without a frontend fallback, the card's `domain-badge` would render blank. We resolve by reading `task.blocks[scrape].scrape.scraperConfigId` and looking it up in the `useScraperConfigs()` cache, falling back to `t.scraperConfigName` first (so legacy seeded tasks like Demo Task still show correctly). M5 will backfill the legacy column on the backend. |
| 3 | **`useTask` query disables retry on 4xx.** | TanStack Query's default 3 retries + exponential backoff means a deleted-task lookup sits at `Loading…` for ~7 seconds before the "no longer exists" banner shows. `retry: (n, e) => !axios.isAxiosError(e) || (e.response?.status ?? 0) >= 500 ? n < 2 : false` cuts this to one round-trip. |
| 4 | **`ConfigEditor.tsx` uses `'280px 1fr'` not `'320px 1fr'`** for its grid. The plan said `'320px 1fr'`. TaskEditor uses `'320px 1fr'` as originally specified — the left column has more fields and needs the extra space. |
| 5 | **No frontend unit tests.** Consistent with M2.5 deviation #4. WebScrape.Client has no vitest setup; deferred to M2.7. |

---

## 1. Modified: App.tsx

Add two imports after the existing `ConfigEditor` import (currently line 10):

```tsx
import TaskEditor from './pages/TaskEditor';
import RunBatchDetail from './pages/RunBatchDetail';
```

Add three routes inside the `<AuthShell>` block, after the existing `<Route path="/configs/:id/edit" ...>` (currently line 46):

```tsx
<Route path="/tasks/new" element={<TaskEditor />} />
<Route path="/tasks/:id/edit" element={<TaskEditor />} />
<Route path="/run-batches/:id" element={<RunBatchDetail />} />
```

Complete file after changes:

```tsx
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useMe } from './api/queries';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import ApiKeys from './pages/ApiKeys';
import Workers from './pages/Workers';
import Tasks from './pages/Tasks';
import RunDetail from './pages/RunDetail';
import Configs from './pages/Configs';
import ConfigEditor from './pages/ConfigEditor';
import TaskEditor from './pages/TaskEditor';
import RunBatchDetail from './pages/RunBatchDetail';

function AuthShell() {
  const { data: me, isPending } = useMe();
  const location = useLocation();

  if (isPending) return null;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div className="app">
      <header className="header">
        <h1 style={{ color: 'white', fontSize: 'var(--font-size-xl)', fontWeight: 700, letterSpacing: '-0.3px' }}>
          WebScrape
        </h1>
        <span className="header-version">{me.email}</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar />
        <main className="app-content" style={{ flex: 1 }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AuthShell />}>
        <Route index element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/new" element={<TaskEditor />} />
        <Route path="/tasks/:id/edit" element={<TaskEditor />} />
        <Route path="/configs" element={<Configs />} />
        <Route path="/configs/new" element={<ConfigEditor />} />
        <Route path="/configs/:id/edit" element={<ConfigEditor />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/run-batches/:id" element={<RunBatchDetail />} />
      </Route>
    </Routes>
  );
}
```

---

## 2. Modified: api/queries.ts

`TaskDto` is already in the import list at the top of the file — verify and leave as-is:

```ts
import type { AccountDto, ApiKeyDto, RunBatchDetailDto, RunItemDto, ScraperConfigDto, TaskDto, WorkerDto } from './types';
```

Append at the end of the file:

```ts
export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ['tasks', id],
    enabled: !!id,
    queryFn: async () => (await api.get<TaskDto>(`/api/tasks/${id}`)).data,
    retry: (failureCount, error) => {
      // Don't retry 4xx (404 deleted task, 403 cross-user) — surface the error fast.
      if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        if (status >= 400 && status < 500) return false;
      }
      return failureCount < 2;
    },
  });
}
```

> Note: `axios` is already imported at the top of `queries.ts` (used by `useMe`). No new import needed.

---

## 3. Modified: api/mutations.ts

Update the type import line to add `SaveTaskDto` and `TaskDto`:

```ts
import type { AccountDto, BatchDispatchResultDto, CreateApiKeyResponseDto, CreateBatchDto, CreateRunSuccess, CreateScraperConfigDto, ExpansionPreviewDto, SaveTaskDto, ScraperConfigDto, TaskDto } from './types';
```

Append at the end of the file (before the final blank line):

```ts
export function useSaveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: SaveTaskDto }): Promise<TaskDto> => {
      if (id) {
        return (await api.put<TaskDto>(`/api/tasks/${id}`, body)).data;
      }
      return (await api.post<TaskDto>('/api/tasks', body)).data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      if (vars.id) qc.invalidateQueries({ queryKey: ['tasks', vars.id] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/tasks/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
```

---

## 4. Modified: pages/Tasks.tsx — full rewrite

Replace the entire file:

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useScraperConfigs, useTasks } from '../api/queries';
import { useDeleteTask } from '../api/mutations';
import Modal from '../components/Modal';
import PopulatePreviewModal from '../components/PopulatePreviewModal';
import type { ScraperConfigDto, TaskDto } from '../api/types';

// Tasks created via the M2.6 editor have a null legacy `ScraperConfigId` column,
// so the backend-derived `t.scraperConfigName` is empty. Look up the name from
// the scrape block's id against the configs cache. See spec deviation #2.
function configNameFor(t: TaskDto, configs: ScraperConfigDto[] | undefined): string {
  if (t.scraperConfigName) return t.scraperConfigName;
  const scrape = t.blocks.find((b) => b.blockType === 'scrape');
  const scrapeConfigId = scrape?.scrape?.scraperConfigId;
  if (!scrapeConfigId) return '';
  return configs?.find((c) => c.id === scrapeConfigId)?.name ?? '';
}

export default function Tasks() {
  const { data: tasks, isPending } = useTasks();
  const { data: configs } = useScraperConfigs();
  const remove = useDeleteTask();
  const nav = useNavigate();

  const [confirmDelete, setConfirmDelete] = useState<TaskDto | null>(null);
  const [runTask, setRunTask] = useState<TaskDto | null>(null);

  const doDelete = async () => {
    if (!confirmDelete) return;
    await remove.mutateAsync(confirmDelete.id);
    setConfirmDelete(null);
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Tasks</h2>
        <button className="btn btn-primary" onClick={() => nav('/tasks/new')}>
          + New task
        </button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && tasks && tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No tasks yet</div>
          <div className="empty-state-desc">
            Create one to start scraping. A task is one loop of values feeding one scraper config.
          </div>
        </div>
      )}

      {!isPending && tasks && tasks.length > 0 && (
        <div className="config-list">
          {tasks.map((t) => {
            const configName = configNameFor(t, configs);
            return (
              <div key={t.id} className="card list-card config-card">
                <div className="config-card-header">
                  <div className="config-card-name">{t.name}</div>
                  <div style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
                    <Link to={`/tasks/${t.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmDelete(t)}
                    >
                      Delete
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setRunTask(t)}
                    >
                      Run batch…
                    </button>
                  </div>
                </div>
                <div className="config-card-meta">
                  {configName ? (
                    <span className="domain-badge">{configName}</span>
                  ) : (
                    <span className="meta-badge">No config</span>
                  )}
                  <span className="meta-badge">
                    {t.searchTerms.length} value{t.searchTerms.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this task?"
      >
        <div className="modal-body">
          Delete <strong>{confirmDelete?.name}</strong>? This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>

      {runTask && (
        <PopulatePreviewModal
          task={runTask}
          onClose={() => setRunTask(null)}
        />
      )}
    </div>
  );
}
```

> Notes for Sonnet:
> - `value`/`values` (not `term`/`terms`) — the loop in M2.6 is general-purpose, not just search terms. Keeps the language consistent with the editor's "Loop values" label.
> - `useScraperConfigs()` is cheap (cached after first call) and is invoked here to give us names for M2.6-created tasks. Don't try to skip the call when configs aren't strictly needed — most tasks will need it.

---

## 5. New: components/BindingsEditor.tsx

```tsx
import type { StepBindingDto } from '../api/types';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type Props = {
  steps: SetInputStep[];
  loopBlockId: string;
  loopName: string;
  stepBindings: Record<string, StepBindingDto>;
  onChange: (bindings: Record<string, StepBindingDto>) => void;
};

export default function BindingsEditor({ steps, loopBlockId, loopName, stepBindings, onChange }: Props) {
  if (steps.length === 0) {
    return (
      <div className="form-hint">
        This config has no inputs. Loop values will run the scrape, but won't be substituted.
      </div>
    );
  }

  const update = (stepId: string, binding: StepBindingDto) => {
    onChange({ ...stepBindings, [stepId]: binding });
  };

  return (
    <div>
      {steps.length > 1 && (
        <div className="form-hint" style={{ marginBottom: 'var(--spacing-sm)' }}>
          Other inputs default to Unbound — bind them manually.
        </div>
      )}
      {steps.map((step) => {
        const binding = stepBindings[step.id] ?? { kind: 'unbound' as const };
        return (
          <div key={step.id} className="form-group">
            <label className="form-label">{step.id}</label>
            <select
              className="form-select"
              value={binding.kind}
              onChange={(e) => {
                const kind = e.target.value as 'loopRef' | 'literal' | 'unbound';
                if (kind === 'loopRef') update(step.id, { kind: 'loopRef', loopBlockId });
                else if (kind === 'literal') update(step.id, { kind: 'literal', value: '' });
                else update(step.id, { kind: 'unbound' });
              }}
            >
              <option value="loopRef">Loop value ({loopName}.currentItem)</option>
              <option value="literal">Literal value</option>
              <option value="unbound">Unbound</option>
            </select>
            {binding.kind === 'literal' && (
              <input
                className="form-input"
                placeholder="Static text"
                value={binding.value}
                onChange={(e) => update(step.id, { kind: 'literal', value: e.target.value })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

---

## 6. New: components/PopulatePreviewModal.tsx

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useWorkers } from '../api/queries';
import { useCreateBatch, usePopulateTask } from '../api/mutations';
import Modal from './Modal';
import type { ExpansionPreviewDto, TaskDto } from '../api/types';

type Props = {
  task: TaskDto;
  onClose: () => void;
};

function warningCopy(code: string, stepId?: string | null): string {
  switch (code) {
    case 'STEP_NO_LONGER_EXISTS':
      return `Binding for step '${stepId ?? '?'}' references a step that no longer exists. It will be ignored.`;
    case 'NEW_STEP_UNBOUND':
      return `Step '${stepId ?? '?'}' has no binding — input will be empty for this run.`;
    case 'BINDING_UNBOUND':
      return `Step '${stepId ?? '?'}' is unbound — input will be empty.`;
    case 'CONFIG_NOT_FOUND_AT_POPULATE':
      return 'Config for a scrape block was deleted; this iteration will be skipped.';
    default:
      return `Warning: ${code}`;
  }
}

export default function PopulatePreviewModal({ task, onClose }: Props) {
  const nav = useNavigate();
  const { data: workers } = useWorkers();
  const populate = usePopulateTask();
  const createBatch = useCreateBatch();

  const [preview, setPreview] = useState<ExpansionPreviewDto | null>(null);
  const [populateError, setPopulateError] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string>('');
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const onlineWorkers = (workers ?? []).filter((w) => w.online);

  useEffect(() => {
    setPreview(null);
    setPopulateError(null);
    setDispatchError(null);
    populate.mutate(task.id, {
      onSuccess: (data) => setPreview(data),
      onError: (e) => {
        if (axios.isAxiosError(e) && e.response?.status === 422) {
          const data = e.response.data as { code: string; count?: number; cap?: number; error: string };
          if (data.code === 'BATCH_TOO_LARGE') {
            setPopulateError(`Too many iterations: ${data.count} (max ${data.cap}). Reduce loop values.`);
          } else {
            setPopulateError('This task expands to zero iterations. Add at least one loop value.');
          }
        } else {
          setPopulateError('Could not preview this task. Try again.');
        }
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    if (onlineWorkers.length > 0 && !workerId) {
      setWorkerId(onlineWorkers[0].id);
    }
  }, [onlineWorkers, workerId]);

  const runBatch = async () => {
    if (!workerId) return;
    setDispatchError(null);
    try {
      const result = await createBatch.mutateAsync({ taskId: task.id, workerId });
      onClose();
      nav(`/run-batches/${result.batchId}`);
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const data = e.response?.data as { error?: string } | undefined;
        setDispatchError(data?.error ?? 'Could not start the batch. Try again.');
      } else {
        setDispatchError('Could not start the batch. Try again.');
      }
    }
  };

  return (
    <Modal open onClose={onClose} title={`Run "${task.name}"`}>
      {populate.isPending && <div className="loading-state">Expanding iterations…</div>}

      {populateError && <div className="danger-banner">{populateError}</div>}

      {preview && preview.warnings.length > 0 && (
        <div className="run-banner run-banner-warning">
          <ul style={{ paddingLeft: 'var(--spacing-md)', margin: 0 }}>
            {preview.warnings.map((w, i) => (
              <li key={i}>{warningCopy(w.code, w.stepId)}</li>
            ))}
          </ul>
        </div>
      )}

      {preview && !populateError && (
        <table className="data-table" style={{ marginBottom: 'var(--spacing-md)' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Iteration</th>
              <th>Inputs</th>
            </tr>
          </thead>
          <tbody>
            {preview.items.map((item, i) => (
              <tr key={`${item.scrapeBlockId}-${i}`}>
                <td>{i + 1}</td>
                <td>{item.iterationLabel}</td>
                <td>
                  {Object.entries(item.assignments).map(([k, v]) => (
                    <span key={k} className="meta-badge" style={{ marginRight: 'var(--spacing-xs)' }}>
                      {v}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="form-group">
        {onlineWorkers.length === 0 ? (
          <div className="form-hint text-danger">
            No workers are online right now. Connect a browser extension first.
          </div>
        ) : (
          <select
            className="form-select"
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
          >
            {onlineWorkers.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
      </div>

      {dispatchError && <div className="danger-banner">{dispatchError}</div>}

      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={runBatch}
          disabled={!preview || !!populateError || !workerId || createBatch.isPending}
        >
          {createBatch.isPending ? 'Starting…' : 'Run batch'}
        </button>
      </div>
    </Modal>
  );
}
```

---

## 7. New: pages/TaskEditor.tsx

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useScraperConfigs, useTask } from '../api/queries';
import { useSaveTask } from '../api/mutations';
import BindingsEditor from '../components/BindingsEditor';
import type { SaveTaskDto, StepBindingDto, ValidationErrorDto } from '../api/types';

const LOOP_NAME = 'loop1';

type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

type EditorState = {
  name: string;
  loopBlockId: string;
  scrapeBlockId: string;
  loopName: string;
  loopValues: string[];
  scraperConfigId: string;
  stepBindings: Record<string, StepBindingDto>;
};

function newEditorState(): EditorState {
  return {
    name: '',
    loopBlockId: crypto.randomUUID(),
    scrapeBlockId: crypto.randomUUID(),
    loopName: LOOP_NAME,
    loopValues: [],
    scraperConfigId: '',
    stepBindings: {},
  };
}

function buildSaveDto(state: EditorState): SaveTaskDto {
  return {
    name: state.name,
    blocks: [
      {
        id: state.loopBlockId,
        parentBlockId: null,
        blockType: 'loop',
        orderIndex: 0,
        loop: { name: state.loopName, values: state.loopValues.filter((v) => v.trim().length > 0) },
        scrape: null,
      },
      {
        id: state.scrapeBlockId,
        parentBlockId: state.loopBlockId,
        blockType: 'scrape',
        orderIndex: 0,
        loop: null,
        scrape: { scraperConfigId: state.scraperConfigId, stepBindings: state.stepBindings },
      },
    ],
  };
}

function parseSetInputSteps(configJson: unknown): SetInputStep[] {
  try {
    const obj = configJson as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) return [];
    return obj.steps.filter(
      (s): s is SetInputStep =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>).type === 'setInput' &&
        typeof (s as Record<string, unknown>).id === 'string',
    );
  } catch {
    return [];
  }
}

function autoBindSteps(steps: SetInputStep[], loopBlockId: string): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  let firstBound = false;
  for (const step of steps) {
    if (!firstBound) {
      result[step.id] = { kind: 'loopRef', loopBlockId };
      firstBound = true;
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}

function mapValidationError(e: ValidationErrorDto): string {
  switch (e.code) {
    case 'MISSING_TASK_NAME':
      return 'Add a name for this task.';
    case 'CONFIG_NOT_OWNED':
      return 'Pick a scraper config you own.';
    case 'BINDING_LITERAL_MISSING_VALUE':
      return `Step '${e.stepId ?? '?'}' is set to a literal value but has no text.`;
    case 'LOOP_REF_NON_ANCESTOR':
      return `Step '${e.stepId ?? '?'}' references a loop that doesn't apply here.`;
    default:
      return `Couldn't save this task (${e.code}).`;
  }
}

export default function TaskEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();

  const { data: existingTask, isPending: loadingTask, isError: taskLoadError } = useTask(id);
  const { data: configs } = useScraperConfigs();
  const save = useSaveTask();

  const [state, setState] = useState<EditorState>(newEditorState);
  const [hydrated, setHydrated] = useState(false);
  const [complexStructure, setComplexStructure] = useState(false);

  useEffect(() => {
    if (!isEdit || !existingTask || hydrated) return;

    const loopBlock = existingTask.blocks.find(
      (b) => b.blockType === 'loop' && b.parentBlockId === null,
    );
    const scrapeBlock = loopBlock
      ? existingTask.blocks.find(
          (b) => b.blockType === 'scrape' && b.parentBlockId === loopBlock.id,
        )
      : undefined;

    if (!loopBlock || !scrapeBlock) {
      setComplexStructure(true);
      setHydrated(true);
      return;
    }

    if (existingTask.blocks.length > 2) {
      setComplexStructure(true);
    }

    setState({
      name: existingTask.name,
      loopBlockId: loopBlock.id,
      scrapeBlockId: scrapeBlock.id,
      loopName: loopBlock.loop?.name ?? LOOP_NAME,
      loopValues: loopBlock.loop?.values ?? [],
      scraperConfigId: scrapeBlock.scrape?.scraperConfigId ?? '',
      stepBindings: scrapeBlock.scrape?.stepBindings ?? {},
    });
    setHydrated(true);
  }, [isEdit, existingTask, hydrated]);

  const selectedConfig = useMemo(
    () => configs?.find((c) => c.id === state.scraperConfigId) ?? null,
    [configs, state.scraperConfigId],
  );

  const setInputSteps = useMemo(
    () => (selectedConfig ? parseSetInputSteps(selectedConfig.configJson) : []),
    [selectedConfig],
  );

  const handleConfigChange = (configId: string) => {
    const config = configs?.find((c) => c.id === configId);
    const steps = config ? parseSetInputSteps(config.configJson) : [];
    setState((s) => ({
      ...s,
      scraperConfigId: configId,
      stepBindings: autoBindSteps(steps, s.loopBlockId),
    }));
  };

  const saveError = useMemo(() => {
    const e = save.error;
    if (!e) return null;
    if (axios.isAxiosError(e) && e.response?.status === 400) {
      const data = e.response.data as { errors?: ValidationErrorDto[] };
      if (data.errors?.length) {
        return data.errors.map(mapValidationError).join(' ');
      }
    }
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? "Couldn't save this task.";
    }
    return "Couldn't save this task.";
  }, [save.error]);

  const configMissing =
    isEdit &&
    hydrated &&
    !!state.scraperConfigId &&
    configs !== undefined &&
    !configs.find((c) => c.id === state.scraperConfigId);

  const canSave = !complexStructure && !!state.name.trim() && !!state.scraperConfigId;

  const submit = async () => {
    if (!canSave) return;
    await save.mutateAsync({ id, body: buildSaveDto(state) });
    nav('/tasks');
  };

  if (isEdit && loadingTask) return <div className="loading-state">Loading…</div>;

  if (isEdit && taskLoadError) {
    return (
      <div className="view">
        <div className="danger-banner">This task no longer exists.</div>
        <Link to="/tasks" className="btn btn-ghost">← Back to tasks</Link>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back to tasks">←</Link>
          <h2 className="view-title">{isEdit ? 'Edit task' : 'New task'}</h2>
        </div>
        <div className="flex gap-sm">
          <button className="btn btn-ghost" onClick={() => nav('/tasks')}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={save.isPending || !canSave}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {complexStructure && (
        <div className="run-banner run-banner-warning">
          This task has a more complex structure than this editor supports. You can view it but not save changes.
        </div>
      )}

      {saveError && <div className="danger-banner">{saveError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>
        <div>
          <div className="form-group">
            <label className="form-label" htmlFor="task-name">Name</label>
            <input
              id="task-name"
              className="form-input"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              placeholder="e.g. Bing news search"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="task-config">Scraper config</label>
            <select
              id="task-config"
              className="form-select"
              value={state.scraperConfigId}
              onChange={(e) => handleConfigChange(e.target.value)}
            >
              <option value="">— pick a config —</option>
              {configMissing && (
                <option value={state.scraperConfigId} disabled>
                  {state.scraperConfigId} (deleted)
                </option>
              )}
              {(configs ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="task-values">Loop values</label>
            <textarea
              id="task-values"
              className="form-textarea"
              rows={8}
              value={state.loopValues.join('\n')}
              onChange={(e) => {
                const vals = e.target.value.split('\n').map((v) => v.trimEnd());
                setState((s) => ({ ...s, loopValues: vals }));
              }}
              placeholder="One value per line. Each value runs the scrape once."
            />
            <div className="form-hint">One value per line. Each value runs the scrape once.</div>
          </div>
        </div>

        <div className="card">
          <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
            Input bindings
          </div>
          <BindingsEditor
            steps={setInputSteps}
            loopBlockId={state.loopBlockId}
            loopName={state.loopName}
            stepBindings={state.stepBindings}
            onChange={(bindings) => setState((s) => ({ ...s, stepBindings: bindings }))}
          />
        </div>
      </div>
    </div>
  );
}
```

---

## 8. New: pages/RunBatchDetail.tsx

```tsx
import { Link, useParams } from 'react-router-dom';
import { useRunBatch } from '../api/queries';
import type { RunItemDto } from '../api/types';

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending',
    sent: 'Sent',
    running: 'Running',
    paused: 'Paused',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

function batchBannerClass(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  const allTerminal = items.every(
    (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
  );
  if (!allTerminal) return 'run-banner run-banner-warning';
  return items.some((r) => r.status === 'failed')
    ? 'run-banner run-banner-error'
    : 'run-banner run-banner-success';
}

function batchBannerText(items: RunItemDto[]): string {
  if (items.length === 0) return '';
  const allTerminal = items.every(
    (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
  );
  if (!allTerminal) return 'Batch in progress…';
  const failed = items.filter((r) => r.status === 'failed').length;
  return failed === 0 ? 'All done.' : `${failed} iteration${failed === 1 ? '' : 's'} failed.`;
}

export default function RunBatchDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isPending } = useRunBatch(id);

  if (isPending) return <div className="loading-state">Loading…</div>;
  if (!batch) return <div className="view"><div className="danger-banner">Batch not found.</div></div>;

  const bannerClass = batchBannerClass(batch.runItems);
  const bannerText = batchBannerText(batch.runItems);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/tasks" className="back-btn" aria-label="Back to tasks">←</Link>
          <h2 className="view-title">{batch.taskName}</h2>
        </div>
        <span className="meta-badge">{batch.workerName}</span>
      </div>

      {bannerClass && <div className={bannerClass}>{bannerText}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Iteration</th>
            <th>Status</th>
            <th>Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {batch.runItems.map((item, i) => (
            <tr key={item.id}>
              <td>{i + 1}</td>
              <td>{item.currentTerm ?? '—'}</td>
              <td>{statusLabel(item.status)}</td>
              <td>{item.progressPercent != null ? `${item.progressPercent}%` : '—'}</td>
              <td>
                <Link to={`/runs/${item.id}`} className="btn btn-secondary btn-sm">View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

> **Known gap**: The "Iteration" column shows `currentTerm` (populated by the extension during execution, null initially for pending/sent items) rather than `iterationLabel`. The `run_items.iteration_label` column is populated at batch creation time but `RunItemDto` does not expose it — `AutoMapperProfile` doesn't map the field. Fix deferred to M2.7: add `IterationLabel` to `RunItemDto.cs`, map it in `AutoMapperProfile`, add it to the frontend `RunItemDto` type, and update this column to use `item.iterationLabel`.

---

## 9. UI inventory (Stage C alignment)

| Element | Class / token | New? |
|---|---|---|
| Tasks list header | `view-header-row`, `view-title` | No |
| Task card | `card list-card config-card`, `config-card-header`, `config-card-name`, `config-card-meta` | No |
| Card action buttons | `btn btn-secondary btn-sm`, `btn btn-danger btn-sm`, `btn btn-primary btn-sm` | No |
| Empty state | `empty-state`, `empty-state-title`, `empty-state-desc` | No |
| Delete modal | `Modal` + `modal-body`, `modal-actions`, `danger-banner` | No |
| Editor header | `view-header-row`, `back-btn`, `view-title`, `flex`, `items-center`, `gap-sm` | No |
| Editor split | inline `display: grid; gridTemplateColumns: 320px 1fr` | No (one-off layout, precedent in ConfigEditor.tsx:138) |
| Editor form | `form-group`, `form-label`, `form-input`, `form-select`, `form-textarea`, `form-hint` | No |
| Editor right card | `card` | No |
| Complex-structure banner | `run-banner run-banner-warning` | No |
| Populate modal loading | `loading-state` | No |
| Populate modal warnings | `run-banner run-banner-warning` | No |
| Populate modal table | `data-table` | No |
| Populate modal worker select | `form-group`, `form-select`, `form-hint text-danger` | No |
| Populate modal actions | `modal-actions`, `btn btn-ghost`, `btn btn-primary` | No |
| Dispatch error | `danger-banner` | No |
| Run-batch detail header | `view-header-row`, `back-btn`, `view-title`, `meta-badge` | No |
| Run-batch detail banner | `run-banner run-banner-success/warning/error` | No |
| Run-batch detail table | `data-table`, `btn btn-secondary btn-sm` | No |

No new CSS classes. No new design tokens. No inline colours. No `dangerouslySetInnerHTML`.

---

## 10. Security (Stage D)

No new attack surface. All task endpoints are already user-scoped: `TaskService.SaveAsync` ownership check, `TaskValidator` config-ownership check (`CONFIG_NOT_OWNED`), `RunBatchService` task+worker ownership at dispatch. Loop values and binding values are sent to the backend as literal strings and stored; the extension renders them as scraper inputs, not as HTML. The frontend renders all user strings as React text (escaped). No `dangerouslySetInnerHTML` anywhere in this change.

---

## 11. Verification

### Automated

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet test tests/WebScrape.Tests/WebScrape.Tests.csproj
```

Expected: 75/75 green. No backend files touched.

```bash
cd c:/Users/und3r/blueberry-v3/backend/src/WebScrape.Client
npm run build
```

Expected: clean TypeScript build. No type errors.

### Manual smoke (12 steps)

1. **Setup**: backend running on 5082 (`dotnet run --project src/WebScrape.Server` from `backend/`); frontend `npm run dev` on 5173; signed in as `admin@local` / `admin`; extension connected as a worker in Queue mode.
2. **List page**: open `/tasks` → see `Demo Task` card with `Edit`, `Delete`, `Run batch…` buttons and a `+ New task` button in the header.
3. **Empty editor**: click `+ New task` → `/tasks/new`. Name empty, no config selected, values empty, bindings panel says "This config has no inputs…". Save disabled.
4. **Pick config + auto-bind**: select Demo Local Fixture. If it has a `setInput` step, the first row pre-selects "Loop value (loop1.currentItem)". Save still disabled (no name yet).
5. **Type values + save**: name = `M2.6 Smoke`; loop values textarea = `apple` / `banana` / `cherry` (3 lines). Save → navigates to `/tasks`. **New card shows the config name in the domain-badge** (this verifies deviation #2's frontend lookup is working — without it, the badge would render empty because the legacy `ScraperConfigId` column isn't backfilled). Meta also shows `3 values`.
6. **Edit re-hydrates**: click `Edit` on `M2.6 Smoke` → all fields populated, bindings populated. Save without changes → back at `/tasks`, no error.
7. **Populate preview**: click `Run batch…` → modal opens, loading state briefly visible, then table shows 3 rows with iteration labels `loop1=apple`, `loop1=banana`, `loop1=cherry`. Count 3. No warnings. Check network tab for 200 from `POST /api/tasks/{id}/populate`.
8. **Dispatch**: pick the connected worker → `Run batch` → navigates to `/run-batches/{batchId}`. Table shows 3 rows in Pending/Sent state.
9. **Polling**: row statuses transition `Pending → Sent → Running → Done`. Each row's `View` link opens `/runs/{runItemId}` (existing RunDetail page).
10. **Re-run idempotent**: back to `/tasks`, click `Run batch…` again on same task → same preview. `Run batch` creates a new batch. Confirms populate alone writes no DB rows.
11. **Literal binding**: edit task, change first `setInput` to `Literal value` = `static-term`. Save. `Run batch…` → preview still shows loop-derived iteration labels (loop ref is gone, only literal). Dispatch and verify the extension receives `static-term` as the setInput value.
12. **Delete**: from list, `Delete` → confirm modal → row disappears. Navigate to `/tasks/{deletedId}/edit` → editor shows "This task no longer exists." with back button.

### Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Selected config has zero `setInput` steps | **Cover**. BindingsEditor shows "This config has no inputs…" hint. Save proceeds with `stepBindings: {}`. |
| Loop has zero values | **Cover**. Save succeeds; populate returns 422 `BATCH_EMPTY` → modal shows banner, Run disabled. |
| Worker offline at dispatch | **Cover**. Modal pre-filters online workers. If worker drops between filter and dispatch, backend returns error → `dispatchError` banner inside modal. |
| Worker disconnects mid-batch | **Cover (no UI change)**. RunBatchService marks items `failed`; polling table shows `Failed` status. |
| Edit a task whose config was deleted | **Cover**. Dropdown shows `{configId} (deleted)` as a disabled option. Must pick new config to save (validator returns `CONFIG_NOT_OWNED`). |
| Config with multiple `setInput` steps | **Cover**. First step auto-binds to `loopRef`, rest default to `Unbound`. Hint: "Other inputs default to Unbound — bind them manually." |
| Backend returns 400 validation errors | **Cover**. `danger-banner` lists each error mapped to friendly copy. |
| Populate returns warnings | **Cover**. Warnings shown above the table as `run-banner-warning` bullet list. Run button stays enabled. |
| Complex task structure (M3 multi-loop) | **Cover**. Editor shows `run-banner-warning` banner "This task has a more complex structure…" and disables Save. |
| Concurrent edit (two tabs) | **Ignore (v1)**. Last-write-wins. Same posture as M2.5. |

---

## 12. Memory updates after merge

Update [webscrape_initiative.md](C:\Users\und3r\.claude\projects\c--Users-und3r-blueberry-v3\memory\webscrape_initiative.md):

- Add milestone entry: `**M2.6 — Task editor. ✅ IMPLEMENTED + SMOKE-TESTED <date>.** New `/tasks/new` + `/tasks/:id/edit` routes with bindings editor + populate-preview modal + batch dispatch. New `/run-batches/:id` polling page. M2 frontend complete.`
- Update "M2 — Task authoring" line to: `**M2 — Task authoring. ✅ COMPLETE (M2.1 + M2.5 + M2.6).** Nested loops + multi-scrape deferred to M3.`
- Note known gap: `run_items.iteration_label` not surfaced in `RunItemDto` → RunBatchDetail "Iteration" column shows `currentTerm` (null until extension executes). Fix in M2.7.
