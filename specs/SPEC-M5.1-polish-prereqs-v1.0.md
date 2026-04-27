# SPEC-M5.1 — Polish & Prereqs (Theme 3)

**Status**: Implementation-ready. Sonnet executes top-to-bottom.

**Predecessor**: M4 shipped `8d567a6` + bug-fix follow-ups through `b214b44`.

**Plan reference**: [can-we-plan-m5-idempotent-nebula.md](c:\Users\und3r\.claude\plans\can-we-plan-m5-idempotent-nebula.md) — Theme 3.

---

## Context

M5 is the final WebScrape milestone, scoped as three themes. This spec is **Theme 3 only** — small, independent polish items that **must land before** Themes 1 (tree UI) and 2 (config sync) start. The order matters because Theme 3 touches package versions, schema-adjacent files, and the auth-aware `ApiKeysController` that Theme 2's subscriber endpoint will extend. Landing Theme 3 first keeps Theme 1/2 PRs free of cross-cutting renames.

Nine sections, in commit order. Each section is a single PR (or a single commit when noted).

| # | Section | Files | LoC | Commit unit |
|---|---|---|---|---|
| 1 | AutoMapper 12 → 13 bump | 3 csproj + 1 Program.cs verify | ~10 | own PR |
| 2 | Identity password 5 → 8 + seeder password | Program.cs + InitialSeed.cs | ~4 | single commit |
| 3 | `.NET 8` → `.NET 9` README/spec text | README.md + SPEC-webscrape-v1.0.md | ~6 | own PR |
| 4 | PAT rename | 7 backend + frontend files + tests | ~250 | own PR |
| 5 | Worker presence (`BumpLastSeenAsync` + idle UI) | 6 backend + frontend files + tests | ~200 | own PR |
| 6 | Serilog Seq sink (opt-in) | 3 files | ~30 | own PR |
| 7 | Prod Dockerfile + compose | 4 new files + README rewrite | ~150 | own PR |
| 8 | Debug log gating in extension | 4 files + 1 new helper | ~80 | own PR |
| 9 | `bb_jwt` → `bb_api_token` shim | 2 files + tests | ~80 | own PR |

Total ~810 LoC across ~9 PRs. Each PR is independently shippable.

---

## Verification commands (run after each section)

Backend:
```
cd c:/Users/und3r/blueberry-v3/backend
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests
```

Backend frontend:
```
cd c:/Users/und3r/blueberry-v3/backend/src/WebScrape.Client
npm run typecheck
npm run lint
npm run build
```

Extension:
```
cd c:/Users/und3r/blueberry-v3
npm run typecheck
npm run lint
npm run test
```

End-to-end smoke (after sections 4, 5, 6, 8, 9): user runs the relevant smoke step from Section "Smoke checklist" at the bottom.

---

## Section 1 — AutoMapper 12 → 13 bump

### Why

AutoMapper 12 → 13 is a clean bump. v13 deprecates `AutoMapper.Extensions.Microsoft.DependencyInjection` (the `AddAutoMapper` extension is now in core AutoMapper). Locking to v13.0.1 avoids the v15 commercial-licence change. M1.1 deviation #4 in memory flags this as polish.

### Files

**[backend/src/WebScrape.Server/WebScrape.Server.csproj](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\WebScrape.Server.csproj) — line 12**

Replace:
```xml
<PackageReference Include="AutoMapper.Extensions.Microsoft.DependencyInjection" Version="12.0.1" />
```
With:
```xml
<PackageReference Include="AutoMapper" Version="13.0.1" />
```

**[backend/src/WebScrape.Data/WebScrape.Data.csproj](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\WebScrape.Data.csproj) — line 10**

Replace:
```xml
<PackageReference Include="AutoMapper" Version="12.0.1" />
```
With:
```xml
<PackageReference Include="AutoMapper" Version="13.0.1" />
```

**[backend/src/WebScrape.Services/WebScrape.Services.csproj](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\WebScrape.Services.csproj) — line 9**

Replace:
```xml
<PackageReference Include="AutoMapper" Version="12.0.1" />
```
With:
```xml
<PackageReference Include="AutoMapper" Version="13.0.1" />
```

