using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
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
        var userId = GetUserId();
        var created = await _apiKeys.CreateAsync(userId, dto.Name, ct);
        return Ok(created);
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = GetUserId();
        var list = await _apiKeys.ListAsync(userId, ct);
        return Ok(list);
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Revoke(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        var ok = await _apiKeys.RevokeAsync(userId, id, ct);
        if (!ok) return NotFound();
        return NoContent();
    }

    private Guid GetUserId() => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
}
