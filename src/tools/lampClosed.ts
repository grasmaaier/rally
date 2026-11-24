import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { ParamDef, Params } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { TAU, clamp, smoothstep } from '../geom/helpers';
import type { LatheSample } from '../geom/lathe';
import { externalTapered, heights, helixU, internalTapered, ringsOf, threadSegs, wallSolid, type Ring, type ThreadSpec } from '../geom/thread';
import { kapRadius, type SegSpec } from './lampParts';

// ---------------------------------------------------------------------------
// Closed lamp: a second shade screws onto the kap like a jar lid, with a
// large two-start 45° thread in the seam at the widest point (male neck on
// the kap, female band in the second shade). Unscrew it to change the bulb.

export const SEAM_THREAD: ThreadSpec = { pitch: 4, starts: 2, depth: 1.5 };
/** Neck length (thread engagement ≥ 8 mm), wall outside the female root, core inside the male root. */
const SEAM = { len: 10, wall: 2, core: 1.6 };
const DZ = 0.25;

export const CLOSED_SHAPES = [
  { value: 'spiegel', label: 'Spiegelbeeld van de kap' },
  { value: 'koepel', label: 'Koepel (halve bol)' },
  { value: 'kegel', label: 'Kegel' },
  { value: 'klok', label: 'Klok' },
  { value: 'cilinder', label: 'Cilinder (platte bodem)' },
  { value: 'binnen', label: 'Naar binnen met opening' },
];

export const VENT_OPTIONS = [
  { value: 'verborgen', label: 'Verborgen (in de naden)' },
  { value: 'gaatjes', label: 'Zichtbare gaatjes' },
  { value: 'geen', label: 'Geen' },
];

/** Lip around the opening of an inward second shade: height and the chamfers at the bed. */
export const LIP = { h: 5, chamfer: 0.8 };

/**
 * Hidden ventilation (mm): channels through the kap ceiling (holes near the
 * tube, a trench over the cup on the cavity side, a 45° groove under the
 * neighbouring part on the outside) and notches + grooves at the seam.
 */
export const HIDDEN = { ceil: 6, n: 10, hole: 1.8, trenchW: 5, trenchD: 1.6, groove: 6, notchW: 5, notchD: 1.8, slotW: 5, room: 2 };

export function closedParams(kapOn: (p: Params) => boolean): ParamDef[] {
  const on = (p: Params) => kapOn(p) && bool(p, 'closed');
  return [
    { type: 'group', label: 'Dichte lamp', show: kapOn },
    {
      type: 'bool', key: 'closed', label: 'Dichte lamp (tweede kap)', default: false, show: kapOn,
      help: 'Een tweede kap schroeft op de rand van de kap (schroefdraad in de naad, op het breedste punt), zodat de lamp helemaal dicht is. Losdraaien om de lamp te wisselen. Niet samen met kap in lagen of lamellen.',
    },
    {
      type: 'select', key: 'closedShape', label: 'Vorm tweede kap', options: CLOSED_SHAPES, default: 'spiegel', show: on,
      help: 'Onder de kap bij een hanglamp, erop bij een tafellamp. "Naar binnen met opening": de wand loopt door en buigt (onder 45°, afgerond) naar binnen tot een opening; door de opening zie je de lamp.',
    },
    { type: 'number', key: 'closedH', label: 'Hoogte tweede kap', min: 30, max: 300, step: 1, unit: 'mm', default: 120, show: (p) => on(p) && str(p, 'closedShape') !== 'spiegel' && str(p, 'closedShape') !== 'binnen' },
    {
      type: 'select', key: 'closedWall', label: 'Wand tot de bocht', default: 'recht', show: (p) => on(p) && str(p, 'closedShape') === 'binnen',
      options: [
        { value: 'recht', label: 'Recht naar beneden' },
        { value: 'kap', label: 'Volgt de kap (spiegelbeeld)' },
      ],
    },
    {
      type: 'number', key: 'closedDrop', label: 'Recht stuk', min: 0, max: 250, step: 1, unit: 'mm', default: 40, show: (p) => on(p) && str(p, 'closedShape') === 'binnen',
      help: 'Hoe ver de wand vanaf de naad doorloopt voordat hij naar binnen buigt.',
    },
    {
      type: 'number', key: 'closedOpen', label: 'Opening onderin', min: 30, max: 240, step: 1, unit: 'mm', default: 100, show: (p) => on(p) && str(p, 'closedShape') === 'binnen',
      help: 'Diameter van de opening (binnenkant van de afgeronde lip). Groter dan de lamp: de lamp wisselen door de opening.',
    },
    { type: 'bool', key: 'centerBulb', label: 'Lamp in het midden', default: true, show: on, help: 'De naad ligt ter hoogte van het midden van de lamp; de hoogte van de kap past zich daaraan aan.' },
    { type: 'number', key: 'seamPlay', label: 'Speling naad', min: 0.2, max: 1, step: 0.05, unit: 'mm', default: 0.5, show: on, help: 'Ruimte in de schroefdraad van de naad. Grote ronde delen zijn nooit helemaal rond: liever iets ruimer.' },
    {
      type: 'select', key: 'vent', label: 'Ventilatie', options: VENT_OPTIONS, default: 'verborgen', show: on,
      help: 'Verborgen: kanaaltjes door het plafond van de kap komen uit in de naad tegen het volgende deel op de buis, en smalle sleufjes in de naad tussen de kappen (of de opening) maken de luchtstroom rond. Van opzij zie je geen gaten. Zichtbare gaatjes: ruitjes in de kap en gaatjes in de bodem. Geen: alleen een LED-lamp tot ~5 W, in PETG.',
    },
  ];
}

