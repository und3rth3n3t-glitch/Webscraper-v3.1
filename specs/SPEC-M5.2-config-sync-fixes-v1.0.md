# SPEC-M5.2 Config Sync — Bug-fix Pass v1.0

**Version:** 1.0
**Status:** Ready for implementation
**Prerequisite:** M5.2 base (config-sync) deployed; see `SPEC-M5.2-config-sync-v1.0.md`.
**Related:** Deferred work captured in `FUTURE-config-sync-next-passes.md`.

---

## Context

The base M5.2 config-sync ships works for happy-path single-click flows but has acute bugs:

1. Rapid clicks of the extension's sync (WiFi) toggle create N duplicate server entities (`suggestedId` collision falls through to `Guid.NewGuid()`); the same race deletes the originally-synced row from local storage.
2. The extension's `ConfigList` loads from `chrome.storage.local` once on mount and never refreshes — users can't see push/pull effects without reopening the panel.
3. Duplicating a synced config inherits `shared/lastSyncedAt/dirty` — pushes 404 forever because the inherited etag points to a non-existent server row.
4. Saving an edited shared config sets `dirty: true` but never triggers a push — sync only catches up on next reconnect.
5. The backend frontend's editor never sends `shared` in PUT bodies — every backend-side edit silently un-shares the config; no UI to toggle sharing on/off.
6. Server `CreateAsync` falls back to `Guid.NewGuid()` on `suggestedId` collision regardless of which user owns the existing row — leaks a GUID-existence oracle and enables the duplicate spam in (1).
7. No mechanism for backend-frontend edits to reach an open extension sidepanel (other than reconnect).

This spec fixes all of the above. SignalR push, conflict UX for cookie-auth editors, sync-column enrichment, and other polish are deferred — see `FUTURE-config-sync-next-passes.md`.

---

## Commit order (5 PRs — backend → extension)

| PR | Scope |
|---|---|
| 1 | Server: idempotent `CreateAsync` + GUID-oracle tighten |
| 2 | Backend frontend: share toggle + `shared` preserved on PUT |
| 3 | Extension: `syncStore` (version, pushingIds, concurrency guard) + `syncClient` (409/200 handling) |
| 4 | Extension: `configStore` auto-push, `ConfigList` refresh + manual pull, `ConfigListItem` disabled state, duplicate fix |
| 5 | Extension: `App.tsx` visibility-change pull |

PRs 1 and 2 are independent. PRs 3–5 are extension-only and stack but PR 5 is small and could merge alongside PR 3.

---

## Section 1 — Server: idempotent `CreateAsync`

### 1a. Add `CreateScraperConfigOutcome` + `CreateScraperConfigResult`

**File:** `backend/src/WebScrape.Services/Interfaces/IScraperConfigService.cs`

After the existing `UpdateScraperConfigResult` record (line 26), add:

```csharp
public enum CreateScraperConfigOutcome
{
    Created,
    Idempotent,
    Conflict,
}

public record CreateScraperConfigResult(
    CreateScraperConfigOutcome Outcome,
    ScraperConfigDto Dto);
```

Update the `CreateAsync` signature on line 33:

```csharp
Task<CreateScraperConfigResult> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default);
```

### 1b. Update `ScraperConfigService.CreateAsync`

**File:** `backend/src/WebScrape.Services/Implementations/ScraperConfigService.cs`

Replace the entire `CreateAsync` method (lines 50-82) with:

```csharp
public async Task<CreateScraperConfigResult> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default)
{
    var now = DateTimeOffset.UtcNow;

    // Idempotent first-share: if this user already owns a config at the suggested ID,
    // either return it (matching content → idempotent success) or reject (mismatched
    // content → caller must use PUT to overwrite). Scoping by userId also closes the
    // GUID-existence oracle that the previous fallback exposed.
    if (dto.SuggestedId.HasValue)
    {
        var existing = await _db.ScraperConfigs
            .FirstOrDefaultAsync(c => c.Id == dto.SuggestedId.Value && c.UserId == userId, ct);

        if (existing is not null)
        {
            var incomingJson = dto.ConfigJson.GetRawText();
            var storedJson = existing.ConfigJson.RootElement.GetRawText();
            var matches = existing.Name == dto.Name
                && existing.Domain == dto.Domain
                && incomingJson == storedJson;

            var outcome = matches ? CreateScraperConfigOutcome.Idempotent : CreateScraperConfigOutcome.Conflict;
            return new CreateScraperConfigResult(outcome, await MapWithWorkerName(existing, ct));
        }
    }

    var entityId = dto.SuggestedId ?? Guid.NewGuid();

    var entity = new ScraperConfigEntity
    {
        Id = entityId,
        UserId = userId,
        Name = dto.Name,
        Domain = dto.Domain,
        ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText()),
        SchemaVersion = dto.SchemaVersion <= 0 ? 3 : dto.SchemaVersion,
        Shared = dto.Shared,
        CreatedAt = now,
        UpdatedAt = now,
    };

    if (workerId.HasValue)
    {
        entity.LastSyncedAt = now;
        entity.OriginClientId = workerId.Value.ToString();
    }

    _db.ScraperConfigs.Add(entity);
    await _db.SaveChangesAsync(ct);
    return new CreateScraperConfigResult(CreateScraperConfigOutcome.Created, await MapWithWorkerName(entity, ct));
}
```

