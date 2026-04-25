using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/run-batches")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class RunBatchesController : ControllerBase
{
    private readonly IRunBatchService _batches;

    public RunBatchesController(IRunBatchService batches)
    {
        _batches = batches;
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _batches.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }
}
