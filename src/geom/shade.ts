import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, fromArrays } from './helpers';
import { simplifySamples, type LatheSample } from './lathe';

/**
 * Thin lamp shades with a pattern that depends on both height and angle
 * (helical waves, wavy rings, grids, dots). The profile comes from
 * `printable` samples in print orientation (z up from the bed); every vertex
 * of the outer and the inner surface gets its own radius:
 *
 * - outer = o(z) − tex(z) · relief(z, th)  (relief ≥ 0: the wall undulates inward)
 * - inner = outer − thick(z, th) · sec       on rows that follow the wall,
 *   the round sample radius elsewhere (ceilings, flanges).
 *
 * A final pass per column keeps it printable without support: the outer wall
 * never leans out faster than `slope`, a cavity never narrows faster than
 * `slope` going up (material is only removed outside / added inside).
 */
export interface ShadeField {
  /** Inward relief of the outer surface in mm (0 … maxRelief). */
  relief: (z: number, th: number) => number;
  /** Wall thickness in mm, measured square to the wall. */
  thick: (z: number, th: number) => number;
  segs: number;
  /** Ring spacing for the pattern (mm). */
  dz: number;
}

export interface ShadeGrid {
  z: number[];
  segs: number;
  /** Radii per ring (ring-major: ring k, vertex j at k * segs + j). */
  o: Float64Array;
  i: Float64Array;
  /** Rows where the inner wall follows the outer wall (not ceiling / flange). */
  follow: boolean[];
}

/** Vertex budget per shade (outer + inner). */
const BUDGET = 420000;

function interp(s: LatheSample[], z: number) {
  let lo = 0;
  let hi = s.length - 1;
  if (z <= s[0].z) return { o: s[0].o, i: s[0].i, tex: s[0].tex, follow: !!s[0].follow };
  if (z >= s[hi].z) return { o: s[hi].o, i: s[hi].i, tex: s[hi].tex, follow: !!s[hi].follow };
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (s[m].z <= z) lo = m;
    else hi = m;
  }
  const a = s[lo];
  const b = s[hi];
  const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
  if (t < 1e-6) return { o: a.o, i: a.i, tex: a.tex, follow: !!a.follow };
  if (t > 1 - 1e-6) return { o: b.o, i: b.i, tex: b.tex, follow: !!b.follow };
  return { o: a.o + (b.o - a.o) * t, i: a.i + (b.i - a.i) * t, tex: a.tex + (b.tex - a.tex) * t, follow: !!a.follow && !!b.follow };
}

/** Ring heights: the kinks of the profile plus an even grid for the pattern. */
function ringHeights(s: LatheSample[], dz: number): number[] {
  const z0 = s[0].z;
  const z1 = s[s.length - 1].z;
  const zs = simplifySamples(s, 0.04).map((q) => q.z);
  // every change of the follow flag must be a ring of its own
  for (let k = 1; k < s.length; k++) if (!!s[k].follow !== !!s[k - 1].follow) zs.push(s[k - 1].z, s[k].z);
  const n = Math.max(1, Math.ceil((z1 - z0) / dz));
  for (let k = 0; k <= n; k++) zs.push(z0 + ((z1 - z0) * k) / n);
  zs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of zs) if (!out.length || z - out[out.length - 1] > 0.005) out.push(z);
  out[out.length - 1] = z1;
  return out;
}

