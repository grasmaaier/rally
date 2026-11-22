import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, fromArrays } from './helpers';

/**
 * Printer-friendly screw threads for parts printed with the axis vertical: a
 * trapezoid profile with 45° flanks (90° included angle), so every overhang of
 * the thread is exactly 45°, with small flats on the crest and in the root.
 *
 * Threads are radial surfaces r(z, θ) sampled on horizontal rings (see
 * `wallSolid`): always watertight, no fragile booleans between helices.
 *
 * Helix coordinate: u = z − lead·θ/2π (right-handed: a ridge rises when θ
 * grows). The profile repeats every `pitch` in u with a crest centred on
 * u ≡ 0, and one turn advances the lead = starts × pitch, so a multi-start
 * thread is the same profile with more ridges around.
 */
export interface ThreadSpec {
  /** Distance between neighbouring ridges along the axis (mm). */
  pitch: number;
  starts: number;
  /** Radial depth of the profile (mm). */
  depth: number;
}

export const leadOf = (t: ThreadSpec) => t.pitch * t.starts;

/** Width of the flat on the crest and in the root (equal). */
export const flatOf = (t: ThreadSpec) => Math.max(0, (t.pitch - 2 * t.depth) / 2);

/** Distance from helix coordinate u to the nearest crest centre (0 … pitch/2). */
function crestDist(t: ThreadSpec, u: number) {
  const P = t.pitch;
  const w = ((u % P) + P) % P;
  return Math.min(w, P - w);
}

/** Helix coordinate of a point (z, θ) with the thread phase `phase` (mm along the axis). */
export const helixU = (t: ThreadSpec, z: number, th: number, phase = 0) => z - (leadOf(t) * th) / TAU - phase;

/** Radius of an external thread with major radius R at helix coordinate u. */
export function externalR(t: ThreadSpec, R: number, u: number): number {
  return clamp(R + flatOf(t) / 2 - crestDist(t, u), R - t.depth, R);
}

/**
 * Radius of the internal thread that mates with `externalR(t, R)` at a
 * clearance c: the external profile grown by c in every direction (miter
 * offset), so the gap is at least c everywhere — c on the crests and roots,
 * c along the normal of the flanks (c·√2 radially, also c·√2 axial play).
 */
export function internalR(t: ThreadSpec, R: number, c: number, u: number): number {
  return clamp(R + flatOf(t) / 2 - crestDist(t, u) + c * Math.SQRT2, R - t.depth + c, R + c);
}

/** Axial play of a nut on its thread (each way) for a radial clearance c. */
export const axialPlay = (c: number) => c * Math.SQRT2;

/**
 * External thread with lead-ins: within `depth` of an end the crests are cut
 * back at 45° (`dLo`/`dHi` = distance to the lower/upper end, Infinity = no
 * lead-in), so the thread starts without a feathered edge.
 */
export function externalTapered(t: ThreadSpec, R: number, u: number, dLo: number, dHi: number): number {
  const cut = R - t.depth - 0.2 + Math.min(dLo, dHi);
  return Math.min(externalR(t, R, u), cut);
}

/** Internal thread with 45° countersinks at the ends (distance to the lower/upper face). */
export function internalTapered(t: ThreadSpec, R: number, c: number, u: number, dLo: number, dHi: number, sink = 0.6): number {
  const open = R + c + sink - Math.min(dLo, dHi);
  return Math.max(internalR(t, R, c, u), open);
}

/**
 * Lead angle at the pitch diameter and whether the thread holds by itself
 * (lead angle below the friction angle of a 90° thread, μ' = μ / cos 45°).
 */
export function selfLocking(t: ThreadSpec, R: number, mu = 0.25) {
  const dp = 2 * R - t.depth;
  const lead = (Math.atan(leadOf(t) / (Math.PI * dp)) * 180) / Math.PI;
  const friction = (Math.atan(mu / Math.cos(Math.PI / 4)) * 180) / Math.PI;
  return { lead, friction, locks: lead < friction };
}

/** Segments around for a thread: the helix moves at most `du` per segment and chords stay short. */
export function threadSegs(t: ThreadSpec, R: number, du = 0.13, chord = 1.2) {
  const n = Math.max(leadOf(t) / du, (TAU * R) / chord, 48);
  return Math.min(720, Math.ceil(n / 8) * 8);
}

/** Evenly spaced heights from a to b (both included), about `dz` apart. */
export function heights(a: number, b: number, dz: number): number[] {
  if (b <= a) return [a];
  const n = Math.max(1, Math.ceil((b - a) / dz));
  return Array.from({ length: n + 1 }, (_, k) => (k === n ? b : a + ((b - a) * k) / n));
}

// ---------------------------------------------------------------------------
// Walls of radial surfaces on horizontal rings

export interface Ring {
  z: number;
  /** Radius at angle th (the same angles on every ring of a wall). */
  r: (th: number) => number;
}

export interface Wall {
  segs: number;
  /** Rings bottom to top; a repeated height makes a horizontal step. */
  rings: Ring[];
}

/** Rings of a radius function on a list of heights. */
export const ringsOf = (zs: number[], r: (z: number, th: number) => number): Ring[] => zs.map((z) => ({ z, r: (th) => r(z, th) }));

