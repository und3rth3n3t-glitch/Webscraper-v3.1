const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns a safe href to use in <a href={...}>, or null if the input is missing,
 * malformed, or uses a non-allowlisted scheme. Defends against javascript:/data: XSS
 * when rendering scraped link blocks.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
