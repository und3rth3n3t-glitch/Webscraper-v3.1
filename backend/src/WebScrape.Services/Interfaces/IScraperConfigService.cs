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

public interface IScraperConfigService
{
    Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, CancellationToken ct = default);
    Task<ScraperConfigDto?> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default);
    Task<DeleteScraperConfigResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct = default);
}
