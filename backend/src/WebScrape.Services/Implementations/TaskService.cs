using System.Text.Json;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class TaskService : ITaskService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;
    private readonly ITaskValidator _validator;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public TaskService(WebScrapeDbContext db, IMapper mapper, ITaskValidator validator)
    {
        _db = db;
        _mapper = mapper;
        _validator = validator;
    }

    public async Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.Blocks)
            .Where(t => t.UserId == userId)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<TaskDto>>(rows);
    }

    public async Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.Blocks)
            .FirstOrDefaultAsync(t => t.Id == id && t.UserId == userId, ct);
        return row is null ? null : _mapper.Map<TaskDto>(row);
    }

    public async Task<SaveTaskResult> SaveAsync(Guid userId, Guid? taskId, SaveTaskDto dto, CancellationToken ct = default)
    {
        // Check task ownership BEFORE validation so the caller gets Forbidden rather than a
        // spurious ValidationFailed (e.g. CONFIG_NOT_OWNED against the real owner's config).
        TaskEntity? existingTask = null;
        if (taskId.HasValue)
        {
            existingTask = await _db.Tasks
                .Include(t => t.Blocks)
                .FirstOrDefaultAsync(t => t.Id == taskId.Value, ct);
            if (existingTask is null)
                return new SaveTaskResult(SaveTaskOutcome.NotFound, null, new());
            if (existingTask.UserId != userId)
                return new SaveTaskResult(SaveTaskOutcome.Forbidden, null, new());
        }

        var errors = await _validator.ValidateAsync(userId, dto, ct);
        if (errors.Count > 0)
            return new SaveTaskResult(SaveTaskOutcome.ValidationFailed, null, errors);

        TaskEntity task;
        bool isCreate;

        if (existingTask is not null)
        {
            existingTask.Name = dto.Name;
            _db.TaskBlocks.RemoveRange(existingTask.Blocks);
            existingTask.Blocks.Clear();
            task = existingTask;
            isCreate = false;
        }
        else
        {
            task = new TaskEntity
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                Name = dto.Name,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            _db.Tasks.Add(task);
            isCreate = true;
        }

        foreach (var blockDto in dto.Blocks)
        {
            var block = new TaskBlock
            {
                Id = blockDto.Id,
                TaskId = task.Id,
                ParentBlockId = blockDto.ParentBlockId,
                BlockType = blockDto.BlockType,
                OrderIndex = blockDto.OrderIndex,
                ConfigJsonb = SerializeBlockConfig(blockDto),
            };
            _db.TaskBlocks.Add(block);
        }

        await _db.SaveChangesAsync(ct);

        var saved = await GetAsync(userId, task.Id, ct);
        return new SaveTaskResult(isCreate ? SaveTaskOutcome.Created : SaveTaskOutcome.Updated, saved, new());
    }

    public async Task<DeleteTaskOutcome> DeleteAsync(Guid userId, Guid taskId, CancellationToken ct = default)
    {
        var task = await _db.Tasks.FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null) return DeleteTaskOutcome.NotFound;
        if (task.UserId != userId) return DeleteTaskOutcome.Forbidden;

        _db.Tasks.Remove(task);
        await _db.SaveChangesAsync(ct);
        return DeleteTaskOutcome.Deleted;
    }

    private static JsonDocument SerializeBlockConfig(TaskBlockTreeDto block)
    {
        return block.BlockType switch
        {
            BlockType.Loop   => JsonSerializer.SerializeToDocument(block.Loop ?? new LoopBlockConfigDto(), JsonOpts),
            BlockType.Scrape => JsonSerializer.SerializeToDocument(block.Scrape ?? new ScrapeBlockConfigDto(), JsonOpts),
            _ => JsonDocument.Parse("{}"),
        };
    }
}
