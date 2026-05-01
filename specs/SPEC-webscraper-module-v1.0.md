# SPEC-webscraper-module-v1.0

**Feature:** Port WebScrape backend into `BBWM.WebScraper` — a self-contained BBWT3 module  
**Source repo:** `c:\Users\und3r\webscrape`  
**Target integration:** any BBWT3 host (pharmacy-planet or similar)  
**Testbed:** `WebScrape.Server` remains untouched throughout

---

## Context

WebScrape was built as a prototype testbed. The goal is to extract the scraper domain logic into a proper BBWT3 module (`BBWM.WebScraper`) that any BBWT3 host can install by adding a project reference — zero changes to the host's `Startup.cs` or `Program.cs` required (BBWT3 auto-discovers modules via assembly scanning).

Key changes vs the testbed:
- No own `IdentityDbContext` — entity configs join the host's shared DB via `IDbModelCreateModuleLinkage`
- No `AccountController`, no PAT/cookie auth — host's `[Authorize]` policy used throughout
- No `ApiKey` table — PAT auth dropped entirely
- Services inject `IDbContext` (BBWM.Core) instead of `WebScrapeDbContext`
- SQL Server column types replace PostgreSQL-specific ones

---

## Distribution model

`BBWM.WebScraper` is developed in the webscrape repo and **copied** into each BBWT3 host's `modules/` folder to install it. No cross-repo references at runtime. The copy step is the install step.

**To install into a new BBWT3 host:**
1. Copy `webscrape/src/BBWM.WebScraper/` → `<host>/modules/BBWM.WebScraper/`
2. In the copied `BBWM.WebScraper.csproj`, change the BBWM.Core reference to the within-solution sibling: `<ProjectReference Include="..\BBWM.Core\BBWM.Core.csproj" />`
3. `dotnet sln <host>.sln add modules/BBWM.WebScraper/BBWM.WebScraper.csproj`
4. `dotnet ef migrations add WebScraperModule --project <DataProject> --startup-project <ServerProject>`
5. Start the host — module is auto-discovered via `BBWM.*` assembly name.

**Future: NuGet migration** — when a third or fourth host needs it, run `dotnet pack` on the module, publish the `.nupkg` to a private feed, and hosts replace the folder copy with `<PackageReference Include="BBWM.WebScraper" Version="x.x.x" />`. Module code is unchanged.

---

## Project structure to create

Add `BBWM.WebScraper` to the webscrape solution. Do not modify any existing project.

```
webscrape/src/BBWM.WebScraper/
  BBWM.WebScraper.csproj
  ModuleLinkage.cs
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

## 1. BBWM.WebScraper.csproj

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
    <PackageReference Include="AutoMapper" Version="12.0.1" />
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
  </ItemGroup>

  <ItemGroup>
    <!--
      Development (webscrape repo): cross-repo ref to pharmacy-planet.
      After copying into a BBWT3 host: change to the within-solution sibling:
        <ProjectReference Include="..\BBWM.Core\BBWM.Core.csproj" />
    -->
    <ProjectReference Include="..\..\..\pharmacy-planet\modules\BBWM.Core\BBWM.Core.csproj" />
  </ItemGroup>
</Project>
```

---

## 2. ModuleLinkage.cs

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
        services.AddAutoMapper(typeof(WebScraperModuleLinkage).Assembly);
    }

    public void MapHubs(IEndpointRouteBuilder routes)
        => routes.MapHub<ScraperHub>("/api/scraper-hub");
}
```

---

## 3. Entities

### Entities/ScraperConfigEntity.cs

```csharp
using System.Text.Json;

namespace BBWM.WebScraper.Entities;

public class ScraperConfigEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Domain { get; set; } = string.Empty;
    public JsonDocument ConfigJson { get; set; } = null!;
    public int SchemaVersion { get; set; } = 3;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
```

### Entities/TaskEntity.cs

```csharp
namespace BBWM.WebScraper.Entities;

public class TaskEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    public Guid ScraperConfigId { get; set; }
    public string[] SearchTerms { get; set; } = Array.Empty<string>();
    public DateTimeOffset CreatedAt { get; set; }
    public ScraperConfigEntity? ScraperConfig { get; set; }
}
```

### Entities/WorkerConnection.cs

```csharp
namespace BBWM.WebScraper.Entities;

