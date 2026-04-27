using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum DeleteScraperConfigOutcome
{
    Deleted,
    NotFound,
    Forbidden,
    Referenced,
}

public record DeleteScraperConfigResult(DeleteScraperConfigOutcome Outcome, int ReferencingTaskCount);

public enum UpdateScraperConfigOutcome
{
    Updated,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
}

public record UpdateScraperConfigResult(
    UpdateScraperConfigOutcome Outcome,
    ScraperConfigDto? Dto,
    ScraperConfigDto? Current);

public enum CreateScraperConfigOutcome
{
    Created,
    Idempotent,
    Conflict,
}

public record CreateScraperConfigResult(
    CreateScraperConfigOutcome Outcome,
    ScraperConfigDto Dto);

public interface IScraperConfigService
{
    Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<List<ScraperConfigDto>> ListSharedAsync(Guid userId, CancellationToken ct = default);
    Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<CreateScraperConfigResult> CreateAsync(Guid userId, CreateScraperConfigDto dto, Guid? workerId = null, CancellationToken ct = default);
    Task<UpdateScraperConfigResult> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, string? ifMatch = null, Guid? workerId = null, CancellationToken ct = default);
    Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<List<ScraperConfigSubscriberDto>?> GetSubscribersAsync(Guid userId, Guid configId, CancellationToken ct = default);
    Task RecordSubscriptionAsync(Guid configId, Guid workerId, CancellationToken ct = default);
}
