/**
 * In-viewport drag handles for the selected lamp element, drawn as an SVG
 * overlay (constant size on screen) over the three.js view. While dragging,
 * a cheap preview runs on the main thread: the selected segment is replaced
 * by a lathe of its profile (or scaled), and the parts above move with the
 * height. Releasing commits one undo step and starts the real build.
 */
import * as THREE from 'three';
import type { ParamDef, Params, PartResult } from '../core/types';
import type { ContentItem, Viewer } from '../ui/viewer';
import { POST_HOLE } from '../tools/lampParts';
import { dragValue, elementProfile, formatHandle, handlesFor, numberDef, profilePoints, type Handle } from './handles';
import { segmentInfo, selKey, type Sel } from './lampModel';

export interface GizmoCtx {
  viewer: Viewer;
  defs: ParamDef[];
  params(): Params;
  sel(): Sel;
  parts(): PartResult[] | null;
  /** Gizmos only make sense in the assembled 3D view. */
  active(): boolean;
  /** Commit a dragged value: one undo step and a real build. */
  commit(key: string, value: number): void;
  /** Values while dragging (null when the drag ends), e.g. for live readouts. */
  dragging?(p: Params | null): void;
}

const NS = 'http://www.w3.org/2000/svg';
/** Dimension lines stand this far (mm) beside the element. */
const DIM_GAP = 14;

interface Frame {
  items: ContentItem[];
  selected: ContentItem[];
  z0: number;
  centerZ: number;
}

interface Drag {
  handle: Handle;
  start: number;
  value: number;
  x: number;
  y: number;
  /** Screen pixels per mm along the handle axis. */
  vx: number;
  vy: number;
  frame: Frame;
  pointer: number;
}

export class Gizmo {
  private drag: Drag | null = null;
  /** Values committed but not yet built (keeps the preview and the handles in place). */
  private pending: Params | null = null;
  private hoverKey: string | null = null;
  private off: () => void;
  private abort = new AbortController();

