/**
 * The lamp designer: outliner (the stack in physical order), inspector (only
 * the selected element's settings), click-to-select in the viewport, drag
 * handles and the node view. Every view edits the same flat parameters
 * through the host, which records undo steps and rebuilds.
 */
import type { BuildResult, ParamDef, Params, ParamValue } from '../core/types';
import type { Viewer } from '../ui/viewer';
import { buildInspector, escapeHtml, type InspectorHandle } from './controls';
import { Gizmo } from './gizmo';
import { icon, shapeIcon, type IconName } from './icons';
import {
  DesignError, LAMP, MAX_SEGMENTS, defsFor, deleteSegment, duplicateSegment, globalEntries, insertSegment, isPendant, isPrintedTube, moveSegment, parseSel, sameSel,
  segmentCount, segmentInfo, segments, selKey, selTitle, selValid, toggleFlip, type GlobalKind, type Sel,
} from './lampModel';
import { NodeView } from './nodes';
import { openShapePicker } from './picker';

export interface DesignerHost {
  defs: ParamDef[];
  viewer: Viewer;
  params(): Params;
  /** Apply new parameters: undo step (`key` coalesces slider drags), save, rebuild. */
  apply(next: Params, key: string | null, final: boolean): void;
  result(): BuildResult | null;
  /** The 3D view shows the assembled lamp (not the print plate). */
  assembled(): boolean;
  showAllSettings(): void;
  /** The user picked an element (e.g. to open the bottom sheet on a phone). */
  onSelect?(s: Sel): void;
}

export interface DesignerEls {
  outliner: HTMLElement;
  inspector: HTMLElement;
  nodeview: HTMLElement;
  gizmo: SVGSVGElement;
}

export const GLOBAL_ICON: Record<GlobalKind, IconName> = { lamp: 'lamp', tube: 'tube', socket: 'socket', layers: 'layers', closed: 'closed', base: 'base', canopy: 'canopy' };

/** Subtitle of an outliner / node entry. */
export function selSubtitle(s: Sel, p: Params): string {
  switch (s.kind) {
    case 'seg': {
      const i = segmentInfo(p, s.slot);
      return `Ø${Math.round(i.D)} × ${Math.round(i.H)} mm${i.flip && i.canFlip ? ' · omgekeerd' : ''}`;
    }
    case 'lamp':
      return `${isPendant(p) ? 'Hanglamp' : 'Tafellamp'} · ${segmentCount(p)} ${segmentCount(p) === 1 ? 'segment' : 'segmenten'}`;
    case 'socket':
      return `${String(p.socket ?? 'e27').toUpperCase()}${p.socket === 'e27' ? ` · ${String(p.bulb27 ?? '').toUpperCase()}` : p.socket === 'e14' ? ` · ${String(p.bulb14 ?? '').toUpperCase()}` : ''}${isPrintedTube(p) ? ' · klik' : ''}`;
    case 'layers':
      return `${p.layers ?? 1} ${String(p.layers) === '1' ? 'laag' : 'lagen'}`;
    case 'closed':
      return p.closed === true
        ? `${p.closedShape === 'binnen' ? `opening Ø${p.closedOpen ?? 100}` : 'tweede kap'} · ${p.centerBulb === false ? 'naad vrij' : 'lamp in het midden'} · ${p.vent === 'gaatjes' ? 'gaatjes' : p.vent === 'geen' ? 'geen ventilatie' : 'verborgen ventilatie'}`
        : 'uit';
    case 'tube':
      return !isPrintedTube(p)
        ? 'M10 draadbuis (gekocht)'
        : `${p.fitTest === true ? 'Pasproef · ' : ''}schroefbuis Ø${p.tubeD ?? 24} · speling ${Number(p.threadPlay ?? 0.3).toFixed(2).replace('.', ',')} mm${Number(p.tubeExtra) > 0 ? ` · +${p.tubeExtra} mm` : ''}`;
    case 'base':
      return `Ø${p.baseD} × ${p.baseH} mm`;
    case 'canopy':
      return p.canopy === false ? 'uit' : `Ø${p.canopyD} × ${p.canopyH} mm`;
  }
}

