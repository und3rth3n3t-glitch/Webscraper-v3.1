// Round-trip helpers for the "Extra selectors" textarea in DetectionSettings.
// Stored on disk as string[]; rendered to textarea as newline-joined.

export function parseExtraSelectors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function formatExtraSelectors(selectors: string[] | undefined): string {
  return (selectors ?? []).join('\n');
}
