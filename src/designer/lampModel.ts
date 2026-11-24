/**
 * The lamp as the designer sees it: a stack of segment slots (s1… = top to
 * bottom) plus a few global elements. Pure functions on the flat parameter
 * object of the Lampen tool, so every view (outliner, node graph, gizmos,
 * the old form) edits the same state.
 */
import type { ParamDef, Params } from '../core/types';
import { COLOR_OPTIONS, KAP_OPTIONS, SHAPE_OPTIONS } from '../tools/lampParts';

export const MAX_SEGMENTS = 8;
/** Per-slot parameter suffixes: s{slot}{field}. */
export const SLOT_FIELDS = ['Shape', 'Kap', 'D', 'H', 'Var', 'N', 'Flip', 'Tex', 'TexN', 'Groove', 'Round', 'Scallop', 'Color', 'Mat'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];

export const slotKey = (slot: number, field: SlotField) => `s${slot}${field}`;

export type Sel =
  | { kind: 'lamp' }
  | { kind: 'seg'; slot: number }
  | { kind: 'layers' }
  | { kind: 'closed' }
  | { kind: 'tube' }
  | { kind: 'socket' }
  | { kind: 'base' }
  | { kind: 'canopy' };

export type GlobalKind = Exclude<Sel['kind'], 'seg'>;

export const LAMP: Sel = { kind: 'lamp' };

export function selKey(s: Sel): string {
  return s.kind === 'seg' ? `seg:${s.slot}` : s.kind;
}

/** Parse a selection id (as in PartOut.select); unknown ids select the lamp. */
export function parseSel(id: string | undefined | null): Sel {
  if (!id) return LAMP;
  const m = /^seg:(\d+)$/.exec(id);
  if (m) {
    const slot = Number(m[1]);
    return slot >= 1 && slot <= MAX_SEGMENTS ? { kind: 'seg', slot } : LAMP;
  }
  if (id === 'layers' || id === 'closed' || id === 'tube' || id === 'socket' || id === 'base' || id === 'canopy' || id === 'lamp') return { kind: id };
  return LAMP;
}

export const sameSel = (a: Sel, b: Sel) => selKey(a) === selKey(b);

export function segmentCount(p: Params): number {
  const n = Math.round(Number(p.count));
  return Number.isFinite(n) ? Math.min(MAX_SEGMENTS, Math.max(1, n)) : 1;
}

export const isPendant = (p: Params) => p.lampType === 'pendant';
/** The printed screw tube (default) rather than a bought M10 tube. */
export const isPrintedTube = (p: Params) => p.connection !== 'm10';

export function hasKap(p: Params): boolean {
  const n = segmentCount(p);
  for (let i = 1; i <= n; i++) if (p[slotKey(i, 'Shape')] === 'kap') return true;
  return false;
}

/** Is a selection meaningful for these parameters (e.g. no base on a pendant)? */
export function selValid(s: Sel, p: Params): boolean {
  switch (s.kind) {
    case 'seg':
      return s.slot >= 1 && s.slot <= segmentCount(p);
    case 'layers':
    case 'closed':
      return hasKap(p);
    case 'base':
      return !isPendant(p);
    case 'canopy':
      return isPendant(p);
    default:
      return true;
  }
}

export const SHAPE_SHORT: Record<string, string> = {
  bol: 'Bol', kussen: 'Kussen', cilinder: 'Cilinder', tol: 'Tol', diabolo: 'Diabolo', kegel: 'Kegel', koepel: 'Koepel', boog: 'Boog', trap: 'Ziggurat',
  bloem: 'Bloem', tandwiel: 'Tandwiel', schijf: 'Schijf', hals: 'Hals', stijlen: 'Stijlen', kap: 'Kap', lamel: 'Lamel', ribring: 'Ribbelring',
};

export interface SegmentInfo {
  slot: number;
  shape: string;
  kap: string;
  color: string;
  colorName: string;
  label: string;
  flip: boolean;
  /** Flip applies to this shape. */
  canFlip: boolean;
  D: number;
  H: number;
}

const NO_FLIP = new Set(['hals', 'stijlen', 'kap', 'lamel', 'ribring']);

export function segmentInfo(p: Params, slot: number): SegmentInfo {
  const shape = String(p[slotKey(slot, 'Shape')] ?? 'cilinder');
  const kap = String(p[slotKey(slot, 'Kap')] ?? 'koepel');
  const color = String(p[slotKey(slot, 'Color')] ?? '#f2efe8');
  const kapLabel = KAP_OPTIONS.find((o) => o.value === kap)?.label.split(' (')[0].toLowerCase();
  return {
    slot,
    shape,
    kap,
    color,
    colorName: COLOR_OPTIONS.find((o) => o.value === color)?.label.split(' (')[0] ?? color,
    label: shape === 'kap' && kapLabel ? `Kap · ${kapLabel}` : (SHAPE_SHORT[shape] ?? SHAPE_OPTIONS.find((o) => o.value === shape)?.label ?? shape),
    flip: p[slotKey(slot, 'Flip')] === true,
    canFlip: !NO_FLIP.has(shape),
    D: Number(p[slotKey(slot, 'D')]),
    H: Number(p[slotKey(slot, 'H')]),
  };
}

