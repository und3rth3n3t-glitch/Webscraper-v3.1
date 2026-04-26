using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
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

    [HttpGet("")]
    public async Task<IActionResult> List([FromQuery] RunBatchListQueryDto query, CancellationToken ct)
    {
        var page = await _batches.ListAsync(User.GetUserId(), query, ct);
        return Ok(page);
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _batches.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpGet("{id:guid}/export")]
    public async Task<IActionResult> Export(Guid id, [FromQuery] string format, CancellationToken ct)
    {
        var result = await _batches.ExportAsync(User.GetUserId(), id, format, ct);
        return result.Outcome switch
        {
            RunBatchExportOutcome.Ok        => File(result.Bytes!, result.ContentType!, result.Filename),
            RunBatchExportOutcome.BadFormat => BadRequest(new { error = "format must be 'json' or 'csv'" }),
            RunBatchExportOutcome.NotFound  => NotFound(),
            RunBatchExportOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            _                                => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
}
