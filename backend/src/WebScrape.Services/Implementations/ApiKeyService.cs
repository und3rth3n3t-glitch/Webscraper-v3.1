using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Services.Interfaces;
using WebScrape.Services.Security;

namespace WebScrape.Services.Implementations;

public class ApiKeyService : IApiKeyService
{
    private readonly WebScrapeDbContext _db;
    private readonly IApiKeyHasher _hasher;
    private readonly IApiKeyTokenGenerator _tokens;
    private readonly IMapper _mapper;

    public ApiKeyService(WebScrapeDbContext db, IApiKeyHasher hasher, IApiKeyTokenGenerator tokens, IMapper mapper)
    {
        _db = db;
        _hasher = hasher;
        _tokens = tokens;
        _mapper = mapper;
    }

    public async Task<CreateApiKeyResponseDto> CreateAsync(Guid userId, string name, CancellationToken ct = default)
    {
        var token = _tokens.Generate();
        var prefix = _tokens.GetPrefix(token);
        var hash = _hasher.Hash(token);

        var key = new ApiKey
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = name,
            Hash = hash,
            Prefix = prefix,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.ApiKeys.Add(key);
        await _db.SaveChangesAsync(ct);

        return new CreateApiKeyResponseDto
        {
            Id = key.Id,
            Name = key.Name,
            Prefix = key.Prefix,
            Token = token,
        };
    }

    public async Task<List<ApiKeyDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var keys = await _db.ApiKeys
            .AsNoTracking()
            .Where(k => k.UserId == userId)
            .OrderByDescending(k => k.CreatedAt)
            .ToListAsync(ct);
        return _mapper.Map<List<ApiKeyDto>>(keys);
    }

    public async Task<bool> RevokeAsync(Guid userId, Guid id, CancellationToken ct = default)
    {
        var key = await _db.ApiKeys.FirstOrDefaultAsync(k => k.Id == id && k.UserId == userId, ct);
        if (key is null) return false;
        if (key.RevokedAt is not null) return true;
        key.RevokedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }
}
