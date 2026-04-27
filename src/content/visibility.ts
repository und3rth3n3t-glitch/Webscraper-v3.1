export function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.offsetParent === null && getComputedStyle(html).position !== 'fixed') return false;
  const rect = html.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
