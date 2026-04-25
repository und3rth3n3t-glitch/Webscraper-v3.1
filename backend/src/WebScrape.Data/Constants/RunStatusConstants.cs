namespace WebScrape.Data.Constants;

// Wire-format status strings used in messages exchanged with the extension.
// Lowercase form mirrors the protocol the browser extension speaks.
// Distinct from the persisted RunItemStatus enum (EF stores PascalCase via HasConversion<string>()).
public static class RunStatusConstants
{
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Running = "running";
    public const string Paused = "paused";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}
