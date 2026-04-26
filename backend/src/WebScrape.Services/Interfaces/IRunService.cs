using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum RunExportOutcome { Ok, NotFound, Forbidden, NotTabular, BadFormat, NotReady }

public record RunExportResult(
    RunExportOutcome Outcome,
    byte[]? Bytes,
    string? Filename,
    string? ContentType);

public interface IRunService
{
    Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default);
    Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default);
    Task FailAsync(TaskErrorDto payload, CancellationToken ct = default);
    Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default);
    Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<PagedResultDto<RunListItemDto>> ListAsync(Guid userId, RunListQueryDto query, CancellationToken ct = default);
    Task<RunExportResult> ExportAsync(Guid userId, Guid runId, string format, CancellationToken ct = default);
    Task<bool> CancelAsync(Guid userId, Guid runId, CancellationToken ct = default);
}
