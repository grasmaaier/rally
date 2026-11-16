/** Popover with a grid of segment shapes (used by the outliner and the node view). */
import { SHAPE_OPTIONS } from '../tools/lampParts';
import { escapeHtml, shortLabel } from './controls';
import { shapeIcon } from './icons';
import { SHAPE_SHORT } from './lampModel';

let open: { el: HTMLElement; close: () => void } | null = null;

export function closePicker() {
  open?.close();
}

/** Show the shape grid next to `anchor` (or at a client point). */
export function openShapePicker(anchor: HTMLElement | { x: number; y: number }, title: string, onPick: (shape: string) => void) {
  closePicker();
  const el = document.createElement('div');
  el.className = 'picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="picker-head">${escapeHtml(title)}</div><div class="picker-grid">${SHAPE_OPTIONS.map(
    (o) => `<button type="button" class="tile" data-shape="${o.value}" title="${escapeHtml(o.label)}">${shapeIcon(o.value)}<span>${escapeHtml(SHAPE_SHORT[o.value] ?? shortLabel(o.label))}</span></button>`,
  ).join('')}</div>`;
  document.body.append(el);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let x = r.left;
  let y = r.bottom + 6;
  if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);
  x = Math.min(Math.max(8, x), vw - w - 8);
  el.style.left = `${x}px`;
  el.style.top = `${Math.max(8, Math.min(y, vh - h - 8))}px`;
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (open?.el === el) open = null;
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-shape]');
    if (!b) return;
    close();
    onPick(b.dataset.shape!);
  });
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  open = { el, close };
  el.querySelector<HTMLButtonElement>('button')?.focus();
}
