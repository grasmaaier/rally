/**
 * Drag handles (gizmos) of the lamp designer, defined in one place: which
 * parameter a handle edits, where it sits on the element (radius r from the
 * axis, height z from the element's bottom, world orientation) and how a drag
 * along its axis maps to a parameter value. Profile handles only change the
 * shape's own parameters (diameter, height, variant %), so a shape stays that
 * shape.
 */
import type { NumberParam, ParamDef, Params } from '../core/types';
import { CORE_R, SOCKETS, kapRadius, shapeRadius, type SegSpec } from '../tools/lampParts';
import { FIT_GUIDE } from '../tools/lampTube';
import { isPendant, slotKey, type Sel } from './lampModel';

export interface Handle {
  id: 'height' | 'diameter' | 'variant';
  key: string;
  axis: 'r' | 'z';
  r: number;
  z: number;
  /** Parameter units per mm of pointer movement along +axis (+r outward, +z up). */
  perMm: number;
  label: string;
  unit: string;
  /** Step while Shift is held. */
  snap: number;
}

export interface ElementHandles {
  handles: Handle[];
  /** Height of the element (mm). */
  H: number;
  /** Largest radius (mm), for placing the height dimension beside the element. */
  R: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Name of the variant parameter for a shape (as shown next to the handle). */
export const VARIANT_LABEL: Record<string, string> = {
  bol: 'Platte kant', kussen: 'Bolling', cilinder: 'Afronding', schijf: 'Afronding', tol: 'Punten', diabolo: 'Taille', kegel: 'Ø boven',
  koepel: 'Platte top', boog: 'Boog', trap: 'Ø boven', bloem: 'Bladdiepte', tandwiel: 'Tanddiepte', lamel: 'Ringbreedte', kap: 'Ø boven',
};

function specOf(p: Params, slot: number): SegSpec {
  const n = (f: Parameters<typeof slotKey>[1]) => Number(p[slotKey(slot, f)]);
  return {
    slot,
    shape: String(p[slotKey(slot, 'Shape')]),
    kap: String(p[slotKey(slot, 'Kap')]),
    D: clamp(n('D') || 100, 20, 400),
    H: clamp(n('H') || 40, 2, 400),
    v: clamp(n('Var') / 100 || 0, 0, 1),
    n: clamp(Math.round(n('N') || 1), 1, 48),
    flip: p[slotKey(slot, 'Flip')] === true,
    tex: 'glad',
    texN: 0,
    color: '',
  };
}

/** Smallest radius at the top of a kap (room for the socket), as the build approximates it. */
export function kapTopR(p: Params): number {
  const s = SOCKETS[String(p.socket)] ?? SOCKETS.e27;
  const wall = clamp(Number(p.shadeWall) || 1.2, 0.8, 3);
  if (p.connection !== 'm10') {
    // printed tube: the click cup around the shade ring hangs under the ceiling
    const ring = p.fitSize === 'custom' ? Number(p.fitRingD) || FIT_GUIDE.e27.ringD : (FIT_GUIDE[String(p.socket)] ?? FIT_GUIDE.e27).ringD;
    return ring / 2 + 2.5 + 1.5 + wall + 0.5;
  }
  return s.d / 2 + 2 * wall + 3;
}

/** Variant handle in canonical coordinates (z = 0 at the bottom before flipping; kap: rim at 0). */
function variantHandle(s: SegSpec, topR: number): Omit<Handle, 'key' | 'label' | 'unit' | 'snap' | 'id'> | null {
  const R = s.D / 2;
  const H = s.H;
  const v = s.v;
  const core = Math.min(CORE_R, R);
  const per = (span: number, sign = 1) => (span > 1 ? (sign * 100) / span : 0);
  switch (s.shape) {
    case 'bol':
      return { axis: 'r', r: lerp(core, 0.85 * R, v), z: H, perMm: per(0.85 * R - core) };
    case 'kussen': {
      const a = clamp(lerp(0.4, 1.6, v) * (H / 2), 0.5, Math.max(0.5, R - core));
      return { axis: 'r', r: R - a, z: H, perMm: per(1.2 * (H / 2), -1) };
    }
    case 'cilinder':
    case 'schijf': {
      const max = Math.min(H / 2, (R - core) * 0.9, 20);
      return { axis: 'r', r: R - v * max, z: H, perMm: per(max, -1) };
    }
    case 'tandwiel':
      return { axis: 'r', r: R * (1 - lerp(0.08, 0.3, v)), z: H / 2, perMm: per(0.22 * R, -1) };
    case 'bloem':
      return { axis: 'r', r: R * (1 - lerp(0.12, 0.45, v)), z: H / 2, perMm: per(0.33 * R, -1) };
    case 'tol':
      return { axis: 'r', r: lerp(core, 0.9 * R, v), z: H, perMm: per(0.9 * R - core) };
    case 'diabolo':
      return { axis: 'r', r: lerp(core, 0.9 * R, v), z: H / (2 * Math.max(1, s.n)), perMm: per(0.9 * R - core) };
    case 'kegel':
      return { axis: 'r', r: lerp(core, R, v), z: H, perMm: per(R - core) };
    case 'koepel':
      return { axis: 'r', r: lerp(core, 0.7 * R, v), z: H, perMm: per(0.7 * R - core) };
    case 'boog': {
      const a = Math.min(0.95 * H, lerp(0.3, 1, v) * R);
      return { axis: 'z', r: R, z: H - a, perMm: per(0.7 * R, -1) };
    }
    case 'trap':
      return { axis: 'r', r: lerp(core, R, 0.9 * v), z: H, perMm: per(0.9 * (R - core)) };
    case 'lamel': {
      const w = Math.max(lerp(8, 0.45 * R, v), 6);
      return { axis: 'r', r: R - w, z: H / 2, perMm: per(0.45 * R - 8, -1) };
    }
    case 'kap': {
      if (s.kap !== 'kegel' && s.kap !== 'klok' && s.kap !== 'trap') return null;
      const RR = Math.max(R, topR);
      return { axis: 'r', r: Math.min(RR, Math.max(topR, lerp(topR, RR, v))), z: H, perMm: per(RR - topR) };
    }
    default:
      return null;
  }
}

/** Height (canonical) where a shape is widest, for the diameter handle. */
function widestZ(s: SegSpec, topR: number): number {
  const f = s.shape === 'kap' ? kapRadius(s, topR) : shapeRadius(s);
  let best = 0;
  let bz = s.H / 2;
  for (let k = 0; k <= 40; k++) {
    const z = (s.H * k) / 40;
    const r = f(z);
    // prefer the middle on ties (cylinders): strictly larger only, scanning from the middle out is overkill
    if (r > best + 1e-6 || (Math.abs(r - best) <= 1e-6 && Math.abs(z - s.H / 2) < Math.abs(bz - s.H / 2))) {
      best = r;
      bz = z;
    }
  }
  return bz;
}

export function handlesFor(sel: Sel, p: Params): ElementHandles | null {
  const pend = isPendant(p);
  if (sel.kind === 'seg') {
    const s = specOf(p, sel.slot);
    const topR = kapTopR(p);
    // world orientation: flipped segments and table-lamp shades are mirrored
    const mirrored = s.shape === 'kap' ? !pend : s.flip && s.shape !== 'stijlen' && s.shape !== 'lamel' && s.shape !== 'hals';
    const wz = (z: number) => (mirrored ? s.H - z : z);
    // the build stacks from the bottom up (also for pendants), so the bottom stays put
    const handles: Handle[] = [
      { id: 'height', key: slotKey(sel.slot, 'H'), axis: 'z', r: 0, z: s.H, perMm: 1, label: 'Hoogte', unit: 'mm', snap: 5 },
      { id: 'diameter', key: slotKey(sel.slot, 'D'), axis: 'r', r: s.D / 2, z: wz(widestZ(s, topR)), perMm: 2, label: 'Ø', unit: 'mm', snap: 5 },
    ];
    const vh = s.shape === 'hals' || s.shape === 'stijlen' ? null : variantHandle(s, topR);
    if (vh && vh.perMm !== 0) {
      handles.push({
        ...vh,
        id: 'variant',
        key: slotKey(sel.slot, 'Var'),
        z: wz(vh.z),
        perMm: vh.axis === 'z' && mirrored ? -vh.perMm : vh.perMm,
        label: VARIANT_LABEL[s.shape] ?? 'Variant',
        unit: '%',
        snap: 5,
      });
    }
    return { handles, H: s.H, R: s.shape === 'kap' ? Math.max(s.D / 2, topR) : s.D / 2 };
  }
  if (sel.kind === 'base' && !pend) {
    const D = Number(p.baseD) || 150;
    const H = Number(p.baseH) || 40;
    return {
      H,
      R: D / 2,
      handles: [
        { id: 'height', key: 'baseH', axis: 'z', r: 0, z: H, perMm: 1, label: 'Hoogte', unit: 'mm', snap: 5 },
        { id: 'diameter', key: 'baseD', axis: 'r', r: D / 2, z: H / 2, perMm: 2, label: 'Ø', unit: 'mm', snap: 5 },
      ],
    };
  }
  if (sel.kind === 'canopy' && pend && p.canopy !== false) {
    const D = Number(p.canopyD) || 110;
    const H = Number(p.canopyH) || 28;
    return {
      H,
      R: D / 2,
      handles: [
        { id: 'height', key: 'canopyH', axis: 'z', r: 0, z: H, perMm: 1, label: 'Hoogte', unit: 'mm', snap: 5 },
        { id: 'diameter', key: 'canopyD', axis: 'r', r: D / 2, z: H / 2, perMm: 2, label: 'Ø', unit: 'mm', snap: 5 },
      ],
    };
  }
  return null;
}

/**
 * Outer profile of a segment as it stands in the lamp (z from the bottom of
 * the element, world orientation), for the cheap drag preview. Null for
 * elements that are not a body of revolution (posts).
 */
export function elementProfile(p: Params, slot: number): { H: number; r: (z: number) => number; n: number; outline: 'round' | 'flower' | 'gear' } | null {
  const s = specOf(p, slot);
  if (s.shape === 'stijlen') return null;
  const pend = isPendant(p);
  const mirrored = s.shape === 'kap' ? !pend : s.flip && s.shape !== 'lamel' && s.shape !== 'hals';
  const f = s.shape === 'kap' ? kapRadius(s, kapTopR(p)) : shapeRadius(s);
  const outline = s.shape === 'bloem' ? 'flower' : s.shape === 'tandwiel' ? 'gear' : 'round';
  return { H: s.H, r: (z) => f(mirrored ? s.H - z : z), n: s.n, outline };
}

/** Points of a profile for a lathe: [r, z] from bottom to top, closed to the axis at both ends. */
export function profilePoints(prof: { H: number; r: (z: number) => number }, steps = 48): [number, number][] {
  const pts: [number, number][] = [[0, 0]];
  for (let k = 0; k <= steps; k++) {
    const z = (prof.H * k) / steps;
    const r = prof.r(z);
    pts.push([Number.isFinite(r) ? Math.max(0.1, r) : 0.1, z]);
  }
  pts.push([0, prof.H]);
  return pts;
}

export function numberDef(defs: ParamDef[], key: string): NumberParam | null {
  const d = defs.find((x) => x.type !== 'group' && x.key === key);
  return d && d.type === 'number' ? d : null;
}

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));

/**
 * Value after dragging `deltaMm` along a handle's axis: rounded to the
 * parameter step (or the handle's snap step with Shift) and clamped to the
 * parameter range.
 */
export function dragValue(def: Pick<NumberParam, 'min' | 'max' | 'step'>, start: number, deltaMm: number, perMm: number, snap: number | null = null): number {
  const raw = start + deltaMm * perMm;
  const step = snap && snap > 0 ? snap : (def.step ?? 1);
  let v = Math.round(raw / step) * step;
  if (!Number.isFinite(v)) v = start;
  v = Math.min(def.max, Math.max(def.min, v));
  return Number(v.toFixed(decimals(def.step ?? 1)));
}

export function formatHandle(h: Handle, v: number): string {
  if (h.id === 'diameter') return `Ø ${Math.round(v)} mm`;
  if (h.id === 'height') return `H ${Math.round(v)} mm`;
  return `${h.label} ${Math.round(v)}%`;
}
