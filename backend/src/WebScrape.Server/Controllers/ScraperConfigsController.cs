using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/scraper-configs")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.CookieAndPat)]
public class ScraperConfigsController : ControllerBase
{
    private readonly IScraperConfigService _configs;
    private readonly IWorkerService _workers;

    public ScraperConfigsController(IScraperConfigService configs, IWorkerService workers)
    {
        _configs = configs;
        _workers = workers;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool? shared, CancellationToken ct)
    {
        if (shared == true)
            return Ok(await _configs.ListSharedAsync(User.GetUserId(), ct));
        return Ok(await _configs.ListAsync(User.GetUserId(), ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _configs.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);
        var result = await _configs.CreateAsync(User.GetUserId(), dto, workerId, ct);
        return result.Outcome switch
        {
            CreateScraperConfigOutcome.Created => CreatedAtAction(nameof(Get), new { id = result.Dto.Id }, result.Dto),
            CreateScraperConfigOutcome.Idempotent => Ok(result.Dto),
            CreateScraperConfigOutcome.Conflict => StatusCode(StatusCodes.Status409Conflict, result.Dto),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(
        Guid id,
        [FromBody] CreateScraperConfigDto dto,
        [FromHeader(Name = "If-Match")] string? ifMatch,
        CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);

        // Cookie auth bypasses If-Match (canonical backend edit).
        // PAT auth passes If-Match through — service enforces presence for shared configs.
        var effectiveIfMatch = workerId.HasValue ? ifMatch : null;

        var result = await _configs.UpdateAsync(User.GetUserId(), id, dto, effectiveIfMatch, workerId, ct);

        return result.Outcome switch
        {
            UpdateScraperConfigOutcome.Updated => Ok(result.Dto),
            UpdateScraperConfigOutcome.NotFound => NotFound(),
            UpdateScraperConfigOutcome.PreconditionFailed => StatusCode(StatusCodes.Status412PreconditionFailed, result.Current),
            UpdateScraperConfigOutcome.PreconditionRequired => StatusCode(428, new { error = "Shared config requires If-Match header on PAT requests" }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var result = await _configs.DeleteAsync(User.GetUserId(), id, ct);
        return result.Outcome switch
        {
            DeleteScraperConfigOutcome.Deleted   => NoContent(),
            DeleteScraperConfigOutcome.NotFound  => NotFound(),
            DeleteScraperConfigOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            DeleteScraperConfigOutcome.Referenced => Conflict(new
            {
                code = "CONFIG_REFERENCED",
                referencingTaskCount = result.ReferencingTaskCount,
                error = $"This config is used by {result.ReferencingTaskCount} task{(result.ReferencingTaskCount == 1 ? "" : "s")}. Delete or update those tasks first.",
            }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpGet("{id:guid}/subscribers")]
    public async Task<IActionResult> GetSubscribers(Guid id, CancellationToken ct)
    {
        var subs = await _configs.GetSubscribersAsync(User.GetUserId(), id, ct);
        if (subs is null) return NotFound();
        return Ok(subs);
    }

    [HttpPost("{id:guid}/subscribe")]
    [CookieCsrf]
    public async Task<IActionResult> Subscribe(Guid id, CancellationToken ct)
    {
        var workerId = await ResolveWorkerIdAsync(ct);
        if (!workerId.HasValue) return Forbid();

        var config = await _configs.GetAsync(User.GetUserId(), id, ct);
        if (config is null) return NotFound();

        await _configs.RecordSubscriptionAsync(id, workerId.Value, ct);
        return Ok();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task<Guid?> ResolveWorkerIdAsync(CancellationToken ct)
    {
        var apiKeyId = User.TryGetApiKeyId();
        if (!apiKeyId.HasValue) return null;
        var worker = await _workers.GetWorkerByApiKeyAsync(User.GetUserId(), apiKeyId.Value, ct);
        return worker?.Id;
    }
}
