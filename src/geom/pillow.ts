import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, clamp, fromArrays } from './helpers';

/**
 * Soft, "inflated" solids over a star-shaped outline. The outline is sampled
 * on N rays from the origin; a polar grid of rings inside it carries the
 * distance to the outline, so tops can be shaped as a function of that
 * distance (pillows, rounded rims, 45° chamfers) and undersides as a function
 * of the radius (cones that print without support). The mesh is a height
 * field over the grid, so it is always a valid closed solid.
 */

interface RawPolygons {
  size(): number;
  get(i: number): { size(): number; get(j: number): { x: number; y: number }; delete(): void };
  delete(): void;
}

/**
 * Contours of a cross-section. Same as `cs.toPolygons()`, but that wrapper in
 * manifold-3d 3.5 never frees its per-contour vectors and leaks WASM memory.
 */
export function contoursOf(cs: CrossSection): [number, number][][] {
  const vec = (cs as unknown as { _ToPolygons(): RawPolygons })._ToPolygons();
  const out: [number, number][][] = [];
  for (let i = 0; i < vec.size(); i++) {
    const v = vec.get(i);
    const poly: [number, number][] = [];
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

/**
 * Radii of the outer envelope of a cross-section (seen from the origin) on N
 * equal angles: per ray the farthest crossing with any contour edge. Each edge
 * only visits the rays inside its own angular span, so this stays fast for
 * contours with thousands of points.
 */
export function radiiOf(cs: CrossSection, N: number): number[] {
  const out = new Array<number>(N).fill(0);
  const step = TAU / N;
  for (const poly of contoursOf(cs))
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      let ta = Math.atan2(ay, ax);
      let tb = Math.atan2(by, bx);
      // walk the shorter way round from a to b
      let span = tb - ta;
      if (span > Math.PI) span -= TAU;
      if (span < -Math.PI) span += TAU;
      if (span < 0) {
        [ta, tb] = [tb, ta];
        span = -span;
      }
      const j0 = Math.ceil(ta / step - 1e-9);
      const j1 = Math.floor((ta + span) / step + 1e-9);
      const ex = bx - ax;
      const ey = by - ay;
      for (let j = j0; j <= j1; j++) {
        const th = j * step;
        const ux = Math.cos(th);
        const uy = Math.sin(th);
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (ax * ey - ay * ex) / den;
        const jj = ((j % N) + N) % N;
        if (t > out[jj]) out[jj] = t;
      }
    }
  // rays that hit nothing (custom drawings that leave the origin outside) keep a small radius
  const max = Math.max(...out);
  return out.map((r) => Math.max(r, 0.1 * max));
}

/** Rings at fractions of the outline radius, dense towards the outline (where rims bend). */
export function edgeRings(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 1 - (1 - (i + 1) / n) ** 2);
}

/** Evenly spaced rings plus extra rings packed around `focus` fractions (sharp bends inside). */
export function focusRings(n: number, focus: number[], spread = 0.06, extra = 12): number[] {
  const all = Array.from({ length: n }, (_, i) => (i + 1) / n);
  for (const f of focus)
    for (let k = -extra; k <= extra; k++) {
      const t = k / extra;
      all.push(f + spread * Math.sign(t) * t * t);
    }
  const sorted = all.filter((s) => s > 1e-3 && s <= 1).sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of sorted) if (!out.length || s - out[out.length - 1] > 2e-3) out.push(s);
  out[out.length - 1] = 1;
  return out;
}

export interface PolarGrid {
  N: number;
  /** Ring positions as a fraction of the outline radius (ascending, last = 1). */
  s: number[];
  /** Outline radius on each ray. */
  R: number[];
  /** Grid points: index 0 is the centre, then ring by ring (k = 1 + i·N + j). */
  x: Float64Array;
  y: Float64Array;
  rho: Float64Array;
  /** Distance to the outline in mm. */
  d: Float64Array;
  /** Largest distance to the outline (radius of the largest inscribed circle). */
  dMax: number;
  /** Farthest point of the outline. */
  rMax: number;
}

export function polarGrid(R: number[], s: number[]): PolarGrid {
  const N = R.length;
  const n = 1 + s.length * N;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const rho = new Float64Array(n);
  const d = new Float64Array(n);
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const th = (TAU * j) / N;
    px[j] = R[j] * Math.cos(th);
    py[j] = R[j] * Math.sin(th);
  }
  for (let i = 0; i < s.length; i++)
    for (let j = 0; j < N; j++) {
      const k = 1 + i * N + j;
      x[k] = px[j] * s[i];
      y[k] = py[j] * s[i];
      rho[k] = R[j] * s[i];
    }
  // distance to the outline polygon (brute force; a few million segment tests)
  const ex = new Float64Array(N);
  const ey = new Float64Array(N);
  const el = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const j1 = (j + 1) % N;
    ex[j] = px[j1] - px[j];
    ey[j] = py[j1] - py[j];
    el[j] = ex[j] * ex[j] + ey[j] * ey[j] || 1e-12;
  }
  let dMax = 0;
  for (let k = 0; k < n; k++) {
    const qx = x[k];
    const qy = y[k];
    let best = Infinity;
    for (let j = 0; j < N; j++) {
      const ax = qx - px[j];
      const ay = qy - py[j];
      let t = (ax * ex[j] + ay * ey[j]) / el[j];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ax - t * ex[j];
      const dy = ay - t * ey[j];
      const dd = dx * dx + dy * dy;
      if (dd < best) best = dd;
    }
    d[k] = Math.sqrt(best);
    if (d[k] > dMax) dMax = d[k];
  }
  // boundary points lie on the outline
  for (let j = 0; j < N; j++) d[1 + (s.length - 1) * N + j] = 0;
  return { N, s, R, x, y, rho, d, dMax, rMax: Math.max(...R) };
}

