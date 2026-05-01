# SPEC-webscraper-module-v1.1

**Feature:** Port the WebScrape backend into `BBWM.WebScraper` — a self-contained, drop-in BBWT3 module
**Source repo:** `c:\Users\und3r\webscrape`
**Local validation rig:** `c:\Users\und3r\pharmacy-planet` (NOT a real install target — local sandbox only; devs install into the real host themselves following `INSTALL.md`)
**Implementing agent:** Sonnet
**Replaces:** SPEC-webscraper-module-v1.0.md (drafted by Sonnet without the staged workflow; superseded)

---

## Context

WebScrape was built as a prototype with its own `IdentityDbContext`, PAT auth, and `ApiKey` table. We're extracting the scraper domain logic into a proper BBWT3 module that any host can install by adding a project reference. The webscrape testbed (`WebScrape.Server`, etc.) stays parallel for v1 and is retired in a follow-up after the module is proven in pharmacy-planet.

This v1.1 incorporates the staged review (A1-A10, B1-B7, D1-D7, E1-E6). Material differences from v1.0:

| Area | v1.0 (wrong) | v1.1 (correct) |
|---|---|---|
| User ID type | `Guid UserId` | `string UserId` length 450 (matches `IdentityUser.Id`) |
| JSON column types | `HasColumnType("nvarchar(max)")` hard-coded | No `HasColumnType` — EF infers per provider |
| Provider support | SQL Server only | All three: SqlServer + PostgreSql + MySQL |
| AutoMapper registration | `services.AddAutoMapper(...)` in module | None — host auto-discovers via `bbAssemblies` scan |
| AutoMapper / EF csproj pins | `AutoMapper 12.0.1` + `EF 8.0.0` | None — both come transitively from BBWM.Core |
| Auth scheme attribute | Plain `[Authorize]` | `[Authorize(AuthenticationSchemes = "Cookies,Bearer")]` (portable across cookie-only, JWT-only, mixed hosts) |
| CSRF | Drops `[CookieCsrf]`, no replacement check | Confirmed covered by host's `AutoValidateAntiforgeryTokenAttribute` global filter |
| `IWorkerNotifier` source path | Wrong (`Services/Interfaces/`) | Correct (`Services/Hubs/IWorkerNotifier.cs`) |
| Hub progress security | Spoofable — any user could mutate any run | **D4 fix:** progress methods validate `run.Worker.CurrentConnection == Context.ConnectionId` |
| Auditing | Not addressed | `TaskEntity : IAuditableEntity<Guid>` (only); `ScraperConfigEntity` not auditable (avoids logging large/sensitive ConfigJson blobs in `ChangeLog`) |
| Worker dedup | `(UserId, ApiKeyId)` | `(UserId, Name)` with unique index |
| Migration plan | One migration in `BBWT.Data` | Three migrations, one per provider project |
| Install doc | Inline in spec | Separate `INSTALL.md` shipped inside module folder |

---

## 1. Distribution model

`BBWM.WebScraper` lives in the webscrape repo. Each BBWT3 host installs by **copying the folder**. The copy step is the install step. NuGet migration is deferred until host #3 needs it.

**Per-host install (summarised; full version in [INSTALL.md](#15-installmd-shipped-inside-module-folder)):**

1. Copy `webscrape/src/BBWM.WebScraper/` → `<host>/modules/BBWM.WebScraper/`.
2. In the copied csproj, change the BBWM.Core ref from the cross-repo dev path to the within-solution sibling.
3. `dotnet sln <host>.sln add modules/BBWM.WebScraper/BBWM.WebScraper.csproj`.
4. Add `<ProjectReference>` to `BBWT.Server.csproj`.
5. `dotnet ef migrations add WebScraperModule_Initial` once per provider project.
6. `dotnet ef database update` per active provider.
7. Boot host — module is auto-discovered via `BBWM.*` assembly scan.

---

## 2. Project structure to create

```
webscrape/src/BBWM.WebScraper/
  BBWM.WebScraper.csproj
  WebScraperModuleLinkage.cs
  INSTALL.md
  Entities/
    ScraperConfigEntity.cs
    TaskEntity.cs
    WorkerConnection.cs
    RunItem.cs
  EntityConfiguration/
    ScraperConfigEntityConfiguration.cs
    TaskEntityConfiguration.cs
    WorkerConnectionConfiguration.cs
    RunItemConfiguration.cs
  Dtos/
    HubPayloadDtos.cs
    QueueTaskDto.cs
    RunItemDto.cs
    ScraperConfigDto.cs
    TaskDto.cs
    WorkerDto.cs
  Mapping/
    WebScraperAutoMapperProfile.cs
  Services/
    Interfaces/
      IScraperConfigService.cs
      ITaskService.cs
      IRunService.cs
      IWorkerService.cs
      IWorkerNotifier.cs
    Implementations/
      ScraperConfigService.cs
      TaskService.cs
      RunService.cs
      WorkerService.cs
    Hubs/
      ScraperHubWorkerNotifier.cs
  Hubs/
    ScraperHub.cs
  Controllers/
    ScraperConfigsController.cs
    TasksController.cs
    RunsController.cs
    WorkersController.cs
```

---

## 3. `BBWM.WebScraper.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>

  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>

  <ItemGroup>
    <!--
      DEV (webscrape repo): cross-repo ref to pharmacy-planet's BBWM.Core.
      Requires pharmacy-planet checked out at sibling path: c:\Users\und3r\pharmacy-planet
      INSTALL: copy this folder into a host's modules/ dir, then change this line to:
        <ProjectReference Include="..\BBWM.Core\BBWM.Core.csproj" />
    -->
    <ProjectReference Include="..\..\..\pharmacy-planet\modules\BBWM.Core\BBWM.Core.csproj" />
  </ItemGroup>
</Project>
```

**Note:** no AutoMapper, EF Core, or other package pins. All dependencies come transitively via BBWM.Core. The host's BBWT.Server pins (AutoMapper 14.0.0, EF Core 8.0.14) win at the application level.

---

## 4. `WebScraperModuleLinkage.cs`

```csharp
using System.Reflection;
using BBWM.Core.ModuleLinker;
using BBWM.WebScraper.Hubs;
using BBWM.WebScraper.Services.Hubs;
using BBWM.WebScraper.Services.Implementations;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BBWM.WebScraper;

public class WebScraperModuleLinkage :
    IDbModelCreateModuleLinkage,
    IServicesModuleLinkage,
    ISignalRModuleLinkage
{
    public void OnModelCreating(ModelBuilder builder)
        => builder.ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly());

    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        services.AddScoped<IScraperConfigService, ScraperConfigService>();
        services.AddScoped<ITaskService, TaskService>();
        services.AddScoped<IRunService, RunService>();
        services.AddScoped<IWorkerService, WorkerService>();
        services.AddScoped<IWorkerNotifier, ScraperHubWorkerNotifier>();
        // NB: AutoMapper profile is auto-discovered by host's services.AddAutoMapper(bbAssemblies)
        //     in BBWT.Server/Startup.cs:276. Do NOT register it here.
    }

    public void MapHubs(IEndpointRouteBuilder routes)
        => routes.MapHub<ScraperHub>("/api/scraper-hub");
}
```

---

## 5. Entities

### 5.1 `Entities/ScraperConfigEntity.cs`

```csharp
using System.Text.Json;

