# SPEC-M2.5 — Configs page (CRUD + JSON editor)

> **Implementing agent**: Sonnet. **Reference**: [lets-plan-m2-splendid-flurry.md:284-298](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md#L284-L298), [lets-plan-m2-splendid-flurry.md:422](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md#L422). All Stage A–E decisions for M2 live there; this spec is Stage F only.

## Context

M1 shipped `GET /api/scraper-configs`, `POST`, and `PUT` plus the frontend hits none of them — the only config in the DB is the seeded "Demo Local Fixture". M2.6 (the task editor) is dead-on-arrival without authorable scraper configs because the scrape-block form needs a populated dropdown of user-owned configs. M2.5 fills that gap with a `/configs` page (list + create + edit + delete) and a CodeMirror 6 JSON editor.

## Scope

| In | Out (deferred) |
|---|---|
| `DELETE /api/scraper-configs/{id}` (rejects if referenced by any task) | Diff/merge between extension-local configs and backend (M5) |
| Frontend `/configs` list page | Schema-aware visual editor for steps |
| Frontend `/configs/new` + `/configs/:id/edit` routes with CodeMirror JSON editor | Per-step CodeMirror inside the task editor (M2.9) |
| Sidebar "Configs" link | Importing configs from the extension's `chrome.storage` |
| TanStack Query hooks for configs CRUD | Frontend unit tests (no vitest set up in WebScrape.Client yet — defer with M2.6) |
| Backend xUnit coverage for `DeleteAsync` | |

## Files

### Backend (3 modified, 1 new test)

| File | Action |
|---|---|
| [backend/src/WebScrape.Services/Interfaces/IScraperConfigService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Interfaces\IScraperConfigService.cs) | Add `DeleteScraperConfigOutcome` enum + `DeleteAsync` |
| [backend/src/WebScrape.Services/Implementations/ScraperConfigService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\ScraperConfigService.cs) | Implement `DeleteAsync` (reference check + remove) |
| [backend/src/WebScrape.Server/Controllers/ScraperConfigsController.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Controllers\ScraperConfigsController.cs) | Add `DELETE` action |
| `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceTests.cs` | NEW — delete success / delete-blocked / cross-user 403 / not-found |

### Frontend (4 modified, 2 new)

| File | Action |
|---|---|
| [backend/src/WebScrape.Client/package.json](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\package.json) | Add deps `@uiw/react-codemirror`, `@codemirror/lang-json` |
| [backend/src/WebScrape.Client/src/api/types.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\types.ts) | Add `ScraperConfigDto`, `CreateScraperConfigDto`, source-file comment update |
| [backend/src/WebScrape.Client/src/api/queries.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\queries.ts) | Add `useScraperConfigs`, `useScraperConfig` |
| [backend/src/WebScrape.Client/src/api/mutations.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\mutations.ts) | Add `useCreateScraperConfig`, `useUpdateScraperConfig`, `useDeleteScraperConfig` |
| [backend/src/WebScrape.Client/src/App.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\App.tsx) | Register `/configs`, `/configs/new`, `/configs/:id/edit` routes |
| [backend/src/WebScrape.Client/src/components/Sidebar.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\components\Sidebar.tsx) | Add `Configs` link between Tasks and Workers |
| `backend/src/WebScrape.Client/src/pages/Configs.tsx` | NEW — list page |
| `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx` | NEW — create/edit page with CodeMirror |

---

## Decisions deviating from the roadmap

| # | Decision | Rationale |
|---|---|---|
| 1 | **Editor uses routes, not a modal.** `/configs/new` + `/configs/:id/edit`. | The existing `.modal-box { max-width: 420px }` is too narrow for the planned split layout w/ CodeMirror; routes also pre-establish the pattern M2.6 uses for the task editor. The plan said "modal/route" — the choice was explicitly open. |
| 2 | **Delete rejection check covers BOTH `task_blocks.config_jsonb -> 'scraperConfigId'` AND the deprecated `tasks.scraper_config_id` FK.** | The deprecated FK column survives until M5 ([WebScrapeDbContext.cs:64](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\WebScrapeDbContext.cs#L64) sets `OnDelete(Restrict)`), so a delete that ignores it surfaces as a generic 500 from EF when an old row still points at the config. |
| 3 | **Confirm-delete is a `Modal`** (the existing component) on the list page, not on the editor page. | Mirrors the `ApiKeys.tsx` pattern. Editor has its own inline "Delete" button that opens the same modal so the only delete UX lives in one component. |
| 4 | **No frontend unit tests in this sub-stage.** | WebScrape.Client has no vitest setup ([package.json](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\package.json) — only `tsc -b` + vite). Adding it now expands scope; the M2 plan acknowledges setup is needed by M2.6. Backend xUnit + manual round-trip is sufficient for M2.5. |
| 5 | **Server-side body validation stays minimal: `JsonDocument.Parse` only**, exactly as M1's `Create`/`Update` already does. | Schema-shape validation is not in scope ([roadmap §UI plan](c:\Users\und3r\.claude\plans\lets-plan-m2-splendid-flurry.md#L298): "Save button validates JSON.parse + minimal schema check (top-level keys present, `steps` is an array)" — the **client** does the shape check; the server already validates JSON syntax via the JsonElement model binder). |

---

## 1. Backend changes

### 1.1 [IScraperConfigService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Interfaces\IScraperConfigService.cs) — add delete contract

Replace the file contents with:

```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum DeleteScraperConfigOutcome
{
    Deleted,
    NotFound,
    Forbidden,
    Referenced,
}

public record DeleteScraperConfigResult(DeleteScraperConfigOutcome Outcome, int ReferencingTaskCount);

public interface IScraperConfigService
{
    Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, CancellationToken ct = default);
    Task<ScraperConfigDto?> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default);
    Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default);
}
```

### 1.2 [ScraperConfigService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\ScraperConfigService.cs) — implement DeleteAsync

Append the following method to the `ScraperConfigService` class (after `UpdateAsync`, before the closing brace):

```csharp
public async Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default)
{
    var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id, ct);
    if (entity is null)
        return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.NotFound, 0);
    if (entity.UserId != userId)
        return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Forbidden, 0);

    // Two reference paths must be checked: the deprecated FK on TaskEntity (kept until M5)
    // and the JSONB scraperConfigId inside scrape blocks. EF maps JSONB to a string column,
    // so a substring match on the serialized GUID is the cheapest cross-DB-portable check
    // and is safe because GUIDs are unique tokens that don't collide with other JSONB keys.
    var idAsString = id.ToString();
    var legacyTaskCount = await _db.Tasks.CountAsync(t => t.ScraperConfigId == id, ct);
    var blockTaskCount = await _db.TaskBlocks
        .Where(b => b.BlockType == BlockType.Scrape && EF.Functions.Like(EF.Property<string>(b, "config_jsonb"), $"%{idAsString}%"))
        .Select(b => b.TaskId)
        .Distinct()
        .CountAsync(ct);

    var referencingTaskCount = legacyTaskCount + blockTaskCount;
    if (referencingTaskCount > 0)
        return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Referenced, referencingTaskCount);

    _db.ScraperConfigs.Remove(entity);
    await _db.SaveChangesAsync(ct);
    return new DeleteScraperConfigResult(DeleteScraperConfigOutcome.Deleted, 0);
}
```

Add the missing `using` at the top of the file (if not already present):

```csharp
using WebScrape.Data.Enums;
```

> **Why `EF.Functions.Like` not `>>` JSONB ops**: the EF model maps the JSONB column to a string ([WebScrapeDbContext.cs:73](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\WebScrapeDbContext.cs#L73) — `HasConversion(jsonConverter)`), and the InMemory test provider used by xUnit ([TestDb.cs](c:\Users\und3r\blueberry-v3\backend\tests\WebScrape.Tests\TestSupport\TestDb.cs)) doesn't support raw JSONB operators. `LIKE '%<guid>%'` works on both Npgsql and InMemory. The deprecated FK column path is the precise check; the JSONB substring check is approximate but a GUID-shaped substring outside its key is a non-event in this schema.

### 1.3 [ScraperConfigsController.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Controllers\ScraperConfigsController.cs) — add DELETE action

Insert the following method directly after `Update` (before the `private Guid GetUserId()` line):

```csharp
[HttpDelete("{id:guid}")]
[CookieCsrf]
public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
{
    var userId = GetUserId();
    var result = await _configs.DeleteAsync(userId, id, ct);
    return result.Outcome switch
    {
        DeleteScraperConfigOutcome.Deleted   => NoContent(),
        DeleteScraperConfigOutcome.NotFound  => NotFound(),
        DeleteScraperConfigOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
        DeleteScraperConfigOutcome.Referenced => Conflict(new
        {
            code = "CONFIG_REFERENCED",
            referencingTaskCount = result.ReferencingTaskCount,
            error = $"This config is used by {result.ReferencingTaskCount} task{(result.ReferencingTaskCount == 1 ? "" : "s")}. Delete or update those tasks first.",
        }),
        _ => StatusCode(StatusCodes.Status500InternalServerError),
    };
}
```

### 1.4 NEW `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceTests.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.Services;

public class ScraperConfigServiceTests
{
    private static (ScraperConfigService svc, WebScrape.Data.WebScrapeDbContext db, Guid userId, Guid configId) Build()
    {
        var db = TestDb.CreateInMemory();
        var userId = Guid.NewGuid();
        var configId = Guid.NewGuid();
        db.Users.Add(new User { Id = userId, UserName = "u@x", Email = "u@x" });
        db.ScraperConfigs.Add(new ScraperConfigEntity
        {
            Id = configId,
            UserId = userId,
            Name = "demo",
            Domain = "example.com",
            ConfigJson = JsonDocument.Parse("""{"steps":[]}"""),
            SchemaVersion = 3,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        db.SaveChanges();
        return (new ScraperConfigService(db, TestDb.CreateMapper()), db, userId, configId);
    }

    [Fact]
    public async Task DeleteAsync_unreferenced_config_succeeds()
    {
        var (svc, db, userId, configId) = Build();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Deleted, result.Outcome);
        Assert.Equal(0, result.ReferencingTaskCount);
        Assert.Equal(0, await db.ScraperConfigs.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_blocked_when_scrape_block_references_config()
    {
        var (svc, db, userId, configId) = Build();
        var taskId = Guid.NewGuid();
        db.Tasks.Add(new TaskEntity { Id = taskId, UserId = userId, Name = "T", CreatedAt = DateTimeOffset.UtcNow });
        db.TaskBlocks.Add(new TaskBlock
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            BlockType = BlockType.Scrape,
            OrderIndex = 0,
            ConfigJsonb = JsonDocument.Parse($$"""{ "scraperConfigId": "{{configId}}", "stepBindings": {} }"""),
        });
        await db.SaveChangesAsync();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Referenced, result.Outcome);
        Assert.Equal(1, result.ReferencingTaskCount);
        Assert.Equal(1, await db.ScraperConfigs.CountAsync());
    }

    [Fact]
    public async Task DeleteAsync_blocked_when_legacy_fk_references_config()
    {
        var (svc, db, userId, configId) = Build();
        db.Tasks.Add(new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = "Legacy",
            ScraperConfigId = configId,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();

        var result = await svc.DeleteAsync(userId, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Referenced, result.Outcome);
        Assert.Equal(1, result.ReferencingTaskCount);
    }

    [Fact]
    public async Task DeleteAsync_returns_forbidden_for_other_user()
    {
        var (svc, _, _, configId) = Build();
        var otherUser = Guid.NewGuid();

        var result = await svc.DeleteAsync(otherUser, configId);

        Assert.Equal(DeleteScraperConfigOutcome.Forbidden, result.Outcome);
    }

    [Fact]
    public async Task DeleteAsync_returns_not_found_for_unknown_id()
    {
        var (svc, _, userId, _) = Build();

        var result = await svc.DeleteAsync(userId, Guid.NewGuid());

        Assert.Equal(DeleteScraperConfigOutcome.NotFound, result.Outcome);
    }
}
```

---

## 2. Frontend changes

### 2.1 [package.json](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\package.json) — add deps

Add to `dependencies`:

```json
"@codemirror/lang-json": "^6.0.1",
"@uiw/react-codemirror": "^4.23.0"
```

Run `npm install` inside `backend/src/WebScrape.Client` after the edit. `@codemirror/state` and `@codemirror/view` come transitively via `@uiw/react-codemirror`.

### 2.2 [api/types.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\types.ts) — add config DTOs

Update the source-file comment block at the top to include the ScraperConfig DTO file:

```ts
//   backend/src/WebScrape.Data/Dto/ScraperConfigDto.cs
```

Append (between `CreateApiKeyResponseDto` and the `BlockType` block, around line 33):

```ts
export type ScraperConfigDto = {
  id: string;
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateScraperConfigDto = {
  name: string;
  domain: string;
  configJson: unknown;
  schemaVersion: number;
};

export type DeleteConfigConflictDto = {
  code: 'CONFIG_REFERENCED';
  referencingTaskCount: number;
  error: string;
};
```

### 2.3 [api/queries.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\queries.ts) — add config queries

Update the import of types:

```ts
import type { AccountDto, ApiKeyDto, RunBatchDetailDto, RunItemDto, ScraperConfigDto, TaskDto, WorkerDto } from './types';
```

Append at the end of the file:

```ts
export function useScraperConfigs() {
  return useQuery({
    queryKey: ['scraper-configs'],
    queryFn: async () => (await api.get<ScraperConfigDto[]>('/api/scraper-configs')).data,
  });
}

export function useScraperConfig(id: string | undefined) {
  return useQuery({
    queryKey: ['scraper-configs', id],
    enabled: !!id,
    queryFn: async () => (await api.get<ScraperConfigDto>(`/api/scraper-configs/${id}`)).data,
  });
}
```

### 2.4 [api/mutations.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\mutations.ts) — add config mutations

Update the type import:

```ts
import type { AccountDto, BatchDispatchResultDto, CreateApiKeyResponseDto, CreateBatchDto, CreateRunSuccess, CreateScraperConfigDto, ExpansionPreviewDto, ScraperConfigDto } from './types';
```

Append at the end of the file:

```ts
export function useCreateScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateScraperConfigDto) =>
      (await api.post<ScraperConfigDto>('/api/scraper-configs', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-configs'] }),
  });
}

export function useUpdateScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: CreateScraperConfigDto }) =>
      (await api.put<ScraperConfigDto>(`/api/scraper-configs/${id}`, body)).data,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['scraper-configs'] });
      qc.invalidateQueries({ queryKey: ['scraper-configs', vars.id] });
    },
  });
}

