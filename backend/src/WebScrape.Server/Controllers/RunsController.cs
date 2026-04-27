using Microsoft.AspNetCore.Authorization;
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

    [HttpGet("")]
    public async Task<IActionResult> List([FromQuery] RunListQueryDto query, CancellationToken ct)
    {
        var page = await _runs.ListAsync(User.GetUserId(), query, ct);
        return Ok(page);
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _runs.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpGet("{id:guid}/export")]
    public async Task<IActionResult> Export(Guid id, [FromQuery] string format, CancellationToken ct)
    {
        var result = await _runs.ExportAsync(User.GetUserId(), id, format, ct);
        return result.Outcome switch
        {
            RunExportOutcome.Ok          => File(result.Bytes!, result.ContentType!, result.Filename),
            RunExportOutcome.BadFormat   => BadRequest(new { error = "format must be 'json' or 'csv'" }),
            RunExportOutcome.NotFound    => NotFound(),
            RunExportOutcome.NotReady    => NotFound(new { error = "Run is not yet complete" }),
            RunExportOutcome.Forbidden   => StatusCode(StatusCodes.Status403Forbidden),
            RunExportOutcome.NotTabular  => UnprocessableEntity(new { code = "ITERATION_NOT_TABULAR", error = "CSV isn't available for full-page results — use JSON export" }),
            _                            => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpPost("{id:guid}/cancel")]
    [CookieCsrf]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct)
    {
        var ok = await _runs.CancelAsync(User.GetUserId(), id, ct);
        return ok ? NoContent() : NotFound();
    }

    [HttpPost("batch")]
    [CookieCsrf]
    public async Task<IActionResult> CreateBatch(
        [FromBody] CreateBatchDto dto,
        [FromServices] IRunBatchService batches,
        CancellationToken ct)
    {
        var result = await batches.CreateAndDispatchAsync(User.GetUserId(), dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            RunBatchOutcome.Created => Ok(new BatchDispatchResultDto
            {
                BatchId = result.BatchId!.Value,
                DispatchedCount = result.DispatchedCount,
                FailedCount = result.FailedCount,
            }),
            RunBatchOutcome.NotFound      => NotFound(new { error = result.Error }),
            RunBatchOutcome.Forbidden     => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            RunBatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            RunBatchOutcome.BatchEmpty    => UnprocessableEntity(new { code = "BATCH_EMPTY", error = result.Error }),
            RunBatchOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", error = result.Error }),
            RunBatchOutcome.NestedLoopUnsupported => UnprocessableEntity(new { code = "NESTED_LOOP_UNSUPPORTED", error = result.Error }),
            _                              => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }
}