namespace BBWM.WebScraper.Entities;

public class ScraperConfigEntity
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Domain { get; set; } = string.Empty;
    public JsonDocument ConfigJson { get; set; } = JsonDocument.Parse("{}");
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
```

> **Not** `IAuditableEntity` — D5 decision avoids logging large ConfigJson blobs (and any embedded secrets) in `ChangeLog`.

### 5.2 `Entities/TaskEntity.cs`

```csharp
using BBWM.Core.Data;

namespace BBWM.WebScraper.Entities;

public class TaskEntity : IAuditableEntity<Guid>
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public Guid ScraperConfigId { get; set; }
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public DateTimeOffset CreatedAt { get; set; }
    public ScraperConfigEntity? ScraperConfig { get; set; }
}
```

> Implements `IAuditableEntity<Guid>` (marker only — no extra members). Per [`BBWM.Core.Audit/AuditWrapper.cs:64`](../../pharmacy-planet/modules/BBWM.Core.Audit/AuditWrapper.cs#L64), this opts task changes into the host's `ChangeLog`.

### 5.3 `Entities/WorkerConnection.cs`

```csharp
namespace BBWM.WebScraper.Entities;

public class WorkerConnection
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? CurrentConnection { get; set; }
    public string? ExtensionVersion { get; set; }
    public DateTimeOffset? LastConnectedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
}
```

### 5.4 `Entities/RunItem.cs`

```csharp
using System.Text.Json;

namespace BBWM.WebScraper.Entities;

public static class RunItemStatus
{
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Running = "running";
    public const string Paused = "paused";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public class RunItem
{
    public Guid Id { get; set; }
    public Guid TaskId { get; set; }
    public Guid WorkerId { get; set; }
    public string Status { get; set; } = RunItemStatus.Pending;
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public JsonDocument? ResultJsonb { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PauseReason { get; set; }
    public int? ProgressPercent { get; set; }
    public string? CurrentTerm { get; set; }
    public string? CurrentStep { get; set; }
    public string? Phase { get; set; }
    public TaskEntity? Task { get; set; }
    public WorkerConnection? Worker { get; set; }
}
```

> Field name `ResultJsonb` retained from webscrape source for migration compatibility (does NOT imply Postgres `jsonb`; storage is plain text on every provider).

---

## 6. Entity configurations

**Convention used everywhere below:** value converters for JSON / string[] columns; **no `HasColumnType`** so EF infers `nvarchar(max)` / `text` / `longtext` per provider. `HasMaxLength(450)` on `UserId` columns to match `AspNetUsers.Id`.

### 6.1 `EntityConfiguration/ScraperConfigEntityConfiguration.cs`

```csharp
using System.Text.Json;
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BBWM.WebScraper.EntityConfiguration;

public class ScraperConfigEntityConfiguration : IEntityTypeConfiguration<ScraperConfigEntity>
{
    private static readonly ValueConverter<JsonDocument, string> JsonConverter = new(
        v => v.RootElement.GetRawText(),
        v => JsonDocument.Parse(v, default(JsonDocumentOptions)));

    public void Configure(EntityTypeBuilder<ScraperConfigEntity> e)
    {
        e.ToTable("ScraperConfigs");
        e.HasKey(x => x.Id);
        e.Property(x => x.UserId).IsRequired().HasMaxLength(450);
        e.Property(x => x.Name).IsRequired().HasMaxLength(256);
        e.Property(x => x.Domain).IsRequired().HasMaxLength(256);
        e.Property(x => x.ConfigJson).HasConversion(JsonConverter).IsRequired();
        e.Property(x => x.SchemaVersion).HasDefaultValue(3);
        e.HasIndex(x => x.UserId);
    }
}
```

### 6.2 `EntityConfiguration/TaskEntityConfiguration.cs`

```csharp
using System.Text.Json;
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BBWM.WebScraper.EntityConfiguration;

public class TaskEntityConfiguration : IEntityTypeConfiguration<TaskEntity>
{
    private static readonly ValueConverter<string[], string> SearchTermsConverter = new(
        v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
        v => JsonSerializer.Deserialize<string[]>(v, (JsonSerializerOptions?)null) ?? Array.Empty<string>());

    public void Configure(EntityTypeBuilder<TaskEntity> e)
    {
        e.ToTable("Tasks");
        e.HasKey(x => x.Id);
        e.Property(x => x.UserId).IsRequired().HasMaxLength(450);
        e.Property(x => x.Name).IsRequired().HasMaxLength(256);
        e.Property(x => x.SearchTerms).HasConversion(SearchTermsConverter).IsRequired();
        e.HasOne(x => x.ScraperConfig)
            .WithMany()
            .HasForeignKey(x => x.ScraperConfigId)
            .OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => x.UserId);
    }
}
```

### 6.3 `EntityConfiguration/WorkerConnectionConfiguration.cs`

```csharp
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BBWM.WebScraper.EntityConfiguration;

public class WorkerConnectionConfiguration : IEntityTypeConfiguration<WorkerConnection>
{
    public void Configure(EntityTypeBuilder<WorkerConnection> e)
    {
        e.ToTable("WorkerConnections");
        e.HasKey(x => x.Id);
        e.Property(x => x.UserId).IsRequired().HasMaxLength(450);
        e.Property(x => x.Name).IsRequired().HasMaxLength(256);
        e.Property(x => x.CurrentConnection).HasMaxLength(256);
        e.Property(x => x.ExtensionVersion).HasMaxLength(64);
        e.HasIndex(x => new { x.UserId, x.Name }).IsUnique(); // dedup key
    }
}
```

### 6.4 `EntityConfiguration/RunItemConfiguration.cs`

```csharp
using System.Text.Json;
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BBWM.WebScraper.EntityConfiguration;

public class RunItemConfiguration : IEntityTypeConfiguration<RunItem>
{
    private static readonly ValueConverter<JsonDocument?, string?> NullableJsonConverter = new(
        v => v == null ? null : v.RootElement.GetRawText(),
        v => v == null ? null : JsonDocument.Parse(v, default(JsonDocumentOptions)));

