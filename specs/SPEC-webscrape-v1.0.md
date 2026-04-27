# WebScrape — Remote Job Queue & Backend for Blueberry-v3

**Status**: Stage A–F complete for M1 (with verified extension contract). M2–M5 sketched.

---

## Context

Today, blueberry-v3 is a self-contained browser extension. Configs are built in the sidepanel, run locally, results stay in the extension. The user wants to evolve this into a **remote-driven workflow**:

- A **.NET backend** (sibling architecture to `bbwt3` in [c:\Users\und3r\templating-system](c:\Users\und3r\templating-system)) called **WebScrape**, that owns task definitions, queues, runs, and results.
- A **React web UI** (separate dev process — handed off for hardening) for authoring tasks: a CodeMirror-based editor with a left-hand block tree (loop blocks containing scrape blocks), input wiring (`loop1.currentItem` style), populate-queue / run controls, extension selector, live progress, and a structured data viewer.
- The **extension** gains a "queue mode": instead of running locally, it registers as a worker, receives a batch of tasks pushed from the backend, executes them in sequence, streams progress, and pushes structured results back. Local mode keeps current behaviour.
- **PAT-based auth** between extension instances and the backend, with one PAT per extension install and a way to name each connection.
- New extension capabilities: `navigateTo` step, smarter `awaitUserAction` (only prompt when action is genuinely required — login walls, captchas), and Cloudflare pause/resume crossing the network boundary.

**Why this matters**: enables centralised job authoring, parallel/orchestrated runs across multiple extension instances, persistent result storage and visualisation outside the extension's `chrome.storage`, and remote operation — the user can queue a batch and walk away.

---

## Key findings from exploration

### Extension side ([c:\Users\und3r\blueberry-v3](c:\Users\und3r\blueberry-v3))

The skeleton for remote operation **already exists**:

- **SignalR client**: [src/entrypoints/offscreen/main.ts](c:\Users\und3r\blueberry-v3\src\entrypoints\offscreen\main.ts) + offscreen connection module — uses `@microsoft/signalr` v8, expects `${serverUrl}/api/scraper-hub` with Bearer token, listeners `ReceiveTask`/`ResumeAfterPause`/`CancelTask`, client invokes `RegisterWorker(clientId, extensionVersion)`. Auto-reconnect already wired.
- **Queue store**: [src/sidepanel/stores/queueStore.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\stores\queueStore.ts) — `QueueTask` type, pending/completed/failed stats, status mutators.
- **Queue tab**: already a tab in the sidepanel.
- **Settings tab**: already has API server URL + auth token fields.
- **Step types** ([src/types/config.ts](c:\Users\und3r\blueberry-v3\src\types\config.ts)): `setInput`, `click`, `bestMatch`, `goBack`, `scrape`, `selectEach`, `captureApiCalls`, `awaitUserAction` (already exists — pause until user signals continue).
- **Scraping engine** ([src/content/scraping/scrapingEngine.ts](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts)): step dispatcher, per-term loop, Cloudflare detection ([src/content/cloudflareDetector.ts](c:\Users\und3r\blueberry-v3\src\content\cloudflareDetector.ts)), `FLOW_PAUSED`/`FLOW_RESUMED` messaging, post-navigation continuation tracking.
- **What's missing**: backend isn't built; `awaitUserAction` always prompts (no smart detection); no `navigateTo` step; no two-way sync of configs; no result push protocol; queue tab is a stub.

### Backend reference ([c:\Users\und3r\templating-system](c:\Users\und3r\templating-system), bbwt3)

- **Stack**: .NET 9.0, ASP.NET Core MVC controllers, EF Core 9, Autofac, AutoMapper, Serilog, multi-DB (MySQL/Postgres/SQL Server).
- **Modular monolith** via `ModuleLinker` reflection: each module implements `IDependenciesModuleLinkage`, `ISignalRModuleLinkage`, `IDbModelCreateModuleLinkage`, etc.
- **Auth**: ASP.NET Core Identity + cookies (web) + JWT. **No PAT support today** — needs new entity + scheme handler.
- **SignalR**: 7 hubs in bbwt3, all registered via `ISignalRModuleLinkage.MapHubs(IEndpointRouteBuilder)`. Auth flows through `app.UseAuthentication()`; SignalR client passes Bearer via `accessTokenFactory`.
- **Tests**: xUnit + Moq + AutoFixture + Bogus, EF InMemory/SQLite for unit tests.

### Plan files in flight

- `chart-bridge-injection.md` — Stage A–E locked, Stage F pending. Independent bug fix; no overlap.
- `can-we-go-over-proud-alpaca.md` — internal scraping engine bug fixes; no overlap.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Phasing | 5 milestones; M1 detailed, M2–M5 sketched |
| Backend solution name | **WebScrape** (`WebScrape.sln`, projects `WebScrape.Server`, `WebScrape.Data`, `WebScrape.Services`, `WebScrape.Client`) |
| Frontend stack | React 18 + Vite + TypeScript (sibling to extension; dev to harden) |
| Database | PostgreSQL 16 (JSONB-native results) |
| PAT model | One PAT per extension install, user-named, no expiry, revocable |
| Deployment | Local Docker Compose only for M1 |
| Result storage | JSONB blob mirroring extension's existing `ScrapingResult` shape |
| Config sync | Hybrid — local-only configs allowed; `shared` flag opts a config into backend sync (backend = source of truth for shared configs) |

---

## Milestone overview

**M1 — End-to-end skeleton (the spine).** Detailed below. Proves the protocol with one hardcoded task flowing backend → extension → result.

**M2 — Task authoring.** Tasks page, block tree (loop + scrape), CodeMirror editor, scrape-config dropdown, input wiring, populate-queue + run, worker selector, basic progress display.

**M3 — Result viewer + history.** Persistent runs, structured cards (chart / table / text), run history, export.

**M4 — New extension steps + smart pause.** `navigateTo`, smart `awaitUserAction`, Cloudflare pause/resume across the network boundary.

**M5 — Polish.** Multi-worker presence/heartbeat, PAT management UI, config sync UX, error reporting, prod deployment notes.

---

# M1 — End-to-end skeleton (DETAILED)

**Goal**: a hardcoded task, seeded into the WebScrape DB, can be triggered from a one-button web UI, pushed via SignalR to a registered extension worker, executed, and the result persisted to Postgres as JSONB. Visible end-to-end.

**What's explicitly OUT of M1**:
- Task authoring UI (M2)
- Block trees, loops, CodeMirror (M2)
- Result viewer cards (M3)
- New step types or smart pause (M4)
- Multi-worker management (M5)

## M1.1 — Backend solution

### Solution layout

```
c:\Users\und3r\webscrape\
├── WebScrape.sln
├── docker-compose.yml
├── docker-compose.dev.yml
├── README.md
├── src/
│   ├── WebScrape.Server/         (ASP.NET Core host, controllers, hub, Program.cs)
│   ├── WebScrape.Services/       (business logic, services)
│   ├── WebScrape.Data/           (DbContext, entities, DTOs, AutoMapper profiles)
│   └── WebScrape.Client/         (React + Vite + TS frontend; served separately in dev)
└── tests/
    └── WebScrape.Tests/          (xUnit + Moq + AutoFixture)
```