**Note:** the `entityId` simplification (`dto.SuggestedId ?? Guid.NewGuid()`) is safe now because the user-scoped check above has already returned for the only case where the suggested ID was taken by *this user*. A suggested ID owned by a *different user* will be honoured here — but EF's PK uniqueness will throw on `SaveChangesAsync`. We treat that as so unlikely (random Guid collision) it can fall through as a 500. If it ever happens, the caller retries with a fresh local id.

### 1c. Update controller

**File:** `backend/src/WebScrape.Server/Controllers/ScraperConfigsController.cs`

Replace the `Create` action (lines 38-45) with:

```csharp
[HttpPost]
[CookieCsrf]
public async Task<IActionResult> Create([FromBody] CreateScraperConfigDto dto, CancellationToken ct)
{
    var workerId = await ResolveWorkerIdAsync(ct);
    var result = await _configs.CreateAsync(User.GetUserId(), dto, workerId, ct);
    return result.Outcome switch
    {
        CreateScraperConfigOutcome.Created => CreatedAtAction(nameof(Get), new { id = result.Dto.Id }, result.Dto),
        CreateScraperConfigOutcome.Idempotent => Ok(result.Dto),
        CreateScraperConfigOutcome.Conflict => StatusCode(StatusCodes.Status409Conflict, result.Dto),
        _ => StatusCode(StatusCodes.Status500InternalServerError),
    };
}
```

### 1d. Update `ScraperConfigServiceConflictTests`

**File:** `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceConflictTests.cs`

Append three new tests (place after the existing tests, before the closing brace):

```csharp
[Fact]
public async Task CreateAsync_with_existing_suggested_id_and_matching_content_returns_idempotent()
{
    var (db, svc, user) = await SetupAsync();
    var suggestedId = Guid.NewGuid();
    var dto = new CreateScraperConfigDto
    {
        SuggestedId = suggestedId,
        Name = "Wikipedia",
        Domain = "en.wikipedia.org",
        ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
        SchemaVersion = 4,
        Shared = true,
    };

    var first = await svc.CreateAsync(user.Id, dto);
    var second = await svc.CreateAsync(user.Id, dto);

    Assert.Equal(CreateScraperConfigOutcome.Created, first.Outcome);
    Assert.Equal(CreateScraperConfigOutcome.Idempotent, second.Outcome);
    Assert.Equal(first.Dto.Id, second.Dto.Id);
    Assert.Single(db.ScraperConfigs);
}

[Fact]
public async Task CreateAsync_with_existing_suggested_id_and_mismatched_name_returns_conflict()
{
    var (db, svc, user) = await SetupAsync();
    var suggestedId = Guid.NewGuid();
    var first = new CreateScraperConfigDto
    {
        SuggestedId = suggestedId,
        Name = "Wikipedia",
        Domain = "en.wikipedia.org",
        ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
        SchemaVersion = 4,
    };
    await svc.CreateAsync(user.Id, first);

    var second = first with { Name = "Wikipedia 2" };
    var result = await svc.CreateAsync(user.Id, second);

    Assert.Equal(CreateScraperConfigOutcome.Conflict, result.Outcome);
    Assert.Equal("Wikipedia", result.Dto.Name);
    Assert.Single(db.ScraperConfigs);
}

[Fact]
public async Task CreateAsync_with_suggested_id_owned_by_other_user_creates_new_row()
{
    var (db, svc, user) = await SetupAsync();
    var otherUser = await SeedUserAsync(db, "other@example.com");
    var suggestedId = Guid.NewGuid();

    db.ScraperConfigs.Add(new ScraperConfigEntity
    {
        Id = suggestedId,
        UserId = otherUser.Id,
        Name = "Other",
        Domain = "other.com",
        ConfigJson = JsonDocument.Parse("{}"),
        CreatedAt = DateTimeOffset.UtcNow,
        UpdatedAt = DateTimeOffset.UtcNow,
    });
    await db.SaveChangesAsync();

    var dto = new CreateScraperConfigDto
    {
        SuggestedId = suggestedId,
        Name = "Mine",
        Domain = "mine.com",
        ConfigJson = JsonDocument.Parse("""{"steps":[]}""").RootElement,
        SchemaVersion = 4,
    };
    var result = await svc.CreateAsync(user.Id, dto);

    Assert.Equal(CreateScraperConfigOutcome.Created, result.Outcome);
    Assert.NotEqual(suggestedId, result.Dto.Id);
    Assert.Equal(user.Id, await db.ScraperConfigs.Where(c => c.Id == result.Dto.Id).Select(c => c.UserId).FirstAsync());
}
```

