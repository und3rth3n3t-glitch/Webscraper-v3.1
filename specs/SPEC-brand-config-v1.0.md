# SPEC: Brand-Config Refactor — v1.0

## Context

The blueberry-v3 extension is being repositioned as a **generic, white-labelable** scraping client that any BBWT3 backend can pair with — eventually via OIDC SSO. For that to be real, rebranding has to be a single-source-of-truth operation: drop in a brand file, rebuild, ship.

Today the infrastructure is half there. There's a `BLUEBERRY_THEME` env switch and a `ThemeConfig` TS object, but manifest strings, the CSS palette, UI copy, and log prefixes are independently hardcoded. The `ThemeConfig.primary`/`.secondary` values are not wired into the CSS variables — the CSS is hardcoded purple/magenta. The `__THEME_NAME__` Vite define has no source consumers. A rebrand currently touches 5–9 files plus icon assets, with the CSS palette requiring a separate manual pass. This refactor closes that gap.

This spec was produced via the staged-planning workflow (Stages A–F). The full planning doc lives at `C:\Users\und3r\.claude\plans\lets-go-over-a-golden-reddy.md`. This spec is the implementation hand-off.

---

## Scope

**Building:** a single-file brand-config layer where `src/themes/<brand>.ts` (plus an icon dir) drives the manifest, CSS palette, all user-visible copy, log prefixes, OS notifications, icons, and an optional default backend URL via `BLUEBERRY_THEME=<brand> pnpm build`.

**Locked decisions:**
1. Brand schema = full white-label (10–13 fields).
2. Loading = build-time static; one brand per binary.
3. Manifest = wxt.config.ts dynamic-imports the resolved brand.
4. CSS palette = build-time generated `brand.generated.css` (tracked in git, regenerated each build).
5. Token rename `--purple-*` / `--magenta-*` → `--brand-*` (52 occurrences across 2 files).
6. Brand literals replaced via `import brand from '@/themes'` (existing tsconfig alias).
7. Icons = per-brand dir, copied to `src/public/icons/` at build start.
8. `defaultServerUrl` opt-in pre-fill, gated by a `brandBootstrapped` flag.

**Not in scope:** WebScrape backend branding, runtime brand switching, multi-backend pairing, SSO, server-truth fallback policy, env-var rename `BLUEBERRY_THEME` → `BRAND`.

---

## Architecture

### Build chain

1. `wxt.config.ts` reads `process.env.BLUEBERRY_THEME` → `themeName` (default `'blueberry'`).
2. wxt.config.ts uses top-level `await import()` to load `./src/themes/${themeName}.ts`. Wrapped in try/catch.
3. The resolved brand object feeds manifest fields (`name`, `description`, `action.default_title`).
4. **Brand Vite plugin** registered via `vite: () => ({ plugins: [brandPlugin({ brand, themeName })] })`. In `buildStart`:
   - Writes `src/themes/index.generated.ts` (literal `export { default } from './<themeName>';`).
   - Writes `src/sidepanel/styles/brand.generated.css` from `brand.palette`.
   - Copies `src/themes/${brand.iconDir}/icon{16,48,128}.png` → `src/public/icons/`.
   - Calls `this.addWatchFile(brandTsPath)` for HMR.
5. Source code imports `import brand from '@/themes'` — resolves via existing `tsconfig.json:9` alias `@/* → src/*`.

### Reuse

- `tsconfig.json:9` `"@/*": ["src/*"]` — alias works without config change.
- `wxt.config.ts:5` JSON-import pattern for `package.json` — mirror for brand TS via dynamic `await import()`.
- Existing `:root` non-brand tokens (radii, spacing, font sizes) at `index.css:21-42` — stay in `index.css`.
- Zustand `persist` + `partialize` at `settingsStore.ts:88-101` — extend with `brandBootstrapped`.

### Dead code removed

- Old `ThemeConfig` interface at `src/themes/types.ts`.
- Hardcoded brand `:root` tokens at `index.css:2-20`.
- Vite `__THEME_NAME__` define at `wxt.config.ts:24` (no consumers).
- `--border-focus` at `index.css:13` (identical hex to `--purple-primary`).

