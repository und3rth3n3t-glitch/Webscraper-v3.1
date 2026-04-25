using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class TaskService : ITaskService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;

    public TaskService(WebScrapeDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<List<TaskDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .Where(t => t.UserId == userId)
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<TaskDto>>(rows);
    }

    public async Task<TaskDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.Tasks
            .AsNoTracking()
            .Include(t => t.ScraperConfig)
            .FirstOrDefaultAsync(t => t.Id == id && t.UserId == userId, ct);
        return row is null ? null : _mapper.Map<TaskDto>(row);
    }

    public async Task<TaskDto?> CreateAsync(Guid userId, CreateTaskDto dto, CancellationToken ct = default)
    {
        var configExists = await _db.ScraperConfigs.AnyAsync(c => c.Id == dto.ScraperConfigId && c.UserId == userId, ct);
        if (!configExists) return null;

        var entity = new TaskEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            ScraperConfigId = dto.ScraperConfigId,
            SearchTerms = dto.SearchTerms ?? Array.Empty<string>(),
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.Tasks.Add(entity);
        await _db.SaveChangesAsync(ct);

        return await GetAsync(userId, entity.Id, ct);
    }
}