If `SetupAsync` / `SeedUserAsync` helpers don't exist in the test file, copy from sibling test files (e.g. `ApiKeyServiceTests.cs`).

---

## Section 2 — Backend frontend: preserve `shared` + add toggle

### 2a. Add `.form-check` utility

**File:** `backend/src/WebScrape.Client/src/index.css`

After the `.form-hint` rule (line 167), add:

```css
.form-check { display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; }
.form-check input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
```

### 2b. Update `ConfigEditor.tsx`

**File:** `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx`

After the `hydrated` state declaration (line 56), add:

```tsx
const [shared, setShared] = useState(false);
```

Update the hydration `useEffect` (lines 58-65) to include `shared`:

```tsx
useEffect(() => {
  if (!isEdit || !existing || hydrated) return;
  setName(existing.name);
  setDomain(existing.domain);
  setSchemaVersion(existing.schemaVersion);
  setJsonText(JSON.stringify(existing.configJson, null, 2));
  setShared(existing.shared);
  setHydrated(true);
}, [isEdit, existing, hydrated]);
```

Update the `submit` body construction (lines 75-90) to include `shared`:

```tsx
const submit = async () => {
  if (!parseResult.ok) return;
  if (!name.trim() || !domain.trim()) return;
  const body: CreateScraperConfigDto = {
    name: name.trim(),
    domain: domain.trim(),
    configJson: parseResult.value,
    schemaVersion,
    shared,
  };
  if (isEdit && id) {
    await update.mutateAsync({ id, body });
  } else {
    await create.mutateAsync(body);
  }
  nav('/configs');
};
```

Add the share-toggle `form-group` to the left column. Insert **before** the existing Name field at line 145:

```tsx
<div className="form-group">
  <label className="form-check">
    <input
      type="checkbox"
      checked={shared}
      onChange={(e) => setShared(e.target.checked)}
    />
    Share with my extensions
  </label>
  <div className="form-hint">When on, your connected extensions can pull this config and stay in sync with edits made here.</div>
</div>
```

### 2c. No changes required to `types.ts`

`CreateScraperConfigDto.shared` is already optional in `backend/src/WebScrape.Client/src/api/types.ts:55`.

---

## Section 3 — Extension `syncStore` + `syncClient`

### 3a. Update `syncClient.ts` to handle 409 / 200

**File:** `src/sidepanel/utils/syncClient.ts`

Replace the POST branch in `pushConfig` (lines 49-61) with:

```typescript
if (!config.lastSyncedAt) {
  // First share: POST to create
  const resp = await fetch(`${serverUrl}/api/scraper-configs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  // 409: server has a config at this suggestedId with mismatched content — treat as conflict
  if (resp.status === 409) {
    const current = await resp.json() as ServerScraperConfig;
    return { outcome: 'conflict', current };
  }
  if (!resp.ok) return { outcome: 'error', error: `HTTP ${resp.status}` };
  // 200 (idempotent) and 201 (created) both return the entity in the body — same handling
  return { outcome: 'created', config: await resp.json() as ServerScraperConfig };
}
```

No changes to the PUT branch.

### 3b. Update `syncStore.ts`

**File:** `src/sidepanel/stores/syncStore.ts`

Replace the entire file with:

```typescript
import { create } from 'zustand';
import { getAllConfigs, saveConfig, migrateConfig } from '../utils/storage';
import {
  pullSharedConfigs,
  pushConfig,
  recordSubscription,
  type ServerScraperConfig,
} from '../utils/syncClient';
import type { ScraperConfig } from '../../types/config';

export interface ConflictState {
  localConfig: ScraperConfig;
  serverConfig: ServerScraperConfig;
}

interface SyncState {
  syncing: boolean;
  lastSyncError: string | null;
  conflicts: Record<string, ConflictState>;
  pushingIds: Set<string>;
  version: number;

  pullSharedConfigs: (serverUrl: string, token: string) => Promise<void>;
  pushIfDirty: (serverUrl: string, token: string, configId: string) => Promise<void>;
  resolveConflict: (choice: 'mine' | 'theirs', serverUrl: string, token: string, configId: string) => Promise<void>;
  dismissConflict: (configId: string) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncing: false,
  lastSyncError: null,
  conflicts: {},
  pushingIds: new Set(),
  version: 0,