public class WorkerConnection
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? CurrentConnection { get; set; }
    public string? ExtensionVersion { get; set; }
    public DateTimeOffset? LastConnectedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
}
```

### Entities/RunItem.cs

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

---

## 4. Entity Configuration

### EntityConfiguration/ScraperConfigEntityConfiguration.cs

```csharp
using System.Text.Json;
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BBWM.WebScraper.EntityConfiguration;

public class ScraperConfigEntityConfiguration : IEntityTypeConfiguration<ScraperConfigEntity>
{
    public void Configure(EntityTypeBuilder<ScraperConfigEntity> e)
    {
        e.HasKey(x => x.Id);
        e.Property(x => x.Name).IsRequired();
        e.Property(x => x.Domain).IsRequired();
        e.Property(x => x.ConfigJson)
            .HasColumnType("nvarchar(max)")
            .HasConversion(new ValueConverter<JsonDocument, string>(
                v => v.RootElement.GetRawText(),
                v => JsonDocument.Parse(v, new JsonDocumentOptions())))
            .IsRequired();
        e.Property(x => x.SchemaVersion).HasDefaultValue(3);
        e.Property(x => x.UserId).IsRequired();
    }
}
```

### EntityConfiguration/TaskEntityConfiguration.cs

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
        e.HasKey(x => x.Id);
        e.Property(x => x.Name).IsRequired();
        e.Property(x => x.SearchTerms)
            .HasColumnType("nvarchar(max)")
            .HasConversion(SearchTermsConverter)
            .IsRequired();
        e.Property(x => x.UserId).IsRequired();
        e.HasOne(x => x.ScraperConfig)
            .WithMany()
            .HasForeignKey(x => x.ScraperConfigId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
```

### EntityConfiguration/WorkerConnectionConfiguration.cs

```csharp
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BBWM.WebScraper.EntityConfiguration;

public class WorkerConnectionConfiguration : IEntityTypeConfiguration<WorkerConnection>
{
    public void Configure(EntityTypeBuilder<WorkerConnection> e)
    {
        e.HasKey(x => x.Id);
        e.Property(x => x.Name).IsRequired();
        e.Property(x => x.UserId).IsRequired();
        e.HasIndex(x => x.CurrentConnection);
    }
}
```

### EntityConfiguration/RunItemConfiguration.cs

```csharp
using System.Text.Json;
using BBWM.WebScraper.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BBWM.WebScraper.EntityConfiguration;

public class RunItemConfiguration : IEntityTypeConfiguration<RunItem>
{
    public void Configure(EntityTypeBuilder<RunItem> e)
    {
        e.HasKey(x => x.Id);
        e.Property(x => x.Status).IsRequired();
        e.Property(x => x.ResultJsonb)
            .HasColumnType("nvarchar(max)")
            .HasConversion(new ValueConverter<JsonDocument?, string?>(
                v => v == null ? null : v.RootElement.GetRawText(),
                v => v == null ? null : JsonDocument.Parse(v, new JsonDocumentOptions())));
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

## 5. DTOs

Copy verbatim from `WebScrape.Data/Dto/` with namespace changed to `BBWM.WebScraper.Dtos`. Omit `AccountDtos.cs` and `ApiKeyDto.cs` entirely (PAT removed).

Files to copy and rename namespace:
- `HubPayloadDtos.cs` → `Dtos/HubPayloadDtos.cs`
- `QueueTaskDto.cs` → `Dtos/QueueTaskDto.cs`
- `RunItemDto.cs` → `Dtos/RunItemDto.cs`
- `ScraperConfigDto.cs` → `Dtos/ScraperConfigDto.cs`
- `TaskDto.cs` → `Dtos/TaskDto.cs`
- `WorkerDto.cs` → `Dtos/WorkerDto.cs`

In each file, change `namespace WebScrape.Data.Dto` → `namespace BBWM.WebScraper.Dtos`.

---

## 6. Mapping/WebScraperAutoMapperProfile.cs

Copy `WebScrape.Data/Mapping/AutoMapperProfile.cs`, rename class and namespace, remove the `ApiKey → ApiKeyDto` mapping:

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
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => JsonDocument.Parse(s.ConfigJson.GetRawText())));

        CreateMap<TaskEntity, TaskDto>()
            .ForMember(d => d.ScraperConfigName,
                o => o.MapFrom(s => s.ScraperConfig != null ? s.ScraperConfig.Name : string.Empty));

        CreateMap<WorkerConnection, WorkerDto>()
            .ForMember(d => d.Online, o => o.MapFrom(s => s.CurrentConnection != null));

        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result,
                o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));
    }
}
```

