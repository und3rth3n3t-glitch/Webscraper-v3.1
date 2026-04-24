import { describe, it, expect } from 'vitest';
import { validateBackendUrl } from '../sidepanel/utils/validateBackendUrl';

describe('validateBackendUrl', () => {
  it('rejects empty string', () => {
    expect(validateBackendUrl('').valid).toBe(false);
  });

  it('rejects non-URL strings', () => {
    expect(validateBackendUrl('not-a-url').valid).toBe(false);
  });

  it('rejects http:// URLs', () => {
    const result = validateBackendUrl('http://example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/https/i);
  });

  it('accepts https:// URLs', () => {
    expect(validateBackendUrl('https://example.com').valid).toBe(true);
  });

  it('accepts https:// URLs with paths', () => {
    expect(validateBackendUrl('https://api.example.com/v2/hub').valid).toBe(true);
  });
});