/** Outliner order, top to bottom as the lamp hangs or stands. */
export function outlineOrder(p: Params): Sel[] {
  const g = new Set(globalEntries(p));
  const out: Sel[] = [LAMP];
  const pend = isPendant(p);
  if (g.has('tube')) out.push({ kind: 'tube' });
  if (pend && g.has('canopy')) out.push({ kind: 'canopy' });
  if (!pend) out.push({ kind: 'socket' });
  for (const s of segments(p)) {
    out.push({ kind: 'seg', slot: s.slot });
    if (s.shape === 'kap' && g.has('layers')) out.push({ kind: 'layers' });
    if (s.shape === 'kap' && g.has('closed')) out.push({ kind: 'closed' });
  }
  if (pend) out.push({ kind: 'socket' });
  if (!pend && g.has('base')) out.push({ kind: 'base' });
  return out;
}

export class LampDesigner {
  sel: Sel = LAMP;
  private hover: Sel | null = null;
  private inspector: InspectorHandle | null = null;
  private inspectorKey = '';
  private gizmo: Gizmo;
  private nodes: NodeView;
  private flashTimer: number | undefined;
  private tab: '3d' | 'nodes' = '3d';
  private alive = true;
  private abort = new AbortController();

  constructor(
    private host: DesignerHost,
    private els: DesignerEls,
  ) {
    const v = host.viewer;
    v.onPick = (part) => {
      if (!this.alive) return;
      this.select(this.selOfPart(part));
    };
    v.onHover = (part) => {
      if (!this.alive) return;
      this.hover = part === null ? null : this.selOfPart(part);
      this.highlight();
    };
    this.gizmo = new Gizmo(els.gizmo, {
      viewer: v,
      defs: host.defs,
      params: () => host.params(),
      sel: () => this.sel,
      parts: () => host.result()?.parts ?? null,
      active: () => this.alive && this.tab === '3d' && host.assembled(),
      commit: (key, value) => host.apply({ ...host.params(), [key]: value }, null, true),
      dragging: (p) => this.inspector?.sync(p ?? host.params()),
    });
    this.nodes = new NodeView(els.nodeview, {
      params: () => host.params(),
      sel: () => this.sel,
      select: (s) => this.select(s),
      edit: (fn, next) => this.edit(fn, next),
      flash: (m) => this.flash(m),
    });
    els.outliner.addEventListener('click', (e) => this.onOutlinerClick(e), { signal: this.abort.signal });
    this.setupReorder();
    this.renderAll();
  }

  /** A handle is being dragged (keyboard shortcuts wait). */
  get busy() {
    return this.gizmo.dragging;
  }

  destroy() {
    this.alive = false;
    this.abort.abort();
    this.gizmo.destroy();
    this.host.viewer.onPick = null;
    this.host.viewer.onHover = null;
    this.host.viewer.setHighlight([], []);
    this.els.outliner.innerHTML = '';
    this.els.inspector.innerHTML = '';
    this.nodes.destroy();
  }

  private selOfPart(part: number | null): Sel {
    if (part === null) return LAMP;
    const p = this.host.result()?.parts[part];
    const s = parseSel(p?.select);
    return selValid(s, this.host.params()) ? s : LAMP;
  }

  select(s: Sel) {
    const p = this.host.params();
    const next = selValid(s, p) ? s : LAMP;
    if (sameSel(next, this.sel)) {
      this.host.onSelect?.(next);
      return;
    }
    this.gizmo.cancel();
    this.sel = next;
    this.renderAll();
    this.host.onSelect?.(next);
  }

  setTab(tab: '3d' | 'nodes') {
    this.tab = tab;
    this.els.nodeview.hidden = tab !== 'nodes';
    if (tab === 'nodes') this.nodes.render(true);
    this.gizmo.refresh();
    this.host.viewer.requestRender();
  }

  /** Parameters changed (any view, undo, preset). */
  refresh() {
    if (!selValid(this.sel, this.host.params())) this.sel = LAMP;
    this.renderAll();
  }

  /** A new build result arrived. */
  built() {
    this.highlight();
    this.gizmo.built();
  }

  failed() {
    this.gizmo.failed();
  }