### Pre-existing issues NOT fixed in this PR

- `index.css:367` references undefined `var(--text-primary)` — typo for `--text-dark`. Separate ticket.

---

## UI / Styling Review

### Palette token rename

| Old token | New token | Note |
|---|---|---|
| `--purple-primary` | `--brand-primary` | |
| `--magenta-secondary` | `--brand-secondary` | |
| `--purple-light` | `--brand-primary-light` | |
| `--purple-bg` | `--brand-bg-tint` | |
| `--border-focus` | (deleted, use `--brand-primary`) | identical hex |
| (new) | `--brand-primary-rgb: 95, 37, 159` | for `rgba(var(--brand-primary-rgb), 0.x)` |

### Hardcoded brand literals to replace inside `index.css` (outside `:root`)

| Line | Current | Replacement |
|---|---|---|
| 62 | `linear-gradient(135deg, #FEFEFE 0%, #F5F0FA 100%)` | `linear-gradient(135deg, #FEFEFE 0%, var(--brand-bg-tint) 100%)` |
| 74 | same gradient | same replacement |
| 259 | `box-shadow: 0 0 0 2px rgba(95, 37, 159, 0.12)` | `box-shadow: 0 0 0 2px rgba(var(--brand-primary-rgb), 0.12)` |
| 785, 789, 791 | `rgba(95,37,159, ...)` in `picker-pulse` | `rgba(var(--brand-primary-rgb), ...)` |
| 996 | `.run-log-time { color: #5F259F; }` | `var(--brand-primary)` |

### Non-brand colors that stay literal (semantic palette, justified)

- Chart-banner green at line 819, container-banner blue at line 851, run-log dark theme at lines 994-998, type-badge variants at lines 647-650.

### Inline-style cleanup

`WelcomeSheet.tsx:23` has `style={{ ..., color: 'var(--purple-primary)', ... }}` — pre-existing violation. **Cleanup included**: replace with new class `.welcome-sheet-title` defined in `index.css` using `var(--brand-primary)`.

### HTML title elements

`offscreen.html:3` and `sidepanel/index.html:6` hardcode `<title>Blueberry ...</title>`. **Decision:** leave HTML titles as generic placeholders; entry scripts set `document.title = brand.appName` at boot.

### Component reuse

No new components; one new class (`.welcome-sheet-title`). Brand layer is invisible at the component level.

---

## Security

**No new attack surface.** Brand is build-time static data, not runtime input. `appName` etc. render through React (auto-escaped). `defaultServerUrl` feeds `settingsStore.serverUrl` (same trust boundary as before; `validateBackendUrl.ts` still applies). No DOM injection, no eval, no fetch from brand URLs. No new permissions.

---

## Implementation

### F.1. New file: `src/themes/types.ts` (replaces existing)

```ts
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
```

### F.2. Rewritten: `src/themes/blueberry.ts`

```ts
import type { BrandConfig } from './types';

export default {
  appName: 'Blueberry Web Scraper',
  appDescription: 'Record and execute web scraping flows',
  actionTitle: 'Open Blueberry Scraper',
  welcomeHeading: 'Welcome to Blueberry Scraper',
  notificationTitle: 'Blueberry',
  logPrefix: '[Blueberry]',
  searchVarPlaceholder: 'Blueberry Consultants\nAcme Corp\nTechStart Ltd',
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  iconDir: 'blueberry/icons',
  palette: {
    primary: '#5F259F',
    primaryRgb: '95, 37, 159',
    primaryLight: '#7B4DB5',
    secondary: '#BB16A3',
    bgTint: '#F5F0FA',
    textDark: '#474747',
    textLight: '#969696',
    bgWhite: '#FFFFFF',
    bgLight: '#F5F3F7',
    bgHover: '#EDE8F2',
    border: '#E0D8E8',
    danger: '#D32F2F',
    dangerLight: '#FFEBEE',
    success: '#2E7D32',
    successLight: '#E8F5E9',
    warning: '#F57F17',
    warningLight: '#FFF8E1',
    infoLight: '#F5F0FA',
  },
} satisfies BrandConfig;
```

