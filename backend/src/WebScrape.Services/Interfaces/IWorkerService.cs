using WebScrape.Data.Dto;
using WebScrape.Data.Entities;

namespace WebScrape.Services.Interfaces;

public interface IWorkerService
{
    Task<WorkerConnection> RegisterAsync(Guid userId, Guid apiKeyId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default);
    Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default);
    Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default);
}
