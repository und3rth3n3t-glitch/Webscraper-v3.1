import type { ScraperConfig } from '../../types/config';

const CONFIGS_KEY = 'blueberry_scraper_configs';
const PREFS_KEY   = 'blueberry_scraper_prefs';

export const CURRENT_SCHEMA_VERSION = 2;

const STEP_OPTION_DEFAULTS: Record<string, Record<string, unknown>> = {
  setInput:   { clearBefore: true, pressEnterAfter: false, waitMethod: 'fixedDelay', waitAfterMs: 1500, isInitialInput: false, subsequentSelector: null },
  click:      { waitMethod: 'fixedDelay', waitAfterMs: 1500, waitForSelector: null },
  bestMatch:  { matchStrictness: 'normal', candidateSource: 'similar', containerSelector: null, clickableFilter: 'a, button', waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  goBack:     { waitMethod: 'contentChange', waitAfterMs: 1500, waitForSelector: null },
  scrape:     { mode: 'specificElements', scrollToBottom: true, expandHidden: false, paginate: false, paginationSelector: null, pageCount: 0, elements: [] },
  selectEach: { selectEachOptions: { controlType: null, controlSelector: null, options: [], contentAreaSelector: null, subSteps: [], waitAfterSelectMs: 1500 } },
  captureApiCalls: { urlPattern: '', durationMs: 5000, includeResponseBody: true },
  awaitUserAction: { message: '' },
};

export function migrateConfig(config: Record<string, unknown>): ScraperConfig | null {
  if (!config || typeof config !== 'object') return null;

  if ((config.schemaVersion as number || 0) >= CURRENT_SCHEMA_VERSION) {
    return config as unknown as ScraperConfig;
  }

  const migrated: Record<string, unknown> = { ...config };

  migrated.id = migrated.id || null;
  migrated.name = migrated.name || 'Untitled Config';
  migrated.steps = Array.isArray(migrated.steps) ? migrated.steps : [];
  migrated.domainLocked = (migrated.domainLocked as boolean) ?? !!(migrated.domain);
  migrated.domain = migrated.domain || '';
  migrated.url = migrated.url || '';
  migrated.dataMapping = migrated.dataMapping ?? undefined;

  migrated.steps = (migrated.steps as Array<Record<string, unknown>>)
    .map((step) => {
      if (!step || typeof step !== 'object') return null;
      const defaults = STEP_OPTION_DEFAULTS[step.type as string] || {};
      return {
        id: step.id,
        type: step.type,
        label: step.label || '',
        isSetup: step.isSetup ?? false,
        selector: step.selector || null,
        elementType: step.elementType || null,
        extra: step.extra || null,
        options: { ...defaults, ...(step.options as Record<string, unknown> || {}) },
      };
    })
    .filter(Boolean);

  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return migrated as unknown as ScraperConfig;
}

export async function getAllConfigs(): Promise<ScraperConfig[]> {
  try {
    const result = await browser.storage.local.get(CONFIGS_KEY);
    const raw = (result[CONFIGS_KEY] as Array<Record<string, unknown>>) || [];
    return raw.map(migrateConfig).filter((c): c is ScraperConfig => c !== null);
  } catch {
    return [];
  }
}

export async function saveConfig(config: ScraperConfig): Promise<ScraperConfig[]> {
  const configs = await getAllConfigs();
  const idx = configs.findIndex((c) => c.id === config.id);
  const now = Date.now();
  if (idx >= 0) {
    configs[idx] = { ...config, updatedAt: now };
  } else {
    configs.push({ ...config, createdAt: now, updatedAt: now });
  }
  await browser.storage.local.set({ [CONFIGS_KEY]: configs });
  return configs;
}

export async function deleteConfig(id: string): Promise<ScraperConfig[]> {
  const configs = await getAllConfigs();
  const updated = configs.filter((c) => c.id !== id);
  await browser.storage.local.set({ [CONFIGS_KEY]: updated });
  return updated;
}

export async function getConfigsByDomain(domain: string): Promise<ScraperConfig[]> {
  const configs = await getAllConfigs();
  return configs.filter((c) => c.domain === domain);
}

export async function getPrefs(): Promise<Record<string, unknown>> {
  try {
    const result = await browser.storage.local.get(PREFS_KEY);
    return (result[PREFS_KEY] as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

export async function setPref(key: string, value: unknown): Promise<void> {
  const prefs = await getPrefs();
  prefs[key] = value;
  await browser.storage.local.set({ [PREFS_KEY]: prefs });
}

export async function getStorageUsage(): Promise<{ used: number; quota: number; pct: number }> {
  try {
    const bytes = await browser.storage.local.getBytesInUse(null);
    const quota = (browser.storage.local as { QUOTA_BYTES?: number }).QUOTA_BYTES || 10_485_760;
    return { used: bytes, quota, pct: Math.round((bytes / quota) * 100) };
  } catch {
    return { used: 0, quota: 10_485_760, pct: 0 };
  }
}