### F.3. Move existing icons

```
mv src/public/icons/icon16.png   src/themes/blueberry/icons/icon16.png
mv src/public/icons/icon48.png   src/themes/blueberry/icons/icon48.png
mv src/public/icons/icon128.png  src/themes/blueberry/icons/icon128.png
```

`.gitignore` add: `src/public/icons/` (now build-output only).

### F.4. New: `src/build/brandPlugin.ts`

```ts
import { writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { BrandConfig } from '../themes/types';

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const THEMES_DIR  = join(PROJECT_ROOT, 'src', 'themes');
const PUBLIC_ICONS = join(PROJECT_ROOT, 'src', 'public', 'icons');
const GENERATED_BARREL = join(THEMES_DIR, 'index.generated.ts');
const GENERATED_CSS = join(PROJECT_ROOT, 'src', 'sidepanel', 'styles', 'brand.generated.css');

interface Opts {
  brand: BrandConfig;
  themeName: string;
}

export function brandPlugin({ brand, themeName }: Opts): Plugin {
  return {
    name: 'blueberry:brand',
    buildStart() {
      // 1. Watch the brand TS so HMR re-runs on edits.
      const brandTsPath = join(THEMES_DIR, `${themeName}.ts`);
      this.addWatchFile(brandTsPath);

      // 2. Generate the barrel.
      writeFileSync(
        GENERATED_BARREL,
        `// AUTO-GENERATED by brandPlugin. Do not edit. Regenerated each build.\nexport { default } from './${themeName}';\n`,
      );

      // 3. Generate brand.generated.css.
      const p = brand.palette;
      const css = `/* AUTO-GENERATED by brandPlugin. Do not edit. */
:root {
  --brand-primary: ${p.primary};
  --brand-primary-rgb: ${p.primaryRgb};
  --brand-primary-light: ${p.primaryLight};
  --brand-secondary: ${p.secondary};
  --brand-bg-tint: ${p.bgTint};
  --text-dark: ${p.textDark};
  --text-light: ${p.textLight};
  --bg-white: ${p.bgWhite};
  --bg-light: ${p.bgLight};
  --bg-hover: ${p.bgHover};
  --border: ${p.border};
  --danger: ${p.danger};
  --danger-light: ${p.dangerLight};
  --success: ${p.success};
  --success-light: ${p.successLight};
  --warning: ${p.warning};
  --warning-light: ${p.warningLight};
  --info-light: ${p.infoLight};
  --font-family: ${brand.fontFamily};
}
`;
      writeFileSync(GENERATED_CSS, css);

      // 4. Copy brand icons into src/public/icons/.
      const srcIconDir = join(THEMES_DIR, brand.iconDir);
      if (!existsSync(srcIconDir)) {
        this.error(`brand iconDir not found: ${srcIconDir}`);
      }
      mkdirSync(PUBLIC_ICONS, { recursive: true });
      for (const size of [16, 48, 128]) {
        const src = join(srcIconDir, `icon${size}.png`);
        const dst = join(PUBLIC_ICONS, `icon${size}.png`);
        if (!existsSync(src)) this.error(`brand icon missing: ${src}`);
        copyFileSync(src, dst);
      }
    },
  };
}
```

### F.5. Rewritten: `wxt.config.ts`

```ts
import { defineConfig } from 'wxt';
import { readFileSync } from 'node:fs';
import { brandPlugin } from './src/build/brandPlugin';
import type { BrandConfig } from './src/themes/types';

const themeName = process.env.BLUEBERRY_THEME ?? 'blueberry';