  /** Structural edit (add, move, delete…). DesignErrors are shown inline. */
  edit(fn: (p: Params) => Params, nextSel?: (p: Params) => Sel) {
    let next: Params;
    try {
      next = fn(this.host.params());
    } catch (err) {
      this.flash(err instanceof DesignError ? err.message : `Dat lukte niet: ${(err as Error).message}`);
      return;
    }
    this.flash(null);
    if (nextSel) this.sel = nextSel(next);
    this.host.apply(next, null, true);
  }

  flash(msg: string | null) {
    window.clearTimeout(this.flashTimer);
    for (const box of document.querySelectorAll<HTMLElement>('.designer-flash')) {
      box.hidden = !msg;
      box.textContent = msg ?? '';
    }
    if (msg) this.flashTimer = window.setTimeout(() => this.flash(null), 6000);
  }

  deleteSelected() {
    if (this.sel.kind !== 'seg') return;
    const slot = this.sel.slot;
    this.edit(
      (p) => deleteSegment(p, slot),
      (p) => ({ kind: 'seg', slot: Math.min(slot, segmentCount(p)) }),
    );
  }

  addSegment(anchor: HTMLElement | { x: number; y: number }) {
    const p = this.host.params();
    if (segmentCount(p) >= MAX_SEGMENTS) {
      this.flash(`Maximaal ${MAX_SEGMENTS} segmenten.`);
      return;
    }
    const at = this.sel.kind === 'seg' ? this.sel.slot + 1 : segmentCount(p) + 1;
    openShapePicker(anchor, at <= segmentCount(p) ? `Segment invoegen op plek ${at}` : 'Segment toevoegen', (shape) =>
      this.edit(
        (q) => insertSegment(q, at, shape),
        () => ({ kind: 'seg', slot: at }),
      ),
    );
  }

  private segAction(action: string, slot: number, anchor: HTMLElement) {
    if (action === 'flip') this.edit((p) => toggleFlip(p, slot));
    else if (action === 'dup')
      this.edit(
        (p) => duplicateSegment(p, slot),
        () => ({ kind: 'seg', slot: slot + 1 }),
      );
    else if (action === 'del') {
      this.sel = { kind: 'seg', slot };
      this.deleteSelected();
    } else if (action === 'up') this.edit((p) => moveSegment(p, slot, slot - 1), () => ({ kind: 'seg', slot: Math.max(1, slot - 1) }));
    else if (action === 'down') this.edit((p) => moveSegment(p, slot, slot + 1), (p) => ({ kind: 'seg', slot: Math.min(segmentCount(p), slot + 1) }));
    else if (action === 'add') this.addSegment(anchor);
  }

  // -------------------------------------------------------------------------

  private renderAll() {
    this.renderOutliner();
    this.renderInspector();
    this.highlight();
    this.gizmo.refresh();
    if (this.tab === 'nodes') this.nodes.render();
  }

  private highlight() {
    const parts = this.host.result()?.parts ?? [];
    const of = (s: Sel | null) => {
      const out: number[] = [];
      if (!s || s.kind === 'lamp') return out;
      const k = selKey(s);
      parts.forEach((p, i) => {
        if (p.select === k) out.push(i);
      });
      return out;
    };
    this.host.viewer.setHighlight(of(this.sel), this.hover && !sameSel(this.hover, this.sel) ? of(this.hover) : []);
    this.els.outliner.querySelectorAll('.ol-item').forEach((el) => el.classList.toggle('is-hover', !!this.hover && (el as HTMLElement).dataset.sel === selKey(this.hover)));
  }

  private segActions(slot: number, canFlip: boolean, flipped: boolean, count: number) {
    const b = (act: string, ic: IconName, title: string, disabled = false, pressed?: boolean) =>
      `<button type="button" class="icon-sm" data-act="${act}" data-slot="${slot}" title="${title}" aria-label="${title}"${disabled ? ' disabled' : ''}${pressed !== undefined ? ` aria-pressed="${pressed}"` : ''}>${icon(ic)}</button>`;
    return `${canFlip ? b('flip', 'flip', 'Ondersteboven', false, flipped) : ''}${b('dup', 'copy', count >= MAX_SEGMENTS ? `Maximaal ${MAX_SEGMENTS} segmenten` : 'Dupliceren', count >= MAX_SEGMENTS)}${b('del', 'trash', count <= 1 ? 'Minstens één segment' : 'Verwijderen', count <= 1)}`;
  }

