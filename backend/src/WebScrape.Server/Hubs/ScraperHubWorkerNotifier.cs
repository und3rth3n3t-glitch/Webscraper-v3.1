using Microsoft.AspNetCore.SignalR;
using WebScrape.Data.Dto;
using WebScrape.Services.Hubs;

namespace WebScrape.Server.Hubs;

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
