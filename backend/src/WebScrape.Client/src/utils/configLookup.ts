import { BlockType } from '../api/types';
import type { ScraperConfigDto, TaskDto } from '../api/types';

export function configNameFor(t: TaskDto, configs: ScraperConfigDto[] | undefined): string {
  const scrape = t.blocks.find((b) => b.blockType === BlockType.Scrape);
  const id = scrape?.scrape?.scraperConfigId;
  if (!id) return '';
  return configs?.find((c) => c.id === id)?.name ?? '';
}
