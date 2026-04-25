import { defineConfig } from 'wxt';
import { readFileSync } from 'fs';

const themeName = process.env.BLUEBERRY_THEME ?? 'blueberry';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const appVersion = pkg.version;

export default defineConfig({
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Blueberry Web Scraper',
    description: 'Record and execute web scraping flows',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen'],
    host_permissions: ['<all_urls>'],
    icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    side_panel: { default_path: 'sidepanel/index.html' },
    action: { default_title: 'Open Blueberry Scraper', default_icon: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } },
  },

  vite: () => ({
    define: {
      __THEME_NAME__: JSON.stringify(themeName),
      __APP_VERSION__: JSON.stringify(appVersion),
    },
  }),
});