    public void Configure(EntityTypeBuilder<RunItem> e)
    {
        e.ToTable("RunItems");
        e.HasKey(x => x.Id);
        e.Property(x => x.Status).IsRequired().HasMaxLength(32);
        e.Property(x => x.PauseReason).HasMaxLength(64);
        e.Property(x => x.CurrentTerm).HasMaxLength(512);
        e.Property(x => x.CurrentStep).HasMaxLength(256);
        e.Property(x => x.Phase).HasMaxLength(32);
        e.Property(x => x.ResultJsonb).HasConversion(NullableJsonConverter);
        e.HasOne(x => x.Task)
            .WithMany()
            .HasForeignKey(x => x.TaskId)
            .OnDelete(DeleteBehavior.Cascade);
        e.HasOne(x => x.Worker)
            .WithMany()
            .HasForeignKey(x => x.WorkerId)
            .OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => new { x.TaskId, x.RequestedAt });
        e.HasIndex(x => x.Status);
    }
}
```

---

## 7. DTOs

Copy these six files **verbatim** from `webscrape/src/WebScrape.Data/Dto/` to `BBWM.WebScraper/Dtos/`. In each file, change the namespace declaration:

- `namespace WebScrape.Data.Dto;` → `namespace BBWM.WebScraper.Dtos;`

Files to copy (no other edits):

- `HubPayloadDtos.cs` → `Dtos/HubPayloadDtos.cs`
- `QueueTaskDto.cs` → `Dtos/QueueTaskDto.cs`
- `RunItemDto.cs` → `Dtos/RunItemDto.cs`
- `ScraperConfigDto.cs` → `Dtos/ScraperConfigDto.cs`
- `TaskDto.cs` → `Dtos/TaskDto.cs`
- `WorkerDto.cs` → `Dtos/WorkerDto.cs`

Files explicitly NOT copied (PAT removal):
- `AccountDtos.cs`
- `ApiKeyDto.cs`

---

## 8. `Mapping/WebScraperAutoMapperProfile.cs`

```csharp
using System.Text.Json;
using AutoMapper;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;

namespace BBWM.WebScraper.Mapping;

public class WebScraperAutoMapperProfile : Profile
{
    public WebScraperAutoMapperProfile()
    {
        CreateMap<ScraperConfigEntity, ScraperConfigDto>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => s.ConfigJson.RootElement));

        CreateMap<CreateScraperConfigDto, ScraperConfigEntity>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => JsonDocument.Parse(s.ConfigJson.GetRawText(), default(JsonDocumentOptions))));

        CreateMap<TaskEntity, TaskDto>()
            .ForMember(d => d.ScraperConfigName, o => o.MapFrom(s => s.ScraperConfig != null ? s.ScraperConfig.Name : ""));

        CreateMap<WorkerConnection, WorkerDto>()
            .ForMember(d => d.Online, o => o.MapFrom(s => s.CurrentConnection != null));

        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));
    }
}
```

> No `ApiKey → ApiKeyDto` mapping (PAT removed).

---

## 9. Service interfaces

### 9.1 `Services/Interfaces/IScraperConfigService.cs`

```csharp
using BBWM.WebScraper.Dtos;

namespace BBWM.WebScraper.Services.Interfaces;

public interface IScraperConfigService
{
    Task<List<ScraperConfigDto>> ListAsync(string userId, CancellationToken ct = default);
    Task<ScraperConfigDto?> GetAsync(string userId, Guid id, CancellationToken ct = default);
    Task<ScraperConfigDto> CreateAsync(string userId, CreateScraperConfigDto dto, CancellationToken ct = default);
    Task<ScraperConfigDto?> UpdateAsync(string userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default);
}
```

### 9.2 `Services/Interfaces/ITaskService.cs`

```csharp
using BBWM.WebScraper.Dtos;

namespace BBWM.WebScraper.Services.Interfaces;

public interface ITaskService
{
    Task<List<TaskDto>> ListAsync(string userId, CancellationToken ct = default);
    Task<TaskDto?> GetAsync(string userId, Guid id, CancellationToken ct = default);
    Task<TaskDto?> CreateAsync(string userId, CreateTaskDto dto, CancellationToken ct = default);
}
```

### 9.3 `Services/Interfaces/IRunService.cs`

```csharp
using BBWM.WebScraper.Dtos;

namespace BBWM.WebScraper.Services.Interfaces;

public enum RunDispatchOutcome
{
    Created,
    NotFound,
    Forbidden,
    WorkerOffline,
    SendFailed,
}

public record RunDispatchResult(RunDispatchOutcome Outcome, Guid? RunItemId, string? Error);

public interface IRunService
{
    Task<RunDispatchResult> CreateAndDispatchAsync(string userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task RecordProgressAsync(string connectionId, TaskProgressDto payload, CancellationToken ct = default);
    Task CompleteAsync(string connectionId, TaskCompleteDto payload, CancellationToken ct = default);
    Task FailAsync(string connectionId, TaskErrorDto payload, CancellationToken ct = default);
    Task MarkPausedAsync(string connectionId, TaskPausedDto payload, CancellationToken ct = default);
    Task<RunItemDto?> GetAsync(string userId, Guid id, CancellationToken ct = default);
}
```

> **D4 fix:** `connectionId` parameter added to all 4 progress methods. Implementations (§10.3) verify it matches `run.Worker.CurrentConnection` before mutating.

### 9.4 `Services/Interfaces/IWorkerService.cs`

```csharp
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;

namespace BBWM.WebScraper.Services.Interfaces;

public interface IWorkerService
{
    Task<WorkerConnection> RegisterAsync(string userId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default);
    Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default);
    Task<List<WorkerDto>> ListAsync(string userId, CancellationToken ct = default);
}
```

### 9.5 `Services/Interfaces/IWorkerNotifier.cs`

Copy verbatim from [`webscrape/src/WebScrape.Services/Hubs/IWorkerNotifier.cs`](c:\Users\und3r\webscrape\src\WebScrape.Services\Hubs\IWorkerNotifier.cs) into `Services/Interfaces/IWorkerNotifier.cs`. Change namespace:

- `namespace WebScrape.Services.Hubs;` → `namespace BBWM.WebScraper.Services.Interfaces;`
- `using WebScrape.Data.Dto;` → `using BBWM.WebScraper.Dtos;`

---

## 10. Service implementations

### 10.1 `Services/Implementations/ScraperConfigService.cs`

```csharp
using System.Text.Json;
using AutoMapper;
using BBWM.Core.Data;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace BBWM.WebScraper.Services.Implementations;