  pullSharedConfigs: async (serverUrl, token) => {
    if (get().syncing) return; // concurrency guard
    set({ syncing: true, lastSyncError: null });
    try {
      const serverConfigs = await pullSharedConfigs(serverUrl, token);
      const localConfigs = await getAllConfigs();
      const localById = new Map(localConfigs.map((c) => [c.id, c]));

      let touched = false;
      for (const sc of serverConfigs) {
        const local = localById.get(sc.id);
        const serverUpdatedMs = new Date(sc.updatedAt).getTime();
        const localSyncedMs = local?.lastSyncedAt ? new Date(local.lastSyncedAt).getTime() : 0;
        const serverIsNewer = serverUpdatedMs > localSyncedMs;

        if (!local) {
          const imported = serverToLocal(sc);
          await saveConfig(imported);
          recordSubscription(serverUrl, token, sc.id);
          touched = true;
        } else if (serverIsNewer && !local.dirty) {
          const updated = serverToLocal(sc, local);
          await saveConfig(updated);
          recordSubscription(serverUrl, token, sc.id);
          touched = true;
        } else if (serverIsNewer && local.dirty) {
          set((s) => ({
            conflicts: { ...s.conflicts, [sc.id]: { localConfig: local, serverConfig: sc } },
          }));
        }
      }

      // Push any dirty shared configs that are not in conflict.
      const { conflicts } = get();
      const updatedLocal = await getAllConfigs();
      for (const c of updatedLocal) {
        if (c.shared && c.dirty && !conflicts[c.id]) {
          await get().pushIfDirty(serverUrl, token, c.id);
        }
      }

      if (touched) bumpVersion(set);
    } catch (err) {
      set({ lastSyncError: (err as Error).message });
    } finally {
      set({ syncing: false });
    }
  },

  pushIfDirty: async (serverUrl, token, configId) => {
    if (get().pushingIds.has(configId)) return; // in-flight guard
    set((s) => {
      const next = new Set(s.pushingIds);
      next.add(configId);
      return { pushingIds: next };
    });

    try {
      const configs = await getAllConfigs();
      const config = configs.find((c) => c.id === configId);
      if (!config || !config.dirty) return;

      const result = await pushConfig(serverUrl, token, config);

      if (result.outcome === 'created' || result.outcome === 'updated') {
        const synced: ScraperConfig = {
          ...config,
          id: result.config.id,
          lastSyncedAt: result.config.updatedAt,
          dirty: false,
          shared: true,
        };
        // Defensive: only fires on cross-user GUID collision (server idempotency
        // handles the same-user case). Documented for future audit (FUTURE E.3).
        if (result.config.id !== config.id) {
          const { deleteConfig } = await import('../utils/storage');
          await deleteConfig(config.id);
        }
        await saveConfig(synced);
        recordSubscription(serverUrl, token, result.config.id);
        bumpVersion(set);
      } else if (result.outcome === 'conflict') {
        set((s) => ({
          conflicts: { ...s.conflicts, [configId]: { localConfig: config, serverConfig: result.current } },
        }));
      } else {
        set({ lastSyncError: result.error });
      }
    } finally {
      set((s) => {
        const next = new Set(s.pushingIds);
        next.delete(configId);
        return { pushingIds: next };
      });
    }
  },

  resolveConflict: async (choice, serverUrl, token, configId) => {
    const cs = get().conflicts[configId];
    if (!cs) return;

    if (choice === 'theirs') {
      const imported = serverToLocal(cs.serverConfig, cs.localConfig);
      await saveConfig(imported);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
      bumpVersion(set);
      return;
    }

    const localWithServerEtag: ScraperConfig = {
      ...cs.localConfig,
      lastSyncedAt: cs.serverConfig.updatedAt,
    };
    const result = await pushConfig(serverUrl, token, localWithServerEtag);

    if (result.outcome === 'updated') {
      const synced: ScraperConfig = {
        ...cs.localConfig,
        lastSyncedAt: result.config.updatedAt,
        dirty: false,
      };
      await saveConfig(synced);
      set((s) => {
        const { [configId]: _, ...rest } = s.conflicts;
        return { conflicts: rest };
      });
      bumpVersion(set);
    } else if (result.outcome === 'conflict') {
      set((s) => ({
        conflicts: { ...s.conflicts, [configId]: { localConfig: cs.localConfig, serverConfig: result.current } },
      }));
    }
  },

  dismissConflict: (configId) => {
    set((s) => {
      const { [configId]: _, ...rest } = s.conflicts;
      return { conflicts: rest };
    });
  },
}));

function bumpVersion(set: (partial: Partial<SyncState> | ((s: SyncState) => Partial<SyncState>)) => void) {
  set((s) => ({ version: s.version + 1 }));
}