  private renderOutliner() {
    const p = this.host.params();
    const n = segmentCount(p);
    const rows = outlineOrder(p).map((s) => {
      const key = selKey(s);
      const on = sameSel(s, this.sel);
      if (s.kind === 'seg') {
        const i = segmentInfo(p, s.slot);
        return `<div class="ol-item ol-seg${on ? ' is-sel' : ''}" role="option" tabindex="0" aria-selected="${on}" data-sel="${key}" data-slot="${s.slot}">
          <span class="ol-grip" title="Sleep om te verplaatsen" aria-hidden="true">${icon('grip')}</span>
          <span class="ol-ico">${shapeIcon(i.shape, i.kap)}</span>
          <span class="ol-name"><b>${s.slot} · ${escapeHtml(i.label)}</b><small>${escapeHtml(selSubtitle(s, p))}</small></span>
          <i class="ol-dot" style="--c:${escapeHtml(i.color)}" title="${escapeHtml(i.colorName)}"></i>
          <span class="ol-actions">${this.segActions(s.slot, i.canFlip, i.flip, n)}</span>
        </div>`;
      }
      const g = s.kind as GlobalKind;
      return `<div class="ol-item ol-global ol-${g}${on ? ' is-sel' : ''}${g === 'layers' || g === 'closed' ? ' ol-sub' : ''}" role="option" tabindex="0" aria-selected="${on}" data-sel="${key}">
        <span class="ol-ico">${icon(GLOBAL_ICON[g])}</span>
        <span class="ol-name"><b>${escapeHtml(selTitle(s, p))}</b><small>${escapeHtml(selSubtitle(s, p))}</small></span>
      </div>`;
    });
    const full = n >= MAX_SEGMENTS;
    this.els.outliner.innerHTML = `
      <div class="ol-head"><span>Stapel</span><span class="ol-count" title="Segmenten">${n}/${MAX_SEGMENTS}</span></div>
      <div class="designer-flash callout error" role="alert" hidden></div>
      <div class="ol-list" role="listbox" aria-label="Onderdelen van de lamp">${rows.join('')}</div>
      <button type="button" class="ol-add" data-act="add"${full ? ` disabled title="Maximaal ${MAX_SEGMENTS} segmenten"` : ''}>${icon('plus')}<span>${full ? `Maximaal ${MAX_SEGMENTS} segmenten` : this.sel.kind === 'seg' ? `Segment invoegen onder ${this.sel.slot}` : 'Segment toevoegen'}</span></button>
      <button type="button" class="ol-all" data-act="all">${icon('sliders')}<span>Alle instellingen</span></button>`;
  }

  private onOutlinerClick(e: MouseEvent) {
    if (this.justDragged) return;
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLButtonElement>('[data-act]');
    if (act && !act.disabled) {
      e.stopPropagation();
      const a = act.dataset.act!;
      if (a === 'all') this.host.showAllSettings();
      else this.segAction(a, Number(act.dataset.slot), act);
      return;
    }
    const item = t.closest<HTMLElement>('.ol-item');
    if (item?.dataset.sel) this.select(parseSel(item.dataset.sel));
  }

  private justDragged = false;

