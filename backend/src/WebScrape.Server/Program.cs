using System.Text.Json;
using AspNetCoreRateLimit;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Serilog;
using WebScrape.Data;
using WebScrape.Data.Entities;
using WebScrape.Data.Mapping;
using WebScrape.Server.Auth;
using WebScrape.Server.Hubs;
using WebScrape.Server.Seed;
using WebScrape.Services.Hubs;
using WebScrape.Services.Implementations;
using WebScrape.Services.Interfaces;
using WebScrape.Services.Security;

var builder = WebApplication.CreateBuilder(args);

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

var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("ConnectionStrings:Default is required");

builder.Services.AddDbContext<WebScrapeDbContext>(options =>
    options.UseNpgsql(connectionString)
        .UseSnakeCaseNamingConvention());

builder.Services
    .AddIdentity<User, IdentityRole<Guid>>(opts =>
    {
        opts.Password.RequiredLength = 8;
        opts.Password.RequireDigit = false;
        opts.Password.RequireUppercase = false;
        opts.Password.RequireLowercase = false;
        opts.Password.RequireNonAlphanumeric = false;
        opts.Lockout.MaxFailedAccessAttempts = 5;
        opts.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
        opts.User.RequireUniqueEmail = true;
    })
    .AddEntityFrameworkStores<WebScrapeDbContext>()
    .AddDefaultTokenProviders();

builder.Services.ConfigureApplicationCookie(opts =>
{
    opts.Cookie.Name = "ws_auth";
    opts.Cookie.HttpOnly = true;
    opts.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
    opts.Cookie.SameSite = SameSiteMode.Lax;
    opts.ExpireTimeSpan = TimeSpan.FromDays(14);
    opts.SlidingExpiration = true;
    opts.Events.OnRedirectToLogin = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    };
    opts.Events.OnRedirectToAccessDenied = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    };
});

builder.Services
    .AddAuthentication()
    .AddScheme<PatAuthenticationOptions, PatAuthenticationHandler>(PatAuthenticationOptions.Scheme, _ => { });

builder.Services.AddAuthorization();

builder.Services.AddSingleton<IApiKeyHasher, Argon2idApiKeyHasher>();
builder.Services.AddSingleton<IApiKeyTokenGenerator, ApiKeyTokenGenerator>();
builder.Services.AddSingleton<IRunCsvExporter, RunCsvExporter>();

builder.Services.AddScoped<IApiKeyService, ApiKeyService>();
builder.Services.AddScoped<IWorkerService, WorkerService>();
builder.Services.AddScoped<IRunService, RunService>();
builder.Services.AddScoped<IScraperConfigService, ScraperConfigService>();
builder.Services.AddScoped<ITaskService, TaskService>();
builder.Services.AddScoped<ITaskValidator, TaskValidator>();
builder.Services.AddScoped<IQueueExpansionService>(sp => {
    var db = sp.GetRequiredService<WebScrapeDbContext>();
    var scrape = new WebScrape.Services.Expansion.ScrapeBlockExpander();
    var all = new List<WebScrape.Services.Expansion.IBlockExpander>();
    var loop = new WebScrape.Services.Expansion.LoopBlockExpander(all);
    all.Add(loop);
    all.Add(scrape);
    return new QueueExpansionService(db, all);
});
builder.Services.AddScoped<IRunBatchService, RunBatchService>();
builder.Services.AddScoped<IWorkerNotifier, ScraperHubWorkerNotifier>();

builder.Services.AddAutoMapper(typeof(AutoMapperProfile));

builder.Services.AddSignalR(hubOpts =>
{
    hubOpts.MaximumReceiveMessageSize = 10 * 1024 * 1024; // 10 MB
})
    .AddJsonProtocol(opts =>
    {
        opts.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        opts.PayloadSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

builder.Services.AddControllers()
    .AddJsonOptions(opts =>
    {
        opts.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        opts.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
        opts.JsonSerializerOptions.Converters.Add(
            new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

builder.Services.AddOptions();
builder.Services.AddMemoryCache();
builder.Services.Configure<IpRateLimitOptions>(builder.Configuration.GetSection("IpRateLimiting"));
builder.Services.AddInMemoryRateLimiting();
builder.Services.AddSingleton<IRateLimitConfiguration, RateLimitConfiguration>();

builder.Services.AddHostedService<SeedHostedService>();

var app = builder.Build();

app.UseSerilogRequestLogging();
app.UseIpRateLimiting();

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapHub<ScraperHub>(new PatAuthenticationOptions().HubPath);

app.Run();

public partial class Program { }
