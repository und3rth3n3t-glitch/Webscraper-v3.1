using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/runs")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class RunsController : ControllerBase
{
    private readonly IRunService _runs;

    public RunsController(IRunService runs)
    {
        _runs = runs;
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] CreateRunDto dto, CancellationToken ct)
    {
        var userId = GetUserId();
        var result = await _runs.CreateAndDispatchAsync(userId, dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            RunDispatchOutcome.Created => CreatedAtAction(nameof(Get), new { id = result.RunItemId }, new { runItemId = result.RunItemId }),
            RunDispatchOutcome.NotFound => NotFound(new { error = result.Error }),
            RunDispatchOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            RunDispatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            RunDispatchOutcome.SendFailed => StatusCode(StatusCodes.Status502BadGateway, new { runItemId = result.RunItemId, error = result.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var userId = GetUserId();
        var dto = await _runs.GetAsync(userId, id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    private Guid GetUserId() => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
}