export type VentMode = 'verborgen' | 'gaatjes' | 'geen';

export interface ClosedSetup {
  shape: string;
  H: number;
  center: boolean;
  c: number;
  vent: VentMode;
  /** Inward shape: wall to the bend ('recht' / 'kap'), straight length and opening diameter. */
  wall: 'recht' | 'kap';
  drop: number;
  open: number;
}

export function closedOf(p: Params): ClosedSetup | null {
  if (!bool(p, 'closed')) return null;
  const shape = CLOSED_SHAPES.some((o) => o.value === str(p, 'closedShape')) ? str(p, 'closedShape') : 'spiegel';
  const v = (k: string, def: number, lo: number, hi: number) => clamp(Number.isFinite(num(p, k)) ? num(p, k) : def, lo, hi);
  const vent = VENT_OPTIONS.some((o) => o.value === p.vent) ? (p.vent as VentMode) : 'verborgen';
  return {
    shape,
    H: v('closedH', 120, 20, 400),
    center: p.centerBulb === undefined ? true : bool(p, 'centerBulb'),
    c: v('seamPlay', 0.5, 0.15, 1.2),
    vent,
    wall: p.closedWall === 'kap' ? 'kap' : 'recht',
    drop: v('closedDrop', 40, 0, 400),
    open: v('closedOpen', 100, 10, 500),
  };
}

export interface Seam {
  /** Outer radius of both rims (flush). */
  R: number;
  c: number;
  /** Major radius of the male thread on the neck. */
  Rm: number;
  /** Inner radius of the neck. */
  neckIn: number;
  /** Smallest inner radius of the female band (its crests). */
  bandIn: number;
  len: number;
  /** Depth of the female band (the neck never bottoms out). */
  depth: number;
  segs: number;
}

export function seamOf(R: number, c: number): Seam {
  const t = SEAM_THREAD;
  const Rm = R - c - SEAM.wall;
  return { R, c, Rm, neckIn: Rm - t.depth - SEAM.core, bandIn: Rm - t.depth + c, len: SEAM.len, depth: SEAM.len + 0.6, segs: Math.max(threadSegs(t, Rm, 0.13, 1.6), 96) };
}

/**
 * Male neck on the kap rim in print orientation: the kap prints rim up, the
 * shoulder at z = `z0`, the neck up to z0 + len (overlapping the kap 0.4 mm).
 * Thread phase: relative to the shoulder.
 */
