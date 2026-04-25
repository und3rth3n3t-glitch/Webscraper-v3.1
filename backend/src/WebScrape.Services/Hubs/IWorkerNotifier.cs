using WebScrape.Data.Dto;

namespace WebScrape.Services.Hubs;

public interface IWorkerNotifier
{
    Task SendReceiveTaskAsync(string connectionId, QueueTaskDto task, CancellationToken ct = default);
    Task SendCancelTaskAsync(string connectionId, string taskId, CancellationToken ct = default);
    Task SendResumeAfterPauseAsync(string connectionId, string taskId, CancellationToken ct = default);
}
