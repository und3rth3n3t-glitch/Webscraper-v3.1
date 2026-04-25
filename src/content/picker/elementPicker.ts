import { generateSelectorDescriptor, resolveAllSimilar } from '../scraping/elementResolution';
import { detectElementType, getElementLabel, detectPagination, promoteToChartContainer, injectSelectorGenerator } from '../extraction/domUtils';
import { getTableColumnNames, getTablePreview } from '../extraction/tableExtractor';
import { detectChartExtractionMethod } from '../extraction/chartExtractor';
import type { SelectorDescriptor } from '../../types/config';

// Wire up the domUtils dependency injection so detectPagination can call generateSelectorDescriptor
injectSelectorGenerator(generateSelectorDescriptor);

let isActive = false;
let currentMode: 'single' | 'allSimilar' | 'container' = 'single';
let overlayEl: HTMLDivElement | null = null;
let tooltipEl: HTMLDivElement | null = null;
let hoveredElement: Element | null = null;
let similarOverlays: HTMLDivElement[] = [];
let visibilityHandler: (() => void) | null = null;

export function startPicker(mode: 'single' | 'allSimilar' | 'container' = 'single'): void {
  if (isActive) stopPicker();
  isActive = true;
  currentMode = mode;

  createOverlay();
  createTooltip();

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.documentElement.style.cursor = 'crosshair';

  visibilityHandler = () => {
    if (document.hidden) {
      stopPicker();
      window.dispatchEvent(new CustomEvent('__blueberry_picker_cancelled'));
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function stopPicker(): void {
  if (!isActive) return;
  isActive = false;

  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.documentElement.style.cursor = '';

  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }

  removeOverlay();
  removeTooltip();
  clearSimilarOverlays();
  hoveredElement = null;
}

function createOverlay(): void {
  overlayEl = document.createElement('div');
  overlayEl.id = '__blueberry-picker-overlay';
  overlayEl.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483646;
    border: 2px solid #5F259F;
    background: rgba(95, 37, 159, 0.1);
    border-radius: 2px;
    transition: all 0.05s ease;
    box-sizing: border-box;
    display: none;
  `;
  document.documentElement.appendChild(overlayEl);
}

function removeOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
}

function clearSimilarOverlays(): void {
  similarOverlays.forEach((el) => el.remove());
  similarOverlays = [];
}

function showSimilarOverlays(elements: Element[]): void {
  clearSimilarOverlays();
  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      border: 2px dashed #5F259F;
      background: rgba(95, 37, 159, 0.06);
      border-radius: 2px;
      box-sizing: border-box;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
    `;
    document.documentElement.appendChild(overlay);
    similarOverlays.push(overlay);
  });
}

function positionOverlay(element: Element): void {
  if (!overlayEl || !element) return;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    overlayEl.style.display = 'none';
    return;
  }
  overlayEl.style.display = 'block';
  overlayEl.style.top = `${rect.top}px`;
  overlayEl.style.left = `${rect.left}px`;
  overlayEl.style.width = `${rect.width}px`;
  overlayEl.style.height = `${rect.height}px`;
}

function createTooltip(): void {
  tooltipEl = document.createElement('div');
  tooltipEl.id = '__blueberry-picker-tooltip';
  tooltipEl.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    background: #5F259F;
    color: #fff;
    font-family: monospace;
    font-size: 11px;
    line-height: 1.4;
    padding: 4px 8px;
    border-radius: 4px;
    max-width: 260px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;
  document.documentElement.appendChild(tooltipEl);
}

function removeTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}

function updateTooltip(element: Element, mouseX: number, mouseY: number): void {
  if (!tooltipEl || !element) return;

  const tag = element.tagName.toLowerCase();
  const cls = Array.from(element.classList).slice(0, 2).join('.');
  const text = (element.textContent || '').trim().substring(0, 50);
  const classStr = cls ? `.${cls}` : '';

  const modeLabel = currentMode === 'allSimilar' ? ' [all similar]' : currentMode === 'container' ? ' [container]' : '';
  tooltipEl.textContent = `<${tag}${classStr}>${modeLabel}${text ? ` "${text}"` : ''}`;
  tooltipEl.style.display = 'block';

  const padding = 12;
  const tipW = 270;
  const tipH = 30;
  let tx = mouseX + padding;
  let ty = mouseY + padding;

  if (tx + tipW > window.innerWidth) tx = mouseX - tipW - padding;
  if (ty + tipH > window.innerHeight) ty = mouseY - tipH - padding;

  tooltipEl.style.left = `${Math.max(0, tx)}px`;
  tooltipEl.style.top = `${Math.max(0, ty)}px`;
}

