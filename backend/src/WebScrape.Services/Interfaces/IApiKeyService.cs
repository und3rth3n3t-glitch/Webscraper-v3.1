using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public interface IApiKeyService
{
    Task<CreateApiKeyResponseDto> CreateAsync(Guid userId, string name, CancellationToken ct = default);
    Task<List<ApiKeyDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<bool> RevokeAsync(Guid userId, Guid id, CancellationToken ct = default);
}
