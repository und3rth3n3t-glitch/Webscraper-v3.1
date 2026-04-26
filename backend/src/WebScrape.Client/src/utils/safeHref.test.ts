import { describe, expect, it } from 'vitest';
import { safeHref } from './safeHref';

describe('safeHref', () => {
  it('passes http URLs', () => { expect(safeHref('http://example.com/a')).toBe('http://example.com/a'); });
  it('passes https URLs', () => { expect(safeHref('https://example.com/')).toBe('https://example.com/'); });
  it('passes mailto', () => { expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c'); });
  it('blocks javascript:', () => { expect(safeHref('javascript:alert(1)')).toBeNull(); });
  it('blocks JavaScript: case-insensitive', () => { expect(safeHref('JavaScript:alert(1)')).toBeNull(); });
  it('blocks data: URLs', () => { expect(safeHref('data:text/html,<script>1</script>')).toBeNull(); });
  it('blocks file:', () => { expect(safeHref('file:///etc/passwd')).toBeNull(); });
  it('rejects relative paths', () => { expect(safeHref('/foo')).toBeNull(); });
  it('rejects empty', () => { expect(safeHref('')).toBeNull(); });
  it('rejects whitespace-only', () => { expect(safeHref('   ')).toBeNull(); });
  it('rejects non-strings', () => { expect(safeHref(null)).toBeNull(); expect(safeHref(undefined)).toBeNull(); expect(safeHref(42)).toBeNull(); });
});
