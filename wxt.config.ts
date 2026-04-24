import { defineConfig } from 'wxt';

const themeName = process.env.BLUEBERRY_THEME ?? 'blueberry';

export default defineConfig({
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Blueberry Web Scraper',
    description: 'Record and execute web scraping flows',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs', 'offscreen'],
    host_permissions: ['<all_urls>'],
    side_panel: { default_path: 'sidepanel/index.html' },
    action: { default_title: 'Open Blueberry Scraper' },
  },

  vite: () => ({
    define: {
      __THEME_NAME__: JSON.stringify(themeName),
    },
  }),
});
