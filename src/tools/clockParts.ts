import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { keep } from '../core/registry';
import { clamp } from '../geom/helpers';
import { sizeForHeight, textCross } from '../geom/text';

/**
 * Building blocks for the clock tool: hand outlines, mounting holes, tick
 * marks and fit-test strips. Hands are drawn pointing up (+Y) with the pivot
 * on the origin.
 */

/** PLA, g/cm³ (for the hand-weight estimate). */
export const PLA_DENSITY = 1.24;

export interface Movement {
  label: string;
  /** round hole on the hour tube */
  hour: number;
  /** minute hole: diameter and width across the two flats */
  minute: number;
  minuteFlat: number;
  /** push-on pin of the second hand */
  second: number;
}

/** Hand-hole sizes of common quartz movements (mm). */
export const MOVEMENTS: Record<string, Movement> = {
  eu: { label: 'Europees (5,5 / 3,6 mm)', hour: 5.5, minute: 3.6, minuteFlat: 2.8, second: 1.0 },
  uts: { label: 'Euro-as UTS (5,0 / 2,8 × 3,5 mm)', hour: 5.0, minute: 3.5, minuteFlat: 2.8, second: 1.0 },
  us: { label: 'Amerikaans I-shaft (5,0 / 2,8 × 4,0 mm)', hour: 5.0, minute: 4.0, minuteFlat: 2.8, second: 0.9 },
};

/** Closed polygon as a cross-section, whatever its winding. */
export function polygon(M: ManifoldToplevel, pts: Vec2[]): CrossSection {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return keep(new M.CrossSection([a < 0 ? [...pts].reverse() : pts], 'Positive'));
}

export const disc = (M: ManifoldToplevel, r: number, x = 0, y = 0, segs = 40) => M.CrossSection.circle(Math.max(0.05, r), segs).translate([x, y]);

/** Bar along the Y axis from y0 to y1 with round ends, tapering from width w0 to w1. */
function bar(M: ManifoldToplevel, y0: number, w0: number, y1: number, w1: number): CrossSection {
  const r0 = w0 / 2;
  const r1 = w1 / 2;
  const a = y0 + r0;
  const b = y1 - r1;
  if (b <= a) return disc(M, Math.max(r0, r1), 0, (y0 + y1) / 2);
  return M.CrossSection.hull([disc(M, r0, 0, a), disc(M, r1, 0, b)]);
}

/** Bar from y0 (width w0, round end) ending in a sharp point at y1. */
function needle(M: ManifoldToplevel, y0: number, w0: number, y1: number): CrossSection {
  const r0 = w0 / 2;
  if (y1 - y0 < w0) return disc(M, r0, 0, (y0 + y1) / 2);
  return M.CrossSection.hull([disc(M, r0, 0, y0 + r0), disc(M, 0.08, 0, y1 - 0.08, 8)]);
}

/** Symmetric outline from a half-width profile hw(u), u = 0..1 from y0 to y1. */
function profile(M: ManifoldToplevel, y0: number, y1: number, hw: (u: number) => number, n = 48): CrossSection {
  const right: Vec2[] = [];
  const left: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const y = y0 + (y1 - y0) * u;
    const h = Math.max(0, hw(u));
    if (h < 0.02) {
      if (i === 0 || i === n) right.push([0, y]);
      continue;
    }
    right.push([h, y]);
    left.push([-h, y]);
  }
  return polygon(M, [...right, ...left.reverse()]);
}

export const HAND_STYLES = [
  { value: 'baton', label: 'Stok (strak)' },
  { value: 'spade', label: 'Schoppen (klassiek)' },
  { value: 'arrow', label: 'Pijl' },
  { value: 'leaf', label: 'Blad' },
  { value: 'diamond', label: 'Ruit (dauphine)' },
  { value: 'lolly', label: 'Lolly (bolletje)' },
  { value: 'breguet', label: 'Breguet (maantje)' },
  { value: 'skeleton', label: 'Skelet (open)' },
  { value: 'custom', label: 'Eigen vorm (SVG uploaden)' },
];

