import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { ParamDef, Params } from '../core/types';
import { bool, num, str } from '../core/types';
import { TAU, clamp } from '../geom/helpers';
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
];

export function closedParams(kapOn: (p: Params) => boolean): ParamDef[] {
  const on = (p: Params) => kapOn(p) && bool(p, 'closed');
  return [
    { type: 'group', label: 'Dichte lamp', show: kapOn },
    {
      type: 'bool', key: 'closed', label: 'Dichte lamp (tweede kap)', default: false, show: kapOn,
      help: 'Een tweede kap schroeft op de rand van de kap (schroefdraad in de naad, op het breedste punt), zodat de lamp helemaal dicht is. Losdraaien om de lamp te wisselen. Niet samen met kap in lagen of lamellen.',
    },
    { type: 'select', key: 'closedShape', label: 'Vorm tweede kap', options: CLOSED_SHAPES, default: 'spiegel', show: on, help: 'Onder de kap bij een hanglamp, erop bij een tafellamp.' },
    { type: 'number', key: 'closedH', label: 'Hoogte tweede kap', min: 30, max: 300, step: 1, unit: 'mm', default: 120, show: (p) => on(p) && str(p, 'closedShape') !== 'spiegel' },
    { type: 'bool', key: 'centerBulb', label: 'Lamp in het midden', default: true, show: on, help: 'De naad ligt ter hoogte van het midden van de lamp; de hoogte van de kap past zich daaraan aan.' },
    { type: 'number', key: 'seamPlay', label: 'Speling naad', min: 0.2, max: 1, step: 0.05, unit: 'mm', default: 0.5, show: on, help: 'Ruimte in de schroefdraad van de naad. Grote ronde delen zijn nooit helemaal rond: liever iets ruimer.' },
    { type: 'bool', key: 'vents', label: 'Ventilatiegaatjes', default: true, show: on, help: 'Kleine gaatjes boven (warme lucht eruit) en onder (koele lucht erin). Alleen LED-lampen in een dichte lamp.' },
  ];
}

export interface ClosedSetup {
  shape: string;
  H: number;
  center: boolean;
  c: number;
  vents: boolean;
}

export function closedOf(p: Params): ClosedSetup | null {
  if (!bool(p, 'closed')) return null;
  const shape = CLOSED_SHAPES.some((o) => o.value === str(p, 'closedShape')) ? str(p, 'closedShape') : 'spiegel';
  return {
    shape,
    H: clamp(Number.isFinite(num(p, 'closedH')) ? num(p, 'closedH') : 120, 20, 400),
    center: p.centerBulb === undefined ? true : bool(p, 'centerBulb'),
    c: clamp(Number.isFinite(num(p, 'seamPlay')) ? num(p, 'seamPlay') : 0.5, 0.15, 1.2),
    vents: p.vents === undefined ? true : bool(p, 'vents'),
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