function onMouseMove(e: MouseEvent): void {
  if (!isActive) return;

  if (overlayEl) overlayEl.style.display = 'none';
  if (tooltipEl) tooltipEl.style.display = 'none';

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el === document.documentElement || el === document.body) {
    hoveredElement = null;
    return;
  }

  const target = getTargetElement(el);
  hoveredElement = target;

  positionOverlay(target);
  updateTooltip(target, e.clientX, e.clientY);

  if (currentMode === 'allSimilar') {
    try {
      const descriptor = generateSelectorDescriptor(target);
      const similar = resolveAllSimilar(descriptor);
      showSimilarOverlays(similar.filter((el) => el !== target));
    } catch { /* expected */ }
  } else {
    clearSimilarOverlays();
  }

  sendHoverUpdate(target);
}

function onClick(e: MouseEvent): void {
  if (!isActive) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const el = hoveredElement || (e.target as Element | null);
  if (!el) return;

  void pickElement(el);
}

function onKeyDown(e: KeyboardEvent): void {
  if (!isActive) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    stopPicker();
    window.dispatchEvent(new CustomEvent('__blueberry_picker_cancelled'));
  }
}

function getTargetElement(el: Element): Element {
  if (currentMode === 'container') return findSemanticContainer(el);
  return el;
}

function findSemanticContainer(el: Element): Element {
  const semanticTags = new Set(['article', 'section', 'li', 'tr', 'td', 'th', 'figure', 'aside', 'nav', 'header', 'footer', 'main', 'form', 'fieldset', 'details']);
  let current = el.parentElement;
  while (current && current !== document.body) {
    if (semanticTags.has(current.tagName.toLowerCase())) return current;
    const cls = current.className?.toString() || '';
    if (/(card|item|row|result|product|listing|entry|block|panel)/i.test(cls)) return current;
    current = current.parentElement;
  }
  return el.parentElement || el;
}

async function pickElement(element: Element): Promise<void> {
  stopPicker();

  let target = element;
  const TABLE_DESCENDANTS = new Set(['TD', 'TH', 'TR', 'THEAD', 'TBODY', 'TFOOT', 'CAPTION', 'COL', 'COLGROUP']);
  if (TABLE_DESCENDANTS.has(target.tagName)) {
    const tableAncestor = target.closest('table');
    if (tableAncestor) target = tableAncestor;
  }

  if ((target as SVGElement).ownerSVGElement) {
    target = promoteToChartContainer(target);
  }

  const descriptor = generateSelectorDescriptor(target);
  const elementType = detectElementType(target);
  const label = getElementLabel(target);

  const extra = await buildExtraInfo(target, elementType, descriptor);

  if (currentMode === 'container') {
    const clickables = target.querySelectorAll('a, button');
    const visibleCount = Array.from(clickables).filter((el) => (el as HTMLElement).offsetParent !== null).length;
    extra.clickableCount = visibleCount;
  }

  let allSimilarCount: number | null = null;
  if (currentMode === 'allSimilar') {
    try {
      const similar = resolveAllSimilar(descriptor);
      allSimilarCount = similar.length;
    } catch { /* expected */ }
  }

  const pickData = { descriptor, elementType, label, mode: currentMode, allSimilarCount, extra };
  window.dispatchEvent(new CustomEvent('__blueberry_element_picked', { detail: pickData }));
}

async function buildExtraInfo(
  element: Element,
  elementType: string | null,
  _descriptor: SelectorDescriptor,
): Promise<Record<string, unknown>> {
  const extra: Record<string, unknown> = {};

  if (elementType === 'table') {
    try {
      extra.columnNames = getTableColumnNames(element);
      extra.preview = getTablePreview(element, 3);
    } catch { /* expected */ }
    try {
      extra.paginationDetected = detectPagination(element);
    } catch { /* expected */ }
  }

  if (elementType === 'chart') {
    try {
      extra.chartMethod = await detectChartExtractionMethod(element);
    } catch { /* expected */ }
  }

  if (elementType === 'select') {
    extra.selectOptions = Array.from((element as HTMLSelectElement).querySelectorAll('option')).map((o) => ({
      value: (o as HTMLOptionElement).value,
      label: o.textContent?.trim() || '',
    }));
  }

  return extra;
}

function sendHoverUpdate(element: Element): void {
  if (!element) return;
  const tag = element.tagName.toLowerCase();
  const cls = Array.from(element.classList).slice(0, 3).join('.');
  const text = (element.textContent || '').trim().substring(0, 60);

  window.dispatchEvent(new CustomEvent('__blueberry_element_hover', {
    detail: { tagName: tag, className: cls, textSnippet: text },
  }));
}