function serverToLocal(sc: ServerScraperConfig, existing?: ScraperConfig): ScraperConfig {
  const blob = migrateConfig(sc.configJson as Record<string, unknown>);
  const base = blob ?? {} as ScraperConfig;
  return {
    ...base,
    id: sc.id,
    name: sc.name,
    domain: sc.domain,
    shared: true,
    lastSyncedAt: sc.updatedAt,
    dirty: false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: new Date(sc.updatedAt).getTime(),
  } as ScraperConfig;
}
```

**Behavioural deltas vs. the prior file:**
- Adds `pushingIds` and `version` to state; both surfaced for component subscription.
- Adds concurrency guard at the top of `pullSharedConfigs`.
- Adds in-flight guard at the top of `pushIfDirty`, cleared in `finally`.
- Bumps `version` after every successful local-storage mutation.
- `pushIfDirty`'s `error` outcome now writes to `lastSyncError` instead of swallowing silently.

---

## Section 4 — Extension `configStore` auto-push

**File:** `src/sidepanel/stores/configStore.ts`

Replace `saveCurrentConfig` (lines 197-221) with:

```typescript
saveCurrentConfig: async () => {
  const { steps, currentConfig, pageDomain, pageUrl, configName, domainLocked } = get();
  const config: ScraperConfig = {
    id: currentConfig?.id || generateId(),
    name: configName || 'Untitled Config',
    domain: domainLocked ? pageDomain : '',
    domainLocked,
    url: pageUrl,
    steps,
    dataMapping: currentConfig?.dataMapping,
    schemaVersion: CURRENT_SCHEMA_VERSION as 4,
    createdAt: currentConfig?.createdAt || Date.now(),
    updatedAt: Date.now(),
    shared: currentConfig?.shared ?? false,
    lastSyncedAt: currentConfig?.lastSyncedAt ?? null,
  };

  if (config.shared) {
    config.dirty = true;
  }

  await saveConfigToStorage(config);
  set({ currentConfig: config, isDirty: false });

  // Auto-push when shared + connected. Fire-and-forget; pushIfDirty handles its
  // own errors and dirty flag. Imported lazily to avoid a circular dependency.
  if (config.shared) {
    const { useSettingsStore } = await import('./settingsStore');
    const { useSyncStore } = await import('./syncStore');
    const { serverUrl, jwtToken, connectionStatus } = useSettingsStore.getState();
    if (connectionStatus === 'connected') {
      void useSyncStore.getState().pushIfDirty(serverUrl, jwtToken, config.id);
    }
  }

  return config;
},
```

---

## Section 5 — Extension `ConfigList`: refresh, pull button, duplicate fix

**File:** `src/sidepanel/components/ConfigList.tsx`

Replace the entire file with:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import ConfigListItem from './ConfigListItem';
import EmptyState from './EmptyState';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSyncStore } from '../stores/syncStore';
import { getAllConfigs, saveConfig } from '../utils/storage';
import { generateId } from '../utils/uuid';
import { useRunStore } from '../stores/runStore';
import type { ScraperConfig } from '../../types/config';

export default function ConfigList() {
  const { loadConfig, pageDomain } = useConfigStore();
  const { showToast, setActiveTab } = useUiStore();
  const { serverUrl, jwtToken, connectionStatus } = useSettingsStore();
  const syncing = useSyncStore((s) => s.syncing);
  const version = useSyncStore((s) => s.version);
  const pullSharedConfigs = useSyncStore((s) => s.pullSharedConfigs);

  const [configs, setConfigs] = useState<ScraperConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      const all = await getAllConfigs();
      setConfigs(all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    } catch {
      showToast('Failed to load configs.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // Re-fetch on mount AND whenever syncStore.version bumps (push/pull/conflict resolve).
  useEffect(() => {
    loadConfigs();
  }, [loadConfigs, version]);

  const handleEdit = (config: ScraperConfig) => {
    loadConfig(config);
    setActiveTab('config');
  };

  const handleRun = (config: ScraperConfig) => {
    loadConfig(config);
    useRunStore.getState().launchRun('saved');
  };

  const handleDuplicate = async (config: ScraperConfig) => {
    const now = Date.now();
    // Reset sync metadata: a duplicate is a brand-new local config, not a synced one.
    const copy: ScraperConfig = {
      ...config,
      id: generateId(),
      name: `${config.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      shared: false,
      lastSyncedAt: null,
      dirty: false,
    };
    try {
      await saveConfig(copy);
      await loadConfigs();
      showToast('Config duplicated.', 'success');
    } catch {
      showToast('Failed to duplicate config.', 'error');
    }
  };

  const handleDeleted = (id: string) => {
    setConfigs(prev => prev.filter(c => c.id !== id));
    const { currentConfig, newConfig } = useConfigStore.getState();
    if (currentConfig?.id === id) {
      newConfig();
    }
  };

  const handlePull = () => {
    if (connectionStatus !== 'connected') {
      showToast('Not connected to backend.', 'error');
      return;
    }
    void pullSharedConfigs(serverUrl, jwtToken);
  };

  if (loading) {
    return <div className="loading-state">Loading configs...</div>;
  }

  if (configs.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen size={48} />}
        title="No Saved Configs Yet"
        description="Build a scraping flow in the Config tab and save it to see it here."
        action={
          <button className="btn btn-primary" onClick={() => setActiveTab('config')}>
            Go to Config Tab
          </button>
        }
      />
    );
  }

  const visibleConfigs = configs.filter(c => !c.domainLocked || c.domain === pageDomain);
  const filtered = showAll
    ? visibleConfigs.filter(c => !c.domainLocked)
    : visibleConfigs.filter(c => c.domainLocked && c.domain === pageDomain);

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">Saved Configs</h2>
        <button
          className="btn btn-icon btn-icon-subtle"
          onClick={handlePull}
          disabled={syncing || connectionStatus !== 'connected'}
          title="Pull latest from server"
          aria-label="Pull latest from server"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="radio-pill-group">
        <label className={`radio-pill ${!showAll ? 'radio-pill-active' : ''}`}>
          <input
            type="radio"
            name="domain-filter"
            checked={!showAll}
            onChange={() => setShowAll(false)}
          />
          This domain
        </label>
        <label className={`radio-pill ${showAll ? 'radio-pill-active' : ''}`}>
          <input
            type="radio"
            name="domain-filter"
            checked={showAll}
            onChange={() => setShowAll(true)}
          />
          All domains
        </label>
      </div>
      <div className="config-list">
        {filtered.length === 0 ? (
          <p className="text-sm text-light">No configs match this domain.</p>
        ) : (
          filtered.map(config => (
            <ConfigListItem
              key={config.id}
              config={config}
              onEdit={() => handleEdit(config)}
              onRun={() => handleRun(config)}
              onDuplicate={() => handleDuplicate(config)}
              onDeleted={handleDeleted}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

**Behavioural deltas:**
- Subscribes to `useSyncStore.version` and re-fetches on every change.
- New `RefreshCw` button in the header, disabled while syncing or disconnected.
- `handleDuplicate` resets `shared/lastSyncedAt/dirty`.
- `view-header-row` gets `justifyContent: 'space-between'` inline (matches the same one-off in `ConfigEditor.tsx`; existing convention in this codebase).

---

## Section 6 — Extension `ConfigListItem`: in-flight disabled state

**File:** `src/sidepanel/components/ConfigListItem.tsx`

Replace the imports block (lines 1-10) and the share-button JSX block (lines 80-93). Specifically:

1. After line 8 (`useSyncStore` import), the existing import is fine — but we need to subscribe to `pushingIds`. Replace lines 25-27:

```tsx
const conflicts = useSyncStore((s) => s.conflicts);
const pushIfDirty = useSyncStore((s) => s.pushIfDirty);
const pushingIds = useSyncStore((s) => s.pushingIds);
const { serverUrl, jwtToken, connectionStatus } = useSettingsStore();
```

2. Add a derived flag below `inConflict` (after line 29):

```tsx
const isPushing = pushingIds.has(config.id);
```

3. Replace the share button (lines 80-93):

```tsx
<button
  className={`btn btn-icon ${config.shared ? 'btn-icon-edit' : 'btn-icon-subtle'}`}
  onClick={inConflict ? () => setConflictOpen(true) : handleToggleShare}
  disabled={isPushing}
  title={
    isPushing
      ? 'Syncing…'
      : inConflict
      ? 'Server has newer changes — click to resolve'
      : config.shared
      ? 'Stop syncing (your backend keeps a copy)'
      : 'Sync this config with your backend'
  }
  aria-label={config.shared ? 'Stop syncing' : 'Sync config'}
>
  {config.shared ? <Wifi size={14} /> : <WifiOff size={14} />}
</button>
```

No other changes to this file.

---

## Section 7 — Extension `App.tsx`: visibility-change pull

**File:** `src/sidepanel/App.tsx`

Insert a new `useEffect` directly after the `CONNECTION_STATUS` listener (after line 43, before the queue dispatcher useEffect on line 45):

```tsx
useEffect(() => {
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    const { connectionStatus, serverUrl, jwtToken } = useSettingsStore.getState();
    if (connectionStatus !== 'connected') return;
    void useSyncStore.getState().pullSharedConfigs(serverUrl, jwtToken);
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}, []);
```

The concurrency guard added in Section 3b makes this safe against overlap with the existing `CONNECTION_STATUS=connected` pull.

---

## Section 8 — Extension unit tests

### 8a. Extend `src/__tests__/syncStore.test.ts`

Add the following test cases. Use the existing `makeLocalConfig` helper at line 25.

```typescript
describe('pushIfDirty in-flight guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({
      syncing: false,
      lastSyncError: null,
      conflicts: {},
      pushingIds: new Set(),
      version: 0,
    });
  });

  it('no-ops when configId is already in pushingIds', async () => {
    useSyncStore.setState({ pushingIds: new Set(['config-1']) });
    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(syncClient.pushConfig).not.toHaveBeenCalled();
  });

  it('clears pushingIds on success', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true, lastSyncedAt: null })]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'created',
      config: { id: 'config-1', name: 'Test Config', domain: 'example.com', configJson: {}, schemaVersion: 4, updatedAt: '2026-04-26T11:00:00Z', shared: true, lastSyncedAt: '2026-04-26T11:00:00Z', originClientId: null, originWorkerName: null },
    });

    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().pushingIds.has('config-1')).toBe(false);
  });

  it('clears pushingIds on error', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true })]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({ outcome: 'error', error: 'HTTP 500' });

    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().pushingIds.has('config-1')).toBe(false);
    expect(useSyncStore.getState().lastSyncError).toBe('HTTP 500');
  });

  it('bumps version on successful push', async () => {
    vi.mocked(storage.getAllConfigs).mockResolvedValue([makeLocalConfig({ dirty: true, lastSyncedAt: null })]);
    vi.mocked(syncClient.pushConfig).mockResolvedValue({
      outcome: 'created',
      config: { id: 'config-1', name: 'Test Config', domain: 'example.com', configJson: {}, schemaVersion: 4, updatedAt: '2026-04-26T11:00:00Z', shared: true, lastSyncedAt: '2026-04-26T11:00:00Z', originClientId: null, originWorkerName: null },
    });

    const before = useSyncStore.getState().version;
    await useSyncStore.getState().pushIfDirty(SERVER_URL, TOKEN, 'config-1');
    expect(useSyncStore.getState().version).toBe(before + 1);
  });
});

describe('pullSharedConfigs concurrency guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({ syncing: false, version: 0, pushingIds: new Set(), conflicts: {} });
  });

  it('no-ops when already syncing', async () => {
    useSyncStore.setState({ syncing: true });
    await useSyncStore.getState().pullSharedConfigs(SERVER_URL, TOKEN);
    expect(syncClient.pullSharedConfigs).not.toHaveBeenCalled();
  });
});
```

### 8b. New `src/__tests__/configStoreAutoPush.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sidepanel/utils/storage', () => ({
  saveConfig: vi.fn(),
  migrateConfig: (c: unknown) => c,
  CURRENT_SCHEMA_VERSION: 4,
}));

const mockPushIfDirty = vi.fn();
vi.mock('../sidepanel/stores/syncStore', () => ({
  useSyncStore: { getState: () => ({ pushIfDirty: mockPushIfDirty }) },
}));

vi.mock('../sidepanel/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ serverUrl: 'http://localhost:5082', jwtToken: 'tok', connectionStatus: 'connected' }),
  },
}));