export function shadeGrid(samples: LatheSample[], f: ShadeField, minInner: number, slope = 1): ShadeGrid {
  let segs = Math.max(48, Math.round(f.segs));
  let dz = Math.max(0.2, f.dz);
  let z = ringHeights(samples, dz);
  while (2 * z.length * segs > BUDGET && dz < 3) {
    dz *= 1.25;
    z = ringHeights(samples, dz);
  }
  if (2 * z.length * segs > BUDGET) segs = Math.max(48, Math.floor(BUDGET / (2 * z.length)));
  const K = z.length;
  const o = new Float64Array(K * segs);
  const inn = new Float64Array(K * segs);
  const rows = z.map((zz) => interp(samples, zz));
  const ths = Array.from({ length: segs }, (_, j) => (TAU * j) / segs);
  for (let k = 0; k < K; k++) {
    const r = rows[k];
    for (let j = 0; j < segs; j++) o[k * segs + j] = Math.max(minInner + 0.6, r.o - (r.tex > 0 ? r.tex * f.relief(z[k], ths[j]) : 0));
  }
  // outer: no outward lean beyond `slope`
  for (let k = 1; k < K; k++) {
    const step = slope * (z[k] - z[k - 1]);
    for (let j = 0; j < segs; j++) o[k * segs + j] = Math.min(o[k * segs + j], o[(k - 1) * segs + j] + step);
  }
  // inner: follows the outer wall at the pattern's thickness, square to the surface
  for (let k = 0; k < K; k++) {
    const r = rows[k];
    const ka = Math.max(0, k - 1);
    const kb = Math.min(K - 1, k + 1);
    const dzk = Math.max(1e-6, z[kb] - z[ka]);
    for (let j = 0; j < segs; j++) {
      const at = k * segs + j;
      if (!r.follow) {
        inn[at] = r.i;
        continue;
      }
      const rr = o[at];
      const rz = (o[kb * segs + j] - o[ka * segs + j]) / dzk;
      const jp = (j + 1) % segs;
      const jm = (j + segs - 1) % segs;
      const rt = (o[k * segs + jp] - o[k * segs + jm]) / ((2 * TAU) / segs) / Math.max(rr, 1);
      const sec = clamp(Math.sqrt(1 + rz * rz + rt * rt), 1, 2);
      inn[at] = Math.min(rr - f.thick(z[k], ths[j]) * sec, rr - 0.4);
    }
  }
  // cavity roofs: never narrower than the ring above allows
  for (let k = K - 2; k >= 0; k--) {
    const step = slope * (z[k + 1] - z[k]);
    for (let j = 0; j < segs; j++) inn[k * segs + j] = Math.min(inn[k * segs + j], inn[(k + 1) * segs + j] + step);
  }
  for (let a = 0; a < inn.length; a++) inn[a] = Math.max(inn[a], minInner);
  return { z, segs, o, i: inn, follow: rows.map((r) => r.follow) };
}

/** Round envelope of a grid as lathe samples (largest outer, smallest inner radius per ring). */
export function gridEnvelope(g: ShadeGrid): LatheSample[] {
  return g.z.map((z, k) => {
    let o = 0;
    let i = Infinity;
    for (let j = 0; j < g.segs; j++) {
      o = Math.max(o, g.o[k * g.segs + j]);
      i = Math.min(i, g.i[k * g.segs + j]);
    }
    return { z, o, i, tex: 0, wall: 0, follow: g.follow[k] };
  });
}

/** Closed solid of a grid: outer and inner wall, flat annuli at the bottom and top. */
export function gridSolid(M: ManifoldToplevel, g: ShadeGrid): Manifold {
  const { segs, z } = g;
  const K = z.length;
  const pos = new Float32Array(2 * K * segs * 3);
  const cs = Array.from({ length: segs }, (_, j) => Math.cos((TAU * j) / segs));
  const sn = Array.from({ length: segs }, (_, j) => Math.sin((TAU * j) / segs));
  let p = 0;
  for (const src of [g.o, g.i])
    for (let k = 0; k < K; k++)
      for (let j = 0; j < segs; j++) {
        const r = src[k * segs + j];
        pos[p++] = r * cs[j];
        pos[p++] = r * sn[j];
        pos[p++] = z[k];
      }
  const inner = K * segs;
  const idx = new Uint32Array(((K - 1) * segs * 4 + 2 * segs * 2) * 3);
  let q = 0;
  const tri = (a: number, b: number, c: number) => {
    idx[q++] = a;
    idx[q++] = b;
    idx[q++] = c;
  };
  for (let k = 0; k < K - 1; k++)
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = k * segs + j;
      const b = k * segs + j1;
      const c = (k + 1) * segs + j1;
      const d = (k + 1) * segs + j;
      tri(a, b, c);
      tri(a, c, d);
      tri(inner + a, inner + c, inner + b);
      tri(inner + a, inner + d, inner + c);
    }
  const top = (K - 1) * segs;
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    // bottom (normal down)
    tri(j, inner + j1, j1);
    tri(j, inner + j, inner + j1);
    // top (normal up)
    tri(top + j, top + j1, inner + top + j1);
    tri(top + j, inner + top + j1, inner + top + j);
  }
  return fromArrays(M, pos, idx);
}
