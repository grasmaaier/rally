import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, fromArrays } from './helpers';

/**
 * Parts turned around the Z axis with a pattern around (lamp segments, shades,
 * bases). A part is a list of samples bottom to top, each with an outer radius
 * (at the pattern maximum) and an inner radius (central bore or cavity). The
 * outer surface is `o(z) · (1 - tex(z) · (1 - sec(th)))`: `tex` fades the
 * pattern in and out (spigots stay round). The inner surface is round.
 */
export interface LatheSample {
  z: number;
  /** Outer radius at the pattern maximum. */
  o: number;
  /** Inner radius; Infinity = a cavity that follows the outer wall at `wall`. */
  i: number;
  /** Weight of the pattern (0 = plain round, 1 = full pattern). */
  tex: number;
  /** Minimal wall thickness between the inner and the outer surface. */
  wall: number;
  /** Patterned shades (see `shade.ts`): the inner wall follows the outer wall on this row. */
  follow?: boolean;
}

export interface LathePattern {
  /** Radial factor around (max 1). */
  fn: (th: number) => number;
  segs: number;
  /** Smallest value of `fn` on the vertex angles. */
  min: number;
}

export const ROUND: LathePattern = { fn: () => 1, segs: 96, min: 1 };

/** Mirror a profile top to bottom (z → top - z), keeping it ascending. */
export function mirrorSamples(s: LatheSample[]): LatheSample[] {
  const top = s[s.length - 1].z;
  const bottom = s[0].z;
  return s.map((q) => ({ ...q, z: top + bottom - q.z })).reverse();
}

/** Radius change per mm between two samples, over a window of about ±1 mm. */
function slopeAt(s: LatheSample[], k: number, win = 1) {
  let a = k;
  let b = k;
  while (a > 0 && s[k].z - s[a].z < win) a--;
  while (b < s.length - 1 && s[b].z - s[k].z < win) b++;
  const dz = s[b].z - s[a].z;
  return dz > 1e-9 ? Math.abs(s[b].o - s[a].o) / dz : 0;
}

/**
 * Make a profile (in print orientation, z up from the bed) print without
 * support:
 * - the outer wall never leans out more than `slope` (1 = 45°): faster
 *   growth is cut back to a 45° cone (spheres get a conical underside, steps a chamfer);
 * - a cavity never narrows faster than `slope` going up: its roof becomes a
 *   45° cone (material is only added, so walls never get thinner);
 * - the inner surface keeps `wall` from the pattern's deepest point, and is
 *   never smaller than `minInner` (the bore).
 */
export function printable(input: LatheSample[], pattern: LathePattern, minInner: number, slope = 1): LatheSample[] {
  const s = input.map((q) => ({ ...q }));
  const n = s.length;
  const f = s.map((q) => 1 - q.tex * (1 - pattern.min));
  // room for the bore and the wall, even in the pattern's valleys
  for (let k = 0; k < n; k++) s[k].o = Math.max(s[k].o, (minInner + s[k].wall + 0.5) / f[k]);
  // outer: limit the outward lean, at the peaks and in the valleys (the pattern may fade in)
  for (let k = 1; k < n; k++) {
    const step = slope * (s[k].z - s[k - 1].z);
    s[k].o = Math.min(s[k].o, s[k - 1].o + step, (s[k - 1].o * f[k - 1] + step) / f[k]);
  }
  // inner: at least `wall` inside the valleys, measured square to a leaning wall
  for (let k = 0; k < n; k++) {
    const sec = clamp(Math.sqrt(1 + slopeAt(s, k) ** 2), 1, 2);
    s[k].i = Math.min(s[k].i, s[k].o * f[k] - s[k].wall * sec);
  }
  // cavity roofs: never narrower than the layer above allows
  for (let k = n - 2; k >= 0; k--) s[k].i = Math.min(s[k].i, s[k + 1].i + slope * (s[k + 1].z - s[k].z));
  for (let k = 0; k < n; k++) s[k].i = Math.max(s[k].i, minInner);
  return s;
}

/**
 * Keep only the samples where the profile bends (within `tol` mm), plus every
 * change of the pattern weight.
 */
export function simplifySamples(s: LatheSample[], tol: number): LatheSample[] {
  const n = s.length;
  if (n <= 2) return s;
  const keep = [0];
  let a = 0;
  for (let i = 2; i < n; i++) {
    let bad = s[i - 1].tex !== s[a].tex || s[i].tex !== s[a].tex;
    for (let j = a + 1; j < i && !bad; j++) {
      const t = (s[j].z - s[a].z) / (s[i].z - s[a].z);
      const o = s[a].o + (s[i].o - s[a].o) * t;
      const r = s[a].i + (s[i].i - s[a].i) * t;
      if (Math.abs(o - s[j].o) > tol || Math.abs(r - s[j].i) > tol) bad = true;
    }
    if (bad) {
      a = i - 1;
      keep.push(a);
    }
  }
  keep.push(n - 1);
  return keep.map((k) => s[k]);
}