**Conventions to mirror from bbwt3** (skip the modular `BBWM.*` plugin scaffolding for now — premature for M1; can refactor into modules in M5 if useful):

- Controllers inherit `Microsoft.AspNetCore.Mvc.ControllerBase`, attribute-routed `[Route("api/[controller]")]`.
- Serilog console + file sink configured in `Program.cs`.
- Autofac container builder for DI, services registered via `IServiceCollection` extensions per concern.
- AutoMapper profiles in `WebScrape.Data/Mapping/`.
- JSON: camelCase, `ReferenceHandler.IgnoreCycles`.

### NuGet packages (pinned)

**WebScrape.Server**:
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 9.0.*
- SignalR is part of `Microsoft.AspNetCore.App` (no separate package)
- `Npgsql.EntityFrameworkCore.PostgreSQL` 9.0.*
- `EFCore.NamingConventions` 9.0.* (for `UseSnakeCaseNamingConvention`)
- `Microsoft.EntityFrameworkCore.Design` 9.0.* (for `dotnet ef`)
- `Autofac.Extensions.DependencyInjection` 9.0.*
- `Serilog.AspNetCore` 9.0.*, `Serilog.Sinks.File` 6.0.*, `Serilog.Sinks.Console` 6.0.*
- `AutoMapper.Extensions.Microsoft.DependencyInjection` 12.0.*
- `Konscious.Security.Cryptography.Argon2` 1.3.* (PAT hashing)
- `AspNetCoreRateLimit` 5.0.* (rate limiting)

**WebScrape.Tests**:
- `xunit` 2.6.*, `xunit.runner.visualstudio` 2.5.*
- `Microsoft.NET.Test.Sdk` 17.*
- `Moq` 4.20.*
- `AutoFixture` 4.18.*, `AutoFixture.Xunit2` 4.18.*
- `Microsoft.EntityFrameworkCore.InMemory` 9.0.* (unit-test DbContext)
- `Microsoft.AspNetCore.Mvc.Testing` 9.0.* (integration tests)

### Run commands (pinned)

```bash
# from repo root
dotnet restore WebScrape.sln
dotnet build WebScrape.sln

# initial migration (after entities are written)
dotnet ef migrations add Initial \
    --project src/WebScrape.Data \
    --startup-project src/WebScrape.Server \
    --output-dir Migrations

# apply migrations (on a running Postgres)
dotnet ef database update \
    --project src/WebScrape.Data \
    --startup-project src/WebScrape.Server

# run server (dev)
dotnet run --project src/WebScrape.Server

# run tests
dotnet test tests/WebScrape.Tests
```

### Database schema (M1 minimum)

EF Core code-first. All tables `snake_case` (Postgres convention via `UseSnakeCaseNamingConvention()` from `EFCore.NamingConventions`).

```
users (ASP.NET Identity table — IdentityUser<Guid>)
roles (Identity)
user_roles (Identity)

api_keys
  id           uuid pk
  user_id      uuid fk → users.id
  name         text not null            -- user-friendly e.g. "My laptop"
  hash         text not null            -- argon2id hash of the raw token
  prefix       text not null            -- first 8 chars of token, plaintext, for display
  created_at   timestamptz not null
  last_used_at timestamptz null
  revoked_at   timestamptz null

scraper_configs
  id              uuid pk
  user_id         uuid fk → users.id
  name            text not null
  domain          text not null
  config_json     jsonb not null         -- the full ScraperConfig from the extension
  schema_version  int not null default 3
  created_at      timestamptz not null
  updated_at      timestamptz not null

tasks
  id                uuid pk
  user_id           uuid fk → users.id
  name              text not null
  scraper_config_id uuid fk → scraper_configs.id
  search_terms      text[] not null      -- M1: flat list; M2 introduces loop blocks
  created_at        timestamptz not null

worker_connections
  id                  uuid pk
  user_id             uuid fk → users.id
  name                text not null         -- chosen by user in extension settings
  api_key_id          uuid fk → api_keys.id
  current_connection  text null             -- current SignalR connection id, null if offline
  extension_version   text null
  last_connected_at   timestamptz null
  last_seen_at        timestamptz null

run_items
  id              uuid pk
  task_id         uuid fk → tasks.id
  worker_id       uuid fk → worker_connections.id
  status          text not null            -- 'pending' | 'sent' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  requested_at    timestamptz not null
  sent_at         timestamptz null
  started_at      timestamptz null
  completed_at    timestamptz null
  result_jsonb    jsonb null               -- mirrors extension ScrapingResult shape
  error_message   text null
  pause_reason    text null                -- e.g. 'cloudflare', 'awaitUserAction'
```

EF migrations folder: `src/WebScrape.Data/Migrations/`. Initial migration `0001_initial.cs` creates all the above.

### Auth — PAT scheme

**Identity setup** in `Program.cs` (must use `Guid` keys — extra config beyond default):

```csharp
services.AddIdentityCore<User>(opts =>
    {
        opts.Password.RequiredLength = 8;
        opts.Lockout.MaxFailedAccessAttempts = 5;
        opts.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
        opts.User.RequireUniqueEmail = true;
    })
    .AddRoles<IdentityRole<Guid>>()
    .AddEntityFrameworkStores<WebScrapeDbContext>()
    .AddSignInManager()
    .AddDefaultTokenProviders();

// Where:
public class User : IdentityUser<Guid> { /* extend later if needed */ }
```

**Entity** ([src/WebScrape.Data/Entities/ApiKey.cs](c:\Users\und3r\webscrape\src\WebScrape.Data\Entities\ApiKey.cs)):

```csharp
public class ApiKey
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string Hash { get; set; } = "";       // argon2id of raw token
    public string Prefix { get; set; } = "";     // first 8 chars of raw token (plaintext, indexed)
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public User? User { get; set; }
}
```

EF config: `entity.HasIndex(k => k.Prefix);` — required for fast lookup at validation time.

**Token format**: `wsk_` prefix + 32 random url-safe base64 chars from `RandomNumberGenerator.GetBytes(24)` → base64url. Total length 36. The `wsk_` prefix makes leaks scannable; the random part is 192 bits of entropy.

**Argon2id parameters** (OWASP 2024 baseline, balance security vs server CPU cost per validation):
- `Iterations = 3`
- `MemorySize = 65536` (64 MiB)
- `DegreeOfParallelism = 2`
- `HashLengthBytes = 32`
- `SaltLengthBytes = 16` (random per token)