export function useDeleteScraperConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/scraper-configs/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-configs'] }),
  });
}
```

### 2.5 [App.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\App.tsx) — register routes

Add imports:

```tsx
import Configs from './pages/Configs';
import ConfigEditor from './pages/ConfigEditor';
```

Add inside the `<AuthShell>` route block (after `<Route path="/tasks" ...>`):

```tsx
<Route path="/configs" element={<Configs />} />
<Route path="/configs/new" element={<ConfigEditor />} />
<Route path="/configs/:id/edit" element={<ConfigEditor />} />
```

### 2.6 [Sidebar.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\components\Sidebar.tsx) — add Configs link

Insert between the Tasks and Workers links:

```tsx
<NavLink to="/configs" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
  Configs
</NavLink>
```

### 2.7 NEW `backend/src/WebScrape.Client/src/pages/Configs.tsx`

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useScraperConfigs } from '../api/queries';
import { useDeleteScraperConfig } from '../api/mutations';
import Modal from '../components/Modal';
import type { DeleteConfigConflictDto, ScraperConfigDto } from '../api/types';

function fmtDate(s: string): string {
  return new Date(s).toLocaleString();
}

export default function Configs() {
  const { data: configs, isPending } = useScraperConfigs();
  const remove = useDeleteScraperConfig();
  const nav = useNavigate();

  const [confirmDelete, setConfirmDelete] = useState<ScraperConfigDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(confirmDelete.id);
      setConfirmDelete(null);
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        const data = e.response.data as DeleteConfigConflictDto;
        setDeleteError(data.error);
      } else {
        setDeleteError('Could not delete this config. Try again.');
      }
    }
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Configs</h2>
        <button className="btn btn-primary" onClick={() => nav('/configs/new')}>
          + New config
        </button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && configs && configs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No configs yet</div>
          <div className="empty-state-desc">
            A config describes how to scrape a site. Create one before authoring tasks.
          </div>
        </div>
      )}

      {!isPending && configs && configs.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Schema</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><span className="domain-badge">{c.domain}</span></td>
                <td>{c.schemaVersion}</td>
                <td>{fmtDate(c.updatedAt)}</td>
                <td style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end' }}>
                  <Link to={`/configs/${c.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirmDelete(c); setDeleteError(null); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this config?"
      >
        {deleteError && <div className="danger-banner">{deleteError}</div>}
        <div className="modal-body">
          {confirmDelete && (
            <>Delete <strong>{confirmDelete.name}</strong>? This can't be undone.</>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

### 2.8 NEW `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { json as cmJson } from '@codemirror/lang-json';
import { useScraperConfig } from '../api/queries';
import { useCreateScraperConfig, useDeleteScraperConfig, useUpdateScraperConfig } from '../api/mutations';
import Modal from '../components/Modal';
import type { CreateScraperConfigDto, DeleteConfigConflictDto } from '../api/types';

const DEFAULT_CONFIG_JSON = JSON.stringify(
  { name: '', url: '', domain: '', schemaVersion: 3, steps: [] },
  null,
  2,
);

type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function tryParseConfig(raw: string): ParseResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Top-level value must be a JSON object.' };
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) {
      return { ok: false, error: '"steps" must be an array.' };
    }
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' };
  }
}