let brand: BrandConfig;
try {
  brand = (await import(`./src/themes/${themeName}.ts`)).default;
} catch (err) {
  throw new Error(`Brand '${themeName}' not found at src/themes/${themeName}.ts: ${(err as Error).message}`);
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const appVersion = pkg.version;

export default defineConfig({
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: brand.appName,
    description: brand.appDescription,
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen', 'notifications', 'debugger'],
    host_permissions: ['<all_urls>'],
    icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    side_panel: { default_path: 'sidepanel/index.html' },
    action: {
      default_title: brand.actionTitle,
      default_icon: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    },
  },

  vite: () => ({
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [brandPlugin({ brand, themeName })],
  }),
});
```

### F.6. Source rewrites — exact line edits

**`src/sidepanel/styles/index.css`** (full edit list):

Replace lines 1-43 `:root { ... }` with the non-brand tokens only:

```css
@import './brand.generated.css';

/* Non-brand tokens — brand palette comes from brand.generated.css */
:root {
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --shadow-sm: 0 1px 3px rgba(var(--brand-primary-rgb), 0.1);
  --shadow-md: 0 4px 12px rgba(var(--brand-primary-rgb), 0.15);
  --shadow-card: 0 2px 8px rgba(var(--brand-primary-rgb), 0.08), 0 1px 3px rgba(var(--brand-primary-rgb), 0.06);
  --shadow-card-hover: 0 6px 16px rgba(var(--brand-primary-rgb), 0.12), 0 2px 6px rgba(var(--brand-primary-rgb), 0.08);
  --accent-border: 4px solid var(--brand-primary);
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-base: 13px;
  --font-size-md: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 18px;
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;
  --spacing-2xl: 32px;
  --transition: 150ms ease;
}
```

Bulk replace across the file:
- `var(--purple-primary)` → `var(--brand-primary)`
- `var(--magenta-secondary)` → `var(--brand-secondary)`
- `var(--purple-light)` → `var(--brand-primary-light)`
- `var(--purple-bg)` → `var(--brand-bg-tint)`
- `var(--border-focus)` → `var(--brand-primary)`

Specific line edits:
- Lines 62, 74: replace `#F5F0FA` with `var(--brand-bg-tint)` inside the gradients.
- Line 259: replace `rgba(95, 37, 159, 0.12)` with `rgba(var(--brand-primary-rgb), 0.12)`.
- Lines 785, 789, 791: replace each `rgba(95,37,159, X)` with `rgba(var(--brand-primary-rgb), X)`.
- Line 996: replace `color: #5F259F` with `color: var(--brand-primary)`.

Add new class at the end of the Welcome Screen block (around line 1037):

```css
.welcome-sheet-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--brand-primary);
  margin-bottom: 4px;
}
```

**`src/sidepanel/components/WelcomeSheet.tsx`** at lines 23-24:

Replace:
```tsx
<h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--purple-primary)', marginBottom: '4px' }}>
  Welcome to Blueberry Scraper
```
With:
```tsx
<h2 className="welcome-sheet-title">
  {brand.welcomeHeading}
```
Add at top: `import brand from '@/themes';`

**`src/sidepanel/components/Header.tsx`** at line 4:
- Replace `alt="Blueberry"` with `alt={brand.appName}`. Add `import brand from '@/themes';`.

**`src/sidepanel/components/SearchVarInput.tsx`** at line 158:
- Replace `placeholder={"Blueberry Consultants\nAcme Corp\nTechStart Ltd"}` with `placeholder={brand.searchVarPlaceholder ?? ''}`. Add `import brand from '@/themes';`.

**`src/background/notifications.ts`** at line 73:
- Replace `title: 'Blueberry — batch finished'` with `` title: `${brand.notificationTitle} — batch finished` ``. Add `import brand from '@/themes';`.
- Audit: grep this file for any other `'Blueberry'` literals; apply same pattern.

**`src/content/extraction/domUtils.ts:5`, `src/content/extraction/chartExtractor.ts:5`, `src/content/extraction/svgValueEngine.ts:6`**:
- Each contains `` console.debug(`[Blueberry] ${context}:`, ...) ``. Replace with `` console.debug(`${brand.logPrefix} ${context}:`, ...) ``. Add `import brand from '@/themes';`.

**`src/sidepanel/components/ErrorBoundary.tsx:18`**:
- Replace `console.error('[Blueberry] UI crash:', ...)` with `` console.error(`${brand.logPrefix} UI crash:`, ...) ``. Add `import brand from '@/themes';`.

