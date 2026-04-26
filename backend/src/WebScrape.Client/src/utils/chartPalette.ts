// CSS-variable strings (resolved by the browser at render time).
// Never inline hex/rgb in JSX or chart props — go through this helper.
export const chartPalette = {
  primary:    'var(--purple-primary)',
  secondary:  'var(--magenta-secondary)',
  light:      'var(--purple-light)',
  textDark:   'var(--text-dark)',
  textLight:  'var(--text-light)',
  border:     'var(--border)',
  success:    'var(--success)',
  warning:    'var(--warning)',
  danger:     'var(--danger)',
};

// Series colours, in order. Repeats from index 0 once exhausted.
export const seriesColours = [
  chartPalette.primary,
  chartPalette.secondary,
  chartPalette.light,
  chartPalette.warning,
  chartPalette.success,
];

export function colourFor(index: number): string {
  return seriesColours[index % seriesColours.length];
}