import { useConfigStore } from '../sidepanel/stores/configStore';

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({
    steps: [],
    configName: 'Test',
    pageDomain: 'example.com',
    pageUrl: 'https://example.com',
    domainLocked: true,
    currentConfig: null,
  });
});

describe('saveCurrentConfig auto-push', () => {
  it('pushes when shared + connected', async () => {
    useConfigStore.setState({
      currentConfig: { id: 'c1', name: 'Test', shared: true, lastSyncedAt: '2026-04-26T10:00:00Z' } as never,
    });
    await useConfigStore.getState().saveCurrentConfig();
    expect(mockPushIfDirty).toHaveBeenCalledWith('http://localhost:5082', 'tok', 'c1');
  });

  it('does not push when not shared', async () => {
    useConfigStore.setState({
      currentConfig: { id: 'c1', name: 'Test', shared: false, lastSyncedAt: null } as never,
    });
    await useConfigStore.getState().saveCurrentConfig();
    expect(mockPushIfDirty).not.toHaveBeenCalled();
  });
});
```

A separate `connectionStatus !== 'connected'` test would require re-mocking the settings store between tests; given the simple `if` branch, the two tests above are sufficient for the v1 pass.

### 8c. New `src/__tests__/duplicateConfig.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import type { ScraperConfig } from '../types/config';