  /** Drag segments in the outliner to reorder them (mouse and touch via the grip). */
  private setupReorder() {
    const root = this.els.outliner;
    const signal = this.abort.signal;
    root.addEventListener('keydown', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.ol-item');
      if (!item) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.select(parseSel(item.dataset.sel));
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && item.dataset.slot) {
        e.preventDefault();
        this.segAction(e.key === 'ArrowUp' ? 'up' : 'down', Number(item.dataset.slot), item);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const items = [...root.querySelectorAll<HTMLElement>('.ol-item')];
        const k = items.indexOf(item) + (e.key === 'ArrowUp' ? -1 : 1);
        items[Math.max(0, Math.min(items.length - 1, k))]?.focus();
      }
    }, { signal });
    root.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      const item = t.closest<HTMLElement>('.ol-seg');
      if (!item || t.closest('button') || e.button !== 0) return;
      const onGrip = !!t.closest('.ol-grip');
      if (e.pointerType !== 'mouse' && !onGrip) return;
      const from = Number(item.dataset.slot);
      const y0 = e.clientY;
      let dragging = false;
      let to = from;
      let line: HTMLElement | null = null;
      const others = () => [...root.querySelectorAll<HTMLElement>('.ol-seg')].filter((x) => x !== item);
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!dragging && Math.abs(ev.clientY - y0) < 6) return;
        if (!dragging) {
          dragging = true;
          item.classList.add('is-dragging');
          line = document.createElement('div');
          line.className = 'ol-drop';
          root.querySelector('.ol-list')?.append(line);
        }
        ev.preventDefault();
        item.style.transform = `translateY(${ev.clientY - y0}px)`;
        const rest = others();
        let k = 0;
        for (const r of rest) if (r.getBoundingClientRect().top + r.offsetHeight / 2 < ev.clientY) k++;
        to = k + 1;
        const list = root.querySelector<HTMLElement>('.ol-list')!;
        const lr = list.getBoundingClientRect();
        const ref = rest[k] ?? null;
        const prev = rest[k - 1] ?? null;
        const y = ref ? ref.getBoundingClientRect().top - 3 : prev ? prev.getBoundingClientRect().bottom + 1 : 0;
        if (line) line.style.top = `${y - lr.top + list.scrollTop}px`;
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!dragging) return;
        item.classList.remove('is-dragging');
        item.style.transform = '';
        line?.remove();
        this.justDragged = true;
        window.setTimeout(() => (this.justDragged = false), 0);
        if (ev.type === 'pointerup' && to !== from) this.edit((p) => moveSegment(p, from, to), () => ({ kind: 'seg', slot: to }));
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }, { signal });
  }

  private renderInspector() {
    const p = this.host.params();
    const s = this.sel;
    const defs = defsFor(s, this.host.defs);
    const key = `${selKey(s)}|${defs.map((d) => (d.type === 'group' ? d.label : d.key)).join(',')}`;
    const head = this.els.inspector.querySelector('.insp-title');
    if (key === this.inspectorKey && this.inspector && head) {
      this.inspector.sync(p);
      this.renderInspectorHead();
      return;
    }
    this.inspectorKey = key;
    this.els.inspector.innerHTML = `<div class="insp-title"></div><div class="designer-flash callout error" role="alert" hidden></div><div class="insp-body"></div>
      <button type="button" class="ol-all insp-all">${icon('sliders')}<span>Alle instellingen</span></button>`;
    this.els.inspector.querySelector('.insp-all')!.addEventListener('click', () => this.host.showAllSettings());
    this.els.inspector.querySelector('.insp-title')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
      if (act && !act.disabled) this.segAction(act.dataset.act!, Number(act.dataset.slot), act);
    });
    this.renderInspectorHead();
    const body = this.els.inspector.querySelector<HTMLElement>('.insp-body')!;
    this.inspector = buildInspector(body, defs, p, (k: string, v: ParamValue, final: boolean) => this.host.apply({ ...this.host.params(), [k]: v }, k, final));
  }

  private renderInspectorHead() {
    const p = this.host.params();
    const s = this.sel;
    const head = this.els.inspector.querySelector<HTMLElement>('.insp-title');
    if (!head) return;
    let ico: string;
    let sub: string;
    let actions = '';
    if (s.kind === 'seg') {
      const i = segmentInfo(p, s.slot);
      ico = shapeIcon(i.shape, i.kap);
      sub = `Segment ${s.slot} van ${segmentCount(p)}${s.slot === 1 ? ' · bovenste' : s.slot === segmentCount(p) ? ' · onderste' : ''}`;
      actions = this.segActions(s.slot, i.canFlip, i.flip, segmentCount(p));
    } else {
      ico = icon(GLOBAL_ICON[s.kind]);
      sub = s.kind === 'lamp' ? 'Klik een onderdeel in het model of in de stapel' : selSubtitle(s, p);
    }
    head.innerHTML = `<span class="insp-ico">${ico}</span><div class="insp-name"><h2>${escapeHtml(selTitle(s, p))}</h2><small>${escapeHtml(sub)}</small></div><div class="insp-actions">${actions}</div>`;
  }
}
