using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public interface IRunService
{
    Task RecordProgressAsync(TaskProgressDto payload, CancellationToken ct = default);
    Task CompleteAsync(TaskCompleteDto payload, CancellationToken ct = default);
    Task FailAsync(TaskErrorDto payload, CancellationToken ct = default);
    Task MarkPausedAsync(TaskPausedDto payload, CancellationToken ct = default);
    Task<RunItemDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
}