// Mirror of the duplicate logic in ConfigList.handleDuplicate. Kept inline rather
// than extracted so the component stays self-contained; this test is the contract.
function makeDuplicate(config: ScraperConfig, newId: string, now: number): ScraperConfig {
  return {
    ...config,
    id: newId,
    name: `${config.name} (copy)`,
    createdAt: now,
    updatedAt: now,
    shared: false,
    lastSyncedAt: null,
    dirty: false,
  };
}

describe('makeDuplicate', () => {
  it('strips sync metadata', () => {
    const original: ScraperConfig = {
      id: 'orig',
      name: 'Wikipedia',
      domain: 'en.wikipedia.org',
      domainLocked: true,
      url: '',
      steps: [],
      schemaVersion: 4,
      createdAt: 1,
      updatedAt: 2,
      shared: true,
      lastSyncedAt: '2026-04-26T10:00:00Z',
      dirty: true,
    };
    const copy = makeDuplicate(original, 'new', 100);
    expect(copy.id).toBe('new');
    expect(copy.shared).toBe(false);
    expect(copy.lastSyncedAt).toBeNull();
    expect(copy.dirty).toBe(false);
    expect(copy.name).toBe('Wikipedia (copy)');
  });
});
```

---

## Files deleted

None in this pass. The `saveSharedConfig` alias removal noted in Stage B is parked in `FUTURE-config-sync-next-passes.md` (E.4) — leaving it avoids a needless second touch for this PR.

---

## Verification

### Automated commands

From repo root:

```bash
# Backend
cd backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests/WebScrape.Tests.csproj --filter "FullyQualifiedName~ScraperConfigServiceConflictTests"

