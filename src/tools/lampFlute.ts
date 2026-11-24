import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, fromArrays, lerp } from '../geom/helpers';
import type { LathePattern } from '../geom/lathe';

// ---------------------------------------------------------------------------
// Fluted ("ribbed glass") rings and sleeves: a circle with deep rounded
// grooves, like glass rods side by side. The flat ring is a solid lamp
// segment (the flutes are its outline); the sleeve (kap "geribbelde koker")
// is a straight extrusion with a uniform wall that follows the flutes (one
// wall line: vase mode), standing on a solid ceiling plate. Every wall is
// vertical, so both print without support.

export interface Flute {
  /** Flutes around. */
  n: number;
  /** Groove depth (mm) below the rib tops. */
  depth: number;
  /** Groove width as a fraction of the pitch (0.2 … 0.8). */
  groove: number;
  /** Rounding of the ribs (0 = sharp edges, 1 = round like glass rods). */
  round: number;
  /** Radius of the rib tops. */
  R: number;
}

/** Groove depth as a fraction of the radius for variant 0 % … 100 %. */
export const FLUTE_DEPTH: [number, number] = [0.03, 0.2];
/** Smallest pitch (mm) and smallest groove / rib width (two nozzle widths). */
const MIN_PITCH = 3;
const MIN_FEATURE = 1.2;
/** Samples per pitch of the profile. */
const K = 512;

export const fluteDepthFrac = (v: number) => lerp(FLUTE_DEPTH[0], FLUTE_DEPTH[1], clamp(v, 0, 1));

/**
 * Flutes of a ring or sleeve with rib radius R. `v` (0…1) sets the depth,
 * `groove` (0…1) the groove share of the pitch, `round` (0…1) the rounding of
 * the ribs. Too many flutes for the size are reduced (with a note).
 */
export function fluteOf(R: number, v: number, n: number, groove: number, round: number, notes?: string[], name?: string, even = false): Flute {
  const most = Math.max(6, Math.floor((TAU * R) / MIN_PITCH));
  const asked = Math.round(Number.isFinite(n) ? n : 24);
  let N = clamp(asked, 6, most);
  const odd = even && N % 2 === 1;
  if (odd) N = N + 1 <= most ? N + 1 : N - 1;
  if (notes && N !== asked) {
    const why = asked > most ? 'meer passen er niet op deze diameter' : odd ? 'een even aantal voor de gekartelde rand' : 'minstens 6';
    notes.push(`${name ?? 'Geribbeld'}: ${N} ribben (i.p.v. ${asked}) — ${why}.`);
  }
  const p = (TAU * R) / N;
  // grooves and ribs both at least two nozzle widths wide
  const g = clamp(Number.isFinite(groove) ? groove : 0.5, Math.max(0.2, MIN_FEATURE / p), Math.min(0.8, 1 - MIN_FEATURE / p));
  return { n: N, depth: fluteDepthFrac(v) * R, groove: Number.isFinite(g) ? g : 0.5, round: clamp(Number.isFinite(round) ? round : 0.6, 0, 1), R };
}

const cache = new Map<string, Float64Array>();

/**
 * Groove depth over one pitch (K samples, arc length at the rib radius; the
 * groove is centred at 0): a U-shaped groove (round bottom), then the ribs
 * rounded by a morphological opening with a disc.
 */
