import { BlockType } from '../api/types';
import type { SaveTaskDto, StepBindingDto } from '../api/types';

export type SetInputStep = { id: string; type: 'setInput'; [key: string]: unknown };

export type EditorState = {
  name: string;
  loopBlockId: string;
  scrapeBlockId: string;
  loopName: string;
  loopValues: string[];
  scraperConfigId: string;
  stepBindings: Record<string, StepBindingDto>;
};

export function buildSaveDto(state: EditorState): SaveTaskDto {
  return {
    name: state.name,
    blocks: [
      {
        id: state.loopBlockId,
        parentBlockId: null,
        blockType: BlockType.Loop,
        orderIndex: 0,
        loop: { name: state.loopName, values: state.loopValues.filter((v) => v.trim().length > 0) },
        scrape: null,
      },
      {
        id: state.scrapeBlockId,
        parentBlockId: state.loopBlockId,
        blockType: BlockType.Scrape,
        orderIndex: 0,
        loop: null,
        scrape: { scraperConfigId: state.scraperConfigId, stepBindings: state.stepBindings },
      },
    ],
  };
}

export function parseSetInputSteps(configJson: unknown): SetInputStep[] {
  try {
    const obj = configJson as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) return [];
    return obj.steps.filter(
      (s): s is SetInputStep =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>).type === 'setInput' &&
        typeof (s as Record<string, unknown>).id === 'string',
    );
  } catch {
    return [];
  }
}

export function autoBindSteps(steps: SetInputStep[], loopBlockId: string): Record<string, StepBindingDto> {
  const result: Record<string, StepBindingDto> = {};
  let firstBound = false;
  for (const step of steps) {
    if (!firstBound) {
      result[step.id] = { kind: 'loopRef', loopBlockId };
      firstBound = true;
    } else {
      result[step.id] = { kind: 'unbound' };
    }
  }
  return result;
}
