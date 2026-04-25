using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;
using WebScrape.Services.Interfaces;

namespace WebScrape.Services.Implementations;

public class WorkerService : IWorkerService
{
    private readonly WebScrapeDbContext _db;
    private readonly IMapper _mapper;

    public WorkerService(WebScrapeDbContext db, IMapper mapper)
    {
        _db = db;
        _mapper = mapper;
    }

    public async Task<WorkerConnection> RegisterAsync(Guid userId, Guid apiKeyId, string clientName, string extensionVersion, string connectionId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.UserId == userId && w.ApiKeyId == apiKeyId, ct);
        var now = DateTimeOffset.UtcNow;

        if (worker is null)
        {
            worker = new WorkerConnection
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                ApiKeyId = apiKeyId,
                Name = string.IsNullOrWhiteSpace(clientName) ? "My Browser" : clientName,
            };
            _db.WorkerConnections.Add(worker);
        }
        else if (!string.IsNullOrWhiteSpace(clientName))
        {
            worker.Name = clientName;
        }

        worker.CurrentConnection = connectionId;
        worker.ExtensionVersion = extensionVersion;
        worker.LastConnectedAt = now;
        worker.LastSeenAt = now;

        await _db.SaveChangesAsync(ct);
        return worker;
    }

    public async Task HandleDisconnectAsync(string connectionId, CancellationToken ct = default)
    {
        var worker = await _db.WorkerConnections.FirstOrDefaultAsync(w => w.CurrentConnection == connectionId, ct);
        if (worker is null) return;

        var now = DateTimeOffset.UtcNow;
        worker.CurrentConnection = null;
        worker.LastSeenAt = now;

        var inFlightStatuses = new[] { RunItemStatus.Sent, RunItemStatus.Running, RunItemStatus.Paused };
        var inFlight = await _db.RunItems
            .Where(r => r.WorkerId == worker.Id && inFlightStatuses.Contains(r.Status))
            .ToListAsync(ct);

        foreach (var run in inFlight)
        {
            run.Status = RunItemStatus.Failed;
            run.ErrorMessage = "Worker disconnected";
            run.CompletedAt = now;
        }

        await _db.SaveChangesAsync(ct);
    }

    public async Task<List<WorkerDto>> ListAsync(Guid userId, CancellationToken ct = default)
    {
        var workers = await _db.WorkerConnections
            .AsNoTracking()
            .Where(w => w.UserId == userId)
            .OrderBy(w => w.Name)
            .ToListAsync(ct);
        return _mapper.Map<List<WorkerDto>>(workers);
    }
}
