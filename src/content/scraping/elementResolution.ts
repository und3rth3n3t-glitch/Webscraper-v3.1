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

function isLikelyDynamicId(id: string): boolean {
  // Library-generated ID prefixes — these regenerate on every page load.
  if (/^(highcharts|recharts|chartjs|chart-canvas-|mui-|radix-|chakra-|mantine-|emotion-|css-|__react|gwt-|ext-|aria-|x-|y-|z-)/i.test(id)) return true;
  // Generic random-looking pattern: a short readable prefix followed by 5+
  // alphanumeric characters and an optional trailing index. Catches things
  // like `highcharts-Vqa5b3w-0`, `tooltip-x9k2p`, `ember1234`.
  if (/^[a-z]{2,15}-?[a-z0-9]{5,}(?:-\d+)?$/i.test(id) && /[a-z]/i.test(id) && /[0-9]/.test(id)) return true;
  // Pure hex/UUID-looking IDs.
  if (/^[a-f0-9-]{16,}$/i.test(id)) return true;
  return false;
}

function uniqueAnchorSelector(el: Element, root: Document | ShadowRoot): string | null {
  // Stable ID (skip dynamic library IDs).
  if (el.id && !el.id.match(/^\d/) && !isLikelyDynamicId(el.id)) {
    try {
      if (root.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        return '#' + CSS.escape(el.id);
      }
    } catch { /* expected */ }
  }
  // data-testid / data-id / name with unique value.
  for (const attr of ['data-testid', 'data-id', 'name']) {
    const val = el.getAttribute(attr);
    if (val) {
      const sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
      try { if (root.querySelectorAll(sel).length === 1) return sel; } catch { /* expected */ }
    }
  }
  // Unique class combo.
  const classes = Array.from(el.classList)
    .filter((c) => !c.match(/^(is-|has-|active|hover|focus|selected|disabled|loading|js-)/))
    .slice(0, 2);
  if (classes.length > 0) {
    const sel = `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
    try { if (root.querySelectorAll(sel).length === 1) return sel; } catch { /* expected */ }
  }
  return null;
}

function buildCssSelector(element: Element, root: Document | ShadowRoot = document): string {
  if (!element || element === document.body || element === document.documentElement) return 'body';

  // Try a direct unique selector on the element itself.
  const direct = uniqueAnchorSelector(element, root);
  if (direct) return direct;

  // aria-label is sometimes unique even if class isn't — try it before falling
  // back to the structural path.
  if (element.getAttribute('aria-label')) {
    const sel = `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(element.getAttribute('aria-label')!)}"]`;
    try {
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch { /* expected */ }
  }

  return buildNthChildPath(element, root);
}

function buildNthChildPath(element: Element, root: Document | ShadowRoot = document): string {
  // Walk up looking for an ancestor with a stable unique selector. Anchor
  // the path on it so the resulting selector can't drift to unrelated parts
  // of the DOM after page reload (the original failure mode where a path
  // like `div > div > div > ...` matched a Mapbox container instead of the
  // intended Highcharts wrapper).
  const path: string[] = [];
  let anchor: string | null = null;
  let current: Element | null = element.parentElement;
  let depth = 0;

  while (current && current.tagName && current !== document.body) {
    anchor = uniqueAnchorSelector(current, root);
    if (anchor) break;

    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((c) => c.tagName === current!.tagName)
      : [];
    const idx = siblings.indexOf(current) + 1;
    path.unshift(siblings.length === 1 ? tag : `${tag}:nth-of-type(${idx})`);

    current = current.parentElement;
    depth++;
    if (depth > 8) break;
  }

  // Build the element's own segment.
  const tag = element.tagName.toLowerCase();
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).filter((c) => c.tagName === element.tagName)
    : [];
  const idx = siblings.indexOf(element) + 1;
  const elementSegment = siblings.length === 1 ? tag : `${tag}:nth-of-type(${idx})`;

  if (anchor) {
    return path.length > 0
      ? `${anchor} > ${path.join(' > ')} > ${elementSegment}`
      : `${anchor} > ${elementSegment}`;
  }

  // No stable ancestor found — fall back to a (still un-anchored) path. This
  // matches the original pre-fix behaviour and is brittle, but preferable to
  // returning nothing.
  path.push(elementSegment);
  return path.join(' > ') || tag;
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

export interface ResolveResult {
  element: Element | null;
  confidence: number;
  strategy: string;
}

