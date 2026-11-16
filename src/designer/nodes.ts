/**
 * Node view of the lamp (SVG, no library): the segments as a chain that
 * feeds the stack, which feeds the lamp together with the socket and the
 * base or canopy. Click selects (shared with the 3D view and inspector),
 * nodes can be dragged, a segment dropped between others moves in the chain.
 */
import type { Params } from '../core/types';
import { escapeHtml } from './controls';
import { ICONS, icon, shapeIconPath } from './icons';
import { DesignError, LAMP, MAX_SEGMENTS, deleteSegment, globalEntries, insertSegment, isPendant, moveSegment, sameSel, segmentCount, segments, selTitle, type GlobalKind, type Sel } from './lampModel';
import { openShapePicker } from './picker';

export interface NodeCtx {
  params(): Params;
  sel(): Sel;
  select(s: Sel): void;
  edit(fn: (p: Params) => Params, next?: (p: Params) => Sel): void;
  flash(msg: string | null): void;
}

export interface GNode {
  id: string;
  sel: Sel | null;
  kind: 'seg' | 'global' | 'stack';
  x: number;
  y: number;
  title: string;
  sub: string;
  color?: string;
  icon: { shape: string; kap?: string } | { line: keyof typeof ICONS };
}

export interface GEdge {
  from: string;
  to: string;
  /** Chain links run vertically (bottom → top), the rest left → right. */
  chain?: boolean;
}

export const NODE_W = 196;
export const NODE_H = 58;
const GAP = 26;
const COL = { layers: 0, seg: 250, mid: 530, lamp: 800 };

const GLOBAL_LINE: Record<GlobalKind, keyof typeof ICONS> = { lamp: 'lamp', socket: 'socket', layers: 'layers', base: 'base', canopy: 'canopy' };

/** Default graph layout for these parameters (pure, for tests). */
export function nodeGraph(p: Params): { nodes: GNode[]; edges: GEdge[] } {
  const segs = segments(p);
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const g = new Set(globalEntries(p));
  const y0 = 0;
  segs.forEach((s, i) => {
    nodes.push({
      id: `seg:${s.slot}`, sel: { kind: 'seg', slot: s.slot }, kind: 'seg', x: COL.seg, y: y0 + i * (NODE_H + GAP),
      title: `${s.slot} · ${s.label}`, sub: `Ø${Math.round(s.D)} × ${Math.round(s.H)} mm`, color: s.color, icon: { shape: s.shape, kap: s.kap },
    });
    if (i > 0) edges.push({ from: `seg:${segs[i - 1].slot}`, to: `seg:${s.slot}`, chain: true });
    if (s.shape === 'kap' && g.has('layers')) {
      nodes.push({ id: 'layers', sel: { kind: 'layers' }, kind: 'global', x: COL.layers, y: y0 + i * (NODE_H + GAP), title: selTitle({ kind: 'layers' }, p), sub: `${p.layers ?? 1} laag/lagen`, icon: { line: 'layers' } });
      edges.push({ from: 'layers', to: `seg:${s.slot}` });
    }
  });
  const colH = segs.length * (NODE_H + GAP) - GAP;
  const mid = y0 + colH / 2 - NODE_H / 2;
  nodes.push({ id: 'stack', sel: null, kind: 'stack', x: COL.mid, y: mid, title: 'Stapel', sub: `${segs.length} van ${MAX_SEGMENTS} segmenten`, icon: { line: 'layers' } });
  edges.push({ from: `seg:${segs[segs.length - 1].slot}`, to: 'stack' });
  nodes.push({ id: 'lamp', sel: LAMP, kind: 'global', x: COL.lamp, y: mid, title: 'Lamp', sub: isPendant(p) ? 'Hanglamp' : 'Tafellamp', icon: { line: 'lamp' } });
  edges.push({ from: 'stack', to: 'lamp' });
  nodes.push({ id: 'socket', sel: { kind: 'socket' }, kind: 'global', x: COL.mid, y: mid - NODE_H - 46, title: selTitle({ kind: 'socket' }, p), sub: String(p.socket ?? 'e27').toUpperCase(), icon: { line: 'socket' } });
  edges.push({ from: 'socket', to: 'lamp' });
  const end: GlobalKind = isPendant(p) ? 'canopy' : 'base';
  nodes.push({ id: end, sel: { kind: end }, kind: 'global', x: COL.mid, y: mid + NODE_H + 46, title: selTitle({ kind: end }, p), sub: end === 'base' ? `Ø${p.baseD} mm` : p.canopy === false ? 'uit' : `Ø${p.canopyD} mm`, icon: { line: GLOBAL_LINE[end] } });
  edges.push({ from: end, to: 'lamp' });
  return { nodes, edges };
}