Storage format: a single `text` column holding `$argon2id$v=19$m=65536,t=3,p=2$<saltB64>$<hashB64>` (PHC string format). Both [Konscious.Security.Cryptography.Argon2](https://github.com/kmaragon/Konscious.Security.Cryptography) and most argon2 libraries serialise/parse this directly.

**Generation flow**:
1. `POST /api/api-keys` with `{ name }`. Auth: cookie session + anti-forgery token.
2. Server generates 24 random bytes → base64url → prepend `wsk_` → token.
3. Hash with Argon2id (params above), store `ApiKey { hash, prefix = first 8 chars of token (i.e. `wsk_xxxx`), name, userId }`.
4. Return `{ id, name, prefix, token }` **once**. UI must show in a modal with "copy" + warning that the token can never be retrieved again.

**Validation handler** ([src/WebScrape.Server/Auth/PatAuthenticationHandler.cs](c:\Users\und3r\webscrape\src\WebScrape.Server\Auth\PatAuthenticationHandler.cs)):

Custom `AuthenticationHandler<PatAuthenticationOptions>`:
1. Extract token from `Authorization: Bearer <token>` header. **For SignalR WebSocket upgrade**, also check `?access_token=<token>` query param if the path matches `/api/scraper-hub`.
2. If token doesn't start with `wsk_`, return `AuthenticateResult.NoResult()` (let other schemes handle non-PAT auth).
3. `prefix = token[..8]`. Query `api_keys` where `prefix = @prefix AND revoked_at IS NULL`.
4. For each candidate row (usually 1; index ensures fast scan): `Argon2id.Verify(row.Hash, token)`. Use constant-time comparison inside the library.
5. On match: build `ClaimsPrincipal` with claims `[NameIdentifier = userId, Name = user.UserName, ApiKeyId = row.Id]`. Schedule a fire-and-forget update of `last_used_at` (debounced — only update if older than 1 minute, to avoid hammering DB on chatty hubs).
6. Return `AuthenticateResult.Success(ticket)`.
7. On no match across all candidates: `AuthenticateResult.Fail("Invalid token")`. **Do not log the token** — log only the prefix.

**Registration** in `Program.cs`:

```csharp
services.AddAuthentication()
    .AddCookie(IdentityConstants.ApplicationScheme, opts =>
    {
        opts.Cookie.Name = "ws_auth";
        opts.Cookie.HttpOnly = true;
        opts.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // Always in prod (M5)
        opts.Cookie.SameSite = SameSiteMode.Lax;                     // SPA on same origin
        opts.ExpireTimeSpan = TimeSpan.FromDays(14);
        opts.SlidingExpiration = true;
        opts.Events.OnRedirectToLogin = ctx =>                       // SPA: 401 instead of 302
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    })
    .AddScheme<PatAuthenticationOptions, PatAuthenticationHandler>("PAT", _ => { });

services.AddAuthorization(opts =>
{
    opts.DefaultPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .AddAuthenticationSchemes(IdentityConstants.ApplicationScheme, "PAT")
        .Build();
});

// Anti-forgery for cookie endpoints
services.AddAntiforgery(opts =>
{
    opts.HeaderName = "X-XSRF-TOKEN";
    opts.Cookie.Name = "XSRF-TOKEN";
    opts.Cookie.HttpOnly = false;          // SPA must read it
    opts.Cookie.SameSite = SameSiteMode.Lax;
});
```

Apply `[Authorize(AuthenticationSchemes = "PAT")]` to `ScraperHub`. Apply `[Authorize(AuthenticationSchemes = IdentityConstants.ApplicationScheme)]` + `[ValidateAntiForgeryToken]` to cookie-protected mutations.

### Rate limiting

`AspNetCoreRateLimit` configured in `appsettings.json`:

```json
{
  "IpRateLimiting": {
    "EnableEndpointRateLimiting": true,
    "GeneralRules": [
      { "Endpoint": "POST:/api/account/login", "Period": "15m", "Limit": 5 },
      { "Endpoint": "POST:/api/api-keys",      "Period": "1h",  "Limit": 10 },
      { "Endpoint": "*",                       "Period": "1m",  "Limit": 120 }
    ]
  }
}
```

SignalR hub is excluded from rate limiting (state-tracked via connection lifecycle).

### SignalR — `ScraperHub`

**Hub method signatures must match the extension's existing client code exactly.** Verified against [src/offscreen/messageHandler.ts](c:\Users\und3r\blueberry-v3\src\offscreen\messageHandler.ts) and [src/offscreen/signalrConnection.ts](c:\Users\und3r\blueberry-v3\src\offscreen\signalrConnection.ts):

- `RegisterWorker(string clientId, string extensionVersion)` — TWO string args
- `TaskProgress(TaskProgressDto payload)` — ONE payload arg
- `TaskComplete(TaskCompleteDto payload)` — ONE payload arg
- `TaskError(TaskErrorDto payload)` — ONE payload arg
- `TaskPaused(TaskPausedDto payload)` — ONE payload arg

Server→client: `ReceiveTask(QueueTaskDto)`, `ResumeAfterPause(string taskId)`, `CancelTask(string taskId)`.

[src/WebScrape.Server/Hubs/ScraperHub.cs](c:\Users\und3r\webscrape\src\WebScrape.Server\Hubs\ScraperHub.cs):

```csharp
[Authorize(AuthenticationSchemes = "PAT")]
public class ScraperHub : Hub
{
    private readonly IWorkerService _workers;
    private readonly IRunService _runs;

    public ScraperHub(IWorkerService workers, IRunService runs)
    {
        _workers = workers;
        _runs = runs;
    }

    public override async Task OnConnectedAsync()
    {
        var userId = GetUserId();
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        // Mark worker offline AND fail any in-flight run_items assigned to this connection.
        // The extension cannot resume mid-task in M1, so a disconnect during 'sent' or 'running'
        // is terminal for that run.
        await _workers.HandleDisconnectAsync(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    // ----- Client → Server -----

    // clientId is the user-chosen friendly name from extension Settings.
    public Task RegisterWorker(string clientId, string extensionVersion)
        => _workers.RegisterAsync(GetUserId(), GetApiKeyId(), clientId, extensionVersion, Context.ConnectionId);

    public Task TaskProgress(TaskProgressDto payload)
        => _runs.RecordProgressAsync(payload);

    public Task TaskComplete(TaskCompleteDto payload)
        => _runs.CompleteAsync(payload);

    public Task TaskError(TaskErrorDto payload)
        => _runs.FailAsync(payload);

    public Task TaskPaused(TaskPausedDto payload)
        => _runs.MarkPausedAsync(payload);

    private Guid GetUserId() => Guid.Parse(Context.User!.FindFirst(ClaimTypes.NameIdentifier)!.Value);
    private Guid GetApiKeyId() => Guid.Parse(Context.User!.FindFirst("ApiKeyId")!.Value);
}
```

**`WorkerService.HandleDisconnectAsync(connectionId)`**:
1. Find `worker_connections` row where `current_connection = @connectionId`. If none, return (already cleaned up).
2. Set `current_connection = NULL`, `last_seen_at = NOW()`.
3. Find all `run_items` where `worker_id = @workerId AND status IN ('sent', 'running', 'paused')`. Set each `status = 'failed'`, `error_message = 'Worker disconnected'`, `completed_at = NOW()`.
4. Single transaction.

**Server → Client invocations** are made from `RunService` via `IHubContext<ScraperHub>`:

```csharp
await _hub.Clients.Client(worker.CurrentConnection)
    .SendAsync("ReceiveTask", queueTaskDto, cancellationToken);
```

- `ReceiveTask(QueueTaskDto)` — sent on `POST /api/runs`.
- `ResumeAfterPause(string taskId)` — sent when user clicks "Resume" on a paused run (M4).
- `CancelTask(string taskId)` — sent when user cancels a run.

### Canonical `QueueTaskDto` (matches extension's `QueueTask`)

Verified from [src/types/signalr.ts:4-15](c:\Users\und3r\blueberry-v3\src\types\signalr.ts#L4-L15). The extension's `QueueTask` references a config by `configId`, NOT by inline payload. **For M1**, we extend additively with `inlineConfig` so the extension can run a task without a prior config sync (which lands properly in M5).

```csharp
public class QueueTaskDto
{
    public string Id { get; set; } = "";              // run_item id (string for JSON compatibility)
    public string ConfigId { get; set; } = "";        // scraper_config id
    public string ConfigName { get; set; } = "";
    public List<string> SearchTerms { get; set; } = new();
    public int Priority { get; set; }                 // 0 by default; M2 introduces priorities
    public DateTimeOffset CreatedAt { get; set; }
    public string Status { get; set; } = "pending";   // matches TS union
    public ScraperConfigDto? InlineConfig { get; set; } // M1 helper; extension caches into chrome.storage if not present locally
}
```

Corresponding TypeScript change (extend, don't break):

```ts
// src/types/signalr.ts
export interface QueueTask {
  id: string;
  configId: string;
  configName: string;
  searchTerms: string[];
  priority: number;
  createdAt: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  pausedReason?: 'cloudflare';
  result?: TaskResult;
  error?: string;
  inlineConfig?: ScraperConfig;   // ADDED — present on M1 incoming tasks
}
```

### Inbound payload DTOs (from extension)

These mirror [src/types/signalr.ts:17-58](c:\Users\und3r\blueberry-v3\src\types\signalr.ts#L17-L58) exactly. Field names are `camelCase` on the wire (matches the extension TS); C# uses `PascalCase` with `JsonNamingPolicy.CamelCase` doing the translation.

```csharp
public class TaskProgressDto
{
    public string TaskId { get; set; } = "";          // = run_item id
    public string ConfigId { get; set; } = "";
    public string CurrentTerm { get; set; } = "";
    public string CurrentStep { get; set; } = "";
    public int Progress { get; set; }                 // 0-100
    public string Phase { get; set; } = "loop";       // 'setup' | 'loop'
}

public class TaskCompleteDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public TaskResultDto Result { get; set; } = new();
    public DateTimeOffset CompletedAt { get; set; }
}

public class TaskResultDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string ConfigName { get; set; } = "";
    public string Status { get; set; } = "success";   // 'success' | 'failed' | 'paused'
    public JsonDocument Iterations { get; set; } = JsonDocument.Parse("[]");  // raw — stored as JSONB
    public JsonDocument? DataMapping { get; set; }
    public int TotalTimeMs { get; set; }
    public DateTimeOffset Timestamp { get; set; }
}

public class TaskErrorDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string Error { get; set; } = "";
    public string? StepLabel { get; set; }
    public DateTimeOffset FailedAt { get; set; }
}

public class TaskPausedDto
{
    public string TaskId { get; set; } = "";
    public string ConfigId { get; set; } = "";
    public string Reason { get; set; } = "cloudflare";  // M1: only cloudflare possible
    public string ChallengeType { get; set; } = "";
    public DateTimeOffset PausedAt { get; set; }
}
```

### REST API (M1 minimum)

`+CSRF` = `[ValidateAntiForgeryToken]`. Cookie auth uses `IdentityConstants.ApplicationScheme`.

| Method | Route | Auth | Body | Returns |
|---|---|---|---|---|
| `GET`  | `/api/account/csrf` | none | — | sets `XSRF-TOKEN` cookie; returns 204 |
| `POST` | `/api/account/login` | +CSRF | `{ email, password }` | sets `ws_auth` cookie; returns `{ id, email }` |
| `POST` | `/api/account/logout` | cookie+CSRF | — | 204 |
| `GET`  | `/api/account/me` | cookie | — | `{ id, email, name }` |
| `POST` | `/api/api-keys` | cookie+CSRF | `{ name }` | `{ id, name, prefix, token }` (token shown ONCE; never re-emitted) |
| `GET`  | `/api/api-keys` | cookie | — | `[{ id, name, prefix, createdAt, lastUsedAt, revokedAt }]` |
| `DELETE` | `/api/api-keys/{id}` | cookie+CSRF | — | 204 (sets `revoked_at`) |
| `GET`  | `/api/scraper-configs` | cookie or PAT | — | list |
| `POST` | `/api/scraper-configs` | cookie+CSRF or PAT | full config json | created |
| `PUT`  | `/api/scraper-configs/{id}` | cookie+CSRF or PAT | full config json | updated |
| `GET`  | `/api/tasks` | cookie | — | list |
| `POST` | `/api/tasks` | cookie+CSRF | `{ name, scraperConfigId, searchTerms[] }` | created |
| `GET`  | `/api/workers` | cookie | — | `[{ id, name, online, lastSeenAt, extensionVersion }]` (`online` = `current_connection IS NOT NULL`) |
| `POST` | `/api/runs` | cookie+CSRF | `{ taskId, workerId }` | see below |
| `GET`  | `/api/runs/{id}` | cookie | — | full run including `result_jsonb` |

**`POST /api/runs` algorithm** (handles offline-worker race):

1. Load worker. If `worker.UserId != currentUser.Id` → 403.
2. Load task. If `task.UserId != currentUser.Id` → 403.
3. If `worker.CurrentConnection IS NULL` → 409 Conflict, body `{ error: "Worker is offline" }`. Do NOT create the run.
4. Begin transaction.
5. Insert `run_item { task_id, worker_id, status: 'pending', requested_at: NOW() }` → `runItemId`.
6. Build `QueueTaskDto`:
   - `Id = runItemId`
   - `ConfigId = task.scraper_config_id`
   - `ConfigName, SearchTerms` from joined config + task
   - `InlineConfig` = the full `ScraperConfigDto` (M1 helper; M5 removes once sync exists)
7. Try `_hub.Clients.Client(worker.CurrentConnection).SendAsync("ReceiveTask", dto)`. SignalR send is fire-and-forget; success means accepted into the buffer, not yet delivered.
8. Update `run_item.status = 'sent'`, `sent_at = NOW()`. Commit.
9. Return `201 Created`, body `{ runItemId }`.
10. If step 7 throws (e.g. worker disconnected between checks) → catch, set `status = 'failed'`, `error_message = 'Worker disconnected before task could be sent'`, commit. Return `502 Bad Gateway`, body `{ runItemId, error }`.

**Initial seed** ([src/WebScrape.Server/Seed/InitialSeed.cs](c:\Users\und3r\webscrape\src\WebScrape.Server\Seed\InitialSeed.cs)): on first startup, if no users exist, create one admin user (`admin@local` / `admin`) and one demo `ScraperConfig` + one demo `Task` with two search terms. Lets M1 verification skip ahead to the interesting bit.

### Files to create (M1 backend)

```
src/WebScrape.Server/
  Program.cs
  appsettings.json, appsettings.Development.json
  Auth/
    PatAuthenticationHandler.cs
    PatAuthenticationOptions.cs
  Controllers/
    AccountController.cs
    ApiKeysController.cs
    ScraperConfigsController.cs
    TasksController.cs
    WorkersController.cs
    RunsController.cs
  Hubs/
    ScraperHub.cs
  Seed/
    InitialSeed.cs

src/WebScrape.Services/
  Interfaces/
    IApiKeyService.cs
    IWorkerService.cs
    IRunService.cs
    IScraperConfigService.cs
    ITaskService.cs
  Implementations/
    ApiKeyService.cs        (generate, hash, validate, list, revoke)
    WorkerService.cs        (register, mark connected/disconnected, list)
    RunService.cs           (create, dispatch via hub, record progress/complete/fail/pause)
    ScraperConfigService.cs (CRUD)
    TaskService.cs          (CRUD)

src/WebScrape.Data/
  WebScrapeDbContext.cs
  Entities/
    ApiKey.cs
    ScraperConfigEntity.cs
    TaskEntity.cs
    WorkerConnection.cs
    RunItem.cs
  DTO/
    ApiKeyDto.cs, CreateApiKeyResponseDto.cs
    ScraperConfigDto.cs
    TaskDto.cs, CreateTaskDto.cs
    WorkerDto.cs
    RunItemDto.cs, CreateRunDto.cs
    QueueTaskDto.cs         (must match extension QueueTask shape)
  Mapping/
    AutoMapperProfile.cs
  Migrations/
    0001_initial.cs

tests/WebScrape.Tests/
  ApiKeyServiceTests.cs     (token generation roundtrip, hash verify, revoke)
  PatAuthenticationHandlerTests.cs (valid token → 200, revoked → 401, malformed → 401)
  RunServiceTests.cs        (create dispatches over IHubContext mock; complete persists JSONB)
```

## M1.2 — Extension changes

Files to modify; the SignalR scaffold already exists — these changes wire it through to working state.

### Stage C — UI/styling for new Settings additions

The new Settings fields must use existing tokens and classes from [src/sidepanel/styles/index.css](c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css). No new CSS. No inline styles. No new colour values.

| New element | Existing class to use | Notes |
|---|---|---|
| Mode toggle (Local / Queue) | `.radio-pill-group` + `.radio-pill` (+ `.radio-pill-active`) | Two pills side-by-side; matches existing pattern |
| Connection name input | `.form-group` + `.form-label` + `.form-input` + `.form-hint` | Standard text field |
| Connection status row | `.status-dot` + `.status-dot.success`/`.error`/`.pending` + `.text-sm` | Reuse the existing pattern at [APISettingsView.tsx:84](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx#L84) |
| Save / clear buttons | `.btn` `.btn-primary` / `.btn-secondary` / `.btn-ghost` `.btn-sm` | As today |

User-facing copy (informal, non-technical, actionable):
- Mode toggle labels: `Local` / `Queue`. Hint below: `Local runs jobs you trigger here. Queue listens for jobs sent from your backend.`
- Connection name label: `Worker name`. Hint: `What this browser shows up as in your backend (e.g. "Office laptop").`
- Status text: `Not connected` / `Connecting…` / `Connected` / `Reconnecting (attempt N)…` / `Couldn't connect: <reason>`.
- PAT field hint update: `Paste the access token from your backend's API Keys page. It's stored locally and never synced.`

### [src/sidepanel/components/APISettingsView.tsx](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx)

This is the file (not `SettingsTab.tsx` as previously misnamed). Existing fields: `serverUrl`, `jwtToken` (will hold the PAT now — see migration note below), test/save buttons, debug toggle.

Add (in this order, above the debug toggle):

1. **Worker name** — `.form-group` with `.form-input`. Bound to `useSettingsStore().workerName`. Default value: `'My Browser'`.
2. **Mode** — `.radio-pill-group` with two `.radio-pill` (`Local` selected by default, `Queue`). Bound to `useSettingsStore().mode`.
3. **Connection status** — only visible when `mode === 'queue'`. Reuses existing `.status-dot` markup at line 84 but with a richer label (see copy above).

Submit handler change: when the user saves with `mode === 'queue'`, also send an `INIT_SIGNALR` message to the offscreen document with `{ serverUrl, token, clientId: workerName }`. When `mode === 'local'`, send `STOP_SIGNALR`.

### [src/sidepanel/stores/settingsStore.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\stores\settingsStore.ts)

Extend the persisted state:

```ts
interface SettingsState {
  serverUrl: string;
  jwtToken: string;              // legacy field name, now holds PAT
  connected: boolean;
  lastConnectionError: string | null;
  pauseOnCloudflare: boolean;
  // NEW:
  mode: 'local' | 'queue';       // default 'local'
  workerName: string;            // default 'My Browser'
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

  setMode: (mode: 'local' | 'queue') => void;
  setWorkerName: (name: string) => void;
  setConnectionStatus: (status: SettingsState['connectionStatus']) => void;
  // existing setters unchanged
}
```

`partialize` to add `mode` and `workerName` to localStorage persistence (token stays in `chrome.storage.local`).

### [src/offscreen/messageHandler.ts](c:\Users\und3r\blueberry-v3\src\offscreen\messageHandler.ts) and [src/offscreen/signalrConnection.ts](c:\Users\und3r\blueberry-v3\src\offscreen\signalrConnection.ts)

**Bug fix (existing code is broken for WS upgrade):** `signalrConnection.ts` uses `headers: { Authorization: 'Bearer ...' }`. Browsers cannot send custom headers during WebSocket upgrade. Replace with `accessTokenFactory` so the token is sent via `Authorization` header on the negotiate HTTP request AND as `?access_token=` query string on the WS upgrade:

```ts
this.connection = new signalR.HubConnectionBuilder()
  .withUrl(`${serverUrl}/api/scraper-hub`, {
    accessTokenFactory: () => token,
  })
  .withAutomaticReconnect({ /* unchanged */ })
  .configureLogging(signalR.LogLevel.Warning)
  .build();
```

Add a new message type `STOP_SIGNALR` to `messageHandler.ts` that calls `hub.disconnect()`.

Add forwarding of `connectionStatus` updates to the sidepanel via `browser.runtime.sendMessage({ type: 'CONNECTION_STATUS', payload: { status, error? } })`. The sidepanel listener writes to `useSettingsStore().setConnectionStatus(...)`.

### [src/entrypoints/background.ts](c:\Users\und3r\blueberry-v3\src\entrypoints\background.ts)

Wire the `ReceiveTask` flow end-to-end. The existing offscreen relay sends `{ type: 'TASK_RECEIVED', payload: QueueTask }` to the background. Background must:

1. On `TASK_RECEIVED`:
   - If `payload.inlineConfig` is present and the corresponding `configId` is not in local storage, persist it to `chrome.storage.local` via [src/sidepanel/utils/storage.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\utils\storage.ts).
   - Open or focus a tab at `payload.inlineConfig?.url ?? <lookup local config>.url`.
   - Wait for `tab.status === 'complete'` then send `EXECUTE_FLOW` to the content script with `{ config, searchTerms: payload.searchTerms, taskId: payload.id, configId: payload.configId }`.
2. On `FLOW_PROGRESS` from content (per-step): forward to offscreen as `SEND_TASK_PROGRESS` with a `TaskProgress` payload built per [src/types/signalr.ts:17-24](c:\Users\und3r\blueberry-v3\src\types\signalr.ts#L17-L24).
3. On `FLOW_COMPLETE`: build `TaskComplete` payload with the full `TaskResult` shape (see [signalr.ts:26-58](c:\Users\und3r\blueberry-v3\src\types\signalr.ts#L26-L58)). Forward as `SEND_TASK_COMPLETE`.
4. On `FLOW_ERROR`: build `TaskError` payload, forward as `SEND_TASK_ERROR`.
5. On `FLOW_PAUSED` (Cloudflare): build `TaskPaused`, forward as `SEND_TASK_PAUSED`. (Resume across the network is M4; for M1 the user solves it in-browser and the engine auto-resumes locally — the backend just shows `paused` then `running` then `completed`.)

For M1: exactly one `TASK_RECEIVED` in flight at a time. If a second arrives while busy, push to `queueStore` as `pending`; drain in arrival order when the active one completes.

### Chrome storage key migration

Existing token key: `bb_jwt` ([APISettingsView.tsx:20](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx#L20)). The value will now be a PAT (`wsk_…`) instead of a JWT.

- Keep the storage key `bb_jwt` for M1 — no migration code needed; it's just a token string and the new format coexists.
- M5 polish task: rename to `bb_api_token` with one-release dual-read shim.

New keys (no migration; these don't exist today):
- Settings store fields `mode` and `workerName` are persisted by Zustand `partialize` to localStorage under `bb-settings` (the existing key).
- No new `chrome.storage.local` keys.

### Result push — exact `TaskResult` shape sent to backend

The extension already produces an `IterationResult[]` from [scrapingEngine.ts](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts). Background wraps it into the `TaskResult` shape from [signalr.ts:49-58](c:\Users\und3r\blueberry-v3\src\types\signalr.ts#L49-L58):

```ts
const taskResult: TaskResult = {
  taskId: payload.id,
  configId: payload.configId,
  configName: payload.configName,
  status: scrapingResult.abortedEarly ? 'failed' : 'success',
  iterations: scrapingResult.iterations,
  dataMapping: config.dataMapping,
  totalTimeMs: scrapingResult.totalDurationMs,
  timestamp: new Date().toISOString(),
};
const taskComplete: TaskComplete = {
  taskId: payload.id,
  configId: payload.configId,
  result: taskResult,
  completedAt: new Date().toISOString(),
};
// → SEND_TASK_COMPLETE, hub.invoke('TaskComplete', taskComplete)
```

Backend stores `taskResult` (the inner object) as `run_items.result_jsonb`. Querying inside lands in M3.

## M1.3 — Frontend (React, M1 minimum)

**Scope boundary**: M1 ships only the pages needed to drive the M1.5 verification script. The dev hands off and rebuilds/styles M2+. Sonnet implements these five pages with zero invented features.

**Stack** (pinned):
- Vite 5 + React 18 + TypeScript 5
- React Router 6 (data router style)
- TanStack Query 5 (REST fetch caching)
- Tailwind 3 (utility-first; no component library for M1)
- `@microsoft/signalr` 8.x (only used in `/runs/{id}` page to receive live updates from a UI-side hub method — see below)
- `axios` for HTTP (CSRF interceptor)

**Pages** (file paths under `src/WebScrape.Client/src/pages/`):

| Path | File | Behaviour |
|---|---|---|
| `/login` | `Login.tsx` | Email + password form. POST to `/api/account/login` after fetching `/api/account/csrf`. On success, navigate to `/tasks`. |
| `/api-keys` | `ApiKeys.tsx` | TanStack Query for `GET /api/api-keys`. Create button → modal → POST → display returned `token` ONCE in a "copy now" panel with red warning. Revoke action with confirmation. |
| `/workers` | `Workers.tsx` | TanStack Query, `refetchInterval: 5000`. Render `name`, `online` dot, `lastSeenAt`, `extensionVersion`. |
| `/tasks` | `Tasks.tsx` | TanStack Query for `GET /api/tasks`. Each row has "Run on…" button → opens a worker dropdown (online-only) → on confirm, POST `/api/runs` → navigate to `/runs/{runItemId}`. |
| `/runs/:id` | `RunDetail.tsx` | TanStack Query, `refetchInterval: 1000` (M1: polling, not SignalR). Shows status, progress %, current step, error if any, and `<pre>{JSON.stringify(result_jsonb, null, 2)}</pre>` when complete. |

**App shell** (`App.tsx`): Tailwind layout with sidebar nav (links to Tasks / Workers / API Keys / Logout). Auth gate redirects to `/login` on 401.

**HTTP setup** (`src/api/client.ts`):
- Base URL `/` (Vite dev proxy forwards `/api` and `/api/scraper-hub` to `http://localhost:5000`).
- `withCredentials: true` (cookies).
- Request interceptor: copy `XSRF-TOKEN` cookie value into `X-XSRF-TOKEN` header for unsafe methods.
- Response interceptor: on 401, clear React Query cache and redirect to `/login`.

**Vite dev proxy** (`vite.config.ts`):
```ts
server: {
  proxy: {
    '/api': { target: 'http://localhost:5000', changeOrigin: true, ws: true },
  },
},
```

**Out of M1 frontend**: design polish, dark mode, empty states beyond a single line, loading skeletons, optimistic updates, animations. Dev does these in hardening.

## M1.4 — Docker Compose

[c:\Users\und3r\webscrape\docker-compose.yml](c:\Users\und3r\webscrape\docker-compose.yml):

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: webscrape
      POSTGRES_USER: webscrape
      POSTGRES_PASSWORD: webscrape
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  server:
    build: ./src/WebScrape.Server
    depends_on: [db]
    environment:
      ConnectionStrings__Default: "Host=db;Database=webscrape;Username=webscrape;Password=webscrape"
      ASPNETCORE_ENVIRONMENT: Development
    ports: ["5000:8080"]
volumes:
  pgdata:
```

Frontend runs separately during dev: `cd src/WebScrape.Client && npm run dev` → `http://localhost:5173`, proxies `/api` and `/api/scraper-hub` to `http://localhost:5000`.

## M1.4b — Stage D: Security review

| # | Risk | Mitigation in M1 | Deferred |
|---|---|---|---|
| 1 | Brute-force on `/api/account/login` | AspNetCoreRateLimit: 5 req / 15 min / IP. Identity lockout: 5 fail → 15 min lock. Generic error message ("Invalid credentials"). | — |
| 2 | Brute-force on PAT validation | Argon2id with `t=3, m=64MiB, p=2` (~150ms/validation) makes online brute-force infeasible. Indexed `prefix` lookup keeps legitimate validation fast (one hash op per request). | — |
| 3 | Token leak in URLs / logs (SignalR `?access_token=`) | Configure Serilog request-logging enricher to redact `access_token` query param. Document the residual risk (proxy logs, browser history) — acceptable for local dev. | M5: evaluate negotiate-with-cookie pattern |
| 4 | CSRF on cookie endpoints | ASP.NET Core anti-forgery: `XSRF-TOKEN` cookie + `X-XSRF-TOKEN` header. Frontend axios interceptor sets the header from the cookie. PAT-only endpoints (no cookie auth) are immune. | — |
| 5 | Token retrievable after creation | Server returns raw token ONCE in `POST /api/api-keys` response. Hash-only storage. UI modal forces explicit copy with warning. | — |
| 6 | Unauthenticated SignalR connections | Hub is `[Authorize(AuthenticationSchemes = "PAT")]`. Reject at handshake — no anonymous group join. | — |
| 7 | Cross-user task dispatch | `POST /api/runs` checks `worker.UserId == currentUser.Id` AND `task.UserId == currentUser.Id`. Hub `RegisterWorker` claims user from PAT principal — workers cannot impersonate other users. | — |
| 8 | XSS in result viewer | M1 displays results as `<pre>{JSON.stringify}</pre>` (escaped by React). M3 introduces structured cards — must keep React's default escaping; never `dangerouslySetInnerHTML`. | M3: re-review when chart/table/text cards land |
| 9 | Data exposure (results in JSONB) | Result rows scoped to user via task → user_id join. All `GET /api/runs` queries filtered by `currentUser.Id`. | — |
| 10 | TLS / HTTPS | M1 is localhost-only Docker Compose; plain HTTP is acceptable. Document explicitly: **do not expose this beyond localhost without TLS**. | M5: hardened prod Dockerfile + reverse proxy with TLS |
| 11 | Dependency CVEs | `dotnet list package --vulnerable --include-transitive` and `npm audit` in CI from M1 onward. | — |
| 12 | Secrets in repo | `appsettings.Development.json` git-ignored; `appsettings.Development.json.template` committed. Docker-compose passwords are dev-only and in a separate `.env` file (also git-ignored). | — |

**No new attack surface beyond items above.** Logging policy: never log raw token, only the prefix (`wsk_xxxx`).

## M1.5 — Verification

**Automated tests** (must all pass before M1 ships):

Backend xUnit, in `tests/WebScrape.Tests/`:

| File | Cases |
|---|---|
| `ApiKeyServiceTests.cs` | Generate token → hash → verify same token returns true; tampered token returns false; revoked key returns false; prefix is correctly extracted (`wsk_` + 4 chars). |
| `PatAuthenticationHandlerTests.cs` | Valid Bearer header → Success with correct claims; valid `?access_token=` query for hub path → Success; non-`wsk_` prefix → NoResult; revoked token → Fail; unknown prefix → Fail; mangled token → Fail; `last_used_at` updated only after 1-min debounce. |
| `RunServiceTests.cs` | `CreateAndDispatchAsync` with online worker → row created `status='sent'`, `IHubContext.Clients.Client(connId).SendAsync("ReceiveTask", dto)` invoked once. With offline worker → 409 result, no row. With hub send throwing → row marked `failed`, returns 502 result. |
| `WorkerServiceTests.cs` | `RegisterAsync` sets `current_connection`, `last_connected_at`. `HandleDisconnectAsync` clears connection AND fails any `sent`/`running`/`paused` run_items for that worker. |
| `RunsControllerTests.cs` (integration via `WebApplicationFactory`) | Cross-user dispatch → 403. Anti-forgery missing → 400. Happy path → 201. |

Extension Vitest, in `src/__tests__/`:

| File | Cases |
|---|---|
| `remoteTaskHandler.test.ts` | Pure function that maps a `QueueTask` → `EXECUTE_FLOW` payload: with `inlineConfig` present, returns the inline; without, looks up local config; throws `ConfigNotFoundError` if neither. |
| `flowEventToHubPayload.test.ts` | Maps `FLOW_PROGRESS` / `FLOW_COMPLETE` / `FLOW_ERROR` / `FLOW_PAUSED` content events into the canonical `TaskProgress` / `TaskComplete` / `TaskError` / `TaskPaused` shapes from [src/types/signalr.ts](c:\Users\und3r\blueberry-v3\src\types\signalr.ts). |

Run: `dotnet test tests/WebScrape.Tests` and `cd c:\Users\und3r\blueberry-v3 && npm run test`.

**Manual end-to-end script** (M1 acceptance gate — every step must hold):

1. `cd c:\Users\und3r\webscrape && docker compose up -d` → both `db` and `server` healthy (`docker compose ps`).
2. `cd src/WebScrape.Client && npm install && npm run dev` → frontend at `http://localhost:5173`.
3. Open frontend, log in as `admin@local` / `admin`. Should land on `/tasks`.
4. Navigate to `/api-keys`. Click "Create". Enter name `Local Chrome`. Modal shows token starting `wsk_…`. Copy. Click acknowledge. Modal closes. List shows the new key with `prefix = wsk_xxxx`, `lastUsedAt = null`.
5. Reload the API Keys page. Token is NOT shown again — only prefix.
6. Open the extension sidepanel → API Settings view (existing). Set server URL `http://localhost:5000`. Paste the PAT. Set worker name `Local Chrome`. Set mode to `Queue`. Save.
7. Status row in Settings within 3s shows `Connected`. The dot is green.
8. Frontend `/workers` (refresh): `Local Chrome` row appears, online dot, `extensionVersion` populated, `lastSeenAt` is recent.
9. Frontend `/tasks`: click "Run on…" on the seeded task, select `Local Chrome`, confirm. Browser navigates to `/runs/<id>`.
10. Run page (polling 1s): status sequence `pending` (briefly) → `sent` → `running` → `completed`. Progress increments. Final JSON renders in `<pre>`.
11. Hit refresh on the run page. JSON still there (loaded from Postgres `result_jsonb`).
12. In `/api-keys`, observe `lastUsedAt` for the PAT is now recent.
13. Toggle extension mode back to `Local`, save. Within 10s, `/workers` shows the worker as offline.
14. Toggle back to `Queue`. Within 3s, online again. Run another task — succeeds.
15. In `/api-keys`, revoke the PAT. The extension's existing connection drops within ~5s (next ping fails). Settings status shows `Couldn't connect: Invalid token`. New connection attempts fail.
16. (Negative) From frontend, try POST `/api/runs` for a worker belonging to another user (manually construct via DevTools): expect 403.

**Edge cases — explicit decisions**:

| Case | Decision | Rationale |
|---|---|---|
| Token revoked mid-connection | *Cover*. Hub doesn't know — handler doesn't re-check during the connection. Acceptable for M1; next reconnect will fail. The demo flow proves the rejection on reconnect (step 15). | Per-message re-validation is expensive; existing connection is at most ~hours old. |
| Extension reconnect mid-task | *Cover*. `OnDisconnectedAsync` marks in-flight runs `failed` with `'Worker disconnected'`. M1 has no cross-disconnect resume. | Resume is M4 (with persistent task continuation state). |
| Cloudflare during the demo task | *Ignore (M4)*. The seeded task targets a local fixture page with no Cloudflare. | Pause across-the-network is M4. |
| Two workers with same `workerName` | *Ignore (M5)*. Allowed; separate `worker_connections` rows by `id`. UI shows both. | Disambiguation UI is polish. |
| Concurrent `POST /api/runs` to same worker | *Cover*. Backend dispatches both; extension queues internally (`queueStore`); FIFO drain. | Already handled by extension's queue store. |
| Frontend offline (no network) during run | *Ignore*. Polling resumes when network returns; backend still receives results from extension. | Frontend is observer; backend is source of truth. |
| Postgres restart mid-run | *Ignore (M5)*. Likely to fail in-flight writes; future work to retry. | Out of scope for skeleton. |

---

# M2 — Task authoring (sketch)

**Goal**: replace the seeded hardcoded task with full UI authoring. Loop blocks, scrape blocks, input wiring, queue population.

**Backend changes**:
- New tables: `task_blocks` (id, task_id, parent_block_id nullable, block_type ENUM('loop','scrape'), order_index, config_jsonb).
- `tasks` loses its flat `search_terms` column; replaced by a root loop block.
- `POST /api/tasks/{id}/populate` expands loop blocks → creates pending `run_items` for each iteration.

**Frontend changes**:
- Tasks list page (CRUD).
- Task editor: split pane, left = block tree (drag-drop reorder, add loop / add scrape), right = CodeMirror 6 with the selected block's config. Scrape block config has a dropdown of saved `scraper_configs`; selecting one populates the placeholder for required steps with placeholders the user fills with literals or expressions like `{{loop1.currentItem}}`.
- Populate Queue button → preview of expanded jobs.
- Run button → POST `/api/runs/batch`.
- Worker dropdown sourced from `/api/workers` (online only).

**Extension changes**: none beyond M1; extension still receives one `QueueTask` at a time. The expansion lives on the backend.

---

# M3 — Result viewer + history (sketch)

**Goal**: structured result display, run history, export.

**Backend changes**:
- Indexes on `run_items(task_id, requested_at desc)`, `run_items(status)`.
- Optional: extracted columns for common queries (iteration count, term).
- `GET /api/runs?taskId=&status=&from=&to=` paginated.
- `GET /api/runs/{id}/export?format=json|csv`.

**Frontend changes**:
- Run history page with filters.
- Result viewer that walks `iterations[].extractedData[]` and dispatches per element type:
  - `chart` → render via Recharts/Plotly from the extracted series data.
  - `table` → tabular render with sort/filter.
  - `text` / `pageBlock` → formatted card.
- Export button.

---

# M4 — New extension steps + smart pause (sketch)

**Goal**: `navigateTo` step, smarter `awaitUserAction`, Cloudflare pause/resume across the network.

**Extension changes**:
- New step type `navigateTo` ([src/types/config.ts](c:\Users\und3r\blueberry-v3\src\types\config.ts)) with `{ url: string }` options. Engine handler does `window.location.href = url; await navigationContinuation();`.
- `awaitUserAction` gains optional `detectionRules: { loginWall?: boolean; captcha?: boolean; selector?: string }`. Engine checks rules first; only emits `FLOW_PAUSED` and waits if a rule fires. Otherwise the step is a no-op.
- Login wall detection: presence of `input[type=password]` + visible submit on the same form, or known SSO redirects.
- Captcha detection: existing Cloudflare detector + reCAPTCHA / hCaptcha sitekey presence.
- Cloudflare pause already emits `FLOW_PAUSED`. M4 wires that to backend `TaskPaused('cloudflare', { challengeType })`. Backend updates `run_items.status='paused'`. UI surfaces a "Worker is paused, please solve the challenge in your browser" banner; once cleared (extension already auto-detects), extension fires `FLOW_RESUMED` → `TaskProgress` resumes.

**Backend changes**:
- `run_items.status='paused'` displayed in UI.
- Optional `POST /api/runs/{id}/resume` if the user wants to manually unblock.

---

# M5 — Polish (sketch)

- Multi-worker selection with presence/heartbeat indicators (already mostly there from M1; refine staleness handling).
- PAT management UI: rename, revoke with confirmation, last-used display.
- Config sync UX: per-config `shared` toggle in extension; sync indicator (✓ synced / ⟳ pending / ⚠ conflict).
- Conflict resolution: last-write-wins by default; show diff if `updated_at` mismatch on push.
- Error reporting: Serilog → file + optional Seq sink.
- Hardened production Dockerfile + deployment notes.
- Refactor backend into `BBWM.*`-style modules if useful.

---

## Critical files to read before implementation

Before writing M1 code, the implementing agent must read these in order:

**Extension (read first; the plan's contract is anchored to these):**
- [src/types/signalr.ts](c:\Users\und3r\blueberry-v3\src\types\signalr.ts) — `QueueTask`, `TaskProgress`, `TaskComplete`, `TaskError`, `TaskPaused`, `TaskResult` (the source of truth for hub payloads).
- [src/types/config.ts](c:\Users\und3r\blueberry-v3\src\types\config.ts) — `ScraperConfig`, `Step` discriminated union, `IterationResult`.
- [src/offscreen/signalrConnection.ts](c:\Users\und3r\blueberry-v3\src\offscreen\signalrConnection.ts) — existing client (note the headers→accessTokenFactory bug fix needed).
- [src/offscreen/messageHandler.ts](c:\Users\und3r\blueberry-v3\src\offscreen\messageHandler.ts) — message routing into the hub.
- [src/sidepanel/stores/queueStore.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\stores\queueStore.ts) — `QueueTask` state model.
- [src/sidepanel/stores/settingsStore.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\stores\settingsStore.ts) — to extend with `mode`, `workerName`, `connectionStatus`.
- [src/sidepanel/components/APISettingsView.tsx](c:\Users\und3r\blueberry-v3\src\sidepanel\components\APISettingsView.tsx) — file to edit (NOT `SettingsTab.tsx`).
- [src/sidepanel/styles/index.css](c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css) — design tokens; new UI must reuse existing classes.
- [src/content/scraping/scrapingEngine.ts](c:\Users\und3r\blueberry-v3\src\content\scraping\scrapingEngine.ts) — `executeFlow` signature, `FLOW_*` message names, `ScrapingResult` shape.
- [src/sidepanel/utils/storage.ts](c:\Users\und3r\blueberry-v3\src\sidepanel\utils\storage.ts) — `chrome.storage` key conventions.

**Backend reference (bbwt3 conventions):**
- [c:\Users\und3r\templating-system\project\BBWT.Server\Program.cs](c:\Users\und3r\templating-system\project\BBWT.Server\Program.cs) and `Startup.cs` — host setup, auth pipeline, SignalR wiring (don't copy the modular linker pattern for M1; refactor into modules in M5).
- [c:\Users\und3r\templating-system\project\BBWT.Server\Controllers\AccountApiController.cs](c:\Users\und3r\templating-system\project\BBWT.Server\Controllers\AccountApiController.cs) — controller convention.
- Any existing hub in bbwt3 (e.g. `BBWM.DataProcessing/Classes/DataImportHub.cs`) — registration pattern.

## Out of scope for the entire roadmap

- Multi-tenancy / org separation.
- API versioning beyond v1.
- Public PAT-management API (everything goes through the web UI).
- Mobile app.
- Captcha auto-solving.
