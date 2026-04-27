using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;
using WebScrape.Services.Expansion;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/tasks")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class TasksController : ControllerBase
{
    private readonly ITaskService _tasks;

    public TasksController(ITaskService tasks)
    {
        _tasks = tasks;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        return Ok(await _tasks.ListAsync(User.GetUserId(), ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var dto = await _tasks.GetAsync(User.GetUserId(), id, ct);
        return dto is null ? NotFound() : Ok(dto);
    }

    [HttpPost]
    [CookieCsrf]
    public async Task<IActionResult> Create([FromBody] SaveTaskDto dto, CancellationToken ct)
    {
        var result = await _tasks.SaveAsync(User.GetUserId(), null, dto, ct);
        return Render(result, isCreate: true);
    }

    [HttpPut("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveTaskDto dto, CancellationToken ct)
    {
        var result = await _tasks.SaveAsync(User.GetUserId(), id, dto, ct);
        return Render(result, isCreate: false);
    }

    [HttpDelete("{id:guid}")]
    [CookieCsrf]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var outcome = await _tasks.DeleteAsync(User.GetUserId(), id, ct);
        return outcome switch
        {
            DeleteTaskOutcome.Deleted   => NoContent(),
            DeleteTaskOutcome.NotFound  => NotFound(),
            DeleteTaskOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    [HttpPost("{id:guid}/populate")]
    [CookieCsrf]
    public async Task<IActionResult> Populate(Guid id, [FromServices] IQueueExpansionService expander, CancellationToken ct)
    {
        var preview = await expander.ExpandAsync(User.GetUserId(), id, ct);
        return preview.Outcome switch
        {
            ExpansionOutcome.Ok => Ok(new ExpansionPreviewDto
            {
                Count = preview.Count,
                Items = preview.Results.Select(r => new ExpandedItemDto
                {
                    ScrapeBlockId = r.ScrapeBlockId,
                    ScraperConfigId = r.ScraperConfigId,
                    ConfigName = r.ConfigName,
                    Assignments = r.Assignments.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
                    IterationLabel = r.IterationLabel,
                }).ToList(),
                Warnings = preview.Warnings.Select(w => new ExpansionWarningDto
                {
                    Code = w.Code, BlockId = w.BlockId, ScraperConfigId = w.ScraperConfigId, StepId = w.StepId,
                }).ToList(),
            }),
            ExpansionOutcome.NotFound => NotFound(new { error = preview.Error }),
            ExpansionOutcome.Forbidden => StatusCode(StatusCodes.Status403Forbidden, new { error = preview.Error }),
            ExpansionOutcome.BatchEmpty => UnprocessableEntity(new { code = "BATCH_EMPTY", error = preview.Error }),
            ExpansionOutcome.BatchTooLarge => UnprocessableEntity(new { code = "BATCH_TOO_LARGE", count = preview.Count, cap = IQueueExpansionService.BatchCap, error = preview.Error }),
            ExpansionOutcome.NestedLoopUnsupported => UnprocessableEntity(new { code = "NESTED_LOOP_UNSUPPORTED", error = preview.Error }),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

    private IActionResult Render(SaveTaskResult result, bool isCreate)
    {
        return result.Outcome switch
        {
            SaveTaskOutcome.Created          => CreatedAtAction(nameof(Get), new { id = result.Task!.Id }, result.Task),
            SaveTaskOutcome.Updated          => Ok(result.Task),
            SaveTaskOutcome.ValidationFailed => BadRequest(new { errors = result.Errors }),
            SaveTaskOutcome.NotFound         => NotFound(),
            SaveTaskOutcome.Forbidden        => StatusCode(StatusCodes.Status403Forbidden),
            _ => StatusCode(StatusCodes.Status500InternalServerError),
        };
    }

}