/**
 * Zip an outer and an inner ring at the same height into an annulus (both
 * start at angle 0 and run counter-clockwise). `up` = normal points to +Z.
 */
function zipper(idx: number[], outer: number, nA: number, inner: number, nB: number, up: boolean) {
  let i = 0;
  let j = 0;
  while (i < nA || j < nB) {
    const a0 = outer + (i % nA);
    const b0 = inner + (j % nB);
    const nextA = (i + 1) / nA;
    const nextB = (j + 1) / nB;
    if (j >= nB || (i < nA && nextA < nextB)) {
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

/** Vertex budget per part: keeps the preview interactive with eight segments. */
const BUDGET = 260000;

/**
 * Closed solid of a (printable) profile: patterned outer wall, round inner
 * wall, flat annuli at the bottom and top. The inner radius must stay below
 * the pattern's valleys (see `printable`).
 */
export function latheSolid(M: ManifoldToplevel, samples: LatheSample[], pattern: LathePattern): Manifold {
  let tol = 0.02;
  let rings = simplifySamples(samples, tol);
  const maxI = Math.max(...samples.map((q) => q.i));
  const nI = Math.round(clamp((TAU * maxI) / 1.6, 32, 256));
  while (rings.length * (pattern.segs + nI) > BUDGET && tol < 0.5) {
    tol *= 1.6;
    rings = simplifySamples(samples, tol);
  }
  const segs = pattern.segs;
  const pos: number[] = [];
  const fac = Array.from({ length: segs }, (_, j) => pattern.fn((TAU * j) / segs));
  const cs = Array.from({ length: segs }, (_, j) => Math.cos((TAU * j) / segs));
  const sn = Array.from({ length: segs }, (_, j) => Math.sin((TAU * j) / segs));
  for (const q of rings)
    for (let j = 0; j < segs; j++) {
      const r = q.o * (1 - q.tex * (1 - fac[j]));
      pos.push(r * cs[j], r * sn[j], q.z);
    }
  const innerStart = pos.length / 3;
  for (const q of rings)
    for (let j = 0; j < nI; j++) {
      const a = (TAU * j) / nI;
      pos.push(q.i * Math.cos(a), q.i * Math.sin(a), q.z);
    }
  const idx: number[] = [];
  const R = rings.length;
  for (let k = 0; k < R - 1; k++) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = k * segs + j;
      const b = k * segs + j1;
      const c = (k + 1) * segs + j1;
      const d = (k + 1) * segs + j;
      idx.push(a, b, c, a, c, d);
    }
    for (let j = 0; j < nI; j++) {
      const j1 = (j + 1) % nI;
      const a = innerStart + k * nI + j;
      const b = innerStart + k * nI + j1;
      const c = innerStart + (k + 1) * nI + j1;
      const d = innerStart + (k + 1) * nI + j;
      idx.push(a, c, b, a, d, c);
    }
  }
  zipper(idx, 0, segs, innerStart, nI, false);
  zipper(idx, (R - 1) * segs, segs, innerStart + (R - 1) * nI, nI, true);
  return fromArrays(M, pos, idx);
}

/** Volume between the inner and outer surface (round, at the pattern maximum) in mm³. */
export function latheVolume(s: LatheSample[], from = -Infinity, to = Infinity, which: 'solid' | 'inner' = 'solid') {
  let v = 0;
  for (let k = 0; k < s.length - 1; k++) {
    const z0 = Math.max(from, s[k].z);
    const z1 = Math.min(to, s[k + 1].z);
    if (z1 <= z0) continue;
    const a = which === 'solid' ? s[k].o ** 2 - s[k].i ** 2 : s[k].i ** 2;
    const b = which === 'solid' ? s[k + 1].o ** 2 - s[k + 1].i ** 2 : s[k + 1].i ** 2;
    v += (Math.PI * (a + b) * (z1 - z0)) / 2;
  }
  return v;
}

/** Linear interpolation of a sample field at height z (clamped to the ends). */
export function sampleAt(s: LatheSample[], z: number, key: 'o' | 'i'): number {
  if (z <= s[0].z) return s[0][key];
  for (let k = 0; k < s.length - 1; k++) {
    if (z <= s[k + 1].z) {
      const t = (z - s[k].z) / Math.max(1e-9, s[k + 1].z - s[k].z);
      return s[k][key] + (s[k + 1][key] - s[k][key]) * t;
    }
  }
  return s[s.length - 1][key];
}

/**
 * Samples of a radius function on [z0, z1] (both ends included), about `dz`
 * apart. `fn` returns the outer radius and optionally the inner radius.
 */
export function sampleRange(z0: number, z1: number, dz: number, fn: (z: number) => Omit<LatheSample, 'z'>): LatheSample[] {
  const n = Math.max(2, Math.ceil((z1 - z0) / dz) + 1);
  const out: LatheSample[] = [];
  for (let k = 0; k < n; k++) {
    const z = k === n - 1 ? z1 : z0 + ((z1 - z0) * k) / (n - 1);
    out.push({ z, ...fn(z) });
  }
  return out;
}
