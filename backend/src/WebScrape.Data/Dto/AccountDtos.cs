namespace WebScrape.Data.Dto;

public class LoginDto
{
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
}

public class AccountDto
{
    public Guid Id { get; set; }
    public string Email { get; set; } = "";
    public string? Name { get; set; }
}