export default function ConfigEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();

  const { data: existing, isPending: loadingExisting } = useScraperConfig(id);
  const create = useCreateScraperConfig();
  const update = useUpdateScraperConfig();
  const remove = useDeleteScraperConfig();

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [schemaVersion, setSchemaVersion] = useState(3);
  const [jsonText, setJsonText] = useState(DEFAULT_CONFIG_JSON);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!isEdit || !existing || hydrated) return;
    setName(existing.name);
    setDomain(existing.domain);
    setSchemaVersion(existing.schemaVersion);
    setJsonText(JSON.stringify(existing.configJson, null, 2));
    setHydrated(true);
  }, [isEdit, existing, hydrated]);

  const parseResult = useMemo(() => tryParseConfig(jsonText), [jsonText]);
  const saving = create.isPending || update.isPending;

  const saveError = (() => {
    const e = create.error ?? update.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Could not save this config.';
    }
    return 'Could not save this config.';
  })();

  const submit = async () => {
    if (!parseResult.ok) return;
    if (!name.trim() || !domain.trim()) return;
    const body: CreateScraperConfigDto = {
      name: name.trim(),
      domain: domain.trim(),
      configJson: parseResult.value,
      schemaVersion,
    };
    if (isEdit && id) {
      await update.mutateAsync({ id, body });
    } else {
      await create.mutateAsync(body);
    }
    nav('/configs');
  };

  const doDelete = async () => {
    if (!id) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(id);
      nav('/configs');
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        const data = e.response.data as DeleteConfigConflictDto;
        setDeleteError(data.error);
      } else {
        setDeleteError('Could not delete this config. Try again.');
      }
    }
  };

  if (isEdit && loadingExisting) return <div className="loading-state">Loading…</div>;

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/configs" className="back-btn" aria-label="Back to configs">←</Link>
          <h2 className="view-title">{isEdit ? 'Edit config' : 'New config'}</h2>
        </div>
        <div className="flex gap-sm">
          {isEdit && (
            <button className="btn btn-danger" onClick={() => { setConfirmDelete(true); setDeleteError(null); }}>
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => nav('/configs')}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || !parseResult.ok || !name.trim() || !domain.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && <div className="danger-banner">{saveError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>
        <div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-name">Name</label>
            <input
              id="config-name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bing News"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-domain">Domain</label>
            <input
              id="config-domain"
              className="form-input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
            <div className="form-hint">The site this config runs on. Used for matching at runtime.</div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-schema">Schema version</label>
            <input
              id="config-schema"
              className="form-input"
              type="number"
              value={schemaVersion}
              onChange={(e) => setSchemaVersion(Number(e.target.value) || 3)}
            />
            <div className="form-hint">Leave at 3 unless you know what you're doing.</div>
          </div>
        </div>

        <div>
          <div className="form-group">
            <label className="form-label">Config JSON</label>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <CodeMirror
                value={jsonText}
                onChange={(v) => setJsonText(v)}
                extensions={[cmJson()]}
                height="520px"
                basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }}
              />
            </div>
            {!parseResult.ok && (
              <div className="danger-banner" style={{ marginTop: 'var(--spacing-sm)' }}>
                {parseResult.error}
              </div>
            )}
            {parseResult.ok && (
              <div className="form-hint">Valid JSON · top-level object · steps array present.</div>
            )}
          </div>
        </div>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this config?">
        {deleteError && <div className="danger-banner">{deleteError}</div>}
        <div className="modal-body">
          Delete <strong>{name || 'this config'}</strong>? This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