**`src/entrypoints/chart-bridge.content.ts`** at lines 21, 22, 145:
- Each uses `[Blueberry chart-bridge]`. Replace with `${brandTag(brand, 'chart-bridge')}`. Add `import brand from '@/themes';` and `import { brandTag } from '@/themes/types';`.

**`src/entrypoints/offscreen.html:3`**:
- Replace `<title>Blueberry Offscreen</title>` with `<title>Offscreen</title>`. Offscreen entry script sets `` document.title = `${brand.appName} Offscreen` `` at boot.

**`src/entrypoints/sidepanel/index.html:6`**:
- Replace `<title>Blueberry Web Scraper</title>` with `<title>Scraper</title>`. Sidepanel entry script sets `document.title = brand.appName` at boot.

**Sidepanel + offscreen entry scripts** (find via WXT entry conventions; e.g. `src/entrypoints/sidepanel/index.tsx` and the offscreen entry — confirm exact paths at impl time):
- Add `import brand from '@/themes';`
- Add as the first executable statement: `document.title = brand.appName;` (offscreen: `` document.title = `${brand.appName} Offscreen`; ``)

### F.7. `src/sidepanel/stores/settingsStore.ts` — add bootstrap

Add to interface:
```ts
brandBootstrapped: boolean;
markBrandBootstrapped: () => void;
```

Add to default state inside `create`:
```ts
brandBootstrapped: false,
```

Add setter:
```ts
markBrandBootstrapped: () => set({ brandBootstrapped: true }),
```

Add to `partialize`:
```ts
brandBootstrapped: s.brandBootstrapped,
```

### F.8. New: `src/sidepanel/applyBrandDefaults.ts`

```ts
import brand from '@/themes';
import { useSettingsStore } from './stores/settingsStore';

/**
 * Runs once after the settings store hydrates. If the brand declares a
 * defaultServerUrl AND the user has never been bootstrapped before AND the
 * stored serverUrl is empty, populate it. Then mark bootstrapped — even if
 * we didn't fill anything — so we never run again.
 */
export function applyBrandDefaults(): void {
  const s = useSettingsStore.getState();
  if (s.brandBootstrapped) return;
  if (brand.defaultServerUrl && !s.serverUrl) {
    useSettingsStore.setState({ serverUrl: brand.defaultServerUrl });
  }
  s.markBrandBootstrapped();
}
```

Call from sidepanel entry after store hydration via Zustand's `useSettingsStore.persist.onFinishHydration(applyBrandDefaults)`.

### F.9. tsconfig

No tsconfig change needed — existing `"include": ["src/**/*", ...]` covers `src/themes/index.generated.ts`.

### F.10. `.gitignore` — additions

```
src/public/icons/
```

**Not** added: `src/themes/index.generated.ts`, `src/sidepanel/styles/brand.generated.css` — these are committed as build artefacts.

### F.11. New file order summary

```
src/themes/
  types.ts                                       (rewritten)
  blueberry.ts                                   (rewritten)
  blueberry/icons/icon{16,48,128}.png            (moved from src/public/icons/)
  test-brand.ts                                  (new fixture)
  test-brand/icons/icon{16,48,128}.png           (new)
  index.generated.ts                             (build artefact, committed)

src/build/
  brandPlugin.ts                                 (new)

src/sidepanel/styles/
  index.css                                      (modified)
  brand.generated.css                            (build artefact, committed)

src/sidepanel/
  applyBrandDefaults.ts                          (new)
  stores/settingsStore.ts                        (modified)
```

---

## Verification

### Test-brand fixture