export interface HandDims {
  /** pivot to tip */
  length: number;
  width: number;
  /** counterweight tail behind the pivot */
  tail: number;
  hub: number;
}

/** An uploaded drawing used as a hand: it points up; the pivot sits `pivot` (0..1) up from its bottom. */
export interface CustomHand {
  polygons: [number, number][][];
  pivot: number;
}

/** Tail with a round counterweight, shared by most styles (a plain stub when it is short). */
function tailPiece(M: ManifoldToplevel, d: HandDims): CrossSection | null {
  const { tail: t, width: w, hub } = d;
  if (t < hub / 2 + 1.5) return null;
  const tw = clamp(w * 0.45, 1.2, hub * 0.7);
  const cr = clamp(w * 0.6, tw / 2 + 0.4, Math.max(hub * 0.55, tw / 2 + 0.4));
  if (t - 2 * cr < hub / 2 + 1) {
    const sw = Math.min(w, hub * 0.8);
    return bar(M, -t, sw, 0, sw);
  }
  return M.CrossSection.union([bar(M, -t + cr, tw, 0, tw), disc(M, cr, 0, -t + cr)]);
}

/**
 * Outline of an hour or minute hand (hub included, hole not yet cut). For
 * 'custom' the drawing is scaled so pivot → top equals the hand length.
 */
