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

    public ScraperConfigsController(IScraperConfigService configs)
    {
        _configs = configs;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
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
        var created = await _configs.CreateAsync(User.GetUserId(), dto, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(Guid id, [FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var updated = await _configs.UpdateAsync(User.GetUserId(), id, dto, ct);
        return updated is null ? NotFound() : Ok(updated);
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

}