/** Segments top to bottom (slot 1 is the top one). */
export function segments(p: Params): SegmentInfo[] {
  return Array.from({ length: segmentCount(p) }, (_, i) => segmentInfo(p, i + 1));
}

/**
 * Reorder the segments: `order[k]` is the old slot that ends up at slot k + 1.
 * Must be a permutation of 1..count. Slots beyond the count are untouched.
 */
export function permuteSegments(p: Params, order: number[]): Params {
  const n = segmentCount(p);
  const sorted = [...order].sort((a, b) => a - b);
  if (order.length !== n || sorted.some((v, i) => v !== i + 1)) throw new Error(`Geen geldige volgorde: ${order.join(',')}`);
  const out: Params = { ...p };
  order.forEach((from, k) => {
    for (const f of SLOT_FIELDS) {
      const v = p[slotKey(from, f)];
      if (v !== undefined) out[slotKey(k + 1, f)] = v;
    }
  });
  return out;
}

/** Move the segment at slot `from` to slot `to` (both 1-based). */
export function moveSegment(p: Params, from: number, to: number): Params {
  const n = segmentCount(p);
  if (from < 1 || from > n) return p;
  const t = Math.min(n, Math.max(1, to));
  const order = Array.from({ length: n }, (_, i) => i + 1);
  order.splice(from - 1, 1);
  order.splice(t - 1, 0, from);
  return permuteSegments(p, order);
}

/** Sensible starting values for a new segment of a shape. */
export const SHAPE_DEFAULTS: Record<string, { D: number; H: number; Var: number; N?: number; Kap?: string }> = {
  bol: { D: 90, H: 70, Var: 25 },
  kussen: { D: 110, H: 30, Var: 60 },
  cilinder: { D: 90, H: 40, Var: 30 },
  tol: { D: 110, H: 60, Var: 20, N: 2 },
  diabolo: { D: 110, H: 70, Var: 35, N: 1 },
  kegel: { D: 120, H: 60, Var: 20 },
  koepel: { D: 130, H: 60, Var: 0 },
  boog: { D: 110, H: 70, Var: 60 },
  trap: { D: 130, H: 60, Var: 30, N: 4 },
  bloem: { D: 130, H: 16, Var: 50, N: 8 },
  tandwiel: { D: 130, H: 14, Var: 50, N: 18 },
  schijf: { D: 160, H: 8, Var: 30 },
  ribring: { D: 180, H: 14, Var: 70, N: 36 },
  hals: { D: 26, H: 30, Var: 20 },
  stijlen: { D: 80, H: 30, Var: 20, N: 3 },
  kap: { D: 220, H: 120, Var: 20, Kap: 'koepel' },
  lamel: { D: 200, H: 8, Var: 15 },
};

export class DesignError extends Error {}

function shiftDown(p: Params, from: number, n: number): Params {
  const out: Params = { ...p };
  for (let s = n; s >= from; s--) for (const f of SLOT_FIELDS) if (p[slotKey(s, f)] !== undefined) out[slotKey(s + 1, f)] = p[slotKey(s, f)];
  return out;
}

/** Insert a new segment of `shape` at slot `at` (1..count+1); the rest moves down. */
export function insertSegment(p: Params, at: number, shape: string): Params {
  const n = segmentCount(p);
  if (n >= MAX_SEGMENTS) throw new DesignError(`Maximaal ${MAX_SEGMENTS} segmenten.`);
  const pos = Math.min(n + 1, Math.max(1, at));
  const out = shiftDown(p, pos, n);
  const d = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.cilinder;
  const near = new Set([p[slotKey(pos - 1, 'Color')], p[slotKey(pos, 'Color')]]);
  const color = shape === 'kap' || shape === 'lamel' || shape === 'ribring' ? '#f2efe8' : (COLOR_OPTIONS.find((o) => !near.has(o.value) && o.value !== '#f2efe8')?.value ?? '#d8c3a0');
  Object.assign(out, {
    [slotKey(pos, 'Shape')]: SHAPE_DEFAULTS[shape] ? shape : 'cilinder',
    [slotKey(pos, 'Kap')]: d.Kap ?? 'koepel',
    [slotKey(pos, 'D')]: d.D,
    [slotKey(pos, 'H')]: d.H,
    [slotKey(pos, 'Var')]: d.Var,
    [slotKey(pos, 'N')]: d.N ?? 3,
    [slotKey(pos, 'Flip')]: false,
    [slotKey(pos, 'Tex')]: 'glad',
    [slotKey(pos, 'TexN')]: 96,
    [slotKey(pos, 'Groove')]: 45,
    [slotKey(pos, 'Round')]: 80,
    [slotKey(pos, 'Scallop')]: 0,
    [slotKey(pos, 'Color')]: color,
    [slotKey(pos, 'Mat')]: 'auto',
  });
  out.count = n + 1;
  return out;
}