export function resolveElement(
  descriptor: SelectorDescriptor,
  root: Document | ShadowRoot = document,
): ResolveResult {
  if (!descriptor) return { element: null, confidence: 0, strategy: 'none' };

  if (descriptor.inShadowDom && descriptor.shadowHostSelector) {
    try {
      const host = document.querySelector(descriptor.shadowHostSelector);
      if (host?.shadowRoot) {
        const shadowEl = resolveElement({ ...descriptor, inShadowDom: false }, host.shadowRoot);
        if (shadowEl.element) return shadowEl;
      }
    } catch { /* expected */ }
  }

  type Strategy = { name: string; run: () => { element: Element; confidence: number } | null };

  const strategies: Strategy[] = [
    {
      name: 'cssSelector',
      run: () => {
        try {
          const el = root.querySelector(descriptor.cssSelector);
          return isElement(el) ? { element: el!, confidence: 1.0 } : null;
        } catch { return null; }
      },
    },

    {
      name: 'xpath',
      run: () => {
        try {
          const result = (root as Document).evaluate(
            descriptor.xpathSelector, root, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null,
          );
          const el = result.singleNodeValue as Element | null;
          return isElement(el) ? { element: el!, confidence: 0.95 } : null;
        } catch { return null; }
      },
    },

    {
      name: 'ariaLabel',
      run: () => {
        if (!descriptor.ariaLabel) return null;
        const el = root.querySelector(`[aria-label="${CSS.escape(descriptor.ariaLabel)}"]`);
        return isElement(el) ? { element: el!, confidence: 0.85 } : null;
      },
    },

    {
      name: 'placeholder',
      run: () => {
        if (!descriptor.placeholder) return null;
        const el = root.querySelector(`[placeholder="${CSS.escape(descriptor.placeholder)}"]`);
        return isElement(el) ? { element: el!, confidence: 0.82 } : null;
      },
    },

    {
      name: 'textJaccard',
      run: () => {
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
    },

    {
      name: 'attrCombo',
      run: () => {
        const attrs = descriptor.attributes || {};
        const tag = descriptor.tagName?.toLowerCase() || '*';
        const parts: string[] = [];

        for (const attr of ['name', 'role', 'type']) {
          if (attrs[attr]) parts.push(`[${attr}="${CSS.escape(attrs[attr])}"]`);
        }
        if (parts.length === 0) return null;

        // Try most specific first; on no-match, drop the last attribute and retry.
        // For an input with [name, role, type]: attempts [name][role][type] → [name][role] → [name].
        for (let len = parts.length; len > 0; len--) {
          const sel = tag + parts.slice(0, len).join('');
          const dropped = parts.length - len;
          const baseConf = 0.65 - dropped * 0.05;
          try {
            const els = root.querySelectorAll(sel);
            if (els.length === 0) continue;
            if (els.length === 1) {
              return isElement(els[0]) ? { element: els[0], confidence: baseConf } : null;
            }
            if (descriptor.position?.childIndex !== null && descriptor.position?.childIndex !== undefined) {
              const el = els[Math.min(descriptor.position.childIndex, els.length - 1)];
              if (isElement(el)) return { element: el, confidence: baseConf - 0.10 };
            }
            // Multiple matches with no childIndex hint — fall back to first match
            return isElement(els[0]) ? { element: els[0], confidence: baseConf - 0.15 } : null;
          } catch { /* expected */ }
        }
        return null;
      },
    },

    {
      name: 'parentChildIndex',
      run: () => {
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
    },
  ];

  // For chart elements (saved descriptor tag is SVG or CANVAS), tag is highly
  // meaningful — picking a chart and ending up with a DIV is always wrong.
  // Reject strategy results whose tag doesn't match the descriptor's tag, so
  // we fall through to the next strategy rather than silently mismatching.
  // For other tags (DIV, BUTTON, etc.) we keep the existing permissive
  // behaviour because picker-time tag swaps are common and usually fine.
  const expectedTag = descriptor.tagName?.toUpperCase();
  const tagStrict = expectedTag === 'SVG' || expectedTag === 'CANVAS';

  for (const strategy of strategies) {
    const result = strategy.run();
    if (!result?.element) continue;
    if (tagStrict && result.element.tagName !== expectedTag) continue;
    return { ...result, strategy: strategy.name };
  }

  return { element: null, confidence: 0, strategy: 'none' };
}

export function resolveWithAlternate(
  primary: SelectorDescriptor,
  alternate: SelectorDescriptor | null,
  root: Document | ShadowRoot = document,
): ResolveResult {
  const r = resolveElement(primary, root);
  if (r.element) return r;
  if (!alternate) return r;
  return resolveElement(alternate, root);
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
  return node !== null && node !== undefined && typeof (node as Element).getAttribute === 'function';
}

// Jaccard similarity: intersection/union of token sets
function jaccardSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}
