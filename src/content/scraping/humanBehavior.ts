interface Point { x: number; y: number }

interface MousePathOptions {
  afk?: boolean;
  durationMs?: number;
}

export async function moveMouseToElement(
  element: HTMLElement,
  opts: MousePathOptions = {},
): Promise<void> {
  if (opts.afk) return;

  const rect = element.getBoundingClientRect();
  const target: Point = {
    x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
    y: rect.top + rect.height * (0.3 + Math.random() * 0.4),
  };

  const origin: Point = {
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
  };

  const duration = opts.durationMs ?? (400 + Math.random() * 300);
  await fittsMousePath(origin, target, duration);
}

async function fittsMousePath(from: Point, to: Point, durationMs: number): Promise<void> {
  const STEPS = 25;
  const NOISE_PX = 3;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const perp = { x: -dy * 0.2, y: dx * 0.2 };

  const cp1: Point = { x: from.x + dx * 0.3 + perp.x, y: from.y + dy * 0.3 + perp.y };
  const cp2: Point = { x: from.x + dx * 0.7 + perp.x, y: from.y + dy * 0.7 + perp.y };

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const eased = easeInOutFitts(t);
    const pos = cubicBezier(from, cp1, cp2, to, eased);
    const noise = gaussianNoise(NOISE_PX);
    pos.x += noise.x;
    pos.y += noise.y;

    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: pos.x,
        clientY: pos.y,
      }),
    );

    const stepDelay = (durationMs / STEPS) * (1 + (t > 0.8 ? (t - 0.8) * 3 : 0));
    await delay(stepDelay);
  }

  // Correction sub-movements near target
  const corrections = 1 + Math.floor(Math.random() * 2);
  for (let c = 0; c < corrections; c++) {
    const jitter = gaussianNoise(2);
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: to.x + jitter.x,
        clientY: to.y + jitter.y,
      }),
    );
    await delay(30 + Math.random() * 40);
  }
}

function easeInOutFitts(t: number): number {
  if (t < 0.65) return (t / 0.65) * (t / 0.65) * 0.65;
  return 0.65 + (1 - Math.pow(1 - (t - 0.65) / 0.35, 2)) * 0.35;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
    y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

function gaussianNoise(amplitude: number): Point {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return { x: z * amplitude, y: z * amplitude };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function naturalClick(
  element: HTMLElement,
  opts: { afk?: boolean } = {},
): Promise<void> {
  await moveMouseToElement(element, { afk: opts.afk ?? false });

  // Strip target/rel to avoid triggering new-tab navigation
  if (element instanceof HTMLAnchorElement) {
    element.removeAttribute('target');
    element.removeAttribute('rel');
  }

  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: cx,
    clientY: cy,
  };

  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  await delay(40 + Math.random() * 60);
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  element.dispatchEvent(new MouseEvent('click', eventInit));
}

export async function typeText(
  element: HTMLElement,
  text: string,
  opts: { clearBefore?: boolean; pressEnterAfter?: boolean } = {},
): Promise<void> {
  if (opts.clearBefore) {
    await clearInput(element);
  }

  for (const char of text) {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value += char;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await delay(40 + Math.random() * 80);
  }

  if (opts.pressEnterAfter) {
    await pressEnter(element);
  }
}

export async function clearInput(element: HTMLElement): Promise<void> {
  if (!element) return;
  element.focus();
  await delay(100);

  element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }));
  await delay(50);

  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (nativeInputValueSetter && 'value' in element) {
    nativeInputValueSetter.call(element, '');
  } else if ('value' in element) {
    (element as HTMLInputElement).value = '';
  }

  element.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await delay(80);
}

export async function pressEnter(element: HTMLElement): Promise<void> {
  if (!element) return;
  await delay(150 + Math.random() * 200);
  const keyInit = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true };
  element.dispatchEvent(new KeyboardEvent('keydown', keyInit));
  await delay(50);
  element.dispatchEvent(new KeyboardEvent('keyup', keyInit));
  element.dispatchEvent(new KeyboardEvent('keypress', keyInit));
  const form = element.closest('form');
  if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

export async function smoothScrollToElement(element: HTMLElement): Promise<void> {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  if (rect.top >= 0 && rect.bottom <= viewportHeight) return;

  const targetY = window.scrollY + rect.top - viewportHeight / 3;
  const startY = window.scrollY;
  const distance = targetY - startY;
  const steps = 15 + Math.floor(Math.random() * 10);

  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    window.scrollTo(0, startY + distance * eased);
    await delay(12 + Math.random() * 18);
  }
}

export async function scrollToBottom(onProgress?: (scrollY: number, totalHeight: number) => void): Promise<void> {
  let lastHeight = document.body.scrollHeight;
  let attempts = 0;
  const maxAttempts = 50;

  while (attempts < maxAttempts) {
    const scrollAmount = 250 + Math.random() * 400;
    window.scrollBy(0, scrollAmount);
    await delay(400 + Math.random() * 500);

    onProgress?.(window.scrollY, document.body.scrollHeight);

    const newHeight = document.body.scrollHeight;
    if (newHeight === lastHeight) {
      await delay(1500 + Math.random() * 1000);
      if (document.body.scrollHeight === lastHeight) break;
    }
    lastHeight = document.body.scrollHeight;
    attempts++;
  }
}

export async function selectOption(element: HTMLElement, value: string): Promise<void> {
  if (!element || element.tagName !== 'SELECT') return;
  const sel = element as HTMLSelectElement;

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(sel, value);
  } else {
    sel.value = value;
  }

  sel.dispatchEvent(new Event('change', { bubbles: true }));
  sel.dispatchEvent(new Event('input', { bubbles: true }));
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}