/** Copy a segment right below itself. */
export function duplicateSegment(p: Params, slot: number): Params {
  const n = segmentCount(p);
  if (n >= MAX_SEGMENTS) throw new DesignError(`Maximaal ${MAX_SEGMENTS} segmenten.`);
  if (slot < 1 || slot > n) return p;
  const out = shiftDown(p, slot + 1, n);
  for (const f of SLOT_FIELDS) if (p[slotKey(slot, f)] !== undefined) out[slotKey(slot + 1, f)] = p[slotKey(slot, f)];
  out.count = n + 1;
  return out;
}

/** Remove a segment; the ones below move up. The last segment cannot be removed. */
export function deleteSegment(p: Params, slot: number): Params {
  const n = segmentCount(p);
  if (n <= 1) throw new DesignError('Een lamp heeft minstens één segment.');
  if (slot < 1 || slot > n) return p;
  const out: Params = { ...p };
  for (let s = slot; s < n; s++) for (const f of SLOT_FIELDS) if (p[slotKey(s + 1, f)] !== undefined) out[slotKey(s, f)] = p[slotKey(s + 1, f)];
  // the freed slot keeps the removed values (hidden), so undo is not needed to restore it
  for (const f of SLOT_FIELDS) if (p[slotKey(slot, f)] !== undefined) out[slotKey(n, f)] = p[slotKey(slot, f)];
  out.count = n - 1;
  return out;
}

export function toggleFlip(p: Params, slot: number): Params {
  return { ...p, [slotKey(slot, 'Flip')]: !(p[slotKey(slot, 'Flip')] === true) };
}

// ---------------------------------------------------------------------------
// Which parameters belong to a selection

const GLOBAL_KEYS: Record<Exclude<GlobalKind, 'layers'>, string[]> = {
  lamp: ['lampType', 'texDepth', 'shadeWall', 'shellPrint', 'shellWall'],
  tube: ['connection', 'tubeD', 'threadPlay', 'tubeExtra', 'fitTest'],
  socket: ['socket', 'bulb27', 'bulb14', 'clearance', 'cover', 'fitSize', 'fitRingD', 'fitRingH', 'fitBodyD', 'fitTopD', 'fitTopH', 'fitH', 'cupColor'],
  closed: ['closed', 'closedShape', 'closedH', 'closedWall', 'closedDrop', 'closedOpen', 'centerBulb', 'seamPlay', 'vent'],
  base: ['baseShape', 'baseD', 'baseH', 'baseColor', 'ballast', 'felt'],
  canopy: ['cableCap', 'capColor', 'canopy', 'canopyD', 'canopyH', 'canopyScrews', 'canopyColor'],
};

/** Keys managed by the designer itself (not shown in any inspector). */
export const MANAGED_KEYS = new Set(['count']);

function ownsKey(s: Sel, key: string): boolean {
  switch (s.kind) {
    case 'seg':
      return new RegExp(`^s${s.slot}(${SLOT_FIELDS.join('|')})$`).test(key);
    case 'layers':
      return key === 'layers' || key === 'layerGap' || /^kl\d/.test(key);
    default:
      return GLOBAL_KEYS[s.kind].includes(key);
  }
}

/**
 * The parameter definitions of a selection, in schema order. Group headers
 * are kept (as section titles) when at least one of their parameters is.
 */
export function defsFor(s: Sel, defs: ParamDef[]): ParamDef[] {
  const out: ParamDef[] = [];
  let group: ParamDef | null = null;
  let groups = 0;
  for (const d of defs) {
    if (d.type === 'group') {
      group = d;
      continue;
    }
    if (!ownsKey(s, d.key)) continue;
    // segment headers ("Segment 3") and the first header of an element repeat what the inspector title says
    if (group && (s.kind === 'layers' || (s.kind !== 'seg' && groups > 0))) out.push(group);
    if (group) groups++;
    group = null;
    out.push(d);
  }
  return out;
}

export const SEL_TITLES: Record<GlobalKind, string> = {
  lamp: 'Lamp',
  tube: 'Buis & draad',
  socket: 'Fitting & lamp',
  layers: 'Kap in lagen',
  closed: 'Dichte lamp',
  base: 'Voet',
  canopy: 'Plafondkap',
};

export function selTitle(s: Sel, p: Params): string {
  if (s.kind === 'seg') return `${s.slot}. ${segmentInfo(p, s.slot).label}`;
  return SEL_TITLES[s.kind];
}

/** Global elements shown in the outliner for these parameters. */
export function globalEntries(p: Params): GlobalKind[] {
  const out: GlobalKind[] = ['lamp', 'tube', 'socket'];
  if (hasKap(p)) out.push('layers', 'closed');
  out.push(isPendant(p) ? 'canopy' : 'base');
  return out;
}
