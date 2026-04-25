namespace WebScrape.Data.Enums;

// Used inside ScrapeBlockConfig.stepBindings JSONB payloads.
// Stored as text via System.Text.Json's JsonStringEnumConverter (camelCase).
public enum BindingKind
{
    Literal,
    LoopRef,
    Unbound,
}
