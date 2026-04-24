export interface UrlValidation {
  valid: boolean;
  error?: string;
}

export function validateBackendUrl(raw: string): UrlValidation {
  if (!raw.trim()) return { valid: false, error: 'Enter a backend URL.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, error: 'URL must start with https://' };
  }
  return { valid: true };
}