export function handCross(M: ManifoldToplevel, style: string, d: HandDims, custom?: CustomHand): { cs: CrossSection; note?: string } {
  const { length: L, width: w, hub } = d;
  const sw = clamp(w * 0.32, 1.2, Math.max(1.2, w));
  const parts: CrossSection[] = [disc(M, hub / 2, 0, 0, 48)];
  let tail = true;
  let note: string | undefined;
  switch (style) {
    case 'baton':
      parts.push(bar(M, -Math.max(d.tail, w / 2), w, L, w * 0.72));
      tail = false;
      break;
    case 'spade': {
      const r = Math.max(0.6, Math.min(w * 0.62, (L - hub / 2) / 4.6));
      const yb = L - 2.9 * r;
      parts.push(bar(M, 0, sw, yb, sw * 0.9));
      const head = M.CrossSection.hull([disc(M, r, -0.72 * r, yb), disc(M, r, 0.72 * r, yb), disc(M, 0.08, 0, L - 0.08, 8)]);
      parts.push(head.subtract(disc(M, 0.5 * r, 0, yb - 1.08 * r)));
      break;
    }
    case 'arrow': {
      const hl = Math.min(2.6 * w, 0.4 * L);
      const hw = Math.min(1.05 * w, 0.45 * hl);
      parts.push(bar(M, 0, sw, L - 0.6 * hl, sw));
      parts.push(polygon(M, [[0, L], [-hw, L - hl], [0, L - 0.68 * hl], [hw, L - hl]]));
      if (d.tail > hub / 2 + 1) {
        // feathered tail instead of a counterweight disc
        const t = d.tail;
        const fl = Math.min(2.2 * w, t * 0.6);
        parts.push(bar(M, -t + 0.5, sw, 0, sw));
        parts.push(polygon(M, [[0, -t + fl], [0.75 * w, -t + 0.35 * fl], [0.75 * w, -t - 0.2 * fl], [0, -t + 0.3 * fl], [-0.75 * w, -t - 0.2 * fl], [-0.75 * w, -t + 0.35 * fl]]));
        tail = false;
      }
      break;
    }
    case 'leaf':
      parts.push(profile(M, 0, L, (u) => 0.8 * w * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 0.85)));
      break;
    case 'diamond': {
      const yb = -Math.max(d.tail, hub * 0.6);
      parts.push(polygon(M, [[0, L], [-0.75 * w, 0.24 * L], [0, yb], [0.75 * w, 0.24 * L]]));
      tail = false;
      break;
    }
    case 'lolly': {
      const r = Math.max(1, Math.min(0.85 * w, 0.16 * L));
      parts.push(bar(M, 0, sw, L - r, sw), disc(M, r, 0, L - r, 48));
      break;
    }
    case 'breguet': {
      const ro = Math.max(1.6, Math.min(0.95 * w, 0.15 * L));
      const yc = Math.max(hub / 2 + ro, L * 0.66);
      const ri = Math.max(0.6, 0.55 * ro);
      // shaft and tip stop at the ring so the eccentric hole stays open
      parts.push(bar(M, 0, sw, yc - 0.5 * ro, sw));
      parts.push(disc(M, ro, 0, yc, 48).subtract(disc(M, ri, 0, yc + 0.2 * ro, 40)));
      parts.push(needle(M, yc + 0.8 * ro, sw * 1.1, L));
      break;
    }
    case 'skeleton': {
      const blade = polygon(M, [[0.55 * w, 0], [0.8 * w, 0.78 * L], [0, L], [-0.8 * w, 0.78 * L], [-0.55 * w, 0]]);
      const wall = clamp(0.25 * w, 1.0, 2.0);
      const inner = blade.offset(-wall, 'Miter', 3).intersect(M.CrossSection.square([4 * w, L], false).translate([-2 * w, hub / 2 + wall]));
      parts.push(inner.isEmpty() || inner.area() < 2 ? blade : blade.subtract(inner));
      break;
    }
    case 'custom': {
      if (!custom || !custom.polygons.length) {
        parts.push(bar(M, 0, w, L, w * 0.72));
        note = 'Upload een SVG-bestand voor de eigen wijzervorm; tot dan wordt een stokwijzer getoond.';
        break;
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const poly of custom.polygons)
        for (const [x, y] of poly) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      const h = Math.max(1e-6, maxY - minY);
      const py = minY + clamp(custom.pivot, 0, 0.9) * h;
      const s = L / Math.max(1e-6, maxY - py);
      const cx = (minX + maxX) / 2;
      const drawing = keep(new M.CrossSection(custom.polygons.map((poly) => poly.map(([x, y]) => [(x - cx) * s, (y - py) * s] as Vec2)), 'NonZero'));
      parts.push(drawing);
      if (M.CrossSection.union([drawing, parts[0]]).decompose().length > 1) {
        // the drawing does not reach the hub: add a slim spine so the hand stays in one piece
        parts.push(bar(M, 0, sw, L * 0.92, sw));
        note = 'De eigen wijzervorm raakt de naaf niet overal; er is een dun middenlatje toegevoegd. Verschuif het draaipunt als je dat niet wilt.';
      }
      tail = false;
      break;
    }
    default:
      parts.push(bar(M, 0, w, L, w * 0.72));
  }
  if (tail) {
    const t = tailPiece(M, d);
    if (t) parts.push(t);
  }
  return { cs: M.CrossSection.union(parts), note };
}

/** Second hand: slim needle plus an automatically sized counterweight. */
export function secondCross(M: ManifoldToplevel, style: string, L: number, w: number, hub: number): CrossSection {
  const parts: CrossSection[] = [M.CrossSection.hull([disc(M, w / 2, 0, 0), disc(M, w * 0.3, 0, L - w * 0.3)])];
  const yc = L * 0.8;
  if (style === 'lolly') parts.push(disc(M, Math.max(1.8, w * 1.6), 0, yc));
  if (style === 'ring') {
    const ro = Math.max(2.6, w * 2);
    parts.push(disc(M, ro, 0, yc, 48).subtract(disc(M, ro - Math.max(1.0, w * 0.7), 0, yc, 40)));
  }
  const front = M.CrossSection.union(parts);
  // counterweight: cancel about half of the imbalance with a small disc on a tail
  const lt = Math.max(hub / 2 + 3, L * 0.25);
  const tw = Math.max(1.0, w);
  const tailBar = bar(M, -lt, tw, 0, tw);
  const s = areaStats(front).momentY + areaStats(tailBar).momentY;
  const r = clamp(Math.sqrt(Math.max(0, 0.5 * s) / (Math.PI * lt)), Math.max(1.5, tw * 0.8), Math.max(2.5, Math.min(5, L * 0.05)));
  return M.CrossSection.union([front, tailBar, disc(M, r, 0, -lt, 40), disc(M, hub / 2, 0, 0, 40)]);
}

