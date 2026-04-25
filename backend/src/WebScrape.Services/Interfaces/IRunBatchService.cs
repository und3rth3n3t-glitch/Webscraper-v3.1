using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum RunBatchOutcome
{
    Created,
    NotFound,
    Forbidden,
    WorkerOffline,
    BatchEmpty,
    BatchTooLarge,
}

public record RunBatchDispatchResult(
    RunBatchOutcome Outcome,
    Guid? BatchId,
    int DispatchedCount,
    int FailedCount,
    string? Error);

public interface IRunBatchService
{
    Task<RunBatchDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task<RunBatchDetailDto?> GetAsync(Guid userId, Guid batchId, CancellationToken ct = default);
}