/** Merge sorted height lists (drops near-duplicates). */
export function mergeHeights(...lists: number[][]): number[] {
  const all = lists.flat().sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of all) if (!out.length || z - out[out.length - 1] > 1e-4) out.push(z);
  return out;
}

/** Annulus between two rings at the same height (both start at angle 0, CCW). */
function zipper(idx: number[], outer: number, nA: number, inner: number, nB: number, up: boolean) {
  let i = 0;
  let j = 0;
  while (i < nA || j < nB) {
    const a0 = outer + (i % nA);
    const b0 = inner + (j % nB);
    if (j >= nB || (i < nA && (i + 1) / nA < (j + 1) / nB)) {
      const a1 = outer + ((i + 1) % nA);
      if (up) idx.push(a0, a1, b0);
      else idx.push(a0, b0, a1);
      i++;
    } else {
      const b1 = inner + ((j + 1) % nB);
      if (up) idx.push(a0, b1, b0);
      else idx.push(a0, b0, b1);
      j++;
    }
  }
}

function fan(idx: number[], center: number, ring: number, segs: number, up: boolean) {
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    if (up) idx.push(center, ring + j, ring + j1);
    else idx.push(center, ring + j1, ring + j);
  }
}

/**
 * Body between an outer and an inner wall. Where the inner wall starts at the
 * height of the outer wall the end is an annulus; where it starts higher (or
 * ends lower) the end is closed (a floor / roof at the inner wall's end).
 * Without an inner wall the body is solid. The inner wall must stay inside
 * the outer wall.
 */
export function wallSolid(M: ManifoldToplevel, outer: Wall, inner: Wall | null): Manifold {
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (w: Wall) => {
    const start = pos.length / 3;
    const cs = Array.from({ length: w.segs }, (_, j) => Math.cos((TAU * j) / w.segs));
    const sn = Array.from({ length: w.segs }, (_, j) => Math.sin((TAU * j) / w.segs));
    for (const ring of w.rings)
      for (let j = 0; j < w.segs; j++) {
        const r = Math.max(0.05, ring.r((TAU * j) / w.segs));
        pos.push(r * cs[j], r * sn[j], ring.z);
      }
    return start;
  };
  const stitch = (first: number, w: Wall, inward: boolean) => {
    const S = w.segs;
    for (let k = 0; k < w.rings.length - 1; k++)
      for (let j = 0; j < S; j++) {
        const j1 = (j + 1) % S;
        const a = first + k * S + j;
        const b = first + k * S + j1;
        const c = first + (k + 1) * S + j1;
        const d = first + (k + 1) * S + j;
        if (inward) idx.push(a, c, b, a, d, c);
        else idx.push(a, b, c, a, c, d);
      }
  };
  const o = push(outer);
  stitch(o, outer, false);
  const oTop = o + (outer.rings.length - 1) * outer.segs;
  const z0 = outer.rings[0].z;
  const z1 = outer.rings[outer.rings.length - 1].z;
  if (!inner) {
    const c0 = pos.length / 3;
    pos.push(0, 0, z0, 0, 0, z1);
    fan(idx, c0, o, outer.segs, false);
    fan(idx, c0 + 1, oTop, outer.segs, true);
    return fromArrays(M, pos, idx);
  }
  const i = push(inner);
  stitch(i, inner, true);
  const iTop = i + (inner.rings.length - 1) * inner.segs;
  const zi0 = inner.rings[0].z;
  const zi1 = inner.rings[inner.rings.length - 1].z;
  if (zi0 > z0 + 1e-6) {
    const c = pos.length / 3;
    pos.push(0, 0, z0, 0, 0, zi0);
    fan(idx, c, o, outer.segs, false);
    fan(idx, c + 1, i, inner.segs, true);
  } else zipper(idx, o, outer.segs, i, inner.segs, false);
  if (zi1 < z1 - 1e-6) {
    const c = pos.length / 3;
    pos.push(0, 0, z1, 0, 0, zi1);
    fan(idx, c, oTop, outer.segs, true);
    fan(idx, c + 1, iTop, inner.segs, false);
  } else zipper(idx, oTop, outer.segs, iTop, inner.segs, true);
  return fromArrays(M, pos, idx);
}

/**
 * Smallest cavity radius that contains `need(z)` (cylinder zones) and prints
 * without support with the opening on the bed: going up a cavity may narrow
 * at most 45° (`slope`), so every roof becomes a cone.
 */
export function roofed(zs: number[], need: (z: number) => number, slope = 1): number[] {
  const out: number[] = [];
  for (let k = 0; k < zs.length; k++) {
    const want = need(zs[k]);
    out.push(k === 0 ? want : Math.max(want, out[k - 1] - slope * (zs[k] - zs[k - 1])));
  }
  return out;
}

/** Linear interpolation in a sampled function (zs ascending). */
export function interp(zs: number[], vs: number[], z: number): number {
  if (z <= zs[0]) return vs[0];
  const n = zs.length - 1;
  if (z >= zs[n]) return vs[n];
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (zs[m] <= z) lo = m;
    else hi = m;
  }
  const t = (z - zs[lo]) / Math.max(1e-12, zs[hi] - zs[lo]);
  return vs[lo] + (vs[hi] - vs[lo]) * t;
}