**[backend/src/WebScrape.Server/Program.cs:94](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Program.cs#L94)** — verify, no edit expected.

The current call is `builder.Services.AddAutoMapper(typeof(AutoMapperProfile));`. AutoMapper 13.0.1 keeps this overload via the `AutoMapper.Extensions.Microsoft.DependencyInjection` namespace baked into the core package. **Run `dotnet build` after the package bump** — if it fails to find `AddAutoMapper`, rewrite line 94 as:

```csharp
builder.Services.AddAutoMapper(cfg => cfg.AddProfile<AutoMapperProfile>());
```

(The `cfg => cfg.AddProfile<T>()` overload exists in both v12 and v13, so this rewrite is safe regardless.)

### Verification

```
dotnet restore WebScrape.sln
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests
```

Existing 114 backend tests must all pass. NU1903 CVE warning in build output should disappear.

---

## Section 2 — Identity password 5 → 8 + seeder password

### Why

Spec called for `RequiredLength = 8`. M1.1 deviation #2 relaxed it to 5 so the seeded `admin@local / admin` (5 chars) login worked. Restore the spec value; bump the seeded password to clear the policy.

**Single commit** — bumping length without updating the seeder breaks first-run boot.

### Files

**[backend/src/WebScrape.Server/Program.cs:34](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Program.cs#L34)**

Replace:
```csharp
opts.Password.RequiredLength = 5;
```
With:
```csharp
opts.Password.RequiredLength = 8;
```

**[backend/src/WebScrape.Server/Seed/InitialSeed.cs:13](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Seed\InitialSeed.cs#L13)**

Replace:
```csharp
public const string AdminPassword = "admin";
```
With:
```csharp
public const string AdminPassword = "admin123";
```

### Migration note for users

Existing dev databases retain their old `admin` password (Identity stored hash; policy only enforces on new logins). The change applies to **fresh seeds only**. Document this in the PR description.

### Verification

```
dotnet build WebScrape.sln
dotnet test tests/WebScrape.Tests
```

If any test seeds a user via `UserManager.CreateAsync` with a < 8 char password, it now fails. Search:

```
Grep "CreateAsync.*\".{1,7}\"" backend/tests
```

Update affected tests.

Manual: drop dev DB, restart server, log in as `admin@local` / `admin123`. Should succeed.

---

## Section 3 — `.NET 8` → `.NET 9` doc text

### Why

Backend project files target `net9.0` (verified [WebScrape.Server.csproj:4](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\WebScrape.Server.csproj#L4)). The original spec said `.NET 8`. Sync the docs to reality.

### Files

**[backend/README.md:17](c:\Users\und3r\blueberry-v3\backend\README.md#L17)** — already says `.NET SDK 9 (spec called for .NET 8; this repo targets .NET 9 because that's what's installed locally)`. **No change needed** — but you'll be rewriting this README in Section 7. Verify the rewrite preserves the .NET 9 prerequisite.

**[specs/SPEC-webscrape-v1.0.md](c:\Users\und3r\blueberry-v3\specs\SPEC-webscrape-v1.0.md)** — search-and-replace `.NET 8` → `.NET 9` and pinned `8.0.*` → `9.0.*` for backend NuGet versions, EXCEPT keep `8.0.*` references that describe historical deviation explanations.

Use:
```
Grep -n "\.NET 8" specs/SPEC-webscrape-v1.0.md
Grep -n "8\.0\.\*" specs/SPEC-webscrape-v1.0.md
```

For each match, decide: is it stating "we shipped on .NET 9" (leave) or pinning a package (update to `9.0.*`)? Roughly 8 hits expected.

### Verification

```
Grep -c "\.NET 8" specs/SPEC-webscrape-v1.0.md
```

Should show only "spec said .NET 8" references in deviation notes.

---

## Section 4 — PAT rename

### Why

Memory says PAT management UI is partial — list/create/revoke shipped, rename never did. Add edit-in-place name change.

### Files (in order)

#### 4a. Backend DTO

**[backend/src/WebScrape.Data/Dto/ApiKeyDto.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Dto\ApiKeyDto.cs)** — append after line 24 (after `CreateApiKeyResponseDto`):

```csharp
public class RenameApiKeyDto
{
    public string Name { get; set; } = "";
}
```

#### 4b. Backend service interface

**[backend/src/WebScrape.Services/Interfaces/IApiKeyService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Interfaces\IApiKeyService.cs)** — add a method to the interface (between `RevokeAsync` and the closing brace):

Final file (replace whole):
```csharp
using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public interface IApiKeyService
{
    Task<CreateApiKeyResponseDto> CreateAsync(Guid userId, string name, CancellationToken ct = default);
    Task<List<ApiKeyDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<bool> RevokeAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<ApiKeyDto?> RenameAsync(Guid userId, Guid id, string newName, CancellationToken ct = default);
}
```

#### 4c. Backend service implementation

**[backend/src/WebScrape.Services/Implementations/ApiKeyService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\ApiKeyService.cs)** — append after `RevokeAsync` (after line 71, before closing brace):

```csharp
    public async Task<ApiKeyDto?> RenameAsync(Guid userId, Guid id, string newName, CancellationToken ct = default)
    {
        var trimmed = newName?.Trim() ?? "";
        if (trimmed.Length == 0) return null;

        var key = await _db.ApiKeys.FirstOrDefaultAsync(k => k.Id == id && k.UserId == userId, ct);
        if (key is null) return null;
        if (key.RevokedAt is not null) return null;

        key.Name = trimmed;
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ApiKeyDto>(key);
    }
```

Returns `null` for: missing key, cross-user, revoked key, or whitespace-only name. The controller maps `null` → 404 (callers shouldn't differentiate; revoked keys are functionally absent).

#### 4d. Backend controller

**[backend/src/WebScrape.Server/Controllers/ApiKeysController.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Controllers\ApiKeysController.cs)** — append after `Revoke` method (after line 44):

```csharp
    [HttpPatch("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Rename(Guid id, [FromBody] RenameApiKeyDto dto, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dto?.Name)) return BadRequest(new { error = "Name is required" });
        var updated = await _apiKeys.RenameAsync(User.GetUserId(), id, dto.Name, ct);
        if (updated is null) return NotFound();
        return Ok(updated);
    }
```

Cookie auth + CSRF are inherited from the class-level `[Authorize]` and applied via `[CookieCsrf]` on the action — same pattern as `Create` (line 22) and `Revoke` (line 38). Rate limit: covered by the wildcard `*` rule (120/min) — no new entry needed in `appsettings.json`.

#### 4e. Backend tests

**[backend/tests/WebScrape.Tests/Services/ApiKeyServiceTests.cs](c:\Users\und3r\blueberry-v3\backend\tests\WebScrape.Tests\Services\ApiKeyServiceTests.cs)** — append four new `[Fact]` methods after the existing `Revoke_returns_false_for_other_users_key` (after line 109, before the closing brace of the class):

```csharp
    [Fact]
    public async Task Rename_updates_name_for_owner()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Old name");

        var renamed = await svc.RenameAsync(userId, created.Id, "New name");

        Assert.NotNull(renamed);
        Assert.Equal("New name", renamed!.Name);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("New name", stored.Name);
    }

    [Fact]
    public async Task Rename_trims_whitespace()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Old");

        var renamed = await svc.RenameAsync(userId, created.Id, "  Trimmed  ");

        Assert.Equal("Trimmed", renamed!.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_whitespace_name()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Original");

        var renamed = await svc.RenameAsync(userId, created.Id, "   ");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("Original", stored.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_other_users_key()
    {
        var (svc, db, _) = Build();
        var alice = await SeedUserAsync(db);
        var bob = await SeedUserAsync(db);
        var aliceKey = await svc.CreateAsync(alice, "alice-key");

        var renamed = await svc.RenameAsync(bob, aliceKey.Id, "hijacked");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == aliceKey.Id);
        Assert.Equal("alice-key", stored.Name);
    }

    [Fact]
    public async Task Rename_returns_null_for_revoked_key()
    {
        var (svc, db, _) = Build();
        var userId = await SeedUserAsync(db);
        var created = await svc.CreateAsync(userId, "Original");
        await svc.RevokeAsync(userId, created.Id);

        var renamed = await svc.RenameAsync(userId, created.Id, "Renamed");

        Assert.Null(renamed);
        var stored = await db.ApiKeys.SingleAsync(k => k.Id == created.Id);
        Assert.Equal("Original", stored.Name);
    }
```

#### 4f. Frontend mutation

**[backend/src/WebScrape.Client/src/api/mutations.ts](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\mutations.ts)** — append after `useRevokeApiKey` (after line 51):

```ts
export function useRenameApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await api.patch<ApiKeyDto>(`/api/api-keys/${id}`, { name })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}
```

Add `ApiKeyDto` to the existing import on line 4:
```ts
import type { AccountDto, ApiKeyDto, BatchDispatchResultDto, CreateApiKeyResponseDto, CreateBatchDto, CreateScraperConfigDto, ExpansionPreviewDto, SaveTaskDto, ScraperConfigDto, TaskDto } from './types';
```

#### 4g. Frontend UI — edit-in-place

**[backend/src/WebScrape.Client/src/pages/ApiKeys.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\pages\ApiKeys.tsx)**

Add `useRenameApiKey` to the import on line 3:
```ts
import { useCreateApiKey, useRenameApiKey, useRevokeApiKey } from '../api/mutations';
```

Add state hooks after line 17 (after `confirmRevoke` state):
```ts
  const rename = useRenameApiKey();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
```

Add a handler before `return (` (after line 33):
```ts
  const startEdit = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const submitRename = async () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (!trimmed) { cancelEdit(); return; }
    await rename.mutateAsync({ id: editingId, name: trimmed });
    cancelEdit();
  };
```

Replace the `<td>{k.name}</td>` cell at line 70 with an inline edit pattern:
```tsx
                <td>
                  {editingId === k.id ? (
                    <span className="flex" style={{ gap: 'var(--spacing-xs)', alignItems: 'center' }}>
                      <input
                        className="form-input input-sm"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitRename();
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        autoFocus
                        disabled={rename.isPending}
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={submitRename}
                        disabled={rename.isPending || !editName.trim()}
                      >
                        Save
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={cancelEdit}
                        disabled={rename.isPending}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex" style={{ gap: 'var(--spacing-xs)', alignItems: 'center' }}>
                      {k.name}
                      {!k.revokedAt && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => startEdit(k.id, k.name)}
                          title="Rename — only changes the label here. Workers using this key keep their own name."
                        >
                          Edit
                        </button>
                      )}
                    </span>
                  )}
                </td>
```

Note: the `title` attribute carries the spec's PAT-rename clarification copy. CSS classes used are all existing tokens (`flex`, `form-input`, `input-sm`, `btn`, `btn-primary`, `btn-ghost`, `btn-sm`). No new CSS.

If `input-sm` does not exist in `index.css`, fall back to `form-input` only (omit `input-sm`).

#### 4h. Frontend test

No new vitest test required — this is a UI flow covered by the manual smoke test below. The mutation hook is a thin wrapper over `useMutation` and doesn't merit a unit test.

### Smoke step 4

1. Log in as admin. Navigate to `/api-keys`.
2. Create a key called "Test rename".
3. Click "Edit" next to its name. Inline input appears.
4. Type "Renamed key", press Enter. Row updates with new name.
5. Click "Edit" again. Type whitespace only, press Enter. Row reverts to displayed name (no save).
6. Click "Edit". Press Escape. Cancels.
7. Revoke the key. "Edit" button no longer rendered.

### Verification

Backend: `dotnet test` — 5 new tests pass, total = 119.
Frontend: `npm run typecheck && npm run lint && npm run build` — clean.

---

## Section 5 — Worker presence (LastSeenAt + idle indicator)

### Why

Memory says workers show "Online / Offline" only. Idle workers (online but no events) look fresh. Distinguish: bump `LastSeenAt` on every hub method call (throttled), surface "Idle (Ns)" when stale.

### Files

#### 5a. Service interface

**[backend/src/WebScrape.Services/Interfaces/IWorkerService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Interfaces\IWorkerService.cs)** — replace whole file:

```csharp
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;

namespace WebScrape.Services.Interfaces;

public interface IWorkerService
{
    Task<WorkerConnection> RegisterAsync(Guid userId, Guid apiKeyId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default);
    Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default);
    Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task BumpLastSeenAsync(string connectionId, CancellationToken ct = default);
}
```

#### 5b. Service implementation

**[backend/src/WebScrape.Services/Implementations/WorkerService.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Services\Implementations\WorkerService.cs)** — replace whole file:

```csharp
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class WorkerService : IWorkerService
{
    public static readonly TimeSpan BumpThrottle = TimeSpan.FromSeconds(5);

    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly IMemoryCache _cache;

    public WorkerService(WebScrapeDbContext db, IMapper mapper, IMemoryCache cache)
    {
        _db = db;
        _mapper = mapper;
        _cache = cache;
    }

    public async Task<WorkerConnection> RegisterAsync(Guid userId, Guid apiKeyId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.UserId == userId && w.ApiKeyId == apiKeyId, ct);
        var now = DateTimeOffset.UtcNow;

        if (worker is null)
        {
            worker = new WorkerConnection
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                ApiKeyId = apiKeyId,
                Name = string.IsNullOrWhiteSpace(clientName) ? "My Browser" : clientName,
            };
            _db.WorkerConnections.Add(worker);
        }
        else if (!string.IsNullOrWhiteSpace(clientName))
        {
            worker.Name = clientName;
        }

        worker.CurrentConnection = connectionId;
        worker.ExtensionVersion = extensionVersion;
        worker.LastConnectedAt = now;
        worker.LastSeenAt = now;

        await _db.SaveChangesAsync(ct);
        return worker;
    }

    public async Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.CurrentConnection == connectionId, ct);
        if (worker is null) return;

        var now = DateTimeOffset.UtcNow;
        worker.CurrentConnection = null;
        worker.LastSeenAt = now;

        var inFlightStatuses = new[] { RunItemStatus.Sent, RunItemStatus.Running, RunItemStatus.Paused };
        var inFlight = await _db.RunItems
            .Where(r => r.WorkerId == worker.Id && inFlightStatuses.Contains(r.Status))
            .ToListAsync(ct);

        foreach (var run in inFlight)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = "Worker disconnected";
            run.CompletedAt = now;
        }

        await _db.SaveChangesAsync(ct);
    }

    public async Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var workers = await _db.WorkerConnections
            .AsNoTracking()
            .Where(w => w.UserId == userId)
            .OrderBy(w => w.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<WorkerDto>>(workers);
    }

    public async Task BumpLastSeenAsync(string connectionId, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(connectionId)) return;

        var cacheKey = $"worker-bump:{connectionId}";
        if (_cache.TryGetValue(cacheKey, out _)) return;

        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.CurrentConnection == connectionId, ct);
        if (worker is null) return;

        worker.LastSeenAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        _cache.Set(cacheKey, true, BumpThrottle);
    }
}
```

Notes:
- `IMemoryCache` is already registered in [Program.cs:114](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Program.cs#L114) (`AddMemoryCache()`), so the constructor injection works.
- Throttle is 5s — bumps within 5s of the last bump are skipped. Stale threshold (UI-side) is 30s — gives 6× headroom.
- The `BumpThrottle` constant is `public static readonly` so tests can shorten it via reflection if needed (or accept it as-is and use `Task.Delay`).

#### 5c. Hub wrapping

**[backend/src/WebScrape.Server/Hubs/ScraperHub.cs:53-56](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Hubs\ScraperHub.cs#L53-L56)** — replace lines 53–56 (the four expression-bodied methods):

```csharp
    public async Task TaskProgress(TaskProgressDto payload)
    {
        await _runs.RecordProgressAsync(payload);
        await _workers.BumpLastSeenAsync(Context.ConnectionId);
    }

    public async Task TaskComplete(TaskCompleteDto payload)
    {
        await _runs.CompleteAsync(payload);
        await _workers.BumpLastSeenAsync(Context.ConnectionId);
    }

    public async Task TaskError(TaskErrorDto payload)
    {
        await _runs.FailAsync(payload);
        await _workers.BumpLastSeenAsync(Context.ConnectionId);
    }

    public async Task TaskPaused(TaskPausedDto payload)
    {
        await _runs.MarkPausedAsync(payload);
        await _workers.BumpLastSeenAsync(Context.ConnectionId);
    }
```

Bump runs **after** the run-state update so a slow run-state write doesn't delay the bump (and a failing bump shouldn't roll back the run-state update — they're independent transactions).

#### 5d. DTO + AutoMapper

**[backend/src/WebScrape.Data/Dto/WorkerDto.cs](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Dto\WorkerDto.cs)** — replace whole file:

```csharp
namespace WebScrape.Data.Dto;

public class WorkerDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public bool Online { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset? LastConnectedAt { get; set; }
    public string? ExtensionVersion { get; set; }
}
```

**[backend/src/WebScrape.Data/Mapping/AutoMapperProfile.cs:35-36](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Data\Mapping\AutoMapperProfile.cs#L35-L36)** — no change. AutoMapper convention auto-maps `LastConnectedAt` because both source (`WorkerConnection.LastConnectedAt`) and destination (`WorkerDto.LastConnectedAt`) have matching names + types.

#### 5e. Frontend types

**[backend/src/WebScrape.Client/src/api/types.ts:117-123](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\api\types.ts#L117-L123)** — replace `WorkerDto`:

```ts
export type WorkerDto = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  extensionVersion: string | null;
};
```

#### 5f. Workers page UI

**[backend/src/WebScrape.Client/src/pages/Workers.tsx](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\pages\Workers.tsx)** — replace whole file:

```tsx
import { useWorkers } from '../api/queries';
import { fmtRelative } from '../utils/formatDate';
import type { WorkerDto } from '../api/types';

const STALE_MS = 30_000;

function presence(w: WorkerDto, now: number): { dot: 'success' | 'warning' | 'pending'; label: string } {
  if (!w.online) return { dot: 'pending', label: 'Offline' };
  if (!w.lastSeenAt) return { dot: 'success', label: 'Online' };
  const ageMs = now - new Date(w.lastSeenAt).getTime();
  if (ageMs > STALE_MS) {
    const s = Math.round(ageMs / 1000);
    return { dot: 'warning', label: `Idle (${s}s since last activity)` };
  }
  return { dot: 'success', label: 'Online' };
}

export default function Workers() {
  const { data: workers, isPending } = useWorkers();
  const now = Date.now();

  return (
    <div className="view">
      <h2 className="view-title">Workers</h2>
      <div className="view-subtitle">Browser extensions connected to this backend. Refreshes every 5s.</div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && workers && workers.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No workers yet</div>
          <div className="empty-state-desc">
            Open the extension, paste an API key, set the worker name, and switch mode to Queue.
          </div>
        </div>
      )}

      {!isPending && workers && workers.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => {
              const p = presence(w, now);
              return (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className={`status-dot ${p.dot}`} />
                      {p.label}
                    </span>
                  </td>
                  <td>{w.extensionVersion ?? '—'}</td>
                  <td>{fmtRelative(w.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

`status-dot.warning` should already exist in [index.css](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Client\src\index.css) per the design-system memory. If grep confirms it's missing, add this rule (use existing `--warning` token):
```css
.status-dot.warning { background: var(--warning); }
```

#### 5g. Tests

**[backend/tests/WebScrape.Tests/Services/WorkerServiceTests.cs](c:\Users\und3r\blueberry-v3\backend\tests\WebScrape.Tests\Services\WorkerServiceTests.cs)**

Replace the existing constructor pattern (`new WorkerService(db, TestDb.CreateMapper())`) with a factory that includes `IMemoryCache`:

Add a private helper at the top of the class (after the class brace, before any test):

```csharp
    private static (WorkerService svc, WebScrape.Data.WebScrapeDbContext db, Microsoft.Extensions.Caching.Memory.IMemoryCache cache) Build()
    {
        var db = TestDb.CreateInMemory();
        var cache = new Microsoft.Extensions.Caching.Memory.MemoryCache(new Microsoft.Extensions.Caching.Memory.MemoryCacheOptions());
        var svc = new WorkerService(db, TestDb.CreateMapper(), cache);
        return (svc, db, cache);
    }
```

Then update all four existing tests to use `Build()` (replacing the inline `new WorkerService(...)` lines). Example for the first test (line 13):

```csharp
    [Fact]
    public async Task Register_inserts_new_row_for_first_connection()
    {
        var (svc, db, _) = Build();
        var userId = Guid.NewGuid();
        var apiKeyId = Guid.NewGuid();

        var worker = await svc.RegisterAsync(userId, apiKeyId, "Laptop", "1.0.0", "conn-1");

        Assert.Equal("Laptop", worker.Name);
        Assert.Equal("conn-1", worker.CurrentConnection);
        Assert.Equal("1.0.0", worker.ExtensionVersion);
        Assert.NotNull(worker.LastConnectedAt);
        Assert.NotNull(worker.LastSeenAt);
        Assert.Equal(1, await db.WorkerConnections.CountAsync());
    }
```

Same pattern for `Register_reuses_row_for_same_user_and_api_key`, `HandleDisconnect_clears_connection_and_fails_in_flight_runs`, `HandleDisconnect_is_noop_for_unknown_connection`.

Append three new `[Fact]` methods at the bottom of the class:

```csharp
    [Fact]
    public async Task BumpLastSeen_updates_timestamp_for_connected_worker()
    {
        var (svc, db, _) = Build();
        var worker = await svc.RegisterAsync(Guid.NewGuid(), Guid.NewGuid(), "L", "1", "conn-bump");
        var initial = worker.LastSeenAt;

        await Task.Delay(10);
        await svc.BumpLastSeenAsync("conn-bump");

        var reloaded = await db.WorkerConnections.SingleAsync(w => w.Id == worker.Id);
        Assert.NotNull(reloaded.LastSeenAt);
        Assert.True(reloaded.LastSeenAt > initial, "LastSeenAt should advance after bump");
    }

    [Fact]
    public async Task BumpLastSeen_throttle_skips_within_window()
    {
        var (svc, db, _) = Build();
        var worker = await svc.RegisterAsync(Guid.NewGuid(), Guid.NewGuid(), "L", "1", "conn-throttle");

        await svc.BumpLastSeenAsync("conn-throttle");
        var firstBump = (await db.WorkerConnections.SingleAsync(w => w.Id == worker.Id)).LastSeenAt;

        // Second bump within throttle window — must be skipped.
        await Task.Delay(20);
        await svc.BumpLastSeenAsync("conn-throttle");
        var secondReload = (await db.WorkerConnections.SingleAsync(w => w.Id == worker.Id)).LastSeenAt;

        Assert.Equal(firstBump, secondReload);
    }

    [Fact]
    public async Task BumpLastSeen_is_noop_for_unknown_connection()
    {
        var (svc, db, _) = Build();
        await svc.BumpLastSeenAsync("never-existed");
        Assert.Equal(0, await db.WorkerConnections.CountAsync());
    }
```

### Smoke step 5

1. Connect extension to backend via Queue mode.
2. Open `/workers`. Should show "Online".
3. Wait 35s (no tasks running). Refresh. Should show "Idle (35s since last activity)" with a yellow `.status-dot.warning`.
4. Trigger a task. While task is running (TaskProgress firing), the row flips back to "Online".
5. After task completes, wait 35s again. Returns to "Idle".

### Verification

```
dotnet test  # 117 tests, all pass (3 new + 5 modified existing)
cd backend/src/WebScrape.Client && npm run typecheck && npm run build  # clean
```

---

## Section 6 — Serilog Seq sink (opt-in)

### Why

File logging works (memory confirms `logs/webscrape-*.log`). For prod ops, optional centralised collection via Seq. Default off — zero impact for users who don't run Seq.

### Files

**[backend/src/WebScrape.Server/WebScrape.Server.csproj](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\WebScrape.Server.csproj)** — add inside the existing `<ItemGroup>` (after line 22, the `Serilog.AspNetCore` line):

```xml
    <PackageReference Include="Serilog.Sinks.Seq" Version="9.0.*" />
```

**[backend/src/WebScrape.Server/Program.cs:19-22](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\Program.cs#L19-L22)** — replace lines 19–22:

```csharp
builder.Host.UseSerilog((ctx, lc) =>
{
    lc.ReadFrom.Configuration(ctx.Configuration)
      .WriteTo.Console()
      .WriteTo.File("logs/webscrape-.log", rollingInterval: RollingInterval.Day);

    var seqEnabled = ctx.Configuration.GetValue<bool>("Serilog:Seq:Enabled");
    var seqUrl = ctx.Configuration["Serilog:Seq:ServerUrl"];
    if (seqEnabled && !string.IsNullOrWhiteSpace(seqUrl))
    {
        lc.WriteTo.Seq(seqUrl);
    }
});
```

**[backend/src/WebScrape.Server/appsettings.json](c:\Users\und3r\blueberry-v3\backend\src\WebScrape.Server\appsettings.json)** — replace the entire `Serilog` block (lines 2–11) with:

```json
  "Serilog": {
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft": "Warning",
        "Microsoft.AspNetCore.SignalR": "Information",
        "System": "Warning"
      }
    },
    "Seq": {
      "Enabled": false,
      "ServerUrl": "http://localhost:5341"
    }
  },
```

### Smoke step 6

Optional. To verify locally:

1. `docker run -d --name seq -e ACCEPT_EULA=Y -p 5341:5341 -p 5340:80 datalust/seq:latest`
2. Edit `appsettings.Development.json` (create from template if missing) to set `Serilog:Seq:Enabled = true`.
3. Restart backend.
4. Open `http://localhost:5340` — Seq UI shows the running webscrape logs.
5. Trigger a task — `Microsoft.AspNetCore.SignalR` events appear.

### Verification

```
dotnet build && dotnet test
```

With Seq disabled (default), behaviour unchanged. With it enabled and Seq unreachable, Serilog buffers in memory then drops — no exception propagates.

---

## Section 7 — Prod Dockerfile + compose

### Why

M1.4 was skipped per memory. M5 finishes it: multi-stage Dockerfile, dev/prod compose split, README rewrite documenting prod deployment with TLS.

### Files

#### 7a. Dockerfile

**Create** `c:/Users/und3r/blueberry-v3/backend/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY ["src/WebScrape.Server/WebScrape.Server.csproj", "src/WebScrape.Server/"]
COPY ["src/WebScrape.Services/WebScrape.Services.csproj", "src/WebScrape.Services/"]
COPY ["src/WebScrape.Data/WebScrape.Data.csproj", "src/WebScrape.Data/"]
RUN dotnet restore "src/WebScrape.Server/WebScrape.Server.csproj"

COPY src/ src/
RUN dotnet publish "src/WebScrape.Server/WebScrape.Server.csproj" \
    -c Release \
    -o /app/publish \
    /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "WebScrape.Server.dll"]
```

#### 7b. Dev compose (replaces the M1.4-style local-dev pattern)

**Create** `c:/Users/und3r/blueberry-v3/backend/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: webscrape
      POSTGRES_USER: webscrape
      POSTGRES_PASSWORD: webscrape
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  server:
    build:
      context: .
      dockerfile: Dockerfile
    depends_on:
      - db
    environment:
      ConnectionStrings__Default: "Host=db;Database=webscrape;Username=webscrape;Password=webscrape"
      ASPNETCORE_ENVIRONMENT: Development
    ports:
      - "5082:8080"

volumes:
  pgdata:
```

Port 5082 matches the M1.1 deviation that the running backend uses (per memory).

#### 7c. Prod compose overlay

**Create** `c:/Users/und3r/blueberry-v3/backend/docker-compose.prod.yml`:

```yaml
services:
  db:
    image: postgres:17
    env_file: .env.prod
    volumes:
      - pgdata-prod:/var/lib/postgresql/data
    restart: unless-stopped
    # No ports: only the server reaches the DB via the docker network.

  server:
    build:
      context: .
      dockerfile: Dockerfile
    env_file: .env.prod
    depends_on:
      - db
    expose:
      - "8080"
    restart: unless-stopped
    # No ports: a reverse proxy (Caddy/Traefik) handles ingress + TLS.
    # See README.md "Production deployment" for how to wire one in.

volumes:
  pgdata-prod:
```

#### 7d. Env file template

**Create** `c:/Users/und3r/blueberry-v3/backend/.env.prod.example`:

```
# Copy this to .env.prod and fill in real values.
# .env.prod itself is git-ignored.

POSTGRES_DB=webscrape
POSTGRES_USER=webscrape
POSTGRES_PASSWORD=CHANGE_ME

ConnectionStrings__Default=Host=db;Database=webscrape;Username=webscrape;Password=CHANGE_ME

ASPNETCORE_ENVIRONMENT=Production

# Optional: enable Seq centralised logging
Serilog__Seq__Enabled=false
Serilog__Seq__ServerUrl=http://seq:5341
```

#### 7e. .gitignore

**Append** to `c:/Users/und3r/blueberry-v3/.gitignore` (or `c:/Users/und3r/blueberry-v3/backend/.gitignore` if more local):

```
# Production env file (template lives in backend/.env.prod.example)
backend/.env.prod
```

#### 7f. README rewrite

**Replace** `c:/Users/und3r/blueberry-v3/backend/README.md` entirely:

````markdown
# WebScrape Backend

Backend + web UI for the blueberry-v3 browser extension. Owns task definitions, queues, runs, and results.

## Repo layout

- `src/WebScrape.Server/` — ASP.NET Core host, controllers, SignalR hub, auth handlers
- `src/WebScrape.Services/` — business logic services
- `src/WebScrape.Data/` — DbContext, entities, DTOs, AutoMapper profiles
- `src/WebScrape.Client/` — React + Vite + TS frontend
- `tests/WebScrape.Tests/` — xUnit + Moq + AutoFixture tests

## Local development (no Docker)

Prerequisites: .NET SDK 9, PostgreSQL 17 reachable on `localhost:5432`.

```bash
cp src/WebScrape.Server/appsettings.Development.json.template src/WebScrape.Server/appsettings.Development.json
# Edit the connection string for your local Postgres.

dotnet restore WebScrape.sln
dotnet build WebScrape.sln
dotnet ef database update --project src/WebScrape.Data --startup-project src/WebScrape.Server
dotnet run --project src/WebScrape.Server   # listens on http://localhost:5082
dotnet test tests/WebScrape.Tests
```

Frontend dev server (separate process):

```bash
cd src/WebScrape.Client
npm install
npm run dev   # http://localhost:5173, proxies /api to localhost:5082
```

## Local development (Docker Compose)

```bash
docker compose up -d
# Backend at http://localhost:5082; DB on localhost:5432.
```

The first start auto-applies migrations and seeds an admin user (`admin@local` / `admin123`) plus a demo config + task.

## Production deployment

The prod compose does **not** expose the server publicly. Front it with a reverse proxy that terminates TLS.

```bash
cp .env.prod.example .env.prod
# Edit .env.prod — set POSTGRES_PASSWORD and ConnectionStrings__Default.

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### TLS termination

You bring your own reverse proxy. Two common choices:

#### Caddy (auto Let's Encrypt)

`Caddyfile`:
```
webscrape.example.com {
    reverse_proxy server:8080
}
```

Run Caddy on the same docker network as the compose stack (`docker network connect <network> caddy`).

#### Traefik (auto Let's Encrypt)

Add labels to the `server` service in your override compose:
```yaml
  server:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.webscrape.rule=Host(`webscrape.example.com`)"
      - "traefik.http.routers.webscrape.entrypoints=websecure"
      - "traefik.http.routers.webscrape.tls.certresolver=letsencrypt"
      - "traefik.http.services.webscrape.loadbalancer.server.port=8080"
```

### Centralised logging (optional)

To pipe logs to [Seq](https://datalust.co/seq):

```bash
docker run -d --name seq --network <stack-network> \
  -e ACCEPT_EULA=Y -p 5340:80 -p 5341:5341 \
  datalust/seq:latest
```

Then in `.env.prod`:
```
Serilog__Seq__Enabled=true
Serilog__Seq__ServerUrl=http://seq:5341
```

Restart the server. Logs appear at `http://<host>:5340`.

## On first start

`InitialSeed` creates an admin user (`admin@local` / `admin123`) plus one demo `ScraperConfig` and one demo `Task` if no users exist. The seeded credentials are dev-only — change immediately in any non-throwaway deployment.
````

### Smoke step 7

1. `cd backend && docker compose build`. Build succeeds (multi-stage, ~250MB final image).
2. `docker compose up -d`. `db` and `server` healthy.
3. `curl -i http://localhost:5082/api/account/csrf`. Returns 204 + sets cookie.
4. Stop dev compose: `docker compose down`.
5. `cp .env.prod.example .env.prod` (edit), then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. Confirm `server` only has port 8080 exposed (not published).

### Verification

```
docker compose build  # all stages succeed
```

---

## Section 8 — Debug log gating in extension

### Why

Memory flags `[SW] *`, `[Offscreen] *`, `[SignalR] *` `console.log`s left in for M1 stabilisation. The extension already has a "debug" preference in `useSettingsStore` (toggled in [APISettingsView.tsx:244-252](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx#L244-L252) — currently only used for scrape-output enrichment). Reuse it.

`console.error` calls stay ungated — errors should always log.

### Files

#### 8a. New helper

**Create** `c:/Users/und3r/blueberry-v3/src/utils/debugLog.ts`:

```ts
// Runtime-toggled debug logger shared across extension contexts (SW, offscreen, sidepanel).
// Caches the pref read so dbg() is sync after the first ensureDebugInit().
// Call ensureDebugInit() once at module-load in each context. Subsequent toggles
// from APISettingsView are picked up via storage.onChanged below.

const PREFS_KEY = 'blueberry_scraper_prefs';
const PREF_NAME = 'debug';

let cached = false;
let initialised = false;

export async function ensureDebugInit(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    const prefs = (result[PREFS_KEY] as Record<string, unknown>) || {};
    cached = !!prefs[PREF_NAME];
  } catch { /* keep default false */ }

  // Pick up live toggles from the sidepanel without restarting the SW/offscreen.
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(PREFS_KEY in changes)) return;
      const newPrefs = (changes[PREFS_KEY].newValue as Record<string, unknown>) || {};
      cached = !!newPrefs[PREF_NAME];
    });
  } catch { /* not all contexts have storage.onChanged */ }
}

export function dbg(...args: unknown[]): void {
  if (cached) console.log(...args);
}
```

This replaces the per-context per-call log with a single `dbg(…)` whose `console.log` only fires when the pref is on. The sidepanel toggle propagates to SW + offscreen via `storage.onChanged`.

#### 8b. background.ts

**[src/entrypoints/background.ts](c:\Users\und3r\blueberry-v3\src\entrypoints\background.ts)**

Add import at the top of the file (line 1, before existing imports):
```ts
import { dbg, ensureDebugInit } from '../utils/debugLog';
```

Add init call at the start of `defineBackground` callback (line 11, immediately after the opening brace):
```ts
  ensureDebugInit();
```

Replace `console.log` lines:
- **Line 317**: `console.log('[SW] Relaying to offscreen:', type);` → `dbg('[SW] Relaying to offscreen:', type);`
- **Line 327**: `console.log('[SW] Relay response for', type, response);` → `dbg('[SW] Relay response for', type, response);`

Leave **all `console.error` calls untouched** (lines 76, 114, 186, 290, 331).

#### 8c. messageHandler.ts

**[src/offscreen/messageHandler.ts](c:\Users\und3r\blueberry-v3\src\offscreen\messageHandler.ts)**

Add import at top (line 3, after the existing import from `signalrConnection`):
```ts
import { dbg, ensureDebugInit } from '../utils/debugLog';
```

Add init call after the `hub` instantiation (line 5, before line 6):
```ts
ensureDebugInit();
```

Replace:
- **Line 6**: `console.log('[Offscreen] Loaded at', new Date().toISOString());` → `dbg('[Offscreen] Loaded at', new Date().toISOString());`
- **Line 14**: `console.log('[Offscreen] Got message', message.type, 'fromSW=', !!message._fromSW);` → `dbg('[Offscreen] Got message', message.type, 'fromSW=', !!message._fromSW);`

Leave `console.error` callbacks (lines 37, 42, 47, 52) untouched — those are inside `.catch(console.error)`.

#### 8d. signalrConnection.ts

**[src/offscreen/signalrConnection.ts](c:\Users\und3r\blueberry-v3\src\offscreen\signalrConnection.ts)**

Add import at top (line 3, after `signalR` and `QueueTask` imports):
```ts
import { dbg } from '../utils/debugLog';
```

(`ensureDebugInit` is called in messageHandler.ts, which loads first in the offscreen document — `signalrConnection.ts` inherits the cached state.)

Replace:
- **Line 79**: `console.log('[SignalR] Invoking RegisterWorker', { clientId, version, state: this.connection.state });` → `dbg('[SignalR] Invoking RegisterWorker', { clientId, version, state: this.connection.state });`
- **Line 81**: `.then(() => console.log('[SignalR] RegisterWorker succeeded'))` → `.then(() => dbg('[SignalR] RegisterWorker succeeded'))`

Leave **line 54** (`'[SignalR] RegisterWorker after reconnect failed:'` — passed to `console.error`) and **line 83** (`console.error('[SignalR] RegisterWorker failed:', err);`) untouched.

### Smoke step 8

1. Open the extension service worker DevTools console (`chrome://extensions` → "Inspect views: service worker").
2. With Debug pref OFF (default), trigger a queue-mode connect + task. No `[SW]`/`[Offscreen]`/`[SignalR]` logs appear. Errors (e.g. force a 401) still log.
3. Open sidepanel → API Settings → toggle "Show debug info in scrape output".
4. Trigger another task. Logs appear immediately (no extension reload needed) thanks to `storage.onChanged`.
5. Toggle off. Logs go silent again.

### Verification

```
cd c:/Users/und3r/blueberry-v3
npm run typecheck
npm run lint
npm run build
```

---

## Section 9 — `bb_jwt` → `bb_api_token` shim

### Why

Memory flags this as M5 polish: rename misleading legacy name (`bb_jwt` holds a PAT, not a JWT). Dual-read shim avoids breaking existing installs.

### Files

#### 9a. Storage helpers

**[src/sidepanel/utils/storage.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\utils\storage.ts)** — append after the existing `getStorageUsage` function (after line 124, before EOF):

```ts
// ── API token (PAT) — bb_jwt → bb_api_token migration ───────────────────────
//
// The chrome.storage key was originally `bb_jwt` (legacy name; it always held a
// PAT, never a real JWT). M5 renames to `bb_api_token`. This shim:
//   - getApiToken(): prefer new key; fall back to old; migrate on read.
//   - setApiToken(): write new key; clear old.
//   - clearApiToken(): clear both.
// One-release shim — drop the legacy fallback after users have had a chance to
// upgrade.

const TOKEN_KEY_NEW = 'bb_api_token';
const TOKEN_KEY_OLD = 'bb_jwt';

export async function getApiToken(): Promise<string | null> {
  try {
    const r = await browser.storage.local.get([TOKEN_KEY_NEW, TOKEN_KEY_OLD]);
    const fresh = r[TOKEN_KEY_NEW] as string | undefined;
    if (fresh) return fresh;
    const legacy = r[TOKEN_KEY_OLD] as string | undefined;
    if (legacy) {
      // Migrate-on-read: copy to the new key, then clear the old one so the
      // shim doesn't keep firing on every read.
      await browser.storage.local.set({ [TOKEN_KEY_NEW]: legacy });
      await browser.storage.local.remove(TOKEN_KEY_OLD).catch(() => {});
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setApiToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY_NEW]: token });
  await browser.storage.local.remove(TOKEN_KEY_OLD).catch(() => {});
}

export async function clearApiToken(): Promise<void> {
  await browser.storage.local.remove([TOKEN_KEY_NEW, TOKEN_KEY_OLD]);
}
```

#### 9b. APISettingsView wires through helpers

**[src/sidepanel/components/APISettingsView.tsx](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx)**

Update the import at line 6 to add the new helpers:
```ts
import { getPrefs, setPref, getApiToken, setApiToken, clearApiToken } from '../utils/storage';
```

Replace the mount-effect token loader (current lines 39–47):
```tsx
  useEffect(() => {
    const { serverUrl: url, setConnection: connect } = useSettingsStore.getState();
    getApiToken().then((saved) => {
      if (saved) {
        setTokenDraft(saved);
        connect(url, saved);
      }
    }).catch(() => {});

    getPrefs().then((prefs) => {
      setDebugEnabled(!!prefs.debug);
    }).catch(() => {});
  }, []);
```

Replace the save-handler token write (current line 77):
```tsx
      await setApiToken(tokenDraft);
```

Replace the clear-saved-token button onClick (current lines 231–236) — reuse the helper:
```tsx
            onClick={() => {
              useSettingsStore.getState().clearToken();
              setTokenDraft('');
              clearApiToken().catch(() => {});
              browser.runtime.sendMessage({ type: 'STOP_SIGNALR' }).catch(() => {});
            }}
```

After these edits, the literal string `'bb_jwt'` no longer appears anywhere in this file.

Run a sanity grep:
```
Grep -n "bb_jwt" src/
```

Expected matches: ZERO outside `src/sidepanel/utils/storage.ts` (the shim itself). If any remain, rewrite them through `getApiToken/setApiToken/clearApiToken`.

#### 9c. Tests

**Create** `c:/Users/und3r/blueberry-v3/src/__tests__/apiTokenShim.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getApiToken, setApiToken, clearApiToken } from '../sidepanel/utils/storage';

// In-memory mock of browser.storage.local for the tests.
type Store = Record<string, unknown>;

function mockStorage(): Store {
  const store: Store = {};
  globalThis.browser = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Store = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (obj: Store) => { Object.assign(store, obj); }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        }),
      },
    },
  } as unknown as typeof browser;
  return store;
}

describe('api token shim (bb_jwt → bb_api_token)', () => {
  beforeEach(() => {
    mockStorage();
  });

  it('returns null when neither key is set', async () => {
    expect(await getApiToken()).toBeNull();
  });

  it('reads from the new key when present', async () => {
    await browser.storage.local.set({ bb_api_token: 'wsk_new' });
    expect(await getApiToken()).toBe('wsk_new');
  });

  it('migrates from the legacy key on read and clears the old one', async () => {
    await browser.storage.local.set({ bb_jwt: 'wsk_legacy' });

    expect(await getApiToken()).toBe('wsk_legacy');

    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBe('wsk_legacy');
    expect(after.bb_jwt).toBeUndefined();
  });

  it('prefers the new key over the legacy one if both somehow exist', async () => {
    await browser.storage.local.set({ bb_api_token: 'wsk_new', bb_jwt: 'wsk_legacy' });
    expect(await getApiToken()).toBe('wsk_new');
  });

  it('setApiToken writes to the new key and clears the legacy one', async () => {
    await browser.storage.local.set({ bb_jwt: 'wsk_legacy' });
    await setApiToken('wsk_replacement');

    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBe('wsk_replacement');
    expect(after.bb_jwt).toBeUndefined();
  });

  it('clearApiToken removes both keys', async () => {
    await browser.storage.local.set({ bb_api_token: 'a', bb_jwt: 'b' });
    await clearApiToken();
    const after = await browser.storage.local.get(['bb_api_token', 'bb_jwt']);
    expect(after.bb_api_token).toBeUndefined();
    expect(after.bb_jwt).toBeUndefined();
  });
});
```

If `src/__tests__/` doesn't exist yet, place the file at the same path as a co-located `.test.ts` next to `storage.ts`: `src/sidepanel/utils/storage.apiToken.test.ts`. Keep whichever convention the existing test suite uses (check `vitest.config.ts` includes pattern).

### Smoke step 9

1. Install over an existing extension build that has `bb_jwt` set in `chrome.storage.local` (use DevTools "Application → Storage → Extension storage" to verify).
2. Open the sidepanel. Token field auto-populates from the legacy key.
3. Inspect storage again: `bb_api_token` is now set, `bb_jwt` is gone.
4. Re-paste a new token. Save. Inspect storage: only `bb_api_token` exists.
5. Click "Clear saved token". Inspect: both keys absent.

### Verification

```
cd c:/Users/und3r/blueberry-v3
npm run test  # new shim tests pass
npm run typecheck && npm run lint && npm run build
```

---

## Smoke checklist (whole spec)

After all 9 sections land, run end-to-end:

| # | Step | Pass criteria |
|---|---|---|
| 1 | `dotnet test` | 117 backend tests pass (114 existing + 3 worker presence; PAT rename adds 5 to ApiKeyServiceTests = 5 modified count) |
| 2 | `npm run test` (extension) | All vitest tests pass including new apiTokenShim |
| 3 | `npm run build` (extension) | Clean; bundle size unchanged ±5% |
| 4 | `npm run build` (backend frontend) | Clean; chunk-size warning for CodeMirror still expected |
| 5 | `dotnet ef database update` | Migration list unchanged from M4 (this spec adds none) |
| 6 | Boot fresh DB; log in `admin@local / admin123` | Lands on /tasks |
| 7 | `/api-keys` rename flow | Section 4 smoke step |
| 8 | `/workers` idle indicator | Section 5 smoke step |
| 9 | Seq sink optional | Section 6 smoke step |
| 10 | `docker compose build && up -d` | Section 7 smoke step |
| 11 | Debug log toggle | Section 8 smoke step |
| 12 | Token migration | Section 9 smoke step |

When all green, M5.1 ships. Theme 2 spec (`SPEC-M5.2-config-sync-v1.0.md`) and Theme 1 spec (`SPEC-M5.3-tree-ui-v1.0.md`) follow.

---

## Out of scope for M5.1

The following items are intentionally NOT in this spec:
- Config sync (Theme 2 — own spec)
- Tree UI / multi-scrape / nested loops (Theme 1 — own spec)
- Auto-detection (Theme 4 — flagged but deferred per user)
- Shared editor package between extension and backend (deferred per user)
- Multi-tenancy / org separation
- Public PAT-management API
- Heartbeat ping for never-idle worker indicator (memory-flagged: accept "Idle" as the idle state)

---

## Spec checksum

When complete:
- 9 PRs against `c:/Users/und3r/blueberry-v3` (master)
- ~810 LoC net (additions, mostly UI + tests)
- 0 EF migrations (Theme 2 introduces them)
- 0 breaking API changes (PAT rename is additive; WorkerDto.lastConnectedAt is additive)
- 0 schema changes (entity-level changes are AutoMapper-derivable)