/**
 * Closed solid between a bottom and a top height field over the grid,
 * with a vertical wall along the outline. `top(k)` must stay above `bottom(k)`
 * (it is kept at least `minGap` higher). The bottom only uses the rings that
 * `bottomEvery` mm apart (plus the last few), which is plenty for cones and planes.
 */
export function gridSolid(M: ManifoldToplevel, g: PolarGrid, top: (k: number) => number, bottom: (k: number) => number, opts: { minGap?: number; bottomEvery?: number; bottomEdge?: number } = {}): Manifold {
  const { N, s } = g;
  const minGap = opts.minGap ?? 0.2;
  const n = 1 + s.length * N;
  // rings used by the bottom surface
  const every = opts.bottomEvery ?? 1.2;
  const edge = opts.bottomEdge ?? 2;
  const low: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const last = low.length ? s[low[low.length - 1]] : 0;
    if (i === s.length - 1 || (s[i] - last) * g.rMax >= every || (1 - s[i]) * g.rMax < edge) low.push(i);
  }
  const pos = new Float32Array(n * 6);
  for (let k = 0; k < n; k++) {
    const zb = bottom(k);
    const zt = Math.max(top(k), zb + minGap);
    pos[k * 3] = g.x[k];
    pos[k * 3 + 1] = g.y[k];
    pos[k * 3 + 2] = zt;
    pos[(n + k) * 3] = g.x[k];
    pos[(n + k) * 3 + 1] = g.y[k];
    pos[(n + k) * 3 + 2] = zb;
  }
  const idx: number[] = [];
  const ring = (i: number, j: number) => 1 + i * N + (j % N);
  const surface = (off: number, up: boolean, rs: number[]) => {
    for (let j = 0; j < N; j++) {
      const a = off + ring(rs[0], j);
      const b = off + ring(rs[0], j + 1);
      if (up) idx.push(off, a, b);
      else idx.push(off, b, a);
    }
    for (let q = 0; q < rs.length - 1; q++)
      for (let j = 0; j < N; j++) {
        const a = off + ring(rs[q], j);
        const b = off + ring(rs[q], j + 1);
        const c = off + ring(rs[q + 1], j + 1);
        const d = off + ring(rs[q + 1], j);
        if (up) idx.push(a, d, c, a, c, b);
        else idx.push(a, c, d, a, b, c);
      }
  };
  surface(0, true, s.map((_, i) => i));
  surface(n, false, low);
  const last = s.length - 1;
  for (let j = 0; j < N; j++) {
    const t0 = ring(last, j);
    const t1 = ring(last, j + 1);
    idx.push(n + t0, n + t1, t1, n + t0, t1, t0);
  }
  // drop the bottom vertices no triangle uses (Manifold requires none)
  const used = new Uint8Array(2 * n);
  for (const v of idx) used[v] = 1;
  const remap = new Int32Array(2 * n);
  let m = 0;
  for (let v = 0; v < 2 * n; v++) remap[v] = used[v] ? m++ : -1;
  const pos2 = new Float32Array(m * 3);
  for (let v = 0; v < 2 * n; v++)
    if (used[v]) {
      const t = remap[v] * 3;
      pos2[t] = pos[v * 3];
      pos2[t + 1] = pos[v * 3 + 1];
      pos2[t + 2] = pos[v * 3 + 2];
    }
  return fromArrays(M, pos2, Uint32Array.from(idx, (v) => remap[v]));
}

/** Quarter-ellipse rise: 0 at u = 0 (vertical tangent), 1 at u ≥ 1. */
export const rise = (u: number) => {
  const w = 1 - clamp(u, 0, 1);
  return Math.sqrt(Math.max(0, 1 - w * w));
};

/**
 * Height of a soft top above the bottom of a head of thickness `th`, as a
 * function of the distance to the outline. `puff` 0 gives a flat top with a
 * rounded rim of radius `edge`; 1 a full cushion. With `flat` (printed top
 * down) the shoulder that would overhang more than 45° becomes a 45° chamfer.
 */
export function cushion(o: { th: number; puff: number; edge: number; dMax: number; flat: boolean; side?: number }): (d: number) => number {
  const side = Math.min(o.side ?? 1.2, o.th * 0.3);
  const puff = o.flat ? 0 : clamp(o.puff, 0, 1);
  const e = clamp(o.edge, 0.4, Math.max(0.4, Math.min(o.dMax * 0.95, o.th - side)));
  const L = e + (Math.max(e, o.dMax) - e) * puff;
  const A = Math.min(o.th - side, e + (o.th - side - e) * puff);
  const zs = o.th - A;
  const base = (d: number) => zs + A * rise(d / L);
  if (!o.flat) return base;
  // the rim slope dz/dd equals 1 at w = 1/√(1 + (A/L)²)
  const w = 1 / Math.sqrt(1 + (A / L) ** 2);
  const d45 = (1 - w) * L;
  const z45 = base(d45);
  return (d) => (d <= d45 ? base(d) : Math.min(o.th, z45 + (d - d45)));
}
