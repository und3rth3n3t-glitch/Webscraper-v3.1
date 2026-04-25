using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
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
        var userId = GetUserId();
        return Ok(await _configs.ListAsync(userId, ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        var dto = await _configs.GetAsync(userId, id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var userId = GetUserId();
        var created = await _configs.CreateAsync(userId, dto, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(Guid id, [FromBody] CreateScraperConfigDto dto, CancellationToken ct)
    {
        var userId = GetUserId();
        var updated = await _configs.UpdateAsync(userId, id, dto, ct);
        return updated is null ? NotFound() : Ok(updated);
    }

    private Guid GetUserId() => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
}