  constructor(
    private svg: SVGSVGElement,
    private ctx: GizmoCtx,
  ) {
    this.off = ctx.viewer.addFrameListener(() => this.layout());
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.drag) this.cancel();
      },
      { signal: this.abort.signal },
    );
  }

  destroy() {
    this.cancel();
    this.off();
    this.abort.abort();
    this.svg.replaceChildren();
  }

  /** Params as the handles should show them (dragging / not yet built). */
  private shown(): Params {
    if (this.drag) return { ...this.ctx.params(), [this.drag.handle.key]: this.drag.value };
    return this.pending ?? this.ctx.params();
  }

  /** New build result: the preview is gone with the old content. */
  built() {
    this.pending = null;
    this.layout();
  }

  /** Build failed: put the old model back where it was. */
  failed() {
    this.pending = null;
    this.restore();
    this.layout();
  }

  refresh() {
    this.layout();
  }

  private selectedParts(sel: Sel): Set<number> {
    const parts = this.ctx.parts();
    const out = new Set<number>();
    if (!parts) return out;
    const key = selKey(sel);
    parts.forEach((p, i) => {
      if (p.select === key) out.add(i);
    });
    return out;
  }

  private frame(sel: Sel, H: number): Frame | null {
    const want = this.selectedParts(sel);
    if (!want.size) return null;
    const items = this.ctx.viewer.contentItems();
    let selected = items.filter((it) => it.part !== null && want.has(it.part));
    if (!selected.length) return null;
    if (sel.kind === 'canopy') {
      // the cap over the nut belongs to the same element; the canopy is the top one
      const top = Math.max(...selected.map((it) => it.box.max.z));
      const part = selected.find((it) => it.box.max.z === top)!.part;
      selected = selected.filter((it) => it.part === part);
    }
    const box = new THREE.Box3();
    for (const it of selected) box.union(it.box);
    let z0 = box.min.z;
    if (sel.kind === 'base') z0 = box.max.z - H;
    else if (sel.kind === 'seg' && segmentInfo(this.ctx.params(), sel.slot).shape === 'stijlen') z0 = box.min.z + POST_HOLE;
    return { items, selected, z0, centerZ: (box.min.z + box.max.z) / 2 };
  }

  private layout() {
    const svg = this.svg;
    const sel = this.ctx.sel();
    if (!this.ctx.active() || !this.ctx.parts()) {
      if (svg.childNodes.length) svg.replaceChildren();
      return;
    }
    const p = this.shown();
    const eh = handlesFor(sel, p);
    const fr = eh && (this.drag?.frame ?? this.frame(sel, eh.H));
    if (!eh || !fr) {
      if (svg.childNodes.length) svg.replaceChildren();
      return;
    }
    const v = this.ctx.viewer;
    const right = v.screenRight();
    const at = (r: number, z: number) => new THREE.Vector3(right.x * r, right.y * r, fr.z0 + z);
    const parts: string[] = [];
    const knobs: { h: Handle; x: number; y: number }[] = [];
    for (const h of eh.handles) {
      const def = numberDef(this.ctx.defs, h.key);
      if (!def) continue;
      const val = Number(p[h.key]);
      const dragging = this.drag?.handle.key === h.key;
      const cls = `gz${dragging ? ' gz-drag' : ''}${this.hoverKey === h.key ? ' gz-hover' : ''}`;
      if (h.id === 'height') {
        const rr = -(eh.R + DIM_GAP);
        const a = v.project(at(rr, 0));
        const b = v.project(at(rr, eh.H));
        if (a.behind || b.behind) continue;
        parts.push(`<g class="${cls}">${dimLine(a.x, a.y, b.x, b.y)}${label(b.x, b.y, formatHandle(h, val), 'left')}</g>`);
        knobs.push({ h, x: b.x, y: b.y });
      } else if (h.id === 'diameter') {
        const a = v.project(at(-h.r, h.z));
        const b = v.project(at(h.r, h.z));
        if (a.behind || b.behind) continue;
        parts.push(`<g class="${cls}">${dimLine(a.x, a.y, b.x, b.y)}${label(b.x, b.y, formatHandle(h, val), 'right')}</g>`);
        knobs.push({ h, x: b.x, y: b.y });
      } else {
        const a = v.project(at(h.r, h.z));
        if (a.behind) continue;
        const show = dragging || this.hoverKey === h.key;
        parts.push(`<g class="${cls}">${show ? label(a.x, a.y, formatHandle(h, val), 'right') : ''}</g>`);
        knobs.push({ h, x: a.x, y: a.y });
      }
    }
    svg.innerHTML = parts.join('');
    for (const k of knobs) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `gz-knob gz-${k.h.id}${this.drag?.handle.key === k.h.key ? ' gz-drag' : ''}`);
      g.setAttribute('transform', `translate(${k.x.toFixed(1)} ${k.y.toFixed(1)})`);
      g.dataset.key = k.h.key;
      g.setAttribute('role', 'slider');
      g.setAttribute('aria-label', k.h.label);
      g.setAttribute('aria-valuetext', formatHandle(k.h, Number(p[k.h.key])));
      g.innerHTML =
        k.h.id === 'variant'
          ? '<circle class="gz-hit" r="16"/><rect class="gz-dot" x="-6" y="-6" width="12" height="12" rx="2" transform="rotate(45)"/>'
          : '<circle class="gz-hit" r="16"/><circle class="gz-dot" r="7"/>';
      g.addEventListener('pointerdown', (e) => this.start(e, k.h, sel));
      g.addEventListener('pointerenter', () => {
        if (this.drag) return;
        this.hoverKey = k.h.key;
        this.ctx.viewer.requestRender();
      });
      g.addEventListener('pointerleave', () => {
        if (this.drag || this.hoverKey !== k.h.key) return;
        this.hoverKey = null;
        this.ctx.viewer.requestRender();
      });
      svg.append(g);
    }
  }

  private start(e: PointerEvent, h: Handle, sel: Sel) {
    if (e.button !== 0 || this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const p = this.ctx.params();
    const eh = handlesFor(sel, p);
    const def = numberDef(this.ctx.defs, h.key);
    const fr = eh && this.frame(sel, eh.H);
    if (!eh || !fr || !def) return;
    const v = this.ctx.viewer;
    const right = v.screenRight();
    const r = h.id === 'height' ? -(eh.R + DIM_GAP) : h.r;
    const P = new THREE.Vector3(right.x * r, right.y * r, fr.z0 + h.z);
    const dir = h.axis === 'z' ? new THREE.Vector3(0, 0, 1) : right.clone();
    const L = 10;
    const s0 = v.project(P);
    const s1 = v.project(P.clone().addScaledVector(dir, L));
    const vx = (s1.x - s0.x) / L;
    const vy = (s1.y - s0.y) / L;
    if (vx * vx + vy * vy < 1e-4) return; // looking straight along the axis
    const start = Number(p[h.key]);
    this.drag = { handle: h, start, value: start, x: e.clientX, y: e.clientY, vx, vy, frame: fr, pointer: e.pointerId };
    v.setOrbit(false);
    // the knobs are redrawn every frame, so follow the pointer on the window
    const move = (ev: PointerEvent) => {
      const d = this.drag;
      if (!d || ev.pointerId !== d.pointer) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      const mm = (dx * d.vx + dy * d.vy) / (d.vx * d.vx + d.vy * d.vy);
      const val = dragValue(def, d.start, mm, d.handle.perMm, ev.shiftKey ? d.handle.snap : null);
      if (val !== d.value) {
        d.value = val;
        this.preview();
        this.ctx.dragging?.(this.shown());
      }
      this.ctx.viewer.requestRender();
    };
    const up = (ev: PointerEvent) => {
      if (this.drag && ev.pointerId !== this.drag.pointer) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.finish(ev.type !== 'pointercancel');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    v.requestRender();
  }

  private finish(commit: boolean) {
    const d = this.drag;
    this.drag = null;
    this.ctx.viewer.setOrbit(true);
    if (!d) return;
    if (commit && d.value !== d.start) {
      this.pending = { ...this.ctx.params(), [d.handle.key]: d.value };
      this.ctx.commit(d.handle.key, d.value);
    } else {
      this.restore();
      this.ctx.dragging?.(null);
    }
    this.ctx.viewer.requestRender();
  }

  cancel() {
    if (!this.drag) return;
    this.drag = null;
    this.ctx.viewer.setOrbit(true);
    this.restore();
    this.ctx.dragging?.(null);
  }

  private restore() {
    const v = this.ctx.viewer;
    v.setPreview(null);
    for (const it of v.contentItems()) v.restoreItem(it);
  }

  /** Cheap main-thread preview of the dragged value. */
  private preview() {
    const d = this.drag;
    if (!d) return;
    const v = this.ctx.viewer;
    const sel = this.ctx.sel();
    const p = { ...this.ctx.params(), [d.handle.key]: d.value };
    const fr = d.frame;
    const isH = d.handle.id === 'height';
    const dH = isH ? d.value - d.start : 0;
    const selSet = new Set(fr.selected);
    const prof = sel.kind === 'seg' ? elementProfile(p, sel.slot) : null;
    if (prof && sel.kind === 'seg') {
      for (const it of fr.selected) v.moveItem(it, new THREE.Matrix4(), false);
      const pts = profilePoints(prof, 64).map(([r, z]) => new THREE.Vector2(r, z));
      const geo = new THREE.LatheGeometry(pts, 96);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, fr.z0);
      const color = String(p[`s${sel.slot}Color`] ?? '#f2efe8');
      v.setPreview(new THREE.Mesh(geo, v.previewMaterial(color)));
    } else {
      const k = d.start > 0 ? d.value / d.start : 1;
      const sxy = d.handle.id === 'diameter' ? k : 1;
      const sz = isH ? k : 1;
      const m = new THREE.Matrix4()
        .makeTranslation(0, 0, fr.z0)
        .multiply(new THREE.Matrix4().makeScale(sxy, sxy, sz))
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, -fr.z0));
      for (const it of fr.selected) v.moveItem(it, m);
    }
    for (const it of fr.items) {
      if (selSet.has(it)) continue;
      const c = (it.box.min.z + it.box.max.z) / 2;
      if (it.part === null && it.box.min.z < fr.centerZ && it.box.max.z > fr.centerZ) {
        // a reference running through the element (the tube): stretch it
        const len = it.box.max.z - it.box.min.z;
        const s = len > 1 ? Math.max(0.05, (len + dH) / len) : 1;
        const z = it.box.min.z;
        v.moveItem(it, new THREE.Matrix4().makeTranslation(0, 0, z).multiply(new THREE.Matrix4().makeScale(1, 1, s)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -z)));
      } else if (c > fr.centerZ) v.moveItem(it, new THREE.Matrix4().makeTranslation(0, 0, dH));
      else v.restoreItem(it);
    }
  }

  get dragging() {
    return this.drag !== null;
  }
}

function dimLine(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * 5;
  const ny = (dx / L) * 5;
  const f = (n: number) => n.toFixed(1);
  return `<line class="gz-line" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/><line class="gz-tick" x1="${f(x1 - nx)}" y1="${f(y1 - ny)}" x2="${f(x1 + nx)}" y2="${f(y1 + ny)}"/>`;
}

function label(x: number, y: number, text: string, side: 'left' | 'right'): string {
  const w = 18 + text.length * 7.2;
  const lx = side === 'right' ? x + 14 : x - 14 - w;
  const ly = y - 11;
  return `<g class="gz-label"><rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="11"/><text x="${(lx + w / 2).toFixed(1)}" y="${(ly + 15).toFixed(1)}" text-anchor="middle">${text}</text></g>`;
}