public class ScraperConfigService : IScraperConfigService
{
    private readonly IDbContext _db;
    private readonly IMapper _mapper;

    public ScraperConfigService(IDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<List<ScraperConfigDto>> ListAsync(string userId, CancellationToken ct = default)
    {
        var rows = await _db.Set<ScraperConfigEntity>()
            .AsNoTracking()
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<ScraperConfigDto>>(rows);
    }

    public async Task<ScraperConfigDto?> GetAsync(string userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Set<ScraperConfigEntity>()
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        return row is null ? null : _mapper.Map<ScraperConfigDto>(row);
    }

    public async Task<ScraperConfigDto> CreateAsync(string userId, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var entity = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            Domain = dto.Domain,
            ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText()),
            SchemaVersion = dto.SchemaVersion <= 0 ? 3 : dto.SchemaVersion,
            CreatedAt = now,
            UpdatedAt = now,
        };
        _db.Set<ScraperConfigEntity>().Add(entity);
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }

    public async Task<ScraperConfigDto?> UpdateAsync(string userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var entity = await _db.Set<ScraperConfigEntity>()
            .FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (entity is null) return null;

        entity.Name = dto.Name;
        entity.Domain = dto.Domain;
        entity.ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText());
        if (dto.SchemaVersion > 0) entity.SchemaVersion = dto.SchemaVersion;
        entity.UpdatedAt = DateTimeOffset.UtcNow;

        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }
}
```

### 10.2 `Services/Implementations/TaskService.cs`

```csharp
using AutoMapper;
using BBWM.Core.Data;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace BBWM.WebScraper.Services.Implementations;

public class TaskService : ITaskService
{
    private readonly IDbContext _db;
    private readonly IMapper _mapper;

    public TaskService(IDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<List<TaskDto>> ListAsync(string userId, CancellationToken ct = default)
    {
        var rows = await _db.Set<TaskEntity>()
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .Where(t => t.UserId == userId)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<TaskDto>>(rows);
    }

    public async Task<TaskDto?> GetAsync(string userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Set<TaskEntity>()
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.Id == id && t.UserId == userId, ct);
        return row is null ? null : _mapper.Map<TaskDto>(row);
    }

    public async Task<TaskDto?> CreateAsync(string userId, CreateTaskDto dto, CancellationToken ct = default)
    {
        var configExists = await _db.Set<ScraperConfigEntity>()
            .AnyAsync(c => c.Id == dto.ScraperConfigId && c.UserId == userId, ct);
        if (!configExists) return null;

        var entity = new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            ScraperConfigId = dto.ScraperConfigId,
            SearchTerms = dto.SearchTerms ?? Array.Empty<string>(),
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.Set<TaskEntity>().Add(entity);
        await _db.SaveChangesAsync(ct);

        return await GetAsync(userId, entity.Id, ct);
    }
}
```

### 10.3 `Services/Implementations/RunService.cs`

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using AutoMapper;
using BBWM.Core.Data;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace BBWM.WebScraper.Services.Implementations;

public class RunService : IRunService
{
    private readonly IDbContext _db;
    private readonly IMapper _mapper;
    private readonly IWorkerNotifier _notifier;

    public RunService(IDbContext db, IMapper mapper, IWorkerNotifier notifier)
    {
        _db = db;
        _mapper = mapper;
        _notifier = notifier;
    }

    public async Task<RunDispatchResult> CreateAndDispatchAsync(string userId, Guid taskId, Guid workerId, CancellationToken ct = default)
    {
        var worker = await _db.Set<WorkerConnection>().FirstOrDefaultAsync(w => w.Id == workerId, ct);
        if (worker is null) return new(RunDispatchOutcome.NotFound, null, "Worker not found");
        if (worker.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, "Worker does not belong to user");

        var task = await _db.Set<TaskEntity>()
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null) return new(RunDispatchOutcome.NotFound, null, "Task not found");
        if (task.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, "Task does not belong to user");

        if (string.IsNullOrEmpty(worker.CurrentConnection))
            return new(RunDispatchOutcome.WorkerOffline, null, "Worker is offline");

        var connectionId = worker.CurrentConnection;
        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = task.Id,
            WorkerId = worker.Id,
            Status = RunItemStatus.Pending,
            RequestedAt = DateTimeOffset.UtcNow,
        };
        _db.Set<RunItem>().Add(run);
        await _db.SaveChangesAsync(ct);

        var config = task.ScraperConfig!;
        var queueDto = new QueueTaskDto
        {
            Id = run.Id.ToString(),
            ConfigId = config.Id.ToString(),
            ConfigName = config.Name,
            SearchTerms = task.SearchTerms.ToList(),
            Priority = 0,
            CreatedAt = run.RequestedAt,
            Status = "pending",
            InlineConfig = BuildInlineConfig(config),
        };

        try
        {
            await _notifier.SendReceiveTaskAsync(connectionId, queueDto, ct);
        }
        catch (Exception ex)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = $"Worker disconnected before task could be sent: {ex.Message}";
            run.CompletedAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(CancellationToken.None);
            return new(RunDispatchOutcome.SendFailed, run.Id, run.ErrorMessage);
        }

        run.Status = RunItemStatus.Sent;
        run.SentAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        return new(RunDispatchOutcome.Created, run.Id, null);
    }

    // Builds the flat ScraperConfig JSON the extension expects as inlineConfig.
    // Takes the stored configJson blob and injects "id" at the top level.
    private static JsonElement BuildInlineConfig(ScraperConfigEntity config)
    {
        var node = JsonNode.Parse(config.ConfigJson.RootElement.GetRawText())!.AsObject();
        node["id"] = config.Id.ToString();
        return JsonSerializer.SerializeToElement(node);
    }

    public async Task RecordProgressAsync(string connectionId, TaskProgressDto payload, CancellationToken ct = default)
    {
        var run = await LoadAndAuthoriseAsync(connectionId, payload.TaskId, ct);
        if (run is null) return;

        if (run.Status == RunItemStatus.Sent || run.Status == RunItemStatus.Paused)
        {
            run.Status = RunItemStatus.Running;
            run.StartedAt ??= DateTimeOffset.UtcNow;
        }

        run.ProgressPercent = payload.Progress;
        run.CurrentTerm = payload.CurrentTerm;
        run.CurrentStep = payload.CurrentStep;
        run.Phase = payload.Phase;

        await _db.SaveChangesAsync(ct);
    }

    public async Task CompleteAsync(string connectionId, TaskCompleteDto payload, CancellationToken ct = default)
    {
        var run = await LoadAndAuthoriseAsync(connectionId, payload.TaskId, ct);
        if (run is null) return;

        var resultJson = JsonSerializer.Serialize(payload.Result);
        run.ResultJsonb = JsonDocument.Parse(resultJson);
        run.Status = RunItemStatus.Completed;
        run.CompletedAt = payload.CompletedAt == default ? DateTimeOffset.UtcNow : payload.CompletedAt;
        run.ProgressPercent = 100;

        await _db.SaveChangesAsync(ct);
    }

    public async Task FailAsync(string connectionId, TaskErrorDto payload, CancellationToken ct = default)
    {
        var run = await LoadAndAuthoriseAsync(connectionId, payload.TaskId, ct);
        if (run is null) return;

        run.Status = RunItemStatus.Failed;
        run.ErrorMessage = string.IsNullOrEmpty(payload.StepLabel) ? payload.Error : $"[{payload.StepLabel}] {payload.Error}";
        run.CompletedAt = payload.FailedAt == default ? DateTimeOffset.UtcNow : payload.FailedAt;

        await _db.SaveChangesAsync(ct);
    }

    public async Task MarkPausedAsync(string connectionId, TaskPausedDto payload, CancellationToken ct = default)
    {
        var run = await LoadAndAuthoriseAsync(connectionId, payload.TaskId, ct);
        if (run is null) return;

        run.Status = RunItemStatus.Paused;
        run.PauseReason = payload.Reason;

        await _db.SaveChangesAsync(ct);
    }

    public async Task<RunItemDto?> GetAsync(string userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Set<RunItem>()
            .AsNoTracking()
            .Include(r => r.Task)
            .FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return null;
        if (row.Task is null || row.Task.UserId != userId) return null;
        return _mapper.Map<RunItemDto>(row);
    }

    // D4: load run + verify caller owns the worker. Returns null on any mismatch — silent drop.
    private async Task<RunItem?> LoadAndAuthoriseAsync(string connectionId, string runIdStr, CancellationToken ct)
    {
        if (!Guid.TryParse(runIdStr, out var runId)) return null;
        var run = await _db.Set<RunItem>()
            .Include(r => r.Worker)
            .FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return null;
        if (run.Worker is null || run.Worker.CurrentConnection != connectionId) return null;
        return run;
    }
}
```

