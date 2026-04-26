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

public enum RunBatchExportOutcome { Ok, NotFound, Forbidden, BadFormat }

public record RunBatchExportResult(
    RunBatchExportOutcome Outcome,
    byte[]? Bytes,
    string? Filename,
    string? ContentType);

public interface IRunBatchService
{
    Task<RunBatchDispatchResult> CreateAndDispatchAsync(Guid userId, Guid taskId, Guid workerId, CancellationToken ct = default);
    Task<RunBatchDetailDto?> GetAsync(Guid userId, Guid batchId, CancellationToken ct = default);
    Task<PagedResultDto<RunBatchListItemDto>> ListAsync(Guid userId, RunBatchListQueryDto query, CancellationToken ct = default);
    Task<RunBatchExportResult> ExportAsync(Guid userId, Guid batchId, string format, CancellationToken ct = default);
}
