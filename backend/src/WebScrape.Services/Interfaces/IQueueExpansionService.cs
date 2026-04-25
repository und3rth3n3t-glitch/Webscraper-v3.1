using WebScrape.Services.Expansion;

namespace WebScrape.Services.Interfaces;

public enum ExpansionOutcome
{
    Ok,
    NotFound,
    Forbidden,
    BatchEmpty,
    BatchTooLarge,
}

public record ExpansionPreview(
    ExpansionOutcome Outcome,
    int Count,
    List<ExpansionResult> Results,
    List<ExpansionWarning> Warnings,
    string? Error = null);

public interface IQueueExpansionService
{
    public const int BatchCap = 1000;

    Task<ExpansionPreview> ExpandAsync(Guid userId, Guid taskId, CancellationToken ct = default);
}
