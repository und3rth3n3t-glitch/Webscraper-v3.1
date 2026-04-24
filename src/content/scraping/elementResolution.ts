import type { SelectorDescriptor } from '../../types/config';

export function generateSelectorDescriptor(element: Element): SelectorDescriptor {
  const root = element.getRootNode();
  const inShadow = root instanceof ShadowRoot;
  const shadowHost = inShadow ? (root as ShadowRoot).host : null;

  return {
    cssSelector: buildCssSelector(element),
    xpathSelector: buildXPathSelector(element),
    textContent: ((element as HTMLElement).innerText || element.textContent || '').trim().substring(0, 100) || null,
    ariaLabel: element.getAttribute('aria-label') || null,
    placeholder: element.getAttribute('placeholder') || null,
    tagName: element.tagName,
    attributes: extractNotableAttributes(element),
    position: {
      parentSelector: element.parentElement ? buildCssSelector(element.parentElement) : null,
      childIndex: element.parentElement
        ? Array.from(element.parentElement.children).indexOf(element)
        : 0,
    },
    frameId: null,
    frameSrc: null,
    inShadowDom: inShadow,
    shadowHostSelector: shadowHost ? buildCssSelector(shadowHost) : null,
    shadowSelector: inShadow ? buildCssSelector(element, root as unknown as Document) : null,
  };
}

function buildCssSelector(element: Element, root: Document | ShadowRoot = document): string {
  if (!element || element === document.body || element === document.documentElement) return 'body';

  if (element.id && !element.id.match(/^\d/)) {
    try {
      if (root.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
        return '#' + CSS.escape(element.id);
      }
    } catch { /* expected */ }
  }

  for (const attr of ['data-testid', 'data-id', 'name']) {
    const val = element.getAttribute(attr);
    if (val) {
      const sel = `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
      try {
        if (root.querySelectorAll(sel).length === 1) return sel;
      } catch { /* expected */ }
    }
  }

  if (element.getAttribute('aria-label')) {
    const sel = `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(element.getAttribute('aria-label')!)}"]`;
    try {
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch { /* expected */ }
  }

  const classes = Array.from(element.classList)
    .filter((c) => !c.match(/^(is-|has-|active|hover|focus|selected|disabled|loading|js-)/))
    .slice(0, 2);

  const tag = element.tagName.toLowerCase();
  if (classes.length > 0) {
    const sel = `${tag}.${classes.map(CSS.escape).join('.')}`;
    try {
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch { /* expected */ }
  }

  return buildNthChildPath(element);
}

function buildNthChildPath(element: Element): string {
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((c) => c.tagName === current!.tagName)
      : [];
    const idx = siblings.indexOf(current) + 1;
    path.unshift(siblings.length === 1 ? tag : `${tag}:nth-of-type(${idx})`);
    current = current.parentElement;
    if (path.length > 6) break;
  }

  return path.join(' > ') || element.tagName.toLowerCase();
}

function buildXPathSelector(element: Element): string {
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((c) => c.tagName === current!.tagName)
      : [];
    const idx = siblings.indexOf(current) + 1;
    path.unshift(siblings.length === 1 ? tag : `${tag}[${idx}]`);
    current = current.parentElement;
    if (path.length > 8) break;
  }

  return '//' + path.join('/');
}

function extractNotableAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  const notable = [
    'id', 'name', 'role', 'type', 'href', 'data-testid', 'data-id',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'class',
  ];
  for (const attr of notable) {
    const val = element.getAttribute(attr);
    if (val) attrs[attr] = val.substring(0, 100);
  }
  return attrs;
}

