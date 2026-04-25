namespace WebScrape.Data.Constants;

// Wire-format phase strings used in TaskProgressDto.Phase.
// Mirrors the BlockType enum (lowercased) — the phase the worker is currently executing.
public static class PhaseConstants
{
    public const string Loop = "loop";
    public const string Scrape = "scrape";
}