export function neckSolid(M: ManifoldToplevel, s: Seam, z0: number, segsIn = 96): Manifold {
  const t = SEAM_THREAD;
  const top = z0 + s.len;
  const outer: Ring[] = [{ z: z0 - 0.4, r: () => s.Rm - 0.3 }, ...ringsOf(heights(z0, top, DZ), (z, th) => externalTapered(t, s.Rm, helixU(t, z - z0, th), Infinity, top - z))];
  // inside the kap the neck lies on the kap's 45° inner wall (same segments), so no ledge shows in the cavity
  return wallSolid(M, { segs: s.segs, rings: outer }, { segs: segsIn, rings: [{ z: z0 - 0.4, r: () => s.neckIn + 0.4 }, { z: z0, r: () => s.neckIn }, { z: top, r: () => s.neckIn }] });
}

/** Outer radius of the second shade at distance d from its rim (0 … H), widest (R) at the rim. */
export function partnerRadius(kap: SegSpec, setup: ClosedSetup, R: number, H: number, poleR: number): (d: number) => number {
  const kind = setup.shape === 'spiegel' ? kap.kap : setup.shape;
  const spec: SegSpec = { ...kap, kap: kind, D: 2 * R, H, v: setup.shape === 'spiegel' ? kap.v : kind === 'kegel' || kind === 'klok' ? 0 : kap.v };
  if (kind === 'cilinder') return () => R;
  return kapRadius(spec, poleR);
}

/**
 * Samples of the second shade in print orientation (pole on the bed, rim up):
 * a collar at the rim for the female band (45° below it), the follow-the-wall
 * cavity, a flat floor at the pole.
 */
export function partnerSamples(radius: (d: number) => number, H: number, s: Seam, wall: number, floor: number): LatheSample[] {
  const collar = s.depth + 0.8;
  const out: LatheSample[] = [];
  const n = Math.max(2, Math.ceil(H / 0.25));
  for (let k = 0; k <= n; k++) {
    const z = (H * k) / n;
    const d = H - z;
    // the band needs the full rim radius over its depth, then widens out at 45°
    const o = Math.max(radius(d), s.R - Math.max(0, d - collar));
    const band = d <= s.depth + 0.01 ? s.bandIn - 0.2 : Infinity;
    out.push({ z, o, i: z < floor ? 0.5 : band, tex: 1, wall });
  }
  return out;
}

/** Female band rings (inner wall, print orientation, rim at z = H): countersunk at the rim. */
export function bandRings(s: Seam, H: number): Ring[] {
  const t = SEAM_THREAD;
  return ringsOf(heights(H - s.depth, H, DZ), (z, th) => internalTapered(t, s.Rm, s.c, helixU(t, z - H, th), Infinity, H - z));
}

/** Diamond vent cutters (45° edges) through a wall around the axis at height z (print coordinates). */
export function ventCutters(M: ManifoldToplevel, n: number, z: number, rIn: number, rOut: number, a: number, phase = 0): Manifold[] {
  const out: Manifold[] = [];
  for (let k = 0; k < n; k++) {
    const th = phase + (k * TAU) / n;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const pts: [number, number, number][] = [];
    for (const r of [rIn, rOut]) for (const [x, dz] of [[-a, 0], [a, 0], [0, a], [0, -a]] as const) pts.push([r * c - x * sn, r * sn + x * c, z + dz]);
    out.push(M.Manifold.hull(pts));
  }
  return out;
}

