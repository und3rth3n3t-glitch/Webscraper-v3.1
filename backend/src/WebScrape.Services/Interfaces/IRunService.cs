using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

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
    Task<RunDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default);
    Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default);
    Task FailAsync(TaskErrorDto payload, CancellationToken ct = default);
    Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default);
    Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
}
