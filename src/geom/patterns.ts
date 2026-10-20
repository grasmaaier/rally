/**
 * Organic 3D pattern fields for generative prints. Every field returns an
 * approximate signed distance in mm: negative = material.
 */
import { smin } from './sdf';

/** Integer hash of a lattice cell and seed → [0, 1). */
export function hash3(i: number, j: number, k: number, seed: number, salt = 0): number {
  let h = Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ Math.imul(k, 0xcb1ab31f) ^ Math.imul(seed + salt * 7919, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Gradient noise (Perlin-style, seeded), roughly in [-1, 1]

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad(i: number, j: number, k: number, seed: number, x: number, y: number, z: number) {
  const h = Math.floor(hash3(i, j, k, seed, 3) * 12);
  // the 12 cube-edge gradients
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

export function noise3(x: number, y: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const n000 = grad(i, j, k, seed, fx, fy, fz);
  const n100 = grad(i + 1, j, k, seed, fx - 1, fy, fz);
  const n010 = grad(i, j + 1, k, seed, fx, fy - 1, fz);
  const n110 = grad(i + 1, j + 1, k, seed, fx - 1, fy - 1, fz);
  const n001 = grad(i, j, k + 1, seed, fx, fy, fz - 1);
  const n101 = grad(i + 1, j, k + 1, seed, fx - 1, fy, fz - 1);
  const n011 = grad(i, j + 1, k + 1, seed, fx, fy - 1, fz - 1);
  const n111 = grad(i + 1, j + 1, k + 1, seed, fx - 1, fy - 1, fz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

// ---------------------------------------------------------------------------
// Voronoi (jittered grid of seeds, one per cell)

export interface VoronoiHit {
  /** Distance to the nearest cell wall (bisector plane). */
  e1: number;
  /** Distance to the second-nearest wall (small near cell edges). */
  e2: number;
  /** Distance to the third-nearest wall (small near the nodes where edges meet). */
  e3: number;
  /** Random value [0, 1) of the cell the point lies in. */
  cell: number;
}

const seedX = new Float64Array(27);
const seedY = new Float64Array(27);
const seedZ = new Float64Array(27);
const seedR = new Float64Array(27);

/** Walls of the Voronoi cells around p (cell size s). Reuses `out` to avoid garbage. */
export function voronoi(x: number, y: number, z: number, s: number, seed: number, out: VoronoiHit, jitter = 0.85): VoronoiHit {
  const gx = x / s, gy = y / s, gz = z / s;
  const ci = Math.floor(gx), cj = Math.floor(gy), ck = Math.floor(gz);
  let best = Infinity;
  let bi = 0;
  let n = 0;
  for (let dk = -1; dk <= 1; dk++)
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++, n++) {
        const i = ci + di, j = cj + dj, k = ck + dk;
        const sx = i + 0.5 + jitter * (hash3(i, j, k, seed, 0) - 0.5);
        const sy = j + 0.5 + jitter * (hash3(i, j, k, seed, 1) - 0.5);
        const sz = k + 0.5 + jitter * (hash3(i, j, k, seed, 2) - 0.5);
        seedX[n] = sx;
        seedY[n] = sy;
        seedZ[n] = sz;
        const d = (sx - gx) ** 2 + (sy - gy) ** 2 + (sz - gz) ** 2;
        seedR[n] = d;
        if (d < best) {
          best = d;
          bi = n;
        }
      }
  let e1 = Infinity;
  let e2 = Infinity;
  let e3 = Infinity;
  const ax = seedX[bi], ay = seedY[bi], az = seedZ[bi];
  for (let m = 0; m < 27; m++) {
    if (m === bi) continue;
    const dx = seedX[m] - ax, dy = seedY[m] - ay, dz = seedZ[m] - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // distance from p to the bisector plane between the nearest seed and seed m
    const e = (seedR[m] - best) / (2 * len);
    if (e < e1) {
      e3 = e2;
      e2 = e1;
      e1 = e;
    } else if (e < e2) {
      e3 = e2;
      e2 = e;
    } else if (e < e3) e3 = e;
  }
  out.e1 = e1 * s;
  out.e2 = e2 * s;
  out.e3 = e3 * s;
  const bk = Math.floor(bi / 9), bj = Math.floor(bi / 3) % 3, bii = bi % 3;
  out.cell = hash3(ci + bii - 1, cj + bj - 1, ck + bk - 1, seed, 5);
  return out;
}

// ---------------------------------------------------------------------------
// Pattern definitions

export type PatternKind = 'voronoi' | 'blobs' | 'gyroid';

export interface PatternOptions {
  kind: PatternKind;
  /** Cell size / period in mm. */
  cell: number;
  /** Strut / web width in mm. */
  strut: number;
  /** 0..1: how much the joints and hole corners are rounded. */
  smooth: number;
  /** 0..1: share of open area (blobs, lattice gyroid). */
  porosity: number;
  seed: number;
}

/**
 * A perforation pattern for thin shells: walls between holes (negative =
 * material). Used for covers, cages and perforated skins.
 */
export function surfacePattern(o: PatternOptions): (x: number, y: number, z: number) => number {
  const s = o.cell;
  const half = o.strut / 2;
  const hit: VoronoiHit = { e1: 0, e2: 0, e3: 0, cell: 0 };
  if (o.kind === 'gyroid') {
    const w = (2 * Math.PI) / s;
    // |∇g| is about 1.2·w on the surface: scale to mm
    const toMm = 1 / (1.2 * w);
    const t = half + (1 - o.porosity) * s * 0.12;
    return (x, y, z) => {
      const X = x * w, Y = y * w, Z = z * w;
      const g = Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X);
      return Math.abs(g) * toMm - t;
    };
  }
  if (o.kind === 'blobs') {
    // warped Voronoi: rounded, irregular holes with a guaranteed web width; some cells stay closed
    const amp = 0.28 * s;
    const f = 1.3 / s;
    const k = Math.max(0.05, o.smooth) * 0.6 * s;
    const open = 0.35 + 0.65 * o.porosity;
    return (x, y, z) => {
      const qx = x + amp * noise3(x * f, y * f, z * f, o.seed + 11);
      const qy = y + amp * noise3(x * f + 31.7, y * f, z * f, o.seed + 12);
      const qz = z + amp * noise3(x * f, y * f + 17.3, z * f, o.seed + 13);
      voronoi(qx, qy, qz, s, o.seed, hit, 1);
      if (hit.cell > open) return -half;
      const e = smin(hit.e1, hit.e2, k);
      // smaller holes in some cells
      const extra = (1 - o.porosity) * 0.22 * s * hash3(Math.floor(hit.cell * 1e6), 0, 0, o.seed, 9);
      return e - half - extra;
    };
  }
  const k = o.smooth * 0.35 * s;
  return (x, y, z) => {
    voronoi(x, y, z, s, o.seed, hit);
    return smin(hit.e1, hit.e2, k) - half;
  };
}

/**
 * A 3D strut/sheet network that fills space (negative = material): Voronoi
 * cell edges (bone-like struts), a gyroid sheet or noise blobs. Used for
 * solid lattices and organic stand bodies.
 */
export function volumePattern(o: PatternOptions): (x: number, y: number, z: number) => number {
  const s = o.cell;
  const half = o.strut / 2;
  const hit: VoronoiHit = { e1: 0, e2: 0, e3: 0, cell: 0 };
  if (o.kind === 'gyroid') {
    const w = (2 * Math.PI) / s;
    const toMm = 1 / (1.2 * w);
    const t = half + (1 - o.porosity) * s * 0.15;
    return (x, y, z) => {
      const X = x * w, Y = y * w, Z = z * w;
      const g = Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X);
      return Math.abs(g) * toMm - t;
    };
  }
  if (o.kind === 'blobs') {
    // a connected noise "sponge": material where the noise is below the threshold
    const f = 1 / s;
    const thr = 0.55 - 1.0 * o.porosity;
    const toMm = s * 0.45;
    return (x, y, z) => {
      const n = noise3(x * f, y * f, z * f, o.seed) + 0.5 * noise3(x * f * 2.1, y * f * 2.1, z * f * 2.1, o.seed + 1);
      return (n - thr) * toMm - half * 0.3;
    };
  }
  // thicker nodes where several struts meet (bone-like joints)
  const node = o.smooth * 0.5 * half;
  return (x, y, z) => {
    voronoi(x, y, z, s, o.seed, hit);
    // distance to the cell edge where the two nearest walls meet
    const edge = Math.hypot(hit.e1, hit.e2);
    return edge - half - node * Math.max(0, 1 - hit.e3 / (0.3 * s));
  };
}