### 10.4 `Services/Implementations/WorkerService.cs`

```csharp
using AutoMapper;
using BBWM.Core.Data;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace BBWM.WebScraper.Services.Implementations;

public class WorkerService : IWorkerService
{
    private readonly IDbContext _db;
    private readonly IMapper _mapper;

    public WorkerService(IDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    // Dedup key: (UserId, Name). Two simultaneous registrations from the same user
    // with the same name share a row (enforced by unique index in WorkerConnectionConfiguration).
    public async Task<WorkerConnection> RegisterAsync(string userId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default)
    {
        var resolvedName = string.IsNullOrWhiteSpace(clientName) ? "My Browser" : clientName;
        var worker = await _db.Set<WorkerConnection>()
            .FirstOrDefaultAsync(w => w.UserId == userId && w.Name == resolvedName, ct);
        var now = DateTimeOffset.UtcNow;

        if (worker is null)
        {
            worker = new WorkerConnection
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                Name = resolvedName,
            };
            _db.Set<WorkerConnection>().Add(worker);
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
        var worker = await _db.Set<WorkerConnection>()
            .FirstOrDefaultAsync(w => w.CurrentConnection == connectionId, ct);
        if (worker is null) return;

        var now = DateTimeOffset.UtcNow;
        worker.CurrentConnection = null;
        worker.LastSeenAt = now;

        var inFlightStatuses = new[] { RunItemStatus.Sent, RunItemStatus.Running, RunItemStatus.Paused };
        var inFlight = await _db.Set<RunItem>()
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

    public async Task<List<WorkerDto>> ListAsync(string userId, CancellationToken ct = default)
    {
        var workers = await _db.Set<WorkerConnection>()
            .AsNoTracking()
            .Where(w => w.UserId == userId)
            .OrderBy(w => w.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<WorkerDto>>(workers);
    }
}
```

---

## 11. `Services/Hubs/ScraperHubWorkerNotifier.cs`

```csharp
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Hubs;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace BBWM.WebScraper.Services.Hubs;

public class ScraperHubWorkerNotifier : IWorkerNotifier
{
    private readonly IHubContext<ScraperHub> _hub;

    public ScraperHubWorkerNotifier(IHubContext<ScraperHub> hub)
    {
        _hub = hub;
    }

    public Task SendReceiveTaskAsync(string connectionId, QueueTaskDto task, CancellationToken ct = default)
        => _hub.Clients.Client(connectionId).SendAsync("ReceiveTask", task, ct);

    public Task SendCancelTaskAsync(string connectionId, string taskId, CancellationToken ct = default)
        => _hub.Clients.Client(connectionId).SendAsync("CancelTask", taskId, ct);

    public Task SendResumeAfterPauseAsync(string connectionId, string taskId, CancellationToken ct = default)
        => _hub.Clients.Client(connectionId).SendAsync("ResumeAfterPause", taskId, ct);
}
```

---

## 12. `Hubs/ScraperHub.cs`