/** Where a segment node dropped at `y` (top of the node) lands in the chain (1-based, as for moveSegment). */
export function dropSlot(p: Params, from: number, y: number): number {
  const n = segmentCount(p);
  let k = 0;
  for (let s = 1; s <= n; s++) {
    if (s === from) continue;
    const top = (s - 1) * (NODE_H + GAP);
    if (top + NODE_H / 2 < y + NODE_H / 2) k++;
  }
  return Math.min(n, k + 1);
}

export class NodeView {
  private tx = 40;
  private ty = 40;
  private k = 1;
  private offsets = new Map<string, { dx: number; dy: number }>();
  private svg: SVGSVGElement;
  private world: SVGGElement;
  private bar: HTMLElement;
  private fitted = false;

  constructor(
    private host: HTMLElement,
    private ctx: NodeCtx,
  ) {
    host.innerHTML = `<svg class="nv-svg" tabindex="0" aria-label="Nodes van de lamp"><g class="nv-world"></g></svg>
      <div class="nv-bar">
        <button type="button" class="tbtn" data-nv="add" title="Segment toevoegen">${icon('plus')}<span>Segment</span></button>
        <button type="button" class="tbtn" data-nv="del" title="Geselecteerd segment verwijderen">${icon('trash')}</button>
        <span class="tsep"></span>
        <button type="button" class="tbtn" data-nv="out" title="Uitzoomen" aria-label="Uitzoomen">${icon('zoomOut')}</button>
        <button type="button" class="tbtn" data-nv="in" title="Inzoomen" aria-label="Inzoomen">${icon('zoomIn')}</button>
        <button type="button" class="tbtn" data-nv="fit" title="Alles in beeld" aria-label="Alles in beeld">${icon('fit')}</button>
      </div>
      <p class="nv-hint">Klik een node om hem te bewerken · sleep een segment tussen andere om de volgorde te wijzigen · sleep de achtergrond om te schuiven, scroll om te zoomen</p>`;
    this.svg = host.querySelector('svg')!;
    this.world = host.querySelector('.nv-world')!;
    this.bar = host.querySelector('.nv-bar')!;
    this.bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-nv]');
      if (!b) return;
      const a = b.dataset.nv;
      if (a === 'fit') this.fit();
      else if (a === 'in' || a === 'out') this.zoomAt(this.svg.clientWidth / 2, this.svg.clientHeight / 2, a === 'in' ? 1.2 : 1 / 1.2);
      else if (a === 'add') this.add(b);
      else if (a === 'del') this.del();
    });
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.svg.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.del();
      }
    });
    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    new ResizeObserver(() => {
      if (!this.fitted && host.clientWidth > 0) this.fit();
    }).observe(host);
  }

  destroy() {
    this.host.innerHTML = '';
  }

  private add(anchor: HTMLElement) {
    const p = this.ctx.params();
    const n = segmentCount(p);
    if (n >= MAX_SEGMENTS) {
      this.ctx.flash(`Maximaal ${MAX_SEGMENTS} segmenten.`);
      return;
    }
    const s = this.ctx.sel();
    const at = s.kind === 'seg' ? s.slot + 1 : n + 1;
    openShapePicker(anchor, 'Segment toevoegen', (shape) => this.ctx.edit((q) => insertSegment(q, at, shape), () => ({ kind: 'seg', slot: at })));
  }

  private del() {
    const s = this.ctx.sel();
    if (s.kind !== 'seg') {
      this.ctx.flash('Selecteer eerst een segment om te verwijderen.');
      return;
    }
    this.ctx.edit(
      (p) => {
        if (segmentCount(p) <= 1) throw new DesignError('Een lamp heeft minstens één segment.');
        return deleteSegment(p, s.slot);
      },
      (p) => ({ kind: 'seg', slot: Math.min(s.slot, segmentCount(p)) }),
    );
  }

  private zoomAt(x: number, y: number, f: number) {
    const k = Math.min(2.5, Math.max(0.3, this.k * f));
    const wx = (x - this.tx) / this.k;
    const wy = (y - this.ty) / this.k;
    this.k = k;
    this.tx = x - wx * k;
    this.ty = y - wy * k;
    this.applyView();
  }

  private applyView() {
    this.world.setAttribute('transform', `translate(${this.tx.toFixed(1)} ${this.ty.toFixed(1)}) scale(${this.k.toFixed(3)})`);
  }

  fit() {
    const { nodes } = nodeGraph(this.ctx.params());
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (!w || !h) return;
    this.fitted = true;
    const pos = nodes.map((n) => this.pos(n));
    const minX = Math.min(...pos.map((q) => q.x));
    const minY = Math.min(...pos.map((q) => q.y));
    const maxX = Math.max(...pos.map((q) => q.x + NODE_W));
    const maxY = Math.max(...pos.map((q) => q.y + NODE_H));
    const pad = 36;
    const top = 64; // room for the toolbar
    this.k = Math.min(1.2, Math.max(0.3, Math.min((w - 2 * pad) / (maxX - minX), (h - top - pad - 30) / (maxY - minY))));
    this.tx = (w - (maxX - minX) * this.k) / 2 - minX * this.k;
    this.ty = top + (h - top - 30 - (maxY - minY) * this.k) / 2 - minY * this.k;
    this.applyView();
  }

  private pos(n: GNode) {
    const o = this.offsets.get(n.id);
    return { x: n.x + (o?.dx ?? 0), y: n.y + (o?.dy ?? 0) };
  }

  render(fit = false) {
    const p = this.ctx.params();
    const { nodes, edges } = nodeGraph(p);
    const sel = this.ctx.sel();
    const at = new Map(nodes.map((n) => [n.id, this.pos(n)]));
    const paths = edges.map((e) => {
      const a = at.get(e.from);
      const b = at.get(e.to);
      if (!a || !b) return '';
      if (e.chain) {
        const x1 = a.x + NODE_W / 2;
        const y1 = a.y + NODE_H;
        const x2 = b.x + NODE_W / 2;
        const y2 = b.y;
        const c = Math.max(12, Math.abs(y2 - y1) / 2);
        return `<path class="nv-edge nv-chain" d="M${x1} ${y1}C${x1} ${y1 + c} ${x2} ${y2 - c} ${x2} ${y2}"/>`;
      }
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const c = Math.max(30, Math.abs(x2 - x1) / 2);
      return `<path class="nv-edge" d="M${x1} ${y1}C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}"/>`;
    });
    const boxes = nodes.map((n) => {
      const q = at.get(n.id)!;
      const on = !!n.sel && sameSel(n.sel, sel);
      const ico =
        'shape' in n.icon
          ? `<path class="nv-ico-fill" fill-rule="evenodd" transform="translate(12 15) scale(1.17)" d="${shapeIconPath(n.icon.shape, n.icon.kap)}"/>`
          : `<path class="nv-ico-line" transform="translate(12 15) scale(1.17)" d="${ICONS[n.icon.line]}"/>`;
      const ports =
        n.kind === 'seg'
          ? `<circle class="nv-port" cx="${NODE_W / 2}" cy="0" r="4"/><circle class="nv-port" cx="${NODE_W / 2}" cy="${NODE_H}" r="4"/>${n.id === `seg:${segmentCount(p)}` ? `<circle class="nv-port" cx="${NODE_W}" cy="${NODE_H / 2}" r="4"/>` : ''}<circle class="nv-port" cx="0" cy="${NODE_H / 2}" r="4"/>`
          : `${n.id !== 'lamp' ? `<circle class="nv-port" cx="${NODE_W}" cy="${NODE_H / 2}" r="4"/>` : ''}${n.id === 'lamp' || n.id === 'stack' ? `<circle class="nv-port" cx="0" cy="${NODE_H / 2}" r="4"/>` : ''}`;
      return `<g class="nv-node nv-${n.kind}${on ? ' is-sel' : ''}" data-id="${n.id}" transform="translate(${q.x} ${q.y})">
        <rect class="nv-box" width="${NODE_W}" height="${NODE_H}" rx="12"/>
        <rect class="nv-ico-bg" x="8" y="11" width="36" height="36" rx="9"/>
        ${ico}
        <text class="nv-title" x="54" y="25">${escapeHtml(n.title)}</text>
        <text class="nv-sub" x="54" y="43">${escapeHtml(n.sub)}</text>
        ${n.color ? `<circle class="nv-dot" cx="${NODE_W - 16}" cy="${NODE_H / 2}" r="6" style="fill:${escapeHtml(n.color)}"/>` : ''}
        ${ports}
      </g>`;
    });
    this.world.innerHTML = `<g class="nv-edges">${paths.join('')}</g><line class="nv-dropline" x1="${COL.seg - 10}" x2="${COL.seg + NODE_W + 10}" y1="0" y2="0" visibility="hidden"/>${boxes.join('')}`;
    const del = this.bar.querySelector<HTMLButtonElement>('[data-nv="del"]')!;
    del.disabled = sel.kind !== 'seg' || segmentCount(p) <= 1;
    const add = this.bar.querySelector<HTMLButtonElement>('[data-nv="add"]')!;
    add.disabled = segmentCount(p) >= MAX_SEGMENTS;
    add.title = add.disabled ? `Maximaal ${MAX_SEGMENTS} segmenten` : 'Segment toevoegen';
    if (fit || !this.fitted) this.fit();
    else this.applyView();
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const nodeEl = (e.target as Element).closest<SVGGElement>('.nv-node');
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const id = nodeEl?.dataset.id ?? null;
    const p = this.ctx.params();
    const { nodes } = nodeGraph(p);
    const node = id ? nodes.find((n) => n.id === id) : undefined;
    const start = node ? this.pos(node) : null;
    const tx0 = this.tx;
    const ty0 = this.ty;
    const drop = this.world.querySelector<SVGLineElement>('.nv-dropline');
    let target = 0;
    try {
      this.svg.setPointerCapture(e.pointerId);
    } catch {
      // not essential
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (node && start && nodeEl) {
        const nx = start.x + dx / this.k;
        const ny = start.y + dy / this.k;
        nodeEl.setAttribute('transform', `translate(${nx} ${ny})`);
        nodeEl.classList.add('is-dragging');
        if (node.kind === 'seg' && node.sel?.kind === 'seg' && drop) {
          target = dropSlot(p, node.sel.slot, ny);
          const others = segments(p).filter((s) => s.slot !== (node.sel as { slot: number }).slot);
          // line between the nodes where it will land
          const k = target - 1;
          const ly = k <= 0 ? -GAP / 2 : k >= others.length ? others.length * (NODE_H + GAP) + GAP / 2 - GAP : k * (NODE_H + GAP) - GAP / 2;
          drop.setAttribute('y1', String(ly));
          drop.setAttribute('y2', String(ly));
          drop.setAttribute('visibility', target !== node.sel.slot ? 'visible' : 'hidden');
        }
      } else {
        this.tx = tx0 + dx;
        this.ty = ty0 + dy;
        this.applyView();
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      this.svg.removeEventListener('pointermove', move);
      this.svg.removeEventListener('pointerup', up);
      this.svg.removeEventListener('pointercancel', up);
      if (!moved) {
        if (node?.sel) this.ctx.select(node.sel);
        else if (!node) this.ctx.select(LAMP);
        this.svg.focus({ preventScroll: true });
        return;
      }
      if (!node || !start) return;
      if (node.kind === 'seg' && node.sel?.kind === 'seg') {
        const from = node.sel.slot;
        if (ev.type === 'pointerup' && target && target !== from) this.ctx.edit((q) => moveSegment(q, from, target), () => ({ kind: 'seg', slot: target }));
        else this.render();
        return;
      }
      const o = this.offsets.get(node.id) ?? { dx: 0, dy: 0 };
      this.offsets.set(node.id, { dx: o.dx + (ev.clientX - x0) / this.k, dy: o.dy + (ev.clientY - y0) / this.k });
      this.render();
    };
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }
}


