using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Hubs;

[Authorize(AuthenticationSchemes = PatAuthenticationOptions.Scheme)]
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
        var userId = Context.User.TryGetUserId();
        if (userId is not null)
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
        var userId = Context.User.TryGetUserId() ?? throw new HubException("Missing user claim");
        var apiKeyId = Context.User.TryGetApiKeyId() ?? throw new HubException("Missing api key claim");
        return _workers.RegisterAsync(userId, apiKeyId, clientId, extensionVersion, Context.ConnectionId);
    }

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
}