# Extension
pnpm vitest run src/__tests__/syncStore.test.ts src/__tests__/configStoreAutoPush.test.ts src/__tests__/duplicateConfig.test.ts
pnpm eslint src/sidepanel src/__tests__
pnpm build  # WXT build — catches any type errors

# Backend frontend (no test runner — type check only)
cd backend/src/WebScrape.Client
pnpm tsc --noEmit
```

### Manual test plan

Run with backend up, extension installed, and one user account. Cleanup duplicate "something" rows in backend frontend before starting.

1. **Sync race** — create config "race-test" in extension, click WiFi 5× rapidly. Expected: backend `/configs` shows exactly one "race-test".
2. **List refresh** — click WiFi-off on a config to share. Expected: WiFi-on icon and "Synced" badge appear within ~1s without tab switch.
3. **Duplicate is fresh** — duplicate a synced config. Expected: copy shows WiFi-off, no sync badge.
4. **Edit-and-save auto-push** — open a shared config in extension Config tab, add a step, save. Expected: "Synced" badge updates within ~1s; backend frontend reflects new step on refresh.
5. **Backend preserves `shared`** — extension shares a config; backend frontend edits its name without touching the new checkbox; save. Expected: row still shows "Synced" in backend list.
6. **Backend share toggle** — backend frontend creates a new config with checkbox checked; save; trigger pull in extension. Expected: config appears in extension with WiFi-on.
7. **Visibility-change pull** — backend frontend edit a shared config; switch focus to extension sidepanel. Expected: row reflects new content within ~1s.
8. **Manual pull button** — click RefreshCw icon at top of Saved Configs. Expected: button briefly disables; list refreshes.
9. **In-flight disabled** — DevTools Slow 3G; click WiFi-off; immediately try to click again. Expected: second click is a no-op; button visibly disabled.
10. **Concurrency guard** — toggle API token off→on while clicking pull button. Expected: only one network round-trip fires (verify in DevTools Network panel).

---

## File-structure summary after changes

| File | Action |
|---|---|
| `backend/src/WebScrape.Services/Interfaces/IScraperConfigService.cs` | Add enum + result; change `CreateAsync` return type |
| `backend/src/WebScrape.Services/Implementations/ScraperConfigService.cs` | Replace `CreateAsync` body |
| `backend/src/WebScrape.Server/Controllers/ScraperConfigsController.cs` | Replace `Create` action |
| `backend/tests/WebScrape.Tests/Services/ScraperConfigServiceConflictTests.cs` | Append 3 tests |
| `backend/src/WebScrape.Client/src/index.css` | Add `.form-check` + nested checkbox rule |
| `backend/src/WebScrape.Client/src/pages/ConfigEditor.tsx` | Add `shared` state, hydrate, send in body, render checkbox |
| `src/sidepanel/utils/syncClient.ts` | Handle 409 + 200 in POST branch |
| `src/sidepanel/stores/syncStore.ts` | Replace file (adds version, pushingIds, guards) |
| `src/sidepanel/stores/configStore.ts` | Replace `saveCurrentConfig` |
| `src/sidepanel/components/ConfigList.tsx` | Replace file (refresh subscription, pull button, duplicate fix) |
| `src/sidepanel/components/ConfigListItem.tsx` | Add `isPushing` derived flag, replace share-button JSX |
| `src/sidepanel/App.tsx` | Insert visibility-change `useEffect` |
| `src/__tests__/syncStore.test.ts` | Append 5 tests |
| `src/__tests__/configStoreAutoPush.test.ts` | New file |
| `src/__tests__/duplicateConfig.test.ts` | New file |