/** Mounting hole: round, or round with two flats (minute hands). */
export function holeCross(M: ManifoldToplevel, d: number, flat = 0): CrossSection {
  const c = M.CrossSection.circle(Math.max(0.1, d / 2), 64);
  if (!flat || flat >= d - 0.01) return c;
  return c.intersect(M.CrossSection.square([Math.max(0.1, flat), d + 1], true));
}

interface RawPolygons {
  size(): number;
  get(i: number): { size(): number; get(j: number): { x: number; y: number }; delete(): void };
  delete(): void;
}

/**
 * Contours of a cross-section. Same as `cs.toPolygons()`, but that wrapper in
 * manifold-3d 3.5 never frees the per-contour vectors and leaks WASM memory
 * on every call, which adds up quickly in the numeral-fitting loops.
 */
export function polygonsOf(cs: CrossSection): Vec2[][] {
  const vec = (cs as unknown as { _ToPolygons(): RawPolygons })._ToPolygons();
  const out: Vec2[][] = [];
  for (let i = 0; i < vec.size(); i++) {
    const v = vec.get(i);
    const poly: Vec2[] = [];
    for (let j = 0; j < v.size(); j++) {
      const p = v.get(j);
      poly.push([p.x, p.y]);
    }
    v.delete();
    out.push(poly);
  }
  vec.delete();
  return out;
}

/** Signed area (mm²) and first moment about the X axis (mm³) of a cross-section. */
export function areaStats(cs: CrossSection) {
  let a = 0;
  let sy = 0;
  for (const poly of polygonsOf(cs)) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const c = x1 * y2 - x2 * y1;
      a += c;
      sy += c * (y1 + y2);
    }
  }
  return { area: a / 2, momentY: sy / 6 };
}

export const TICK_STYLES = [
  { value: 'none', label: 'Geen' },
  { value: 'line', label: 'Streepje' },
  { value: 'dot', label: 'Stip' },
  { value: 'triangle', label: 'Driehoekje' },
  { value: 'diamond', label: 'Ruitje' },
];

/**
 * A tick mark pointing outward along +Y: the outer end at y = 0, reaching
 * inward to y = -len. `w` is the width of a line.
 */
export function tickCross(M: ManifoldToplevel, style: string, len: number, w: number): CrossSection | null {
  const L = Math.max(0.8, len);
  switch (style) {
    case 'line':
      return M.CrossSection.square([Math.max(0.8, w), L], false).translate([-Math.max(0.8, w) / 2, -L]);
    case 'dot': {
      const r = Math.max(0.7, L * 0.3);
      return disc(M, r, 0, -r, 32);
    }
    case 'triangle':
      return polygon(M, [[-0.35 * L, 0], [0.35 * L, 0], [0, -L]]);
    case 'diamond':
      return polygon(M, [[0, 0], [0.26 * L, -L / 2], [0, -L], [-0.26 * L, -L / 2]]);
    default:
      return null;
  }
}

