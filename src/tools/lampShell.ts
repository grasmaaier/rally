import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, smoothstep } from '../geom/helpers';
import { ROUND, sampleRange, simplifySamples, type LathePattern, type LatheSample } from '../geom/lathe';
import { gridSolid, type ShadeGrid } from '../geom/shade';
import { patternFor, ringFactor, shapeRadius, type SegSpec } from './lampParts';

// ---------------------------------------------------------------------------
// Hollow decorative segments for the printed screw tube: thin shells, open at
// both ends, with a uniform wall (textures included: the inner wall follows
// the outer one), closed by the threaded discs or by a solid neighbour.
// Every wall leans at most 45° in both directions, so the shell prints either
// way up without support — also as a single spiral wall in vase mode.

/** Shapes that become shells; flat or non-round ones (bloem, tandwiel, schijf) and the neck stay solid. */
export const SHELL_SHAPES = new Set(['bol', 'kussen', 'cilinder', 'tol', 'diabolo', 'kegel', 'koepel', 'boog', 'trap']);

const DZ = 0.25;
/** Vertex budget per shell (outer + inner). */
const BUDGET = 200000;

export interface ShellHub {
  /** Stack face (0 = bottom, 1 = top) where a disc hub reaches into the shell. */
  face: 0 | 1;
  /** Room needed around the hub (inner radius). */
  r: number;
  len: number;
}

export interface ShellNeeds {
  /** Smallest inner radius anywhere (clear of the tube). */
  inMin: number;
  hubs: ShellHub[];
}

export interface ShellProfile {
  /** Stack coordinates (z = 0 at the bottom of the segment as it stands). */
  zs: number[];
  /** Outer radius at the pattern maximum. */
  o: number[];
  wall: number;
  pattern: LathePattern;
  /** Weight of the vertical texture (fades out at the rims over `fade` mm). */
  tex: (z: number) => number;
  fade: number;
  H: number;
  /** Largest radius against the design (< 1 = narrowed for the 45° walls). */
  shrunk: number;
  /** Rim radii (outer, inner) at the bottom and top. */
  rims: [{ ro: number; ri: number }, { ro: number; ri: number }];
  /** Rims made wider than the shape for the tube or a disc hub (mm). */
  grown: [number, number];
}

/** Largest relative slope of the pattern around (|dr/dθ| / r), one-sided. */
function patternSlope(p: LathePattern) {
  let m = 0;
  const d = TAU / p.segs;
  for (let j = 0; j < p.segs; j++) {
    const a = p.fn(j * d);
    const b = p.fn(((j + 1) % p.segs) * d);
    m = Math.max(m, Math.abs(b - a) / d / Math.max(0.2, Math.min(a, b)));
  }
  return m;
}

/** 1-Lipschitz upper limit: no point more than 45° (`slope`) above any other (both directions). */
function limitBoth(v: number[], zs: number[], slope = 1) {
  for (let k = 1; k < v.length; k++) v[k] = Math.min(v[k], v[k - 1] + slope * (zs[k] - zs[k - 1]));
  for (let k = v.length - 2; k >= 0; k--) v[k] = Math.min(v[k], v[k + 1] + slope * (zs[k + 1] - zs[k]));
}

/** 1-Lipschitz lower limit (spreads a floor at 45°). */
function spreadFloor(v: number[], zs: number[], slope = 1) {
  for (let k = 1; k < v.length; k++) v[k] = Math.max(v[k], v[k - 1] - slope * (zs[k] - zs[k - 1]));
  for (let k = v.length - 2; k >= 0; k--) v[k] = Math.max(v[k], v[k + 1] - slope * (zs[k + 1] - zs[k]));
}

/**
 * Profile of a shell segment (world orientation, z = 0 at its bottom). The
 * shape is narrowed where it would lean more than 45°, and widened where the
 * tube or a disc hub needs room inside (the rims grow, never the middle).
 */