/** Ring of round vent holes through a flat floor on the bed. */
export function floorVents(M: ManifoldToplevel, n: number, r: number, hole: number, floor: number): Manifold[] {
  const out: Manifold[] = [M.Manifold.cylinder(floor + 2, hole, hole, 24).translate([0, 0, -1])];
  for (let k = 0; k < n; k++) {
    const th = (k * TAU) / n;
    out.push(M.Manifold.cylinder(floor + 2, hole, hole, 24).translate([r * Math.cos(th), r * Math.sin(th), -1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Second shade that curves inward to an opening (print orientation: the
// opening on the bed, the rim with the female band on top). From the seam the
// wall runs on (straight down or as the kap's mirror image), then turns in at
// 45° with rounded bends to a short, thicker lip around the opening.

/** Quadratic smooth minimum: the slope stays between the slopes of a and b. */
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
/** Smooth max(0, x) with slope 0 … 1. */
const smax0 = (x: number, k: number) => (x >= k / 2 ? x : x <= -k / 2 ? 0 : (x + k / 2) ** 2 / (2 * k));

export interface Inward {
  /** Print height (opening on the bed, rim at H). */
  H: number;
  rOpen: number;
  rLip: number;
  /** Straight wall length from the seam before the bend (at least the band). */
  drop: number;
  samples: LatheSample[];
}

/**
 * Lathe samples of an inward second shade. `wallR(d)` is the wall before the
 * bend at distance d below the seam; `textured` fades the kap's pattern in
 * between the band and the lip.
 */
export function inwardSamples(wallR: (d: number) => number, s: Seam, setup: ClosedSetup, shadeWall: number, textured: boolean, notes: string[], name: string): Inward {
  const R = s.R;
  const collar = s.depth + 0.8;
  const drop = Math.max(setup.drop, collar);
  // the wall before the bend: the band keeps the full rim radius, and nowhere does the wall lean more than
  // 45° (a 1-Lipschitz envelope), so the bend's 45° cone stays clear of it and the band is never cut back
  const m = Math.max(1, Math.ceil(drop / 0.25));
  const dd = drop / m;
  const ws = Array.from({ length: m + 1 }, (_, j) => {
    const d = j * dd;
    return d <= collar ? R : Math.max(Math.min(wallR(d), R), R - (d - collar));
  });
  for (let j = 1; j <= m; j++) ws[j] = Math.min(ws[j], ws[j - 1] + dd);
  for (let j = m - 1; j >= 0; j--) ws[j] = Math.min(ws[j], ws[j + 1] + dd);
  const w = (d: number) => {
    const u = clamp(d / dd, 0, m);
    const j = Math.min(m - 1, Math.floor(u));
    return ws[j] + (ws[j + 1] - ws[j]) * (u - j);
  };
  const Rt = w(drop);
  const lipW = Math.max(2, 2 * shadeWall);
  const most = Rt - lipW - 4;
  if (most < 10) throw new UserError(`${name}: hier is de kap te smal om nog naar binnen te buigen (Ø${(2 * Rt).toFixed(0)} mm). Maak het rechte stuk korter, kies "Recht naar beneden" of maak de kap breder.`);
  let rOpen = setup.open / 2;
  if (rOpen > most) {
    notes.push(`${name}: opening Ø${(2 * most).toFixed(0)} mm (i.p.v. Ø${setup.open.toFixed(0)}) — de wand moet nog naar binnen kunnen buigen.`);
    rOpen = most;
  }
  if (rOpen < 10) rOpen = 10;
  const rLip = rOpen + lipW;
  const k = clamp(0.35 * (Rt - rLip), 2, 14);
  // the bend starts k below the straight part, so the wall above it keeps its exact radius
  const H = drop + k + (Rt - rLip) + LIP.h;
  const out: LatheSample[] = [];
  const n = Math.max(2, Math.ceil(H / 0.25));
  for (let j = 0; j <= n; j++) {
    const z = (H * j) / n;
    const d = H - z;
    // past the straight part the wall would go on straight down: the 45° cone cuts it off (rounded by k)
    const cone = rLip + smax0(z - LIP.h, k);
    let o = d <= collar ? R : smin(d <= drop ? w(d) : Rt, cone, k);
    o -= Math.max(0, 0.6 - z);
    const band = d <= s.depth + 0.01;
    const lip = z <= LIP.h;
    const i = band ? s.bandIn - 0.2 : lip ? rOpen + Math.max(0, LIP.chamfer - z) : Infinity;
    const tex = textured ? smoothstep(LIP.h + 2, LIP.h + 7, z) * smoothstep(s.depth + 2, s.depth + 7, d) : 0;
    out.push({ z, o, i, tex, wall: lip ? lipW : shadeWall });
  }
  return { H, rOpen, rLip, drop, samples: out };
}

// ---------------------------------------------------------------------------
// Hidden ventilation. Ceiling of the kap in print orientation: the outer face
// (against the neighbouring part on the tube) on the bed, the cavity face at
// z = ceil. Every channel prints without support: vertical holes, trenches
// open to the top, and the grooves on the bed face have a 45° gable roof.

export interface CeilingVents {
  /** Vent angles (print coordinates). */
  angles: number[];
  /** Radius of the hole centres, end of the trench on the cavity side, end of the groove on the outer face (null: no groove). */
  rHole: number;
  rTrench: number;
  rExit: number | null;
  ceil: number;
}

/** Radial prism through the points (tangential offset, z) from radius r0 to r1 at angle th. */
function radialPrism(M: ManifoldToplevel, th: number, r0: number, r1: number, section: [number, number][]): Manifold {
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const pts: [number, number, number][] = [];
  for (const r of [r0, r1]) for (const [x, z] of section) pts.push([r * c - x * sn, r * sn + x * c, z]);
  return M.Manifold.hull(pts);
}

export function ceilingVentCutters(M: ManifoldToplevel, v: CeilingVents): Manifold[] {
  const h = HIDDEN;
  const out: Manifold[] = [];
  const g = h.groove / 2;
  for (const th of v.angles) {
    const x = v.rHole * Math.cos(th);
    const y = v.rHole * Math.sin(th);
    out.push(M.Manifold.cylinder(v.ceil + 0.6, h.hole, h.hole, 24).translate([x, y, -0.3]));
    const w = h.trenchW / 2;
    out.push(radialPrism(M, th, v.rHole, v.rTrench, [[-w, v.ceil - h.trenchD], [w, v.ceil - h.trenchD], [w, v.ceil + 0.5], [-w, v.ceil + 0.5]]));
    if (v.rExit !== null) out.push(radialPrism(M, th, v.rHole, v.rExit, [[-(g + 0.3), -0.3], [g + 0.3, -0.3], [0, g]]));
  }
  return out;
}

/** Open area (mm²) of the ceiling channels: the narrowest of trenches, holes and grooves. */
export function ceilingVentArea(v: CeilingVents): number {
  const h = HIDDEN;
  const n = v.angles.length;
  const groove = v.rExit === null ? Infinity : (h.groove * h.groove) / 4;
  return n * Math.min(h.trenchW * h.trenchD, Math.PI * h.hole * h.hole, groove);
}

/**
 * Seam vents in the second shade (print orientation, rim at z = H): a notch
 * in the rim face (a shadow slit under the kap's shoulder) and a slot in the
 * female band past the male neck into the shade. A horizontal look into the
 * notch ends on the neck.
 */
export function seamVentCutters(M: ManifoldToplevel, s: Seam, H: number, angles: number[]): Manifold[] {
  const h = HIDDEN;
  const out: Manifold[] = [];
  const r0 = s.bandIn - 1;
  for (const th of angles) {
    const w = h.notchW / 2;
    out.push(radialPrism(M, th, r0, s.R + 1, [[-w, H - h.notchD], [w, H - h.notchD], [w, H + 1], [-w, H + 1]]));
    const u = h.slotW / 2;
    out.push(radialPrism(M, th, r0, s.R - 1.2, [[-u, H - s.depth - 0.5], [u, H - s.depth - 0.5], [u, H + 1], [-u, H + 1]]));
  }
  return out;
}

/** Open area (mm²) of the seam vents: notch or slot past the male thread, whichever is narrower. */
export function seamVentArea(s: Seam, n: number): number {
  const h = HIDDEN;
  return n * Math.min(h.notchW * h.notchD, h.slotW * (s.R - 1.2 - s.Rm));
}
