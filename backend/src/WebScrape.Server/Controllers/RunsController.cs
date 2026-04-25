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

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _runs.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost("batch")]
    [CookieCsrf]
    public async Task<IActionResult> CreateBatch(
        [FromBody] WebScrape.Data.Dto.CreateBatchDto dto,
        [FromServices] WebScrape.Services.Interfaces.IRunBatchService batches,
        CancellationToken ct)
    {
        var result = await batches.CreateAndDispatchAsync(User.GetUserId(), dto.TaskId, dto.WorkerId, ct);
        return result.Outcome switch
        {
            WebScrape.Services.Interfaces.RunBatchOutcome.Created => Ok(new WebScrape.Data.Dto.BatchDispatchResultDto
            {
                BatchId = result.BatchId!.Value,
                DispatchedCount = result.DispatchedCount,
                FailedCount = result.FailedCount,
            }),
            WebScrape.Services.Interfaces.RunBatchOutcome.NotFound => NotFound(new { error = result.Error }),
            WebScrape.Services.Interfaces.RunBatchOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = result.Error }),
            WebScrape.Services.Interfaces.RunBatchOutcome.WorkerOffline => Conflict(new { error = result.Error }),
            WebScrape.Services.Interfaces.RunBatchOutcome.BatchEmpty => UnprocessableEntity(new { code = "BATCH_EMPTY", error = result.Error }),
            WebScrape.Services.Interfaces.RunBatchOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", error = result.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

}