```csharp
using BBWM.Core.Web.Extensions;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

namespace BBWM.WebScraper.Hubs;

[Authorize(AuthenticationSchemes = CookieAuthenticationDefaults.AuthenticationScheme + "," + JwtBearerDefaults.AuthenticationScheme)]
public class ScraperHub : Hub
{
    private readonly IWorkerService _workers;
    private readonly IRunService _runs;
    private readonly ILogger<ScraperHub> _logger;

    public ScraperHub(IWorkerService workers, IRunService runs, ILogger<ScraperHub> logger)
    {
        _workers = workers;
        _runs = runs;
        _logger = logger;
    }

    public override async Task OnConnectedAsync()
    {
        var userId = Context.GetHttpContext()?.GetUserId();
        if (!string.IsNullOrEmpty(userId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        try
        {
            await _workers.HandleDisconnectAsync(Context.ConnectionId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to clean up disconnected worker");
        }
        await base.OnDisconnectedAsync(exception);
    }

    public Task RegisterWorker(string clientId, string extensionVersion)
    {
        var userId = RequireUserId();
        return _workers.RegisterAsync(userId, clientId, extensionVersion, Context.ConnectionId);
    }

    public Task TaskProgress(TaskProgressDto payload) => _runs.RecordProgressAsync(Context.ConnectionId, payload);
    public Task TaskComplete(TaskCompleteDto payload) => _runs.CompleteAsync(Context.ConnectionId, payload);
    public Task TaskError(TaskErrorDto payload) => _runs.FailAsync(Context.ConnectionId, payload);
    public Task TaskPaused(TaskPausedDto payload) => _runs.MarkPausedAsync(Context.ConnectionId, payload);

    private string RequireUserId()
    {
        var userId = Context.GetHttpContext()?.GetUserId();
        if (string.IsNullOrEmpty(userId)) throw new HubException("Missing user claim");
        return userId;
    }
}
```

---

## 13. Controllers

### 13.1 `Controllers/ScraperConfigsController.cs`

```csharp
using BBWM.Core.Web.Extensions;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BBWM.WebScraper.Controllers;

[ApiController]
[Route("api/scraper-configs")]
[Authorize(AuthenticationSchemes = CookieAuthenticationDefaults.AuthenticationScheme + "," + JwtBearerDefaults.AuthenticationScheme)]
public class ScraperConfigsController : ControllerBase
{
    private readonly IScraperConfigService _configs;

    public ScraperConfigsController(IScraperConfigService configs)
    {
        _configs = configs;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
        => Ok(await _configs.ListAsync(HttpContext.GetUserId(), ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _configs.GetAsync(HttpContext.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var created = await _configs.CreateAsync(HttpContext.GetUserId(), dto, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var updated = await _configs.UpdateAsync(HttpContext.GetUserId(), id, dto, ct);
        return updated is null ? NotFound() : Ok(updated);
    }
}
```

### 13.2 `Controllers/TasksController.cs`

```csharp
using BBWM.Core.Web.Extensions;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BBWM.WebScraper.Controllers;

[ApiController]
[Route("api/tasks")]
[Authorize(AuthenticationSchemes = CookieAuthenticationDefaults.AuthenticationScheme + "," + JwtBearerDefaults.AuthenticationScheme)]
public class TasksController : ControllerBase
{
    private readonly ITaskService _tasks;

    public TasksController(ITaskService tasks)
    {
        _tasks = tasks;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
        => Ok(await _tasks.ListAsync(HttpContext.GetUserId(), ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _tasks.GetAsync(HttpContext.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateTaskDto dto, CancellationToken ct)
    {
        var created = await _tasks.CreateAsync(HttpContext.GetUserId(), dto, ct);
        if (created is null) return BadRequest(new { error = "Scraper config not found" });
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }
}
```

### 13.3 `Controllers/RunsController.cs`

```csharp
using BBWM.Core.Web.Extensions;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BBWM.WebScraper.Controllers;

[ApiController]
[Route("api/runs")]
[Authorize(AuthenticationSchemes = CookieAuthenticationDefaults.AuthenticationScheme + "," + JwtBearerDefaults.AuthenticationScheme)]
public class RunsController : ControllerBase
{
    private readonly IRunService _runs;

    public RunsController(IRunService runs)
    {
        _runs = runs;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRunDto dto, CancellationToken ct)
    {
        var result = await _runs.CreateAndDispatchAsync(HttpContext.GetUserId(), dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            RunDispatchOutcome.Created => CreatedAtAction(nameof(Get), new { id = result.RunItemId }, new { runItemId = result.RunItemId }),
            RunDispatchOutcome.NotFound => NotFound(new { error = result.Error }),
            RunDispatchOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            RunDispatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            RunDispatchOutcome.SendFailed => StatusCode(StatusCodes.Status502BadGateway, new { runItemId = result.RunItemId, error = result.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _runs.GetAsync(HttpContext.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }
}
```

### 13.4 `Controllers/WorkersController.cs`

```csharp
using BBWM.Core.Web.Extensions;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BBWM.WebScraper.Controllers;

[ApiController]
[Route("api/workers")]
[Authorize(AuthenticationSchemes = CookieAuthenticationDefaults.AuthenticationScheme + "," + JwtBearerDefaults.AuthenticationScheme)]
public class WorkersController : ControllerBase
{
    private readonly IWorkerService _workers;

    public WorkersController(IWorkerService workers)
    {
        _workers = workers;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
        => Ok(await _workers.ListAsync(HttpContext.GetUserId(), ct));
}
```

---

## 14. Test project changes (`webscrape/tests/WebScrape.Tests/`)

### 14.1 Files to delete

- `tests/WebScrape.Tests/Auth/PatAuthenticationHandlerTests.cs`
- `tests/WebScrape.Tests/Security/ApiKeyServiceTests.cs`
- `tests/WebScrape.Tests/Security/ApiKeyTokenGeneratorTests.cs`
- `tests/WebScrape.Tests/Security/Argon2idApiKeyHasherTests.cs`
- `tests/WebScrape.Tests/Services/ApiKeyServiceTests.cs`

If the `Auth/` and `Security/` folders end up empty, delete them.

### 14.2 `WebScrape.Tests.csproj` — replace project refs

Replace lines 27-29 (refs to `WebScrape.Server`, `WebScrape.Services`, `WebScrape.Data`) with the single ref:

```xml
<ProjectReference Include="..\..\src\BBWM.WebScraper\BBWM.WebScraper.csproj" />
```

### 14.3 `TestSupport/TestWebScraperDbContext.cs` *(new file)*

```csharp
using BBWM.Core.Data;
using BBWM.WebScraper;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;

namespace WebScrape.Tests.TestSupport;

// Minimal DbContext implementing IDbContext, with the module's entity configurations applied.
public class TestWebScraperDbContext : DbContext, IDbContext
{
    public TestWebScraperDbContext(DbContextOptions<TestWebScraperDbContext> options) : base(options) { }

    protected override void OnModelCreating(ModelBuilder builder)
        => builder.ApplyConfigurationsFromAssembly(typeof(WebScraperModuleLinkage).Assembly);

    // IDbContext explicit members are inherited from DbContext (Database, Model, Set<T>, SaveChanges, SaveChangesAsync, Entry<T>).
}
```

### 14.4 `TestSupport/TestDb.cs` *(replace contents)*

