export interface BrandPalette {
  /** Primary brand color, hex with leading #. e.g. '#5F259F' */
  primary: string;
  /** Primary as 'r, g, b' (no spaces required). Used for rgba() composition. e.g. '95, 37, 159' */
  primaryRgb: string;
  /** Lighter primary for hover states. */
  primaryLight: string;
  /** Secondary accent color. */
  secondary: string;
  /** Tinted brand background, used for selected/hover backgrounds. */
  bgTint: string;
  /** Primary text. */
  textDark: string;
  /** Muted text. */
  textLight: string;
  bgWhite: string;
  bgLight: string;
  bgHover: string;
  border: string;
  danger: string;
  dangerLight: string;
  success: string;
  successLight: string;
  warning: string;
  warningLight: string;
  infoLight: string;
}

export interface BrandConfig {
  /** App name. Manifest, sidepanel title, OS notification base. Informal, no jargon. */
  appName: string;
  /** Manifest description. One sentence, user-facing. */
  appDescription: string;
  /** Toolbar action button hover title. e.g. 'Open <appName>'. */
  actionTitle: string;
  /** Welcome sheet first-open heading. */
  welcomeHeading: string;
  /** Notification title prefix. Concatenated with ' — batch finished' etc. at the call site. */
  notificationTitle: string;
  /** Log prefix tag, including brackets. e.g. '[Blueberry]'. */
  logPrefix: string;
  /** Optional tagline for marketing slots. */
  tagline?: string;
  /** Optional placeholder text for the SearchVarInput multi-line example. Fallback: empty string. */
  searchVarPlaceholder?: string;
  /** CSS font-family value. */
  fontFamily: string;
  /** Path relative to src/themes/, e.g. 'blueberry/icons'. Must contain icon{16,48,128}.png. */
  iconDir: string;
  /** Optional default backend URL pre-filled on first install only. */
  defaultServerUrl?: string;
  palette: BrandPalette;
}

/** Helper: returns a tagged log prefix. brandTag(brand) -> '[Blueberry]'; brandTag(brand, 'chart-bridge') -> '[Blueberry chart-bridge]' */
export function brandTag(brand: BrandConfig, suffix?: string): string {
  if (!suffix) return brand.logPrefix;
  return brand.logPrefix.replace(/]$/, ` ${suffix}]`);
}
