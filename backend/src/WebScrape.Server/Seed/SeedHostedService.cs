namespace WebScrape.Server.Seed;

public class SeedHostedService : IHostedService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<SeedHostedService> _logger;

    public SeedHostedService(IServiceProvider services, ILogger<SeedHostedService> logger)
    {
        _services = services;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await InitialSeed.RunAsync(_services, _logger, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Initial seed failed");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