---

## 7. Service Interfaces

Copy verbatim from `WebScrape.Services/Services/Interfaces/` with namespace changed to `BBWM.WebScraper.Services.Interfaces` and using directives updated to `BBWM.WebScraper.Dtos`.

**IWorkerService.cs** — remove `Guid apiKeyId` parameter from `RegisterAsync`:

```csharp
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;

namespace BBWM.WebScraper.Services.Interfaces;

public interface IWorkerService
{
    Task<WorkerConnection> RegisterAsync(Guid userId, string clientName, string extensionVersion,
        string connectionId, CancellationToken ct = default);
    Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default);
    Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default);
}
```

All other interfaces (`IScraperConfigService`, `ITaskService`, `IWorkerNotifier`) copy verbatim — only namespace and using directives change.

**IRunService.cs** — copy verbatim; the `RunDispatchOutcome` enum and `RunDispatchResult` record are defined inside this file and must be copied with it. Only namespace and using directives change.

---

## 8. Service Implementations

All four services change their constructor injection from `WebScrapeDbContext` to `IDbContext`, and all `_db.DbSetProperty` calls become `_db.Set<EntityType>()`.

### Services/Implementations/ScraperConfigService.cs

```csharp
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

    public async Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var configs = await _db.Set<ScraperConfigEntity>()
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<ScraperConfigDto>>(configs);
    }

    public async Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var config = await _db.Set<ScraperConfigEntity>()
            .FirstOrDefaultAsync(c => c.UserId == userId && c.Id == id, ct);
        return config is null ? null : _mapper.Map<ScraperConfigDto>(config);
    }

    public async Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var entity = _mapper.Map<ScraperConfigEntity>(dto);
        entity.Id = Guid.NewGuid();
        entity.UserId = userId;
        entity.SchemaVersion = dto.SchemaVersion > 0 ? dto.SchemaVersion : 3;
        entity.CreatedAt = DateTimeOffset.UtcNow;
        entity.UpdatedAt = DateTimeOffset.UtcNow;
        _db.Set<ScraperConfigEntity>().Add(entity);
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }

    public async Task<ScraperConfigDto?> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var entity = await _db.Set<ScraperConfigEntity>()
            .FirstOrDefaultAsync(c => c.UserId == userId && c.Id == id, ct);
        if (entity is null) return null;
        entity.Name = dto.Name;
        entity.Domain = dto.Domain;
        entity.ConfigJson = System.Text.Json.JsonDocument.Parse(dto.ConfigJson.GetRawText());
        if (dto.SchemaVersion > 0) entity.SchemaVersion = dto.SchemaVersion;
        entity.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }
}
```

