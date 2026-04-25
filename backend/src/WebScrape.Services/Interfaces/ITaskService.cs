using WebScrape.Data.Dto;

namespace WebScrape.Services.Interfaces;

public enum SaveTaskOutcome
{
    Created,
    Updated,
    NotFound,
    Forbidden,
    ValidationFailed,
}

public record SaveTaskResult(SaveTaskOutcome Outcome, TaskDto? Task, List<ValidationErrorDto> Errors);

public enum DeleteTaskOutcome
{
    Deleted,
    NotFound,
    Forbidden,
}

public interface ITaskService
{
    Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default);
    Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default);
    Task<SaveTaskResult> SaveAsync(Guid userId, Guid? taskId, SaveTaskDto dto, CancellationToken ct = default);
    Task<DeleteTaskOutcome> DeleteAsync(Guid userId, Guid taskId, CancellationToken ct = default);
}
