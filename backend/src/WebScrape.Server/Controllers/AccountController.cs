using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Server.Auth;

namespace WebScrape.Server.Controllers;

[ApiController]
[Route("api/account")]
public class AccountController : ControllerBase
{
    private readonly UserManager<User> _userManager;
    private readonly SignInManager<User> _signInManager;

    public AccountController(UserManager<User> userManager, SignInManager<User> signInManager)
    {
        _userManager = userManager;
        _signInManager = signInManager;
    }

    [HttpGet("csrf")]
    [AllowAnonymous]
    public IActionResult Csrf()
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        Response.Cookies.Append(CookieCsrfAttribute.CookieName, token, new CookieOptions
        {
            HttpOnly = false,
            SameSite = SameSiteMode.Lax,
            Secure = Request.IsHttps,
        });
        return NoContent();
    }

    [HttpPost("login")]
    [AllowAnonymous]
    [CookieCsrf]
    public async Task<IActionResult> Login([FromBody] LoginDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Email) || string.IsNullOrEmpty(dto.Password))
            return Unauthorized(new { error = "Invalid credentials" });

        var user = await _userManager.FindByEmailAsync(dto.Email);
        if (user is null) return Unauthorized(new { error = "Invalid credentials" });

        var result = await _signInManager.CheckPasswordSignInAsync(user, dto.Password, lockoutOnFailure: true);
        if (!result.Succeeded) return Unauthorized(new { error = "Invalid credentials" });

        await _signInManager.SignInAsync(user, isPersistent: true);
        return Ok(new AccountDto { Id = user.Id, Email = user.Email ?? "", Name = user.UserName });
    }

    [HttpPost("logout")]
    [Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
    [CookieCsrf]
    public async Task<IActionResult> Logout()
    {
        await _signInManager.SignOutAsync();
        return NoContent();
    }

    [HttpGet("me")]
    [Authorize(AuthenticationSchemes = WebScrapeSchemes.Cookie)]
    public async Task<IActionResult> Me()
    {
        var idClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!Guid.TryParse(idClaim, out var id)) return Unauthorized();
        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null) return Unauthorized();
        return Ok(new AccountDto { Id = user.Id, Email = user.Email ?? "", Name = user.UserName });
    }
}
