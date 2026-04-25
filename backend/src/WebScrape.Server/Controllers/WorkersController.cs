using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Server.Auth;
using WebScrape.Services.Interfaces;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/workers")]
[Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
public class WorkersController : ControllerBase
{
    private readonly IWorkerService _workers;

    public WorkersController(IWorkerService workers)
    {
        _workers = workers;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        return Ok(await _workers.ListAsync(userId, ct));
    }
}