---

## 3. UI inventory (Stage C alignment)

| Element | Class / token used | New global class? |
|---|---|---|
| Header row + title | `view-header-row`, `view-title`, `back-btn` | No |
| Action buttons | `btn btn-primary`, `btn-secondary`, `btn-danger`, `btn-ghost`, `btn-sm` | No |
| Form fields | `form-group`, `form-label`, `form-input`, `form-hint` | No |
| List | `data-table`, `domain-badge` | No |
| Empty state | `empty-state`, `empty-state-title`, `empty-state-desc` | No |
| Confirm dialog | `Modal` component + `modal-body`, `modal-actions`, `danger-banner` | No |
| CodeMirror surround | `card` (border + radius) with inline `padding: 0` | No |
| Editor split | inline `display: grid; gridTemplateColumns: 280px 1fr` | No (one-off layout, doesn't justify a global class — same shortcut Tasks.tsx uses for its row spread) |

No new design tokens, no inline colours, no `dangerouslySetInnerHTML`. Copy is informal and actionable: "Delete or update those tasks first." rather than a stack-trace style error.

## 4. Security (Stage D alignment)

| Risk | Mitigation in this spec |
|---|---|
| Cross-user delete via guessed id | `DeleteAsync` checks `entity.UserId != userId` → returns Forbidden → controller maps to 403. |
| Orphaning tasks via delete | Two-path reference check (deprecated FK + JSONB substring) returns 409 with task count. |
| Delete bypasses CSRF | `[CookieCsrf]` attribute applied to the new action, matching every other unsafe action in the controller. |
| Saving giant JSON to OOM the server | Existing global request size limits unchanged; not introduced by this spec. Out of scope (M5). |
| XSS via config name in the list | React default escaping; `name` is rendered as text, never as HTML. CodeMirror handles its own content sandbox. |

No new attack surface beyond the existing `Create`/`Update` pattern.

## 5. Verification

### Automated

```bash
cd c:/Users/und3r/blueberry-v3/backend
dotnet test tests/WebScrape.Tests/WebScrape.Tests.csproj
```

Expected: all existing tests still pass + 5 new `ScraperConfigServiceTests` pass.

```bash
cd c:/Users/und3r/blueberry-v3/backend/src/WebScrape.Client
npm install
npm run typecheck
npm run build
```

Expected: clean type-check, clean build, no warnings about unused imports.

### Manual end-to-end (after install + restart)

1. Backend running on 5082, frontend `npm run dev` on 5173, signed in as `admin@local / admin`.
2. Sidebar shows **Configs** between Tasks and Workers. Click it → `/configs`.
3. Demo Local Fixture is listed. Click **Edit** → editor opens with form values populated and CodeMirror showing the config JSON.
4. Edit the JSON: change `"url"` to `"https://test.local"`. Save → returns to `/configs`. Re-enter editor; new value persists.
5. Break the JSON (delete a closing brace). The "Save" button is disabled and a red banner shows the parse error. Restore. Save works.
6. Click **+ New config**. Name: `M2.5 Smoke`. Domain: `smoke.local`. Leave default JSON skeleton. Save. New row appears in the list.
7. Click **Delete** on `M2.5 Smoke` row → confirm modal → Delete. Row disappears.
8. Click **Delete** on `Demo Local Fixture` (it's referenced by the seeded Demo Task). Confirm. The modal stays open and shows: "This config is used by 1 task. Delete or update those tasks first." Cancel.
9. (Optional) On `/tasks`, run "Demo Task" on a connected worker — the task editor doesn't exist yet but the existing single-run flow must still work, proving the config we just edited round-tripped through the run pipeline.

### Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Save with empty Name or empty Domain | Cover — Save button is disabled until both are non-empty. |
| Save with invalid JSON | Cover — Save button disabled; banner shows parse error. |
| Concurrent edit (user A and user B both PUT same config) | Ignore (v1) — last-write-wins, same as M1. M5 may add `If-Unmodified-Since`. |
| Schema version field used to gate behaviour | Ignore (v1) — exposed for transparency; backend stores whatever value the client sends. |
| Soft-delete / undo | Ignore — DELETE is hard. M5 may revisit. |
| Pasting the wrong file (e.g. an entire task export) into the JSON editor | Ignore (v1) — server accepts any valid JSON object with a `steps` array; the M2.6 task editor will surface mismatches when bindings fail. |
| CodeMirror in read-only mode (e.g. after a 401 mid-edit) | Ignore — `axios` interceptor in [client.ts:33-41](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\client.ts#L33-L41) bounces to login. |

## 6. Memory updates after merge

After M2.5 lands and is smoke-tested, update [webscrape_initiative.md](C:\Users\und3r\.claude\projects\c--Users-und3r-blueberry-v3\memory\webscrape_initiative.md):
- Add a milestone entry: `**M2.5 — Configs page. ✅ IMPLEMENTED + SMOKE-TESTED <date>.** New `/configs` route with CodeMirror editor; `DELETE /api/scraper-configs/{id}` rejects when referenced. New deps: `@uiw/react-codemirror`, `@codemirror/lang-json`.`
- Note any deviations encountered during implementation.