```csharp
using AutoMapper;
using BBWM.WebScraper.Mapping;
using Microsoft.EntityFrameworkCore;

namespace WebScrape.Tests.TestSupport;

public static class TestDb
{
    public static TestWebScraperDbContext CreateInMemory()
    {
        var opts = new DbContextOptionsBuilder<TestWebScraperDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        var ctx = new TestWebScraperDbContext(opts);
        ctx.Database.EnsureCreated();
        return ctx;
    }

    public static IMapper CreateMapper()
        => new MapperConfiguration(cfg => cfg.AddProfile<WebScraperAutoMapperProfile>()).CreateMapper();
}
```

### 14.5 `Services/WorkerServiceTests.cs` *(rewrite)*

Test cases (5 total):

1. `RegisterAsync_NoExisting_CreatesRow` — creates row with `(userId, name)`, sets connection.
2. `RegisterAsync_SameUserAndName_ReusesRow` — second call with same `(userId, name)` updates the existing row's connection, doesn't insert.
3. `RegisterAsync_BlankClientName_DefaultsToMyBrowser` — confirms fallback name.
4. `HandleDisconnectAsync_ClearsConnection_AndFailsInFlightRuns` — Sent/Running/Paused runs become Failed with `"Worker disconnected"`.
5. `ListAsync_OnlyReturnsCallersWorkers` — workers for other users excluded; `Online` projected from `CurrentConnection`.

All `Guid userId` → `string userId`. All references to `ApiKeyId` removed. Setup uses `TestDb.CreateInMemory()` and `TestDb.CreateMapper()`.

### 14.6 `Services/RunServiceTests.cs` *(rewrite)*

Test cases (8 total):

1. `CreateAndDispatch_HappyPath_ReturnsCreatedAndCallsNotifierOnce` — outcome=Created, run.Status=Sent, notifier called with correct connectionId.
2. `CreateAndDispatch_WorkerNotFound_ReturnsNotFound`.
3. `CreateAndDispatch_WorkerOtherUser_ReturnsForbidden`.
4. `CreateAndDispatch_TaskOtherUser_ReturnsForbidden`.
5. `CreateAndDispatch_WorkerOffline_ReturnsWorkerOffline` — `CurrentConnection` is null/empty.
6. `CreateAndDispatch_NotifierThrows_ReturnsSendFailed` — run.Status=Failed, ErrorMessage populated.
7. `[Theory] HubProgress_ConnectionIdMismatch_DropsSilently` — for each of `(RecordProgress, Complete, Fail, MarkPaused)`, calling with a `connectionId` that doesn't match `run.Worker.CurrentConnection` leaves the run unchanged.
8. `RecordProgress_ValidConnection_Sent_TransitionsToRunning` — happy path: Sent → Running with StartedAt set.

Use Moq for `IWorkerNotifier`. `Guid userId` → `string userId` everywhere.

### 14.7 `Services/ScraperConfigServiceTests.cs` *(new)*

6 test cases per E2 (List filters; Get returns null for other user; Create round-trips ConfigJson; Update succeeds for owner; Update returns null for non-owner; Update preserves SchemaVersion when dto.SchemaVersion ≤ 0).

### 14.8 `Services/TaskServiceTests.cs` *(new)*

