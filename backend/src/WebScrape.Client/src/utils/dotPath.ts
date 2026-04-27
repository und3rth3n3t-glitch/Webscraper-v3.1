export function dotPath(...segments: string[]): string {
  return segments.join('.');
}

export function toNunjucks(path: string): string {
  return `{{ runs.latest.${path} }}`;
}

export function buildNodePath(parents: string[], key: string | number): string {
  return [...parents, String(key)].join('.');
}
