import { DETECTION_MEMORY_KEY, type DetectionMemory } from '../sidepanel/utils/detectionMemory';
import type { DetectionTrigger } from '../types/messages';

let cache: DetectionMemory = {};
let loaded = false;

// Initialise on content-script load. Synchronous reads happen later via
// `getCachedIgnoredTriggers`; reads before this completes return [].
export function initDetectionMemoryCache(): void {
  try {
    browser.storage.local.get(DETECTION_MEMORY_KEY).then((result) => {
      cache = (result[DETECTION_MEMORY_KEY] as DetectionMemory | undefined) ?? {};
      loaded = true;
    }).catch(() => { /* leave empty */ });
  } catch { /* browser not available (e.g. test environment) */ }

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[DETECTION_MEMORY_KEY];
      if (!change) return;
      cache = (change.newValue as DetectionMemory | undefined) ?? {};
    });
  } catch { /* SW restart edge case or browser not available */ }
}

export function getCachedIgnoredTriggers(domain: string): DetectionTrigger[] {
  if (!loaded) return [];
  return cache[domain]?.ignoredTriggers ?? [];
}