export function shellProfile(spec: SegSpec, texDepth: number, wall: number, needs: ShellNeeds): ShellProfile {
  const H = spec.H;
  const R = spec.D / 2;
  const raw = shapeRadius(spec);
  const ring = ringFactor(spec, texDepth, R);
  const pattern = spec.tex === 'plisse' || spec.tex === 'ribbels' ? patternFor({ ...spec, shape: 'cilinder' }, texDepth) : { ...ROUND, segs: Math.round(clamp((TAU * R) / 1.4, 96, 360)) };
  const zs = sampleRange(0, H, DZ, () => ({ o: 0, i: 0, tex: 0, wall: 0 })).map((q) => q.z);
  const o = zs.map((z) => raw(spec.flip ? H - z : z) * ring(z));
  const designed = Math.max(...o);
  limitBoth(o, zs);
  // room inside: tube everywhere, disc hubs near the rims (with the wall square to a 45° face and the pattern's valleys)
  const sec = Math.min(3, Math.sqrt(2 + patternSlope(pattern) ** 2));
  const fmin = pattern.min;
  const margin = pattern.min < 1 ? 0.4 : 0;
  const floor = zs.map((z) => {
    let need = needs.inMin;
    for (const h of needs.hubs) {
      const d = h.face === 0 ? z : H - z;
      if (d <= h.len + 0.5) need = Math.max(need, h.r);
    }
    return (need + wall * sec + margin) / fmin;
  });
  spreadFloor(floor, zs);
  const before = [o[0], o[o.length - 1]];
  for (let k = 0; k < o.length; k++) o[k] = Math.max(o[k], floor[k]);
  // the vertical texture fades out at the rims, so the discs close a round rim
  const fade = Math.max(3, 2 * texDepth);
  const tex = (z: number) => (fmin < 1 ? smoothstep(0, fade, Math.min(z, H - z)) : 0);
  const rim = (k: number) => ({ ro: o[k], ri: o[k] - wall * Math.min(2, Math.sqrt(1 + slopeAt(o, zs, k) ** 2)) });
  return {
    zs,
    o,
    wall,
    pattern,
    tex,
    fade,
    H,
    shrunk: Math.max(...o) / designed,
    rims: [rim(0), rim(o.length - 1)],
    grown: [o[0] - before[0], o[o.length - 1] - before[1]],
  };
}

function slopeAt(o: number[], zs: number[], k: number, win = 1) {
  let a = k;
  let b = k;
  while (a > 0 && zs[k] - zs[a] < win) a--;
  while (b < o.length - 1 && zs[b] - zs[k] < win) b++;
  return zs[b] > zs[a] ? (o[b] - o[a]) / (zs[b] - zs[a]) : 0;
}

/** Round envelope as lathe samples in stack coordinates (outer max, inner min), for clearance checks and outlines. */
export function shellSamples(p: ShellProfile): LatheSample[] {
  return p.zs.map((z, k) => ({ z, o: p.o[k], i: Math.max(0.5, p.o[k] * p.pattern.min - p.wall * 2), tex: 0, wall: p.wall }));
}

/** Material volume (mm³) of the same shape as a solid segment around a bore, for the filament comparison. */
export function solidVolume(p: ShellProfile, bore: number): number {
  let v = 0;
  for (let k = 0; k < p.zs.length - 1; k++) {
    const a = p.o[k] ** 2 - bore * bore;
    const b = p.o[k + 1] ** 2 - bore * bore;
    v += (Math.PI * (a + b) * (p.zs[k + 1] - p.zs[k])) / 2;
  }
  return v;
}

/**
 * Inner radius at every ring of one column: the outer polyline (zs, o) eroded
 * by a disc of radius w (an exact offset square to the wall: 45° flanks get
 * w·√2 radially, inward V's an arc, outward corners a sharp corner).
 */
function erode(zs: ArrayLike<number>, o: (k: number) => number, w: (k: number) => number, K: number, out: Float64Array, stride: number, off: number) {
  for (let k = 0; k < K; k++) {
    const zk = zs[k];
    const wk = w(k);
    let best = o(k) - wk;
    // segments within reach on both sides
    for (let m = k; m > 0 && zk - zs[m] < wk; m--) best = Math.min(best, segMin(zs[m - 1], o(m - 1), zs[m], o(m), zk, wk));
    for (let m = k; m < K - 1 && zs[m] - zk < wk; m++) best = Math.min(best, segMin(zs[m], o(m), zs[m + 1], o(m + 1), zk, wk));
    out[k * stride + off] = best;
  }
}

/** Smallest o(z') − √(w² − (z' − zk)²) over a straight piece of the outer wall. */
function segMin(za: number, oa: number, zb: number, ob: number, zk: number, w: number) {
  const lo = Math.max(za, zk - w);
  const hi = Math.min(zb, zk + w);
  if (hi < lo) return Infinity;
  const s = zb > za ? (ob - oa) / (zb - za) : 0;
  const f = (z: number) => oa + s * (z - za) - Math.sqrt(Math.max(0, w * w - (z - zk) ** 2));
  const star = clamp(zk - (s * w) / Math.sqrt(1 + s * s), lo, hi);
  return Math.min(f(lo), f(hi), f(star));
}

/**
 * Mesh grid of a shell in print orientation (`flipped`: printed upside down).
 * Outer = envelope × pattern; every column keeps its walls within 45° both
 * ways; inner = the outer wall offset by the wall thickness (square to the
 * wall, also across the pleats), never closer to the axis than `needIn(z)`
 * (stack z).
 */
