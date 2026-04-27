using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/api-keys")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class ApiKeysController : ControllerBase
{
    private readonly IApiKeyService _apiKeys;

    public ApiKeysController(IApiKeyService apiKeys)
    {
        _apiKeys = apiKeys;
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] CreateApiKeyDto dto, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dto.Name)) return BadRequest(new { error = "Name is required" });
        var created = await _apiKeys.CreateAsync(User.GetUserId(), dto.Name, ct);
        return Ok(created);
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var list = await _apiKeys.ListAsync(User.GetUserId(), ct);
        return Ok(list);
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Revoke(Guid id, CancellationToken ct)
    {
        var ok = await _apiKeys.RevokeAsync(User.GetUserId(), id, ct);
        if (!ok) return NotFound();
        return NoContent();
    }

    [HttpPatch("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Rename(Guid id, [FromBody] RenameApiKeyDto dto, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dto?.Name)) return BadRequest(new { error = "Name is required" });
        var updated = await _apiKeys.RenameAsync(User.GetUserId(), id, dto.Name, ct);
        if (updated is null) return NotFound();
        return Ok(updated);
    }
}
