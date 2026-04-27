import type { DetectionTrigger } from '../../types/messages';

const KEY = 'blueberry_detection_memory';

export interface DomainMemory {
  ignoredTriggers: DetectionTrigger[];
  updatedAt: number;
}

export type DetectionMemory = Record<string, DomainMemory>;

export async function getDetectionMemory(): Promise<DetectionMemory> {
  try {
    const result = await browser.storage.local.get(KEY);
    return (result[KEY] as DetectionMemory | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function getIgnoredTriggers(domain: string): Promise<DetectionTrigger[]> {
  const memory = await getDetectionMemory();
  return memory[domain]?.ignoredTriggers ?? [];
}

export async function addIgnoredTrigger(
  domain: string,
  trigger: DetectionTrigger,
): Promise<void> {
  if (!domain) return;
  const memory = await getDetectionMemory();
  const existing = memory[domain] ?? { ignoredTriggers: [], updatedAt: 0 };
  if (existing.ignoredTriggers.includes(trigger)) return;
  memory[domain] = {
    ignoredTriggers: [...existing.ignoredTriggers, trigger],
    updatedAt: Date.now(),
  };
  await browser.storage.local.set({ [KEY]: memory });
}

export async function removeIgnoredTrigger(
  domain: string,
  trigger: DetectionTrigger,
): Promise<void> {
  const memory = await getDetectionMemory();
  const existing = memory[domain];
  if (!existing) return;
  const next = existing.ignoredTriggers.filter((t) => t !== trigger);
  if (next.length === 0) {
    delete memory[domain];
  } else {
    memory[domain] = { ignoredTriggers: next, updatedAt: Date.now() };
  }
  await browser.storage.local.set({ [KEY]: memory });
}

export async function clearDomainMemory(domain: string): Promise<void> {
  const memory = await getDetectionMemory();
  if (memory[domain]) {
    delete memory[domain];
    await browser.storage.local.set({ [KEY]: memory });
  }
}

// Exported for tests and the in-content cache.
export const DETECTION_MEMORY_KEY = KEY;
