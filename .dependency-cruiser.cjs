/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── V2 rules (carried forward) ──────────────────────────────────────────
    {
      name: 'no-content-to-sidepanel',
      severity: 'error',
      from: { path: '^src/entrypoints/content|^src/content' },
      to:   { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
    },
    {
      name: 'no-sidepanel-to-content',
      severity: 'error',
      from: { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
      to:   { path: '^src/content|^src/entrypoints/content' },
    },
    {
      name: 'no-content-to-background',
      severity: 'error',
      from: { path: '^src/content|^src/entrypoints/content' },
      to:   { path: '^src/entrypoints/background' },
    },
    {
      name: 'no-sidepanel-to-background',
      severity: 'error',
      from: { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
      to:   { path: '^src/entrypoints/background' },
    },
    {
      name: 'no-background-to-sidepanel',
      severity: 'error',
      from: { path: '^src/entrypoints/background' },
      to:   { path: '^src/sidepanel|^src/entrypoints/sidepanel' },
    },
    {
      name: 'no-background-to-content',
      severity: 'error',
      from: { path: '^src/entrypoints/background' },
      to:   { path: '^src/content|^src/entrypoints/content' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to:   { circular: true },
    },
    {
      name: 'no-store-reverse-imports',
      severity: 'error',
      from: { path: '^src/sidepanel/stores/configStore' },
      to:   { path: '^src/sidepanel/stores/(uiStore|runStore|settingsStore|queueStore|networkRecordStore)' },
    },
    {
      name: 'no-npm-in-content',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { dependencyTypes: ['npm'], pathNot: '^src/types' },
    },
    // ── V3 new rules ─────────────────────────────────────────────────────────
    {
      name: 'no-offscreen-to-content',
      severity: 'error',
      from: { path: '^src/entrypoints/offscreen|^src/offscreen' },
      to:   { path: '^src/content' },
    },
    {
      name: 'no-content-to-offscreen',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { path: '^src/offscreen' },
    },
    {
      name: 'no-signalr-in-content',
      severity: 'error',
      from: { path: '^src/content' },
      to:   { path: '@microsoft/signalr' },
    },
    {
      name: 'no-network-recorder-in-isolated',
      severity: 'error',
      from: { path: '^src/content/(scraping|extraction|picker)' },
      to:   { path: '^src/content/network' },
    },
    {
      name: 'no-npm-in-types',
      severity: 'error',
      from: { path: '^src/types' },
      to:   { dependencyTypes: ['npm'] },
    },
    {
      name: 'no-config-store-imports-new-stores',
      severity: 'error',
      from: { path: '^src/sidepanel/stores/configStore' },
      to:   { path: '^src/sidepanel/stores/(settingsStore|queueStore|networkRecordStore)' },
    },
  ],
  options: {
    includeOnly: '^src/',
    doNotFollow: { path: 'node_modules' },
  },
};