export function fluteProfile(f: Flute): Float64Array {
  const key = `${f.n}|${f.depth.toFixed(4)}|${f.groove.toFixed(4)}|${f.round.toFixed(4)}|${f.R.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (TAU * f.R) / f.n;
  const dx = p / K;
  const a = (f.groove * p) / 2;
  const d = f.depth;
  const y = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    let x = k * dx;
    if (x > p / 2) x -= p;
    const ax = Math.abs(x);
    let h = 0;
    if (ax < a) {
      if (d >= a) h = d - a + Math.sqrt(Math.max(0, a * a - ax * ax));
      else {
        const rho = (a * a + d * d) / (2 * d);
        h = d - rho + Math.sqrt(Math.max(0, rho * rho - ax * ax));
      }
    }
    y[k] = -h;
  }
  // round the ribs: opening of the material below y with a disc of radius rr
  const rr = f.round * Math.min((p - 2 * a) / 2, d);
  const J = Math.floor(rr / dx);
  if (J >= 2) {
    const disc = Array.from({ length: J + 1 }, (_, j) => Math.sqrt(Math.max(0, rr * rr - (j * dx) ** 2)));
    const at = (arr: Float64Array, k: number) => arr[((k % K) + K) % K];
    const c = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      let m = Infinity;
      for (let j = -J; j <= J; j++) m = Math.min(m, at(y, k + j) - disc[Math.abs(j)]);
      c[k] = m;
    }
    for (let k = 0; k < K; k++) {
      let m = -Infinity;
      for (let j = -J; j <= J; j++) m = Math.max(m, at(c, k + j) + disc[Math.abs(j)]);
      y[k] = Math.min(y[k], m);
    }
  }
  const out = new Float64Array(K);
  for (let k = 0; k < K; k++) out[k] = clamp(-y[k], 0, d);
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

/** Groove depth (mm) at angle th. */
export function fluteDepthAt(f: Flute, th: number): number {
  const prof = fluteProfile(f);
  const p = (TAU * f.R) / f.n;
  let u = ((((th * f.R) % p) + p) % p) / p;
  u *= K;
  const k = Math.floor(u);
  const t = u - k;
  return prof[k % K] * (1 - t) + prof[(k + 1) % K] * t;
}

/** Vertices around for a fluted outline. */
export const fluteSegs = (f: Flute) => f.n * clamp(Math.floor(3200 / f.n), 24, 96);

/** Radial factor around (rib tops = 1) as a lathe pattern for a solid fluted ring. */
export function flutePattern(f: Flute): LathePattern {
  const segs = fluteSegs(f);
  const fn = (th: number) => 1 - fluteDepthAt(f, th) / f.R;
  let min = 1;
  for (let j = 0; j < segs; j++) min = Math.min(min, fn((TAU * j) / segs));
  return { fn, segs, min };
}

/** Outline polygon (counter-clockwise). */
export function fluteOutline(f: Flute): [number, number][] {
  const S = fluteSegs(f);
  const pts: [number, number][] = [];
  for (let j = 0; j < S; j++) {
    const th = (TAU * j) / S;
    const r = f.R - fluteDepthAt(f, th);
    pts.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return pts;
}

/** The fluted wall of a sleeve in section: outline minus the outline offset inward by the wall (square to the wall everywhere). */
export function flutedBand(M: ManifoldToplevel, f: Flute, wall: number): CrossSection {
  const outer = M.CrossSection.ofPolygons([fluteOutline(f)]);
  const inner = outer.offset(-wall, 'Round', 2, 64).simplify(0.002);
  return outer.subtract(inner);
}

/** Smallest inner radius of a fluted sleeve (bottom of the grooves, minus the wall). */
export const sleeveInnerMin = (f: Flute, wall: number) => f.R - f.depth - wall;

export interface SleeveSpec {
  f: Flute;
  wall: number;
  /** Ceiling plate on the bed (print coordinates z ∈ [0, ceil]), bore radius. */
  ceil: number;
  bore: number;
  /** Top of the wall (the rim, print coordinates), the long ribs included. */
  top: number;
  /** Scalloped rim: every other rib longer by this much (0 = straight rim). */
  scallop: number;
}

/**
 * Fluted sleeve in print orientation: a round ceiling plate on the bed (45°
 * chamfer at the bed edge), the fluted wall standing on it up to the rim, open
 * at the top. A scalloped rim keeps every other rib `scallop` longer with a
 * round end — at the top while printing, so it needs no support.
 */
export function sleeveSolid(M: ManifoldToplevel, s: SleeveSpec): Manifold {
  const { f, ceil } = s;
  const segs = Math.round(clamp((TAU * f.R) / 1.2, 96, 720) / 8) * 8;
  const ch = Math.min(0.6, ceil / 3);
  const plate = M.Manifold.union([
    M.Manifold.cylinder(ch, f.R - ch, f.R, segs),
    M.Manifold.cylinder(ceil - ch + 0.005, f.R, f.R, segs).translate([0, 0, ch - 0.005]),
  ]).subtract(M.Manifold.cylinder(ceil + 2, s.bore, s.bore, 64).translate([0, 0, -1]));
  const wall = flutedBand(M, f, s.wall).extrude(s.top - ceil + 0.02).translate([0, 0, ceil - 0.02]);
  let solid = M.Manifold.union([plate, wall]);
  if (s.scallop > 0.2) solid = solid.subtract(scallopCutter(M, f, s.wall, s.top, s.scallop));
  return solid;
}

/** Top edge of the wall at angle th for a scalloped rim at `top` (print coordinates). */
export function scallopEdge(f: Flute, top: number, s: number, th: number): number {
  const p = (TAU * f.R) / f.n;
  const x = ((((th * f.R) % (2 * p)) + 2 * p) % (2 * p)) / p;
  // ribs run from groove centre to groove centre: odd ones are the long tongues
  if (x < 1) return top - s;
  const q = 2 * (x - 1) - 1;
  const a = Math.min(s, p / 2);
  return top - a + a * Math.sqrt(Math.max(0, 1 - q * q));
}

/** Cutter above the scalloped edge (a ring with a wavy underside). */
function scallopCutter(M: ManifoldToplevel, f: Flute, wall: number, top: number, s: number): Manifold {
  const S = 2 * f.n * clamp(Math.floor(2400 / f.n), 32, 96);
  const rIn = Math.max(1, f.R - f.depth - wall - 1.5);
  const rOut = f.R + 1.5;
  const zTop = top + 1;
  const pos = new Float32Array(S * 4 * 3);
  const idx = new Uint32Array(S * 8 * 3);
  let p = 0;
  for (let j = 0; j < S; j++) {
    const th = (TAU * j) / S;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const z = scallopEdge(f, top, s, th);
    for (const [r, zz] of [[rIn, z], [rOut, z], [rOut, zTop], [rIn, zTop]] as const) {
      pos[p++] = r * c;
      pos[p++] = r * sn;
      pos[p++] = zz;
    }
  }
  let q = 0;
  const quad = (a: number, b: number, c: number, d: number) => {
    idx[q++] = a;
    idx[q++] = b;
    idx[q++] = c;
    idx[q++] = a;
    idx[q++] = c;
    idx[q++] = d;
  };
  for (let j = 0; j < S; j++) {
    const a = 4 * j;
    const b = 4 * ((j + 1) % S);
    quad(a + 1, b + 1, b + 2, a + 2); // outside
    quad(a + 2, b + 2, b + 3, a + 3); // top
    quad(a + 3, b + 3, b, a); // inside
    quad(a, b, b + 1, a + 1); // underside (the wavy edge)
  }
  return fromArrays(M, pos, idx);
}

/** Length at each end of a hollow fluted segment where the grooves fill up to a round rim (45°). */
export const fluteFade = (f: Flute) => f.depth + 0.5;

/** Can a fluted ring of this height be hollow (fluted wall between two round rims, room for the tube inside)? */
export const flutedShellFits = (f: Flute, H: number, wall: number, needIn: number) => H >= 2 * fluteFade(f) + 4 && f.R - f.depth - wall >= needIn + 0.5;

/**
 * Hollow fluted ring for the printed tube, standing on one rim (print
 * orientation, z ∈ [0, H]): the fluted wall (inner side = the outline offset
 * by the wall) with the grooves filled by 45° cones toward both rims, so each
 * rim is a round ring that a disc centres in its groove. Every surface leans
 * at most 45° (vase mode: one wall line).
 */
export function flutedShellSolid(M: ManifoldToplevel, f: Flute, wall: number, H: number): Manifold {
  const segs = Math.round(clamp((TAU * f.R) / 1.2, 96, 720) / 8) * 8;
  const cs = M.CrossSection.ofPolygons([fluteOutline(f)]);
  const inner = cs.offset(-wall, 'Round', 2, 64).simplify(0.002);
  const fade = fluteFade(f);
  const lo = f.R - fade;
  const s2 = wall * Math.SQRT2;
  const outer = M.Manifold.union([
    cs.extrude(H),
    // the grooves fill toward the rims: cones from the full radius at the rim inward at 45°
    M.Manifold.cylinder(fade, f.R, lo, segs),
    M.Manifold.cylinder(fade, lo, f.R, segs).translate([0, 0, H - fade]),
  ]);
  const cavity = M.Manifold.union([
    inner.extrude(H + 2).translate([0, 0, -1]),
    // the same cones a wall (square to the 45° face) further in, past the rims
    M.Manifold.cylinder(fade + 1, f.R - s2 + 1, lo - s2, segs).translate([0, 0, -1]),
    M.Manifold.cylinder(fade + 1, lo - s2, f.R - s2 + 1, segs).translate([0, 0, H - fade]),
  ]);
  return outer.subtract(cavity);
}
