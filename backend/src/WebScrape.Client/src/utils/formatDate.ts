export function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

export function fmtRelative(s: string | null): string {
  if (!s) return 'never';
  const ms = Date.now() - new Date(s).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(s).toLocaleDateString();
}
