const SYMBOL_MAP: Record<string, string> = {
  '%': 'pct', '£': 'gbp', '$': 'usd', '€': 'eur', '¥': 'jpy',
  '₹': 'inr', '#': 'num', '&': 'and', '+': 'plus',
};

export function slugify(input: string): string {
  let s = input.toLowerCase();
  for (const [sym, word] of Object.entries(SYMBOL_MAP)) {
    s = s.split(sym).join(`_${word}_`);
  }
  s = s
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'col';
  if (/^\d/.test(s)) s = '_' + s;
  return s.slice(0, 64);
}

export function disambiguate(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