`src/themes/test-brand.ts`:
```ts
import type { BrandConfig } from './types';
export default {
  appName: 'TestScrape',
  appDescription: 'Verification fixture for the brand-config layer',
  actionTitle: 'Open TestScrape',
  welcomeHeading: 'Welcome to TestScrape',
  notificationTitle: 'TestScrape',
  logPrefix: '[TestScrape]',
  tagline: 'Verification fixture',
  searchVarPlaceholder: 'TestCo One\nTestCo Two\nTestCo Three',
  fontFamily: "system-ui, sans-serif",
  iconDir: 'test-brand/icons',
  defaultServerUrl: 'http://localhost:5099',
  palette: {
    primary: '#0D7C66',
    primaryRgb: '13, 124, 102',
    primaryLight: '#1FA383',
    secondary: '#FFB800',
    bgTint: '#E8F7F2',
    textDark: '#1A2E2A',
    textLight: '#6B7C78',
    bgWhite: '#FFFFFF',
    bgLight: '#F5F8F7',
    bgHover: '#E0EEE9',
    border: '#C5DDD4',
    danger: '#D32F2F',
    dangerLight: '#FFEBEE',
    success: '#2E7D32',
    successLight: '#E8F5E9',
    warning: '#F57F17',
    warningLight: '#FFF8E1',
    infoLight: '#E8F7F2',
  },
} satisfies BrandConfig;
```

`src/themes/test-brand/icons/icon{16,48,128}.png`: solid teal squares with white "TS" centered. Generate any way (ImageMagick, online tool); commit.

### Automated commands

```bash
pnpm build && \
  BLUEBERRY_THEME=test-brand pnpm build && \
  pnpm test && pnpm lint && \
  git diff --exit-code -- src/themes/index.generated.ts src/sidepanel/styles/brand.generated.css
```

The `git diff --exit-code` check ensures committed copies of the generated files match what the plugin regenerated (drift detector).

### Manual test plan (after `BLUEBERRY_THEME=test-brand pnpm build` and load-unpacked in Chrome)

1. Toolbar action title hover → "Open TestScrape".
2. Sidepanel header → teal background, no purple anywhere.
3. Welcome sheet first-open → "Welcome to TestScrape".
4. SearchVarInput placeholder → "TestCo One / TestCo Two / TestCo Three".
5. Trigger an extraction error → console log prefix `[TestScrape]` (and `[TestScrape chart-bridge]` for chart-bridge entries).
6. First-install: API Settings shows `serverUrl` pre-filled `http://localhost:5099`.
7. Clear that URL → reload sidepanel → field stays empty (bootstrap flag honored).
8. Settle a batch → OS notification title `TestScrape — batch finished`.
9. DevTools → Application → Local Storage → `bb-settings` key contains `brandBootstrapped: true`.

### Edge cases

| Case | Decision | How |
|---|---|---|
| Brand without `defaultServerUrl` | Cover | `applyBrandDefaults` no-ops if field undefined |
| Brand without `searchVarPlaceholder` | Cover | SearchVarInput falls back to empty placeholder |
| `BLUEBERRY_THEME=nonexistent pnpm build` | Cover | wxt.config.ts try/catch throws clear error |
| User on existing install reopens after upgrade | Cover | New `brandBootstrapped` defaults `false`; if existing `serverUrl` non-empty, bootstrap does NOT overwrite — only fills when empty |
| User clears `serverUrl` deliberately | Cover | Bootstrap runs once (gated by flag); cleared field stays cleared |
| HMR on brand TS edit during `wxt dev` | Ignore (v1) | `addWatchFile` should pick it up; restart dev if not |
| Multi-brand swap mid-session | Ignore (v1) | Out of scope |
| Brand author types `primaryRgb` not matching `primary` | Ignore (v1) | Visual review during fixture authoring catches it |

---

## Stuck-loop guidance

- **WXT may not support top-level `await` in `defineConfig`** (F.5). Fallback: make `wxt.config.ts` an `async function` returning `defineConfig({ ... })`, or precompute the brand to a JSON file in a separate `prebuild` script. If the dynamic-import path fails after **one** retry, escalate per the global CLAUDE.md stuck-loop rule rather than thrashing on import variants.
- **Vite plugin `this.addWatchFile` may behave differently inside WXT's plugin pipeline.** If HMR doesn't pick up brand edits, accept as a v1 limitation per Stage E.
- **Verification gate:** do not declare done until **both** `BLUEBERRY_THEME=blueberry` and `BLUEBERRY_THEME=test-brand` builds succeed AND the manual 9-step test passes for the test brand.
