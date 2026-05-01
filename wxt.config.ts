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