### Services/Implementations/TaskService.cs

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

    public async Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var tasks = await _db.Set<TaskEntity>()
            .Where(t => t.UserId == userId)
            .Include(t => t.ScraperConfig)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<TaskDto>>(tasks);
    }

    public async Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var task = await _db.Set<TaskEntity>()
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.UserId == userId && t.Id == id, ct);
        return task is null ? null : _mapper.Map<TaskDto>(task);
    }

    public async Task<TaskDto?> CreateAsync(Guid userId, CreateTaskDto dto, CancellationToken ct = default)
    {
        var configExists = await _db.Set<ScraperConfigEntity>()
            .AnyAsync(c => c.UserId == userId && c.Id == dto.ScraperConfigId, ct);
        if (!configExists) return null;

        var entity = new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            ScraperConfigId = dto.ScraperConfigId,
            SearchTerms = dto.SearchTerms,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.Set<TaskEntity>().Add(entity);
        await _db.SaveChangesAsync(ct);
        return await GetAsync(userId, entity.Id, ct);
    }
}
```

### Services/Implementations/WorkerService.cs

```csharp
using BBWM.Core.Data;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Entities;
using BBWM.WebScraper.Services.Interfaces;
using AutoMapper;
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

    // Deduplication key is userId + clientName. A user's extension instance is identified by the
    // name it registers with. If a connection already exists for that name, we reuse the row.
    public async Task<WorkerConnection> RegisterAsync(Guid userId, string clientName, string extensionVersion,
        string connectionId, CancellationToken ct = default)
    {
        var existing = await _db.Set<WorkerConnection>()
            .FirstOrDefaultAsync(w => w.UserId == userId && w.Name == clientName, ct);

        if (existing is not null)
        {
            existing.CurrentConnection = connectionId;
            existing.ExtensionVersion = extensionVersion;
            existing.LastConnectedAt = DateTimeOffset.UtcNow;
            existing.LastSeenAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(ct);
            return existing;
        }

        var worker = new WorkerConnection
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = clientName,
            CurrentConnection = connectionId,
            ExtensionVersion = extensionVersion,
            LastConnectedAt = DateTimeOffset.UtcNow,
            LastSeenAt = DateTimeOffset.UtcNow,
        };
        _db.Set<WorkerConnection>().Add(worker);
        await _db.SaveChangesAsync(ct);
        return worker;
    }

    public async Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default)
    {
        var worker = await _db.Set<WorkerConnection>()
            .FirstOrDefaultAsync(w => w.CurrentConnection == connectionId, ct);
        if (worker is null) return;

        worker.CurrentConnection = null;
        worker.LastSeenAt = DateTimeOffset.UtcNow;

        var inFlight = await _db.Set<RunItem>()
            .Where(r => r.WorkerId == worker.Id &&
                        (r.Status == RunItemStatus.Sent ||
                         r.Status == RunItemStatus.Running ||
                         r.Status == RunItemStatus.Paused))
            .ToListAsync(ct);

        foreach (var run in inFlight)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = "Worker disconnected";
        }

        await _db.SaveChangesAsync(ct);
    }

    public async Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var workers = await _db.Set<WorkerConnection>()
            .Where(w => w.UserId == userId)
            .OrderBy(w => w.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<WorkerDto>>(workers);
    }
}
```

### Services/Implementations/RunService.cs

```csharp
using System.Text.Json;
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

    public async Task<RunDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId,
        CancellationToken ct = default)
    {
        var task = await _db.Set<TaskEntity>()
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null || task.ScraperConfig is null) return new(RunDispatchOutcome.NotFound, null, null);
        if (task.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, null);

        var worker = await _db.Set<WorkerConnection>()
            .FirstOrDefaultAsync(w => w.Id == workerId, ct);
        if (worker is null) return new(RunDispatchOutcome.NotFound, null, null);
        if (worker.UserId != userId) return new(RunDispatchOutcome.Forbidden, null, null);
        if (worker.CurrentConnection is null) return new(RunDispatchOutcome.WorkerOffline, null, null);

        var run = new RunItem
        {
            Id = Guid.NewGuid(),
            TaskId = taskId,
            WorkerId = workerId,
            Status = RunItemStatus.Pending,
            RequestedAt = DateTimeOffset.UtcNow,
        };
        _db.Set<RunItem>().Add(run);
        await _db.SaveChangesAsync(ct);

        var queueTask = new QueueTaskDto
        {
            Id = run.Id.ToString(),
            ConfigId = task.ScraperConfig.Id.ToString(),
            ConfigName = task.ScraperConfig.Name,
            SearchTerms = task.SearchTerms.ToList(),
            CreatedAt = run.RequestedAt,
            InlineConfig = BuildInlineConfig(task.ScraperConfig),
        };

        try
        {
            await _notifier.SendReceiveTaskAsync(worker.CurrentConnection, queueTask, ct);
            run.Status = RunItemStatus.Sent;
            run.SentAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(ct);
            return new(RunDispatchOutcome.Created, run.Id, null);
        }
        catch (Exception ex)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = ex.Message;
            await _db.SaveChangesAsync(ct);
            return new(RunDispatchOutcome.SendFailed, run.Id, ex.Message);
        }
    }

    public async Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;
        var run = await _db.Set<RunItem>().FindAsync([runId], ct);
        if (run is null) return;
        if (run.Status is RunItemStatus.Sent or RunItemStatus.Paused)
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

    public async Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;
        var run = await _db.Set<RunItem>().FindAsync([runId], ct);
        if (run is null) return;
        run.Status = RunItemStatus.Completed;
        run.CompletedAt = payload.CompletedAt;
        run.ProgressPercent = 100;
        run.ResultJsonb = JsonDocument.Parse(JsonSerializer.Serialize(payload.Result));
        await _db.SaveChangesAsync(ct);
    }

    public async Task FailAsync(TaskErrorDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;
        var run = await _db.Set<RunItem>().FindAsync([runId], ct);
        if (run is null) return;
        run.Status = RunItemStatus.Failed;
        run.ErrorMessage = payload.Error;
        run.CurrentStep = payload.StepLabel;
        await _db.SaveChangesAsync(ct);
    }

    public async Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default)
    {
        if (!Guid.TryParse(payload.TaskId, out var runId)) return;
        var run = await _db.Set<RunItem>().FindAsync([runId], ct);
        if (run is null) return;
        run.Status = RunItemStatus.Paused;
        run.PauseReason = payload.Reason;
        await _db.SaveChangesAsync(ct);
    }

    public async Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var run = await _db.Set<RunItem>()
            .Include(r => r.Task)
            .Include(r => r.Worker)
            .FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null || run.Task is null || run.Task.UserId != userId) return null;
        return _mapper.Map<RunItemDto>(run);
    }

    private static JsonElement BuildInlineConfig(ScraperConfigEntity config)
    {
        var raw = config.ConfigJson.RootElement.GetRawText();
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }
}
```

---

## 9. Services/Hubs/ScraperHubWorkerNotifier.cs

Copy verbatim from `WebScrape.Server/Hubs/ScraperHubWorkerNotifier.cs`. Change namespace to `BBWM.WebScraper.Services.Hubs` and update using directives to `BBWM.WebScraper.Hubs` and `BBWM.WebScraper.Dtos`.

---

## 10. Hubs/ScraperHub.cs

Key changes vs source:
- Remove `[Authorize(AuthenticationSchemes = ...)]` → `[Authorize]`
- Remove `RequireApiKeyId()` and `ApiKeyIdClaim` usage
- `RegisterWorker` calls `_workers.RegisterAsync` without `apiKeyId`

```csharp
using System.Security.Claims;
using BBWM.WebScraper.Dtos;
using BBWM.WebScraper.Services.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BBWM.WebScraper.Hubs;

