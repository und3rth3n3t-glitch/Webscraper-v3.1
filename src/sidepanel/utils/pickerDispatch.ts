import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { generateId } from './uuid';
import type { SelectorDescriptor, ScrapeElementConfig } from '../../types/config';

interface PickData {
  descriptor: SelectorDescriptor;
  elementType: string;
  label: string;
  extra: Record<string, unknown>;
  mode?: string;
}

function handlePrimary(stepId: string, pickData: PickData): void {
  const { descriptor, elementType, label, extra } = pickData;
  const { updateStep, steps } = useConfigStore.getState();

  updateStep(stepId, { selector: descriptor, elementType, extra });

  const step = steps.find((s) => s.id === stepId);
  if (step && !step.label) {
    updateStep(stepId, { label: label || `${step.type} element` });
  }
}

function handleAlternate(stepId: string, pickData: PickData): void {
  const { descriptor } = pickData;
  const { steps, draftStep, updateStepOptions } = useConfigStore.getState();
  const step =
    steps.find((s) => s.id === stepId) ||
    (draftStep?.id === stepId ? draftStep : null);
  if (!step) return;

  if (step.type === 'bestMatch') {
    updateStepOptions(stepId, { alternateContainerSelector: descriptor } as never);
  } else {
    // setInput, click — both store alternate under `alternateSelector`.
    updateStepOptions(stepId, { alternateSelector: descriptor } as never);
  }
}

function handleSelectEachControl(stepId: string, pickData: PickData): void {
  const { descriptor, elementType, extra } = pickData;
  const { updateStepOptions, steps } = useConfigStore.getState();

  const rawOptions = extra?.selectOptions as Array<{ value: string; label: string }> | undefined;
  const options =
    descriptor.tagName === 'SELECT' && rawOptions
      ? rawOptions.map((o) => ({ ...o, selected: true }))
      : [];

  const existing = steps.find((s) => s.id === stepId);
  const sel = existing?.type === 'selectEach' ? existing.options.selectEachOptions : undefined;

  updateStepOptions(stepId, {
    selectEachOptions: {
      ...sel,
      controlSelector: descriptor,
      controlType: elementType === 'select' ? 'select' : 'generic',
      options,
    } as unknown as import('../../types/config').SelectEachOptions['selectEachOptions'],
  } as never);
}

function handleNewElement(stepId: string, pickData: PickData): void {
  const { descriptor, elementType, label, extra, mode } = pickData;
  const { updateStepOptions, steps } = useConfigStore.getState();

  const step = steps.find((s) => s.id === stepId);
  const existingElements =
    step?.type === 'scrape' ? (step.options.elements ?? []) : [];

  const newEl: ScrapeElementConfig = {
    id: generateId(),
    name: label || `element${existingElements.length + 1}`,
    selector: descriptor,
    detectedType: elementType,
    selectMode: (mode as 'single' | 'all') || 'single',
    extra,
    tableFields: (extra?.columnNames as string[]) || [],
    excludedColumns: [],
    dynamicHeaders: false,
    excludedColumnIndices: [],
    paginate: !!(extra?.paginationDetected),
    paginationSelector: (extra?.paginationDetected as SelectorDescriptor | null) || null,
    paginationCount: 0,
  };

  updateStepOptions(stepId, { elements: [...existingElements, newEl] });
}

function handleContainer(stepId: string, pickData: PickData): void {
  const { descriptor, extra } = pickData;
  const clickableCount = extra?.clickableCount ?? null;
  useConfigStore.getState().updateStepOptions(stepId, {
    containerSelector: descriptor,
    containerClickableCount: clickableCount,
  } as never);
}

function handleCondition(stepId: string, pickData: PickData): void {
  const { descriptor } = pickData;
  const { steps, draftStep, updateStep } = useConfigStore.getState();
  const step =
    steps.find((s) => s.id === stepId) ||
    (draftStep?.id === stepId ? draftStep : null);
  if (!step) return;

  const cond = step.condition;
  if (cond?.kind === 'elementPresent') {
    updateStep(stepId, { condition: { ...cond, selector: descriptor } });
  } else {
    // Defensive: condition kind drifted; reset to elementPresent with the picked selector.
    updateStep(stepId, { condition: { kind: 'elementPresent', selector: descriptor } });
  }
}

function handleRepick(stepId: string, elementId: string, pickData: PickData): void {
  const { descriptor, elementType, extra } = pickData;
  const { updateStepOptions, steps } = useConfigStore.getState();

  const step = steps.find((s) => s.id === stepId);
  const existingElements = step?.type === 'scrape' ? (step.options.elements ?? []) : [];

  updateStepOptions(stepId, {
    elements: existingElements.map((el) =>
      el.id === elementId
        ? {
            ...el,
            selector: descriptor,
            detectedType: elementType,
            extra,
            tableFields: (extra?.columnNames as string[]) || [],
            excludedColumns: [],
            dynamicHeaders: false,
            excludedColumnIndices: [],
            paginate: !!(extra?.paginationDetected),
            paginationSelector: (extra?.paginationDetected as SelectorDescriptor | null) || null,
          }
        : el,
    ),
  });
}

function handlePagination(stepId: string, target: string, pickData: PickData): void {
  const { descriptor, label } = pickData;
  const { updateStepOptions, steps } = useConfigStore.getState();

  const step = steps.find((s) => s.id === stepId);
  const enrichedDescriptor: SelectorDescriptor = {
    ...descriptor,
    _paginationMeta: {
      text: (label || descriptor.textContent || '').substring(0, 30),
      tagName: descriptor.tagName,
    },
  };

  if (target === 'wholePage') {
    updateStepOptions(stepId, { paginationSelector: enrichedDescriptor });
  } else {
    const existingElements = step?.type === 'scrape' ? (step.options.elements ?? []) : [];
    updateStepOptions(stepId, {
      elements: existingElements.map((el) =>
        el.id === target ? { ...el, paginationSelector: enrichedDescriptor } : el,
      ),
    });
  }
}

export function dispatchPickerResult(
  field: string | null,
  stepId: string | null,
  pickData: PickData,
): void {
  const { setPickerActive, setPendingPickerStepId } = useUiStore.getState();
  setPickerActive(false);
  setPendingPickerStepId(null);

  if (!stepId) return;

  if (field === 'primary') {
    handlePrimary(stepId, pickData);
  } else if (field === 'alternate') {
    handleAlternate(stepId, pickData);
  } else if (field === 'selectEachControl') {
    handleSelectEachControl(stepId, pickData);
  } else if (field === 'newElement') {
    handleNewElement(stepId, pickData);
  } else if (field === 'container') {
    handleContainer(stepId, pickData);
  } else if (field === 'condition') {
    handleCondition(stepId, pickData);
  } else if (field?.startsWith('repick:')) {
    handleRepick(stepId, field.replace('repick:', ''), pickData);
  } else if (field?.startsWith('pagination:')) {
    handlePagination(stepId, field.replace('pagination:', ''), pickData);
  }
}