4 test cases per E2 (Create rejects non-owner config; Create round-trips SearchTerms; List orders by CreatedAt desc; Get excludes other user's task).

### 14.9 `Mapping/AutoMapperProfileTests.cs` *(new)*

```csharp
using AutoMapper;
using BBWM.WebScraper.Mapping;
using Xunit;

namespace WebScrape.Tests.Mapping;

public class AutoMapperProfileTests
{
    [Fact]
    public void Profile_IsValid()
    {
        var config = new MapperConfiguration(cfg => cfg.AddProfile<WebScraperAutoMapperProfile>());
        config.AssertConfigurationIsValid();
    }

    // Plus 2 more focused mapping tests for RunItem.ResultJsonb → RunItemDto.Result and
    // WorkerConnection.CurrentConnection → WorkerDto.Online (online + offline cases).
}
```

### 14.10 `EntityConfiguration/ConfigurationsApplyTests.cs` *(new)*

```csharp
using WebScrape.Tests.TestSupport;
using Xunit;

namespace WebScrape.Tests.EntityConfiguration;

public class ConfigurationsApplyTests
{
    [Fact]
    public void EnsureCreated_SucceedsForAllEntityConfigurations()
    {
        using var db = TestDb.CreateInMemory();
        // EnsureCreated already called by TestDb — assertion is "no exception thrown".
        Assert.NotNull(db.Model.FindEntityType(typeof(BBWM.WebScraper.Entities.ScraperConfigEntity)));
        Assert.NotNull(db.Model.FindEntityType(typeof(BBWM.WebScraper.Entities.TaskEntity)));
        Assert.NotNull(db.Model.FindEntityType(typeof(BBWM.WebScraper.Entities.WorkerConnection)));
        Assert.NotNull(db.Model.FindEntityType(typeof(BBWM.WebScraper.Entities.RunItem)));
    }
}
```

---

## 15. `INSTALL.md` (shipped inside module folder)

Path: `webscrape/src/BBWM.WebScraper/INSTALL.md`. This file is copied into the host alongside the module so devs always have current install instructions on hand.

```markdown
# BBWM.WebScraper — install into a BBWT3 host

This module is **drop-in**: copy the folder into `<host>/modules/BBWM.WebScraper/`, change one line in the csproj, register, and migrate. ~10 minutes for a host that already runs BBWT3.

## Prerequisites

The host must:
- Have `BBWM.Core` and `BBWM.Core.Web.CookieAuth` (or `BBWM.JWT`) referenced from `BBWT.Server.csproj`.
- Call `services.AddSignalR()` in `Startup.ConfigureServices` (BBWT3's standard setup at `BBWT.Server/Startup.cs:81` does this).
- Call `services.AddAntiforgery(...)` and register `AutoValidateAntiforgeryTokenAttribute` as a global MVC filter (BBWT3 standard at `Startup.cs:115` and `Startup.cs:205`).
- Call `services.AddAutoMapper(bbAssemblies)` to auto-discover module profiles (BBWT3 standard at `Startup.cs:276`).

If your host is BBWT3-derived, all of the above are present out of the box. If you're unsure, grep `BBWT.Server/Startup.cs` for those calls.

## Install steps

### 1. Copy the module folder

```bash
# From your host's repo root:
cp -r <path-to-webscrape>/src/BBWM.WebScraper modules/BBWM.WebScraper
```

### 2. Fix the BBWM.Core reference

Open `modules/BBWM.WebScraper/BBWM.WebScraper.csproj`. Replace the `<ProjectReference>` line marked DEV with the within-solution sibling:

```xml
<ProjectReference Include="..\BBWM.Core\BBWM.Core.csproj" />
```

### 3. Register in solution and server

```bash
dotnet sln <host>.sln add modules/BBWM.WebScraper/BBWM.WebScraper.csproj
```

Add this line to `BBWT.Server/BBWT.Server.csproj` alongside the other module references:

```xml
<ProjectReference Include="..\..\modules\BBWM.WebScraper\BBWM.WebScraper.csproj" />
```

### 4. Generate migrations (per active provider)

For each DB provider your host supports, run from the repo root:

```bash
# SQL Server
dotnet ef migrations add WebScraperModule_Initial --project project/BBWT.Data.SqlServer --startup-project project/BBWT.Server

# PostgreSQL
dotnet ef migrations add WebScraperModule_Initial --project project/BBWT.Data.PostgreSql --startup-project project/BBWT.Server

# MySQL
dotnet ef migrations add WebScraperModule_Initial --project project/BBWT.Data.MySQL --startup-project project/BBWT.Server
```

Inspect each generated migration file. Confirm `CreateTable` blocks for `ScraperConfigs`, `Tasks`, `WorkerConnections`, `RunItems`, with `UserId` as `nvarchar(450)` (or provider equivalent) and JSON columns as the provider's text-blob type.

### 5. Apply the migrations

```bash
dotnet ef database update --project project/BBWT.Data.SqlServer --startup-project project/BBWT.Server
# (and again per provider configured for this host)
```

### 6. CORS allowlist for the extension

If the browser extension connects from a different origin than your host, add the extension's origin (e.g. `chrome-extension://<id>`) to the host's CORS configuration so SignalR's negotiate request can carry credentials.

In `BBWT.Server/Startup.cs`, find the `AddCors`/`UseCors` block and add the extension origin to the allowed origins list. Ensure `.AllowCredentials()` is set.

### 7. Boot and smoke

```bash
dotnet run --project project/BBWT.Server
```

The host log should show `WebScraperModuleLinkage` invoked by `ModuleLinker`. No exceptions on AutoMapper, DI, or EF model build.

Verify endpoints:
- `GET /api/scraper-configs` (logged in) → `200 []`
- `GET /api/scraper-configs` (logged out) → `401`
- SignalR negotiate at `/api/scraper-hub/negotiate` → `200`

## What you get

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/scraper-configs` | GET / POST / PUT | Manage scraper configs (per-user) |
| `/api/tasks` | GET / POST | Manage scrape tasks (per-user) |
| `/api/runs` | POST / GET | Dispatch and inspect runs |
| `/api/workers` | GET | List the user's connected workers |
| `/api/scraper-hub` | WebSocket | SignalR hub for the extension worker |

## Optional: gate access by permission (v1.1+)

By default any authenticated user has scraper access. To gate behind a permission visible in your role-management UI:

1. Add a permission constant `WebScraper.Use` to your host's `Permissions.cs`.
2. Register a policy in `BBWT.Server/Extensions/AuthorizationExtensions.cs` (see existing `Permissions.ScreeningDecisionsRead` policy as a template).
3. Add `IRouteRolesModule` for the four scraper routes with that permission.
4. Change the controllers' attributes from `[Authorize(AuthenticationSchemes = "Cookies,Bearer")]` to `[Authorize(Policy = "WebScraper.Use", AuthenticationSchemes = "Cookies,Bearer")]`.

## Uninstall

1. Run `dotnet ef migrations remove` per provider (or generate a "drop tables" migration).
2. Remove `<ProjectReference>` from `BBWT.Server.csproj`.
3. `dotnet sln <host>.sln remove modules/BBWM.WebScraper/BBWM.WebScraper.csproj`.
4. Delete `modules/BBWM.WebScraper/`.
```

---

## 16. Verification

### 16.1 Build

```bash
dotnet build webscrape/src/BBWM.WebScraper/BBWM.WebScraper.csproj
dotnet build webscrape/tests/WebScrape.Tests/WebScrape.Tests.csproj
```

Both: 0 errors. Warnings tolerated (BBWM.Core itself ships warnings).

### 16.2 Unit tests

```bash
dotnet test webscrape/tests/WebScrape.Tests/
```

Expected: ~27 tests pass (5 Worker + 8 Run + 6 ScraperConfig + 4 Task + 3 Mapping + 1 ConfigurationsApply).

### 16.3 Local pharmacy-planet rig smoke (validation only — no commit to pharmacy-planet)

Per the user's note: pharmacy-planet locally is a sandbox only. Walking through `INSTALL.md` against it proves the install steps; the resulting `pharmacy-planet/modules/BBWM.WebScraper/` and migrations should be reverted (`git restore` / `git clean -fd`) afterward — they are not committed.

The 12-step manual checklist in [Stage E — E3] is the script to follow. Do it once before declaring v1.1 ready for dev hand-off.

### 16.4 Anti-spec check (D4 manual)

From a hub-connected client A, send `TaskProgress({ TaskId: "<some other user's runId>" })`. The target run's status must remain unchanged. (Covered by unit test §14.6 case 7; this manual exercise just confirms end-to-end.)

---

## 17. What is NOT in this spec (deferred)

- **Permission policy `WebScraper.Use`** — current spec uses plain auth-required. v1.1.x adds the policy + `IRouteRolesModule` registration. Template included in `INSTALL.md` §"Optional: gate access".
- **NuGet packaging** — copy-into-host is the install for now; migrate at host #3.
- **Webscrape testbed retirement** — `WebScrape.Server`/`WebScrape.Services`/`WebScrape.Data` stay parallel for v1. Separate sub-spec deletes them after pharmacy-planet rollout.
- **Extension UI cleanup** (dead Account/ApiKey screens) — sibling sub-spec `SPEC-extension-bbwt3-auth-v1.0.md`.
- **User deletion cascade** — when an `AspNetUsers` row is deleted, scraper rows orphan. Application-layer cleanup deferred.
- **Postgres / MySQL live integration tests** — only EF InMemory is exercised. Provider-specific runtime issues surface at install time and get fixed forward.
- **Concurrent dispatch races** (two `RunsController.Create` for same task/worker) — pre-existing webscrape behaviour; out of scope.
- **Stale connection cleanup** when network drops without a disconnect event — pre-existing webscrape behaviour.
- **`IOptions<WebScraperSettings>` configuration** — module ships with no settings; revisit when a real need surfaces.
