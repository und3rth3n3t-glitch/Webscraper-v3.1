using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public interface ITaskService
{
    Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<TaskDto?> CreateAsync(Guid userId, CreateTaskDto dto, CancellationToken ct = default);
}