[Authorize]
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
        var userId = TryGetUserId();
        if (userId is not null)
            await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await _workers.HandleDisconnectAsync(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async Task RegisterWorker(string clientId, string extensionVersion)
    {
        var userId = RequireUserId();
        await _workers.RegisterAsync(userId, clientId, extensionVersion, Context.ConnectionId);
    }

    public async Task TaskProgress(TaskProgressDto payload)
        => await _runs.RecordProgressAsync(payload);

    public async Task TaskComplete(TaskCompleteDto payload)
        => await _runs.CompleteAsync(payload);

    public async Task TaskError(TaskErrorDto payload)
        => await _runs.FailAsync(payload);

    public async Task TaskPaused(TaskPausedDto payload)
        => await _runs.MarkPausedAsync(payload);

    private Guid? TryGetUserId()
    {
        var claim = Context.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(claim, out var id) ? id : null;
    }

    private Guid RequireUserId()
        => TryGetUserId() ?? throw new HubException("Unauthorised");
}
```

---

## 11. Controllers

All four controllers:
- Change `[Authorize(AuthenticationSchemes = "...")]` → `[Authorize]`
- Remove `[CookieCsrf]` attribute entirely — it lives in `WebScrape.Server` and will not exist in the module
- Change namespace to `BBWM.WebScraper.Controllers`
- Update using directives to `BBWM.WebScraper.Dtos` and `BBWM.WebScraper.Services.Interfaces`
- User ID extraction: the source controllers may call a `GetUserId()` helper defined in a `WebScrape.Server` base class. That helper will not exist in the module. Replace every call to it with the inline form:
  ```csharp
  var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
  ```
  Add `using System.Security.Claims;` if not already present.

All route attributes, action method signatures, and status code logic are otherwise identical to the source.

### Controllers/RunsController.cs — status code mapping (copy exactly):

```
RunDispatchOutcome.Created     → 201 Created
RunDispatchOutcome.NotFound    → 404 NotFound
RunDispatchOutcome.Forbidden   → 403 Forbidden
RunDispatchOutcome.WorkerOffline → 409 Conflict
RunDispatchOutcome.SendFailed  → 502 BadGateway
```

---

## 12. Test project changes

### Tests to DELETE from WebScrape.Tests:

- `tests/WebScrape.Tests/Auth/PatAuthenticationHandlerTests.cs`
- `tests/WebScrape.Tests/Security/ApiKeyServiceTests.cs`
- `tests/WebScrape.Tests/Security/ApiKeyTokenGeneratorTests.cs`
- `tests/WebScrape.Tests/Security/Argon2idApiKeyHasherTests.cs`

### WebScrape.Tests.csproj — add project reference:

```xml
<ProjectReference Include="..\..\src\BBWM.WebScraper\BBWM.WebScraper.csproj" />
```

Remove project references to `WebScrape.Services` and `WebScrape.Data`.

### New file: tests/WebScrape.Tests/TestSupport/TestWebScraperDbContext.cs

```csharp
using BBWM.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace WebScrape.Tests.TestSupport;