export function shellGrid(p: ShellProfile, flipped: boolean, needIn: (z: number) => number): ShadeGrid {
  const H = p.H;
  let tol = 0.02;
  const samples: LatheSample[] = p.zs.map((z, k) => ({ z, o: p.o[k], i: 0, tex: p.tex(z), wall: p.wall }));
  let segs = p.pattern.segs;
  const w = p.wall;
  const pick = () => {
    const kinks = simplifySamples(samples, tol).map((q) => q.z);
    const keep = [...kinks];
    // rings beside every bend so the offset inner wall (arcs in the hollows) is represented
    for (const z of kinks) for (const d of [-w, -w / 2, w / 2, w]) if (z + d > 0 && z + d < H) keep.push(z + d);
    // dense rings where the texture fades in and out
    if (p.pattern.min < 1) for (const z of p.zs) if (z < p.fade + 1 || H - z < p.fade + 1) keep.push(z);
    keep.sort((a, b) => a - b);
    const out: number[] = [];
    for (const z of keep) if (!out.length || z - out[out.length - 1] > 0.05) out.push(z);
    out[out.length - 1] = H;
    out[0] = 0;
    return out;
  };
  let zs = pick();
  while (2 * zs.length * segs > BUDGET && tol < 0.6) {
    tol *= 1.6;
    zs = pick();
  }
  if (2 * zs.length * segs > BUDGET) segs = Math.max(48, Math.floor(BUDGET / (2 * zs.length)));
  // print coordinates (ascending)
  const pz = flipped ? zs.map((z) => H - z).reverse() : zs;
  const stackZ = (k: number) => (flipped ? H - pz[k] : pz[k]);
  const K = pz.length;
  const env = (z: number) => {
    let lo = 0;
    let hi = p.zs.length - 1;
    if (z <= p.zs[0]) return p.o[0];
    if (z >= p.zs[hi]) return p.o[hi];
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p.zs[m] <= z) lo = m;
      else hi = m;
    }
    const t = (z - p.zs[lo]) / (p.zs[hi] - p.zs[lo]);
    return p.o[lo] + (p.o[hi] - p.o[lo]) * t;
  };
  const fac = Array.from({ length: segs }, (_, j) => p.pattern.fn((TAU * j) / segs));
  const o = new Float64Array(K * segs);
  const inn = new Float64Array(K * segs);
  for (let k = 0; k < K; k++) {
    const z = stackZ(k);
    const e = env(z);
    const t = p.tex(z);
    for (let j = 0; j < segs; j++) o[k * segs + j] = e * (1 - t * (1 - fac[j]));
  }
  // every column within 45° both ways (the fading texture adds a little slope)
  for (let k = 1; k < K; k++) {
    const st = pz[k] - pz[k - 1];
    for (let j = 0; j < segs; j++) o[k * segs + j] = Math.min(o[k * segs + j], o[(k - 1) * segs + j] + st);
  }
  for (let k = K - 2; k >= 0; k--) {
    const st = pz[k + 1] - pz[k];
    for (let j = 0; j < segs; j++) o[k * segs + j] = Math.min(o[k * segs + j], o[(k + 1) * segs + j] + st);
  }
  // the wall square to the pleats (steepest side around), then offset along the axis exactly
  const dth = TAU / segs;
  const wAt = new Float64Array(K * segs);
  for (let k = 0; k < K; k++)
    for (let j = 0; j < segs; j++) {
      const at = k * segs + j;
      const r = o[at];
      const jp = (j + 1) % segs;
      const jm = (j + segs - 1) % segs;
      const rt = Math.max(Math.abs(o[k * segs + jp] - r), Math.abs(r - o[k * segs + jm])) / dth / Math.max(r, 1);
      wAt[at] = w * clamp(Math.sqrt(1 + rt * rt), 1, 3);
    }
  for (let j = 0; j < segs; j++) erode(pz, (k) => o[k * segs + j], (k) => wAt[k * segs + j], K, inn, segs, j);
  for (let k = 0; k < K; k++) {
    const need = needIn(stackZ(k));
    for (let j = 0; j < segs; j++) inn[k * segs + j] = Math.max(need, inn[k * segs + j]);
  }
  // cavity roofs: in print orientation the inner wall never narrows faster than 45° going up
  for (let k = K - 2; k >= 0; k--) {
    const st = pz[k + 1] - pz[k];
    for (let j = 0; j < segs; j++) inn[k * segs + j] = Math.min(inn[k * segs + j], inn[(k + 1) * segs + j] + st);
  }
  for (let at = 0; at < inn.length; at++) inn[at] = Math.min(inn[at], o[at] - 0.3);
  return { z: pz, segs, o, i: inn, follow: pz.map(() => true) };
}

export function shellSolid(M: ManifoldToplevel, g: ShadeGrid): Manifold {
  return gridSolid(M, g);
}

/** Smallest inner radius of a grid per ring (for checks). */
export function gridInnerMin(g: ShadeGrid): number[] {
  return g.z.map((_, k) => {
    let m = Infinity;
    for (let j = 0; j < g.segs; j++) m = Math.min(m, g.i[k * g.segs + j]);
    return m;
  });
}