/** Layered extrusion with a rounded or 45° chamfered edge at the bottom and/or top. */
export function edgeExtrude(
  M: ManifoldToplevel,
  shape: CrossSection,
  height: number,
  bottom: { r: number; kind: 'round' | 'chamfer' },
  top: { r: number; kind: 'round' | 'chamfer' },
  step = 0.2,
): Manifold {
  const rb = Math.min(bottom.r, height / 2.2);
  const rt = Math.min(top.r, height / 2.2);
  const nb = Math.max(0, Math.round(rb / step));
  const nt = Math.max(0, Math.round(rt / step));
  const inset = (r: number, d: number, kind: 'round' | 'chamfer') =>
    kind === 'chamfer' ? Math.max(0, r - d) : r - Math.sqrt(Math.max(0, r * r - (r - d) * (r - d)));
  const pieces: Manifold[] = [];
  for (let i = 0; i < nb; i++) {
    const z0 = i * step;
    const s = shape.offset(-inset(rb, z0 + step / 2, bottom.kind), 'Round');
    if (!s.isEmpty()) pieces.push(s.extrude(step + 0.01).translate([0, 0, z0]));
  }
  const midStart = nb * step;
  const midEnd = height - nt * step;
  pieces.push(shape.extrude(midEnd - midStart + 0.02).translate([0, 0, midStart - 0.01]));
  for (let i = 0; i < nt; i++) {
    const z0 = midEnd + i * step;
    const s = shape.offset(-inset(rt, height - (z0 + step / 2), top.kind), 'Round');
    if (!s.isEmpty()) pieces.push(s.extrude(step + (i === nt - 1 ? 0 : 0.01)).translate([0, 0, z0]));
  }
  return pieces.length === 1 ? pieces[0] : M.Manifold.union(pieces);
}

/** Dutch number formatting: 5.45 → "5,45", 5.5 → "5,5". */
export function nl(v: number, digits = 2) {
  return String(+v.toFixed(digits)).replace('.', ',');
}

export interface FitItem {
  label: string;
  /** hole outline centred on the origin */
  hole: CrossSection;
  /** outer size of the hole (for spacing) */
  size: number;
}

/**
 * A strip of tabs, each with one hole size and its value written above it, so
 * the best fit can be found before printing big parts.
 */
export function fitStrip(M: ManifoldToplevel, font: Font, title: string, items: FitItem[], thickness: number): Manifold {
  const cell = Math.max(10, Math.max(...items.map((i) => i.size)) + 6.5);
  const textH = 3.2;
  const fs = sizeForHeight(font, textH);
  const titleCs = textCross(M, font, title, fs).rotate(90);
  const tb = titleCs.bounds();
  const titleW = tb.max[0] - tb.min[0] + 4;
  const rowH = cell + textH + 3;
  const x0 = -cell / 2 - titleW;
  const width = items.length * cell + titleW;
  const yMin = -cell / 2;
  const body = M.CrossSection.square([width, rowH], false).translate([x0, yMin]);
  const rounded = body.offset(-2, 'Round').offset(2, 'Round', undefined, 24);
  const holes: CrossSection[] = [];
  const labels: CrossSection[] = [];
  items.forEach((it, i) => {
    const x = i * cell;
    holes.push(it.hole.translate([x, 0]));
    const t = textCross(M, font, it.label, fs);
    const b = t.bounds();
    const s = Math.min(1, (cell - 1.5) / Math.max(1e-6, b.max[0] - b.min[0]));
    labels.push(t.scale(s).translate([x, cell / 2 + textH / 2 + 0.6]));
  });
  labels.push(titleCs.translate([x0 + titleW / 2 + 0.5 - (tb.min[0] + tb.max[0]) / 2, yMin + rowH / 2 - (tb.min[1] + tb.max[1]) / 2]));
  // small notches between the tabs show which hole belongs to which value
  const notches: CrossSection[] = [];
  for (let i = 1; i < items.length; i++) {
    const x = i * cell - cell / 2;
    notches.push(polygon(M, [[x - 1, yMin - 0.01], [x + 1, yMin - 0.01], [x, yMin + 1.4]]));
  }
  const plate = rounded.subtract(M.CrossSection.union([...holes, ...notches]));
  const text = M.CrossSection.union(labels).intersect(rounded.offset(-0.8));
  return M.Manifold.union([plate.extrude(thickness), text.extrude(0.6).translate([0, 0, thickness - 0.01])]);
}