// Minimal DbContext that implements IDbContext for use in tests.
// Applies the same entity configurations as the real module.
public class TestWebScraperDbContext : DbContext, IDbContext
{
    public TestWebScraperDbContext(DbContextOptions<TestWebScraperDbContext> options) : base(options) { }

    protected override void OnModelCreating(ModelBuilder builder)
        => builder.ApplyConfigurationsFromAssembly(typeof(BBWM.WebScraper.WebScraperModuleLinkage).Assembly);
}
```

### Updated: tests/WebScrape.Tests/TestSupport/TestDb.cs

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

### Updated: tests/WebScrape.Tests/Services/WorkerServiceTests.cs

- Remove all `ApiKey` setup and `apiKeyId` parameters
- `_workers.RegisterAsync(userId, clientName, extensionVersion, connectionId)` — no apiKeyId arg
- Test "Register reuses row for same user/api key" → rename to "Register reuses row for same user and client name"
- All assertions on `WorkerConnection.ApiKeyId` → remove

### Updated: tests/WebScrape.Tests/Services/RunServiceTests.cs

- No ApiKey setup needed
- Worker creation: `new WorkerConnection { UserId = userId, Name = "test", ... }` — no ApiKeyId
- All other test logic unchanged

---

## Verification

### Step 1 — Register in solution and build

```bash
dotnet sln webscrape/WebScrape.sln add webscrape/src/BBWM.WebScraper/BBWM.WebScraper.csproj
dotnet build webscrape/src/BBWM.WebScraper/BBWM.WebScraper.csproj
```

Expected: 0 errors, 0 warnings.

### Step 2 — Run tests

```bash
dotnet test webscrape/tests/WebScrape.Tests/
```

Expected: all passing. PAT tests deleted, service tests updated.

### Step 3 — Install into pharmacy-planet and generate migration

```bash
# Copy module into host
cp -r webscrape/src/BBWM.WebScraper pharmacy-planet/modules/BBWM.WebScraper

# Update csproj: change the BBWM.Core reference from the cross-repo dev path
# to the within-solution sibling (see comment in csproj)
# Replace: ..\..\..\pharmacy-planet\modules\BBWM.Core\BBWM.Core.csproj
# With:    ..\BBWM.Core\BBWM.Core.csproj

# Register in solution and generate migration
dotnet sln pharmacy-planet/BBWT.sln add pharmacy-planet/modules/BBWM.WebScraper/BBWM.WebScraper.csproj
dotnet ef migrations add WebScraperModule --project BBWT.Data --startup-project BBWT.Server
```

Inspect the generated migration file. Confirm:
- 4 tables created: `ScraperConfigs`, `Tasks`, `WorkerConnections`, `RunItems`
- `ConfigJson` and `ResultJsonb` are `nvarchar(max)`
- `SearchTerms` is `nvarchar(max)`
- No `ApiKeys` table, no `AspNetUsers` table

### Step 4 — Start pharmacy-planet

```bash
dotnet run --project BBWT.Server
```

Confirm no startup exceptions (AutoMapper conflict, missing service, EF error).

### Step 5 — Manual smoke test

1. Log into pharmacy-planet as a valid user
2. `GET /api/scraper-configs` → 200, empty array
3. `POST /api/scraper-hub/negotiate` (with auth cookie/JWT) → 200
4. Point extension's `defaultServerUrl` at pharmacy-planet local URL
5. Confirm SignalR connects (`RegisterWorker` visible in server logs)
6. Unauthenticated `GET /api/scraper-configs` → 401

---

## What is NOT in this spec (deferred)

- `IInitialDataModuleLinkage` seed data (drop the testbed's seed users for now)
- `WebScraper.Access` permission gate (plain `[Authorize]` for v1)
- UserId cascade delete (no FK constraint to `AspNetUsers` — application layer owns cleanup)
- NuGet packaging — copy-into-host is the install process for now; migrate to `dotnet pack` + private feed when a third host needs it
