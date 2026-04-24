function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export function scoreMatch(linkText: string, searchTerm: string, fuzzy = false): number {
  if (!linkText || !searchTerm) return 0;

  const termTokens = tokenize(searchTerm);
  const textTokens = tokenize(linkText);

  if (termTokens.length === 0) return 0;

  const matched = termTokens.filter((t) =>
    textTokens.some((lt) =>
      fuzzy ? lt.includes(t) || t.includes(lt) : lt === t,
    ),
  ).length;

  const base = matched / termTokens.length;
  if (base < 1.0) return base;

  const lenDiff = Math.abs(textTokens.length - termTokens.length);
  const tightnessBonus = Math.max(0, 0.15 * (1 - lenDiff / Math.max(textTokens.length, 1)));

  const termPhrase = termTokens.join(' ');
  const textJoined = textTokens.join(' ');
  const contiguityBonus = textJoined.includes(termPhrase) ? 0.1 : 0;
  const leadingBonus = textJoined.startsWith(termPhrase) ? 0.05 : 0;

  return base + tightnessBonus + contiguityBonus + leadingBonus;
}

export function findBestMatch(
  elements: Element[],
  searchTerm: string,
  threshold = 0.5,
  fuzzy = false,
): { element: Element | null; score: number; text: string } {
  let best: { element: Element | null; score: number; text: string } = {
    element: null,
    score: 0,
    text: '',
  };

  for (const el of elements) {
    const text = ((el as HTMLElement).innerText || el.textContent || '').trim();
    const score = scoreMatch(text, searchTerm, fuzzy);
    if (score >= threshold && score > best.score) {
      best = { element: el, score, text };
    }
  }

  return best;
}