export function resolveElement(
  descriptor: SelectorDescriptor,
  root: Document | ShadowRoot = document,
): { element: Element | null; confidence: number } {
  if (!descriptor) return { element: null, confidence: 0 };

  if (descriptor.inShadowDom && descriptor.shadowHostSelector) {
    try {
      const host = document.querySelector(descriptor.shadowHostSelector);
      if (host?.shadowRoot) {
        const shadowEl = resolveElement({ ...descriptor, inShadowDom: false }, host.shadowRoot);
        if (shadowEl.element) return shadowEl;
      }
    } catch { /* expected */ }
  }

  type Strategy = () => { element: Element; confidence: number } | null;

  const strategies: Strategy[] = [
    () => {
      try {
        const el = root.querySelector(descriptor.cssSelector);
        return isElement(el) ? { element: el!, confidence: 1.0 } : null;
      } catch { return null; }
    },

    () => {
      try {
        const result = (root as Document).evaluate(
          descriptor.xpathSelector, root, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null,
        );
        const el = result.singleNodeValue as Element | null;
        return isElement(el) ? { element: el!, confidence: 0.95 } : null;
      } catch { return null; }
    },

    () => {
      if (!descriptor.ariaLabel) return null;
      const el = root.querySelector(`[aria-label="${CSS.escape(descriptor.ariaLabel)}"]`);
      return isElement(el) ? { element: el!, confidence: 0.85 } : null;
    },

    () => {
      if (!descriptor.placeholder) return null;
      const el = root.querySelector(`[placeholder="${CSS.escape(descriptor.placeholder)}"]`);
      return isElement(el) ? { element: el!, confidence: 0.82 } : null;
    },

    // Jaccard token similarity (V3 replacement for V2 character-overlap)
    () => {
      if (!descriptor.textContent || descriptor.textContent.length < 3) return null;
      const tag = descriptor.tagName?.toLowerCase() || '*';
      const candidates = Array.from(root.querySelectorAll(tag));
      const target = descriptor.textContent.toLowerCase();

      let best: Element | null = null;
      let bestScore = 0;

      for (const el of candidates) {
        const text = ((el as HTMLElement).innerText || el.textContent || '').trim().toLowerCase();
        if (!text) continue;
        const score = jaccardSimilarity(text, target);
        if (score > bestScore && score > 0.8) {
          best = el;
          bestScore = score;
        }
      }
      return best ? { element: best, confidence: 0.75 * bestScore } : null;
    },

    () => {
      const attrs = descriptor.attributes || {};
      const tag = descriptor.tagName?.toLowerCase() || '*';
      const parts: string[] = [];

      for (const attr of ['name', 'role', 'type']) {
        if (attrs[attr]) parts.push(`[${attr}="${CSS.escape(attrs[attr])}"]`);
      }

      if (parts.length === 0) return null;
      try {
        const sel = tag + parts.join('');
        const els = root.querySelectorAll(sel);
        if (els.length === 1) return isElement(els[0]) ? { element: els[0], confidence: 0.65 } : null;
        if (els.length > 1 && descriptor.position?.childIndex !== null && descriptor.position?.childIndex !== undefined) {
          const el = els[Math.min(descriptor.position.childIndex, els.length - 1)];
          return isElement(el) ? { element: el, confidence: 0.55 } : null;
        }
      } catch { /* expected */ }
      return null;
    },

    () => {
      const pos = descriptor.position;
      if (!pos?.parentSelector || pos.childIndex === null || pos.childIndex === undefined) return null;
      try {
        const parent = root.querySelector(pos.parentSelector);
        if (!parent) return null;
        const children = Array.from(parent.children);
        const el = children[pos.childIndex];
        return isElement(el) ? { element: el, confidence: 0.5 } : null;
      } catch { return null; }
    },
  ];

  for (const strategy of strategies) {
    const result = strategy();
    if (result?.element) return result;
  }

  return { element: null, confidence: 0 };
}

function classesOverlap(refClassName: string, candidateClassName: string): boolean {
  const refSet = new Set(refClassName.split(/\s+/).filter(Boolean));
  const candSet = new Set(candidateClassName.split(/\s+/).filter(Boolean));
  if (refSet.size === 0) return candSet.size === 0;
  const overlap = [...refSet].filter((c) => candSet.has(c)).length;
  return overlap / refSet.size >= 0.75;
}

export function resolveAllSimilar(descriptor: SelectorDescriptor, root: Document | ShadowRoot = document): Element[] {
  const { element } = resolveElement(descriptor, root);
  if (!element) return [];

  let parent = element.parentElement;
  for (let i = 0; i < 4 && parent; i++) {
    const tag = element.tagName;
    const cls = element.className;
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === tag && classesOverlap(cls?.toString() || '', c.className?.toString() || ''),
    );
    if (siblings.length >= 2) return siblings;
    parent = parent.parentElement;
  }

  const listParent = element.closest('ul, ol, tbody, [role="list"], [role="grid"]');
  if (listParent) {
    return Array.from(listParent.querySelectorAll(element.tagName.toLowerCase()));
  }

  return [element];
}

export function resolveContainer(descriptor: SelectorDescriptor, root: Document | ShadowRoot = document): Element | null {
  const { element } = resolveElement(descriptor, root);
  if (!element) return null;

  const semanticTags = ['TABLE', 'ARTICLE', 'SECTION', 'MAIN', 'UL', 'OL', 'DL', 'FIGURE', 'FORM', 'NAV'];
  let current: Element | null = element;

  while (current && current !== document.body) {
    if (semanticTags.includes(current.tagName)) return current;
    if (
      current.getAttribute('role') &&
      ['list', 'grid', 'table', 'region', 'main', 'complementary'].includes(current.getAttribute('role')!)
    ) {
      return current;
    }
    if (current.className && current.className.toString().match(/(card|container|wrapper|panel|box|widget)/i)) {
      return current;
    }
    current = current.parentElement;
  }

  return element.parentElement || element;
}

function isElement(node: Node | null | undefined): node is Element {
  return node != null && typeof (node as Element).getAttribute === 'function';
}

// Jaccard similarity: intersection/union of token sets
function jaccardSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}
