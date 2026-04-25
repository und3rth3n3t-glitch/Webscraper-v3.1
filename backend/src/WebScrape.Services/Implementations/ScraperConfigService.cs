using System.Text.Json;
using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class ScraperConfigService : IScraperConfigService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;

    public ScraperConfigService(WebScrapeDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<List<ScraperConfigDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var rows = await _db.ScraperConfigs
            .AsNoTracking()
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<ScraperConfigDto>>(rows);
    }

    public async Task<ScraperConfigDto?> GetAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var row = await _db.ScraperConfigs.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        return row is null ? null : _mapper.Map<ScraperConfigDto>(row);
    }

    public async Task<ScraperConfigDto> CreateAsync(Guid userId, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var entity = new ScraperConfigEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = dto.Name,
            Domain = dto.Domain,
            ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText()),
            SchemaVersion = dto.SchemaVersion <= 0 ? 3 : dto.SchemaVersion,
            CreatedAt = now,
            UpdatedAt = now,
        };
        _db.ScraperConfigs.Add(entity);
        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }

    public async Task<ScraperConfigDto?> UpdateAsync(Guid userId, Guid id, CreateScraperConfigDto dto, CancellationToken ct = default)
    {
        var entity = await _db.ScraperConfigs.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (entity is null) return null;

        entity.Name = dto.Name;
        entity.Domain = dto.Domain;
        entity.ConfigJson = JsonDocument.Parse(dto.ConfigJson.GetRawText());
        if (dto.SchemaVersion > 0) entity.SchemaVersion = dto.SchemaVersion;
        entity.UpdatedAt = DateTimeOffset.UtcNow;

        await _db.SaveChangesAsync(ct);
        return _mapper.Map<ScraperConfigDto>(entity);
    }
}
