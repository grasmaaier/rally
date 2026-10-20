/**
 * Generative organic prints around (or from) a reference body: perforated
 * covers/cages, branching stands and lattice versions of a model. Everything
 * is a signed-distance field (negative = material) meshed with manifold's
 * level set, so results are smooth, watertight and always manifold.
 */
import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { UserError } from '../core/types';
import { DistanceGrid, smax, smin, type Box3 } from './sdf';
import { SeedSet, hash3, surfacePattern, volumePattern, type PatternOptions } from './patterns';
import { applyM4, mul, rotX, rotY, rotZ, type M4 } from './helpers';
import { normalise, type BodyMesh } from './bodies';

export type Quality = 'draft' | 'normal' | 'fine';

/** Level-set samples per quality (≈ 0.5 µs each plus the field itself). */
const BUDGET: Record<Quality, number> = { draft: 0.45e6, normal: 1.2e6, fine: 2.6e6 };
const MIN_EDGE: Record<Quality, number> = { draft: 1.0, normal: 0.6, fine: 0.4 };
/** Hard cap on level-set samples: keeps a build at roughly 10 s or less. */
export const MAX_SAMPLES = 3.6e6;
const MAX_GRID_NODES = 2.5e6;
/** Smallest web/strut that prints reliably with a 0.4 mm nozzle. */
export const MIN_FEATURE = 1.2;

export const volumeOf = (b: Box3) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

/**
 * Pick the level-set edge length: fine enough for the thinnest feature,
 * coarse enough for the time budget. Throws a UserError when both cannot hold.
 */
export function chooseEdge(bounds: Box3, quality: Quality, feature: number) {
  const V = volumeOf(bounds);
  let edge = Math.max(MIN_EDGE[quality], Math.cbrt((2 * V) / BUDGET[quality]));
  const maxEdge = feature * (quality === 'draft' ? 0.85 : 0.7);
  const limited = edge > maxEdge;
  if (limited) edge = maxEdge;
  const samples = (2 * V) / edge ** 3;
  if (samples > MAX_SAMPLES)
    throw new UserError(
      `Dit ontwerp is te groot voor zo'n fijne structuur (${(samples / 1e6).toFixed(1)} miljoen rekenpunten, maximaal ${MAX_SAMPLES / 1e6}). Maak de stutten/wand dikker of het model kleiner.`,
    );
  return { edge, samples, limited };
}

// ---------------------------------------------------------------------------
// Reference body

export type UpAxis = 'z' | '-z' | 'y' | '-y' | 'x' | '-x';

const UP: Record<UpAxis, M4> = {
  z: rotX(0),
  '-z': rotX(180),
  y: rotX(90),
  '-y': rotX(-90),
  x: rotY(-90),
  '-x': rotY(90),
};

export interface Body extends BodyMesh {
  size: [number, number, number];
}

/** Scale, orient (which model axis points up, then a turn about Z) and put the body on z = 0. */
export function poseBody(src: BodyMesh, scale: number, up: UpAxis, turn: number): Body {
  const m = mul(rotZ(turn), UP[up] ?? UP.z);
  const P = new Float32Array(src.positions.length);
  for (let i = 0; i < P.length; i += 3) {
    const v = applyM4(m, [src.positions[i] * scale, src.positions[i + 1] * scale, src.positions[i + 2] * scale]);
    P[i] = v[0];
    P[i + 1] = v[1];
    P[i + 2] = v[2];
  }
  const body = normalise({ positions: P, indices: src.indices });
  const b = boundsOf(body.positions);
  return { ...body, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
}

export function boundsOf(P: ArrayLike<number>): Box3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (P[i + k] < min[k]) min[k] = P[i + k];
      if (P[i + k] > max[k]) max[k] = P[i + k];
    }
  return { min, max };
}

const grow = (b: Box3, d: number): Box3 => ({ min: [b.min[0] - d, b.min[1] - d, b.min[2] - d], max: [b.max[0] + d, b.max[1] + d, b.max[2] + d] });

function bodyGrid(body: Body, pad: number, h: number, cap: number) {
  const b = grow(boundsOf(body.positions), pad);
  let hh = h;
  while (DistanceGrid.nodesFor(b, hh) > MAX_GRID_NODES) hh *= 1.15;
  return DistanceGrid.build(body.positions, body.indices, b, hh, Math.max(cap, 3 * hh));
}

/**
 * Voronoi seeds spread evenly over the level set `d = level` of a distance
 * grid: jittered candidates near the surface are projected onto it and
 * thinned to a minimum spacing (Poisson-disk style), so holes are even in size.
 */
export function surfaceSeeds(grid: DistanceGrid, level: number, b: Box3, s: number, seed: number): SeedSet {
  const g = s / 2;
  const band = Math.min(g, grid.cap - Math.abs(level) - 2 * grid.h);
  const minD = 0.8 * s;
  const hash = new Map<number, number[]>();
  const key = (p: number[]) => {
    const i = Math.floor(p[0] / minD), j = Math.floor(p[1] / minD), k = Math.floor(p[2] / minD);
    return ((i + 4096) * 8192 + (j + 4096)) * 8192 + (k + 4096);
  };
  const pts: number[] = [];
  const rnd: number[] = [];
  const e = grid.h;
  const i0 = Math.floor(b.min[0] / g), i1 = Math.ceil(b.max[0] / g);
  const j0 = Math.floor(b.min[1] / g), j1 = Math.ceil(b.max[1] / g);
  const k0 = Math.floor(b.min[2] / g), k1 = Math.ceil(b.max[2] / g);
  for (let k = k0; k <= k1; k++)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const q = [(i + hash3(i, j, k, seed, 20)) * g, (j + hash3(i, j, k, seed, 21)) * g, (k + hash3(i, j, k, seed, 22)) * g];
        let d = grid.sample(q[0], q[1], q[2]);
        if (!(Math.abs(d - level) < band)) continue;
        let ok = true;
        for (let it = 0; it < 4; it++) {
          const gx = grid.sample(q[0] + e, q[1], q[2]) - grid.sample(q[0] - e, q[1], q[2]);
          const gy = grid.sample(q[0], q[1] + e, q[2]) - grid.sample(q[0], q[1] - e, q[2]);
          const gz = grid.sample(q[0], q[1], q[2] + e) - grid.sample(q[0], q[1], q[2] - e);
          const l = Math.hypot(gx, gy, gz);
          if (l < 0.5 * e) {
            ok = false;
            break;
          }
          const step = (d - level) / l;
          q[0] -= gx * step;
          q[1] -= gy * step;
          q[2] -= gz * step;
          d = grid.sample(q[0], q[1], q[2]);
        }
        if (!ok || Math.abs(d - level) > 0.5 * s) continue;
        const kk = key(q);
        let close = false;
        const ci = Math.floor(q[0] / minD), cj = Math.floor(q[1] / minD), ck = Math.floor(q[2] / minD);
        for (let a = -1; a <= 1 && !close; a++)
          for (let bb = -1; bb <= 1 && !close; bb++)
            for (let c = -1; c <= 1 && !close; c++) {
              const arr = hash.get(((ci + a + 4096) * 8192 + (cj + bb + 4096)) * 8192 + (ck + c + 4096));
              if (arr) for (const n of arr) if ((pts[n * 3] - q[0]) ** 2 + (pts[n * 3 + 1] - q[1]) ** 2 + (pts[n * 3 + 2] - q[2]) ** 2 < minD * minD) close = true;
            }
        if (close) continue;
        const n = pts.length / 3;
        pts.push(q[0], q[1], q[2]);
        rnd.push(hash3(i, j, k, seed, 23));
        let arr = hash.get(kk);
        if (!arr) hash.set(kk, (arr = []));
        arr.push(n);
      }
  return new SeedSet(new Float64Array(pts), new Float64Array(rnd), s);
}

// ---------------------------------------------------------------------------
// Meshing helpers

function mesh(M: ManifoldToplevel, f: (x: number, y: number, z: number) => number, b: Box3, edge: number): Manifold {
  return M.Manifold.levelSet((p: Vec3) => -f(p[0], p[1], p[2]), { min: b.min, max: b.max }, edge);
}

/** Keep the biggest connected piece (loose crumbs of pattern would print as spaghetti). */
export function largestPiece(solid: Manifold): { solid: Manifold; dropped: number; pieces: number } {
  const parts = solid.decompose();
  if (parts.length <= 1) return { solid, dropped: 0, pieces: parts.length };
  let best = parts[0];
  let bv = -1;
  let total = 0;
  for (const p of parts) {
    const v = p.volume();
    total += v;
    if (v > bv) {
      bv = v;
      best = p;
    }
  }
  return { solid: best, dropped: total > 0 ? (total - bv) / total : 0, pieces: parts.length };
}

function finish(solid: Manifold, what: string, warnings: string[]): Manifold {
  if (solid.isEmpty() || solid.volume() < 1) throw new UserError(`Er blijft geen ${what} over met deze instellingen. Maak de stutten of wand dikker, of de cellen groter.`);
  const { solid: kept, dropped } = largestPiece(solid);
  if (dropped > 0.04) warnings.push(`${Math.round(dropped * 100)}% van het patroon hing los en is weggelaten. Verlaag de openheid of maak de stutten dikker.`);
  return kept;
}

export interface GenPart {
  name: string;
  /** Solid in the pose / use position. */
  solid: Manifold;
  /** Transform from the pose into the print orientation. */
  print: M4;
}

export interface GenResult {
  parts: GenPart[];
  edge: number;
  warnings: string[];
  tips: string[];
  info: [string, string][];
}

// ---------------------------------------------------------------------------
// Cover / cage

export interface CageOptions {
  clearance: number;
  wall: number;
  pattern: PatternOptions;
  /** 'top': covers the lower part, open at the top; 'bottom': covers the upper part; 'halves': both. */
  opening: 'top' | 'bottom' | 'halves';
  /** Cut height as a fraction of the body height. */
  cut: number;
  quality: Quality;
}

export function buildCage(M: ManifoldToplevel, body: Body, o: CageOptions): GenResult {
  const warnings: string[] = [];
  const tips: string[] = [];
  const H = body.size[2];
  const t = o.wall;
  const strut = o.pattern.strut;
  const zCut = Math.min(0.95, Math.max(0.1, o.cut)) * H;
  const sides: (1 | -1)[] = o.opening === 'halves' ? [1, -1] : o.opening === 'bottom' ? [-1] : [1];
  const bb = boundsOf(body.positions);
  const out = o.clearance + t;
  const bounds = (sgn: 1 | -1, e: number): Box3 => ({
    min: [bb.min[0] - out - 2 * e, bb.min[1] - out - 2 * e, sgn > 0 ? bb.min[2] - out - 2 * e : zCut - 2 * e],
    max: [bb.max[0] + out + 2 * e, bb.max[1] + out + 2 * e, sgn > 0 ? zCut + 2 * e : bb.max[2] + out + 2 * e],
  });
  // the biggest half sets the resolution so both halves match
  const sizing = sides.map((s) => bounds(s, 1)).sort((a, b) => volumeOf(b) - volumeOf(a))[0];
  const { edge } = chooseEdge(sizing, o.quality, Math.min(t, strut));
  const kEdge = o.pattern.smooth * Math.min(t, strut) * 0.45;
  const kJoin = o.pattern.smooth * strut * 0.8 + 0.2;
  const level = o.clearance + t / 2;
  const reach = Math.max(out + 3 * edge + kJoin, level + 0.5 * o.pattern.cell + 3 * edge);
  const grid = bodyGrid(body, reach, edge, reach);
  // a hair of extra clearance against interpolation error
  const cIn = o.clearance + 0.1 * edge;
  const cOut = o.clearance + t;
  const pattern = surfacePattern(o.pattern, o.pattern.kind === 'gyroid' ? undefined : surfaceSeeds(grid, level, grow(bb, out + 2), o.pattern.cell, o.pattern.seed));
  const rimH = Math.max(2.5, 1.6 * strut);
  const far = 1.5 * edge + kJoin;
  const parts: GenPart[] = [];
  for (const sgn of sides) {
    const f = (x: number, y: number, z: number) => {
      const d = grid.sample(x, y, z);
      const shell = Math.max(cIn - d, d - cOut);
      // > 0 beyond the cut (removed side)
      const side = sgn * (z - zCut);
      if (shell > far) return Math.max(shell, side - edge);
      const web = smax(shell, pattern(x, y, z), kEdge);
      const rim = Math.max(shell, -side - rimH);
      const v = smin(web, rim, kJoin);
      return Math.max(v, cIn - d, d - cOut, side - edge);
    };
    let solid = mesh(M, f, bounds(sgn, edge), edge);
    solid = sgn > 0 ? solid.trimByPlane([0, 0, -1], -zCut) : solid.trimByPlane([0, 0, 1], zCut);
    solid = finish(solid, 'hoes', warnings);
    const name = o.opening === 'halves' ? (sgn > 0 ? 'Onderhelft' : 'Bovenhelft') : 'Hoes';
    // rim on the bed: the cut is the flattest, widest face
    parts.push({ name, solid, print: sgn > 0 ? rotX(180) : rotX(0) });
  }
  // can the object go in? compare the opening with the widest layer on the covered side
  if (o.opening !== 'halves') {
    const fit = openingCheck(grid, zCut, sides[0]);
    if (fit > 2 * o.clearance + 0.2)
      warnings.push(
        `De opening is ${fit.toFixed(1)} mm smaller dan het breedste deel van het voorwerp: de hoes moet oprekken. Print in TPU of kies een ${sides[0] > 0 ? 'lagere' : 'hogere'} snijhoogte.`,
      );
  } else tips.push('De twee helften klikken niet vast: houd ze bij elkaar met een elastiekje of een druppel lijm, of print in TPU.');
  tips.push('Print met de rand op het bed. De bolle kant hangt over: zet tree supports (organisch) aan, alleen op de bouwplaat.');
  if (o.clearance < 0.25) tips.push('Met minder dan 0,25 mm speling past het alleen als je printer exact is: druk eerst een proefstuk af.');
  const info: [string, string][] = [
    ['Speling', `${o.clearance.toFixed(2)} mm rondom`],
    ['Wanddikte', `${t.toFixed(1)} mm`],
    ['Snijhoogte', `${zCut.toFixed(1)} mm van ${H.toFixed(1)} mm`],
  ];
  return { parts, edge, warnings, tips, info };
}

/** How much the covered side is wider than the opening at the cut (mm, max over X/Y). */
function openingCheck(grid: DistanceGrid, zCut: number, sgn: 1 | -1) {
  const { nx, ny, nz, h, oz } = grid;
  const ext = (k: number) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (grid.inside[i + nx * (j + ny * k)]) {
          x0 = Math.min(x0, i);
          x1 = Math.max(x1, i);
          y0 = Math.min(y0, j);
          y1 = Math.max(y1, j);
        }
    return x1 < x0 ? null : { w: (x1 - x0) * h, d: (y1 - y0) * h };
  };
  const kc = Math.round((zCut - oz) / h);
  const at = ext(Math.min(nz - 1, Math.max(0, kc)));
  if (!at) return 0;
  let worst = 0;
  for (let k = 0; k < nz; k++) {
    const z = oz + k * h;
    if (sgn * (z - zCut) >= 0) continue;
    const e = ext(k);
    if (e) worst = Math.max(worst, e.w - at.w, e.d - at.d);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Lattice / perforated version of the model itself

export interface LatticeOptions {
  structure: 'skin' | 'lattice' | 'both';
  skin: number;
  /** Height of the flat cut at the bottom (bed contact). */
  base: number;
  pattern: PatternOptions;
  quality: Quality;
}

export function buildLattice(M: ManifoldToplevel, body: Body, o: LatticeOptions): GenResult {
  const warnings: string[] = [];
  const tips: string[] = [];
  const H = body.size[2];
  const strut = o.pattern.strut;
  const t = o.skin;
  const skin = o.structure !== 'lattice';
  const lattice = o.structure !== 'skin';
  const zb = Math.min(o.base, H * 0.4);
  const bb = boundsOf(body.positions);
  const feature = skin ? Math.min(t, strut) : strut;
  const bounds = (e: number): Box3 => ({ min: [bb.min[0] - 2 * e, bb.min[1] - 2 * e, zb - 2 * e], max: [bb.max[0] + 2 * e, bb.max[1] + 2 * e, bb.max[2] + 2 * e] });
  const { edge } = chooseEdge(bounds(1), o.quality, feature);
  const kEdge = o.pattern.smooth * feature * 0.45;
  const kJoin = o.pattern.smooth * strut * 0.8 + 0.2;
  const cap = Math.max(Math.max(t, strut) + kJoin + 3 * edge, skin ? t / 2 + 0.5 * o.pattern.cell + 3 * edge : 0);
  const grid = bodyGrid(body, 3 * edge + kJoin, edge, cap);
  const surf = surfacePattern(o.pattern, skin && o.pattern.kind !== 'gyroid' ? surfaceSeeds(grid, -t / 2, bb, o.pattern.cell, o.pattern.seed) : undefined);
  const vol = volumePattern(o.pattern);
  const rimH = Math.max(2.5, 1.6 * strut);
  const far = 1.5 * edge + kJoin;
  const f = (x: number, y: number, z: number) => {
    const d = grid.sample(x, y, z);
    const below = zb - edge - z;
    if (d > far) return Math.max(d, below);
    let v = Infinity;
    if (skin) {
      const shell = Math.max(d, -t - d);
      if (shell > far && !lattice) return Math.max(shell, below);
      const web = shell > far ? shell : smax(shell, surf(x, y, z), kEdge);
      const rim = Math.max(shell, z - (zb + rimH));
      v = smin(web, rim, kJoin);
    }
    if (lattice) {
      const inner = smax(vol(x, y, z), d, kEdge);
      // a solid foot plate keeps a lattice on the bed
      const plate = skin ? Infinity : Math.max(d, z - (zb + Math.max(1.6, 0.8 * strut)));
      v = smin(v, smin(inner, plate, kJoin), kJoin);
    }
    return Math.max(v, d, below);
  };
  let solid = mesh(M, f, bounds(edge), edge).trimByPlane([0, 0, 1], zb);
  solid = finish(solid, 'structuur', warnings);
  const parts: GenPart[] = [{ name: o.structure === 'skin' ? 'Geperforeerd model' : 'Lattice-model', solid, print: rotX(0) }];
  tips.push('Print zoals getoond, met de vlakke onderkant op het bed. Overhangende stutten en de bovenkant van holle vormen hebben tree supports (organisch) nodig.');
  if (lattice) tips.push('Een lattice heeft veel korte stukjes: zet "Avoid crossing walls" aan en verlaag de retractieafstand niet.');
  const info: [string, string][] = [
    ['Opbouw', o.structure === 'skin' ? `Geperforeerde huid van ${t.toFixed(1)} mm` : o.structure === 'lattice' ? 'Volledig lattice' : `Huid van ${t.toFixed(1)} mm met lattice erin`],
    ['Vlakke onderkant', `${zb.toFixed(1)} mm afgesneden`],
  ];
  return { parts, edge, warnings, tips, info };
}

// ---------------------------------------------------------------------------
// Stand: organic branching struts holding the body leaning back

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A set of tapered capsules with a spatial hash for fast smooth-union evaluation. */
class Capsules {
  private list: number[] = [];
  /** Chain id per capsule: one smooth branch is a chain of capsules joined without bulges. */
  private chain: number[] = [];
  private chains = 0;
  private cells = new Map<number, number[]>();
  private cell = 1;
  private reach = 0;
  private clampTo = 0;
  maxR = 0;

  /** Start a new branch: capsules added after this blend smoothly with earlier ones. */
  newChain() {
    this.chains++;
  }

  add(a: V3, b: V3, ra: number, rb: number) {
    this.list.push(a[0], a[1], a[2], b[0], b[1], b[2], ra, rb);
    this.chain.push(this.chains);
    this.maxR = Math.max(this.maxR, ra, rb);
  }

  get count() {
    return this.list.length / 8;
  }

  clone() {
    const c = new Capsules();
    c.list = [...this.list];
    c.chain = [...this.chain];
    c.chains = this.chains;
    c.maxR = this.maxR;
    return c;
  }

  bounds(scale: number, extra: number): Box3 | null {
    if (!this.count) return null;
    const b: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const L = this.list;
    for (let i = 0; i < L.length; i += 8) {
      const r = Math.max(L[i + 6], L[i + 7]) * scale + extra;
      for (let k = 0; k < 3; k++) {
        b.min[k] = Math.min(b.min[k], L[i + k] - r, L[i + 3 + k] - r);
        b.max[k] = Math.max(b.max[k], L[i + k] + r, L[i + 3 + k] + r);
      }
    }
    return b;
  }

  private key(i: number, j: number, k: number) {
    return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  }

  /**
   * Index the capsules. Points farther than `margin` (beyond the scaled
   * radius) from every capsule read a constant, so the hash is seamless.
   */
  index(scale: number, k: number, margin: number) {
    this.reach = margin + 2 * k;
    this.clampTo = margin + 0.5 * k;
    this.cell = Math.max(6, this.maxR * scale + this.reach);
    this.cells.clear();
    const L = this.list;
    const c = this.cell;
    for (let n = 0; n < L.length / 8; n++) {
      const o = n * 8;
      const r = Math.max(L[o + 6], L[o + 7]) * scale + this.reach;
      const lo = [0, 1, 2].map((q) => Math.floor((Math.min(L[o + q], L[o + 3 + q]) - r) / c));
      const hi = [0, 1, 2].map((q) => Math.floor((Math.max(L[o + q], L[o + 3 + q]) + r) / c));
      for (let i = lo[0]; i <= hi[0]; i++)
        for (let j = lo[1]; j <= hi[1]; j++)
          for (let kk = lo[2]; kk <= hi[2]; kk++) {
            const key = this.key(i, j, kk);
            let arr = this.cells.get(key);
            if (!arr) this.cells.set(key, (arr = []));
            arr.push(n);
          }
    }
  }

  /** Smooth union of all capsules (radii × scale), clamped far away. */
  field(x: number, y: number, z: number, scale: number, k: number): number {
    const c = this.cell;
    const arr = this.cells.get(this.key(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c)));
    if (!arr) return this.clampTo;
    const L = this.list;
    const C = this.chain;
    let v = Infinity;
    let cur = -1;
    let cm = Infinity;
    for (const n of arr) {
      const o = n * 8;
      const ax = L[o], ay = L[o + 1], az = L[o + 2];
      const bx = L[o + 3] - ax, by = L[o + 4] - ay, bz = L[o + 5] - az;
      const px = x - ax, py = y - ay, pz = z - az;
      const bb = bx * bx + by * by + bz * bz;
      let t = bb > 1e-12 ? (px * bx + py * by + pz * bz) / bb : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - (L[o + 6] + (L[o + 7] - L[o + 6]) * t) * scale;
      // hard union within a chain (no bulges at the joints), smooth between branches
      if (C[n] === cur) {
        if (d < cm) cm = d;
      } else {
        if (cur >= 0) v = v === Infinity ? cm : smin(v, cm, k);
        cur = C[n];
        cm = d;
      }
    }
    if (cur >= 0) v = v === Infinity ? cm : smin(v, cm, k);
    return Math.min(v, this.clampTo);
  }
}

interface TNode {
  p: V3;
  r: number;
  kids: TNode[];
  parent?: TNode;
  /** Outward surface normal for contact points (struts leave along it). */
  n?: V3;
}

/** Merge the targets of one foot into a branching tree (closest pairs first, ≥ 55° from horizontal). */
function growTree(targets: { p: V3; n?: V3 }[], foot: V3, r0: number, rMax: number): TNode {
  const SLOPE = Math.tan((55 * Math.PI) / 180);
  let open: TNode[] = targets.map((t) => ({ p: t.p, n: t.n, r: r0, kids: [] }));
  while (open.length > 1) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < open.length; i++)
      for (let j = i + 1; j < open.length; j++) {
        const d = len(sub(open[i].p, open[j].p));
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    const a = open[bi];
    const b = open[bj];
    const w = (a.r * a.r) / (a.r * a.r + b.r * b.r);
    const mx = a.p[0] * w + b.p[0] * (1 - w);
    const my = a.p[1] * w + b.p[1] * (1 - w);
    // lean a little towards the foot
    const px = mx + (foot[0] - mx) * 0.25;
    const py = my + (foot[1] - my) * 0.25;
    const hd = Math.max(Math.hypot(a.p[0] - px, a.p[1] - py), Math.hypot(b.p[0] - px, b.p[1] - py));
    const top = Math.min(a.p[2], b.p[2]);
    let z = top - hd * SLOPE - 2;
    z = Math.max(z, foot[2] + 0.3 * (top - foot[2]));
    const parent: TNode = { p: [px, py, z], r: Math.min(rMax, Math.hypot(a.r, b.r)), kids: [a, b] };
    a.parent = parent;
    b.parent = parent;
    open = open.filter((_, i) => i !== bi && i !== bj);
    open.push(parent);
  }
  const root = open[0];
  const footNode: TNode = { p: foot, r: Math.min(rMax, root.r * 1.15), kids: [root] };
  root.parent = footNode;
  return footNode;
}

/** Emit every branch of a tree as a smooth Bézier chain of capsules. */
function treeCapsules(foot: TNode, caps: Capsules) {
  const outDir = (n: TNode): V3 => {
    if (!n.parent) return [0, 0, -1];
    let d = norm(sub(n.parent.p, n.p));
    if (n.kids.length) {
      let inc: V3 = [0, 0, 0];
      for (const k of n.kids) inc = add(inc, norm(sub(n.p, k.p)));
      d = norm(add(d, norm(inc)));
    } else if (n.n) d = norm(add(d, scl(n.n, 0.7)));
    return d;
  };
  const walk = (n: TNode) => {
    for (const k of n.kids) {
      const a = k.p;
      const b = n.p;
      const L = len(sub(b, a));
      const p1 = add(a, scl(outDir(k), L / 3));
      const p2 = sub(b, scl(outDir(n), L / 3));
      const steps = Math.max(3, Math.min(16, Math.ceil(L / Math.max(2, k.r * 1.5))));
      let prev = a;
      caps.newChain();
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        const q: V3 = [0, 1, 2].map((i) => u * u * u * a[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * b[i]) as V3;
        const r0 = k.r + (n.r - k.r) * ((s - 1) / steps);
        const r1 = k.r + (n.r - k.r) * t;
        caps.add(prev, q, r0, r1);
        prev = q;
      }
      walk(k);
    }
  };
  walk(foot);
}

export interface StandOptions {
  /** Angle of the object with the table, degrees (90 = upright). */
  angle: number;
  /** Height of the object's lowest point above the table. */
  lift: number;
  /** How far the cradle (lip) reaches up the object. */
  lip: number;
  wall: number;
  clearance: number;
  /** Strut radius at the contact points. */
  strut: number;
  /** Back support height as a fraction of the object height. */
  support: number;
  cable: boolean;
  cableWidth: number;
  /** Extra contact branches on the back. */
  branches: number;
  smooth: number;
  seed: number;
  /** 'takken' = plain branches; the others wrap the branches in a 3D lattice. */
  style: 'takken' | 'voronoi' | 'blobs' | 'gyroid';
  cell: number;
  quality: Quality;
}

export interface StandResult extends GenResult {
  /** World transform of the body (pose → scene). */
  bodyMatrix: M4;
  /** Distance of the centre of mass inside the footprint (mm). */
  margin: number;
  centerOfMass: V3;
}

/** Assumed densities (g/cm³) for the stability check. */
const OBJECT_DENSITY = 1.5;
const STAND_DENSITY = 1.24 * 0.45;

export function buildStand(M: ManifoldToplevel, body: Body, o: StandOptions): StandResult {
  const warnings: string[] = [];
  const tips: string[] = [];
  const [W, , H] = body.size;
  const bb = boundsOf(body.positions);
  const c = o.clearance;
  const t = o.wall;
  const r = o.strut;
  const cOut = c + t;
  const lip = Math.min(o.lip, H * 0.45);
  const k = o.smooth * r * 1.2 + 0.3;
  // body distance grid in the body's own frame (resolution only matters for the contact zones)
  const hb = Math.min(1.2, Math.max(0.5, Math.cbrt(volumeOf(grow(bb, cOut + 6)) / 6e5)));
  const grid = bodyGrid(body, cOut + 6 + k, hb, cOut + 4 * hb + k);
  const { volume: objVol, centroid } = grid.massProperties();

  // lean back: rotate about X so the top goes to +Y, then lift
  const beta = ((90 - o.angle) * Math.PI) / 180;
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  let zLow = Infinity;
  for (let i = 0; i < body.positions.length; i += 3) zLow = Math.min(zLow, -sb * body.positions[i + 1] + cb * body.positions[i + 2]);
  const lift = Math.max(o.lift, cOut + 1);
  const tz = lift - zLow;
  const toWorld = (p: V3): V3 => [p[0], cb * p[1] + sb * p[2], -sb * p[1] + cb * p[2] + tz];
  const dirWorld = (p: V3): V3 => [p[0], cb * p[1] + sb * p[2], -sb * p[1] + cb * p[2]];
  const bodyMatrix: M4 = mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, tz, 1], rotX(-(90 - o.angle)));

  // --- contact points (body frame) ---
  const surfaceY = (x: number, z: number): number | null => {
    // march from behind towards the front until inside
    const step = hb * 0.5;
    let prev = bb.max[1] + cOut + 2;
    if (grid.sample(x, prev, z) < 0) return null;
    for (let y = prev - step; y > bb.min[1]; y -= step) {
      if (grid.sample(x, y, z) < 0) {
        let lo = y;
        let hi = prev;
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          if (grid.sample(x, m, z) < 0) lo = m;
          else hi = m;
        }
        return hi;
      }
      prev = y;
    }
    return null;
  };
  const surfaceZ = (x: number, y: number): number | null => {
    const step = hb * 0.5;
    let prev = bb.min[2] - cOut - 2;
    for (let z = prev + step; z < bb.max[2]; z += step) {
      if (grid.sample(x, y, z) < 0) {
        let lo = prev;
        let hi = z;
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          if (grid.sample(x, y, m) < 0) hi = m;
          else lo = m;
        }
        return lo;
      }
      prev = z;
    }
    return null;
  };
  const normalAt = (p: V3): V3 => {
    const e = hb;
    return norm([
      grid.sample(p[0] + e, p[1], p[2]) - grid.sample(p[0] - e, p[1], p[2]),
      grid.sample(p[0], p[1] + e, p[2]) - grid.sample(p[0], p[1] - e, p[2]),
      grid.sample(p[0], p[1], p[2] + e) - grid.sample(p[0], p[1], p[2] - e),
    ]);
  };
  const off = cOut - t / 2;
  /** A strut target; `pad` > 0 adds a contact pad (a band towards `to` when set). */
  interface Contact { p: V3; n: V3; pad: number; to?: V3 }
  const back: Contact[] = [];
  const padR = Math.max(2 * r + 3, Math.min(16, 0.16 * Math.min(Math.max(W, 30), H)));
  const backContact = (x: number, z: number, pad: number) => {
    const y = surfaceY(x, z);
    if (y === null) return false;
    const s: V3 = [x, y, z];
    const n = normalAt(s);
    if (n[1] < 0.2) return false;
    back.push({ p: add(s, scl(n, off)), n, pad });
    return true;
  };
  const zSup = Math.min(H - padR, Math.max(lip + padR, o.support * H));
  // the back rest: a band across the back between two struts (or one pad on narrow objects)
  const restR = 0.55 * padR;
  const xr = 0.3 * W;
  let rest = 0;
  if (W >= 30 && backContact(-xr, zSup, restR) && backContact(xr, zSup, restR)) {
    back[0].to = back[1].p;
    rest = 2;
  } else {
    back.length = 0;
    if (backContact(0, zSup, padR) || backContact(0, H / 2, padR)) rest = 1;
  }
  if (!back.length) throw new UserError('Kan de achterkant van het voorwerp niet vinden. Draai het model zodat de voorkant naar voren (−Y) wijst.');
  // extra branches: random small contacts on the back between lip and support
  for (let i = 0; i < o.branches; i++) {
    const x = (hash3(i, 1, 0, o.seed) - 0.5) * 0.84 * W;
    const z = lip + padR * 0.6 + hash3(i, 2, 0, o.seed) * Math.max(1, zSup + padR * 0.5 - lip - padR * 0.6);
    backContact(x, z, Math.max(1.6 * r, 0.35 * padR));
  }
  // the cradle: anchors under the bottom and behind it
  const slotHalf = o.cable ? o.cableWidth / 2 : 0;
  let ax = Math.max(0.28 * W, slotHalf + r + 2);
  if (ax > W / 2 - 1) {
    if (o.cable) throw new UserError('Het voorwerp is te smal voor een kabelsleuf van deze breedte. Maak de sleuf smaller of zet hem uit.');
    ax = 0;
  }
  const cradle: Contact[] = [];
  for (const x of ax > 0 ? [-ax, ax] : [0]) {
    const z = surfaceZ(x, (bb.min[1] + bb.max[1]) / 2);
    if (z !== null) cradle.push({ p: [x, (bb.min[1] + bb.max[1]) / 2, z - off], n: [0, 0, -1], pad: 0 });
    const zr = Math.min(lip * 0.5, H / 4);
    const y = surfaceY(x, zr);
    if (y !== null) back.push({ p: [x, y + off, zr], n: [0, 1, 0], pad: 0 });
  }
  if (!cradle.length) cradle.push({ p: [0, (bb.min[1] + bb.max[1]) / 2, bb.min[2] - off], n: [0, 0, -1], pad: 0 });

  // --- footprint and stability ---
  const objCom = toWorld(centroid);
  const wBack = back.map((b) => toWorld(b.p));
  const wCradle = cradle.map((b) => toWorld(b.p));
  let yFront = Infinity;
  for (const x of [bb.min[0], bb.max[0]])
    for (const z of [-cOut, lip])
      for (const y of [bb.min[1] - cOut]) yFront = Math.min(yFront, toWorld([x, y, z])[1]);
  const rFoot = 1.4 * r * 1.6;
  const margin = Math.max(6, 0.06 * H);
  yFront = Math.min(yFront + r, objCom[1] - margin - rFoot);
  const maxBackY = Math.max(...wBack.map((p) => p[1]));
  let yBack = Math.max(maxBackY + r, objCom[1] + Math.max(20, 0.6 * (objCom[1] - yFront)));
  const xFoot = Math.max(0.45 * W, 25, Math.abs(objCom[0]) + margin + rFoot);
  // planned footprint must contain the centre of mass with margin (auto-widen otherwise)
  for (let i = 0; i < 4 && objCom[1] > yBack + rFoot - margin; i++) yBack += 0.3 * (yBack - yFront);
  const feet = {
    fl: [-xFoot, yFront, 0] as V3,
    fr: [xFoot, yFront, 0] as V3,
    bl: [-xFoot, yBack, 0] as V3,
    br: [xFoot, yBack, 0] as V3,
  };

  // --- branches ---
  const core = new Capsules();
  const assign = new Map<V3, { p: V3; n?: V3 }[]>([[feet.fl, []], [feet.fr, []], [feet.bl, []], [feet.br, []]]);
  back.forEach((b, i) => {
    const w = wBack[i];
    const n = dirWorld(b.n);
    if (Math.abs(b.p[0]) < 1) {
      assign.get(feet.bl)!.push({ p: w, n });
      assign.get(feet.br)!.push({ p: w, n });
    } else assign.get(b.p[0] < 0 ? feet.bl : feet.br)!.push({ p: w, n });
  });
  cradle.forEach((b, i) => {
    const w = wCradle[i];
    const n = dirWorld(b.n);
    if (Math.abs(b.p[0]) < 1) {
      assign.get(feet.fl)!.push({ p: w, n });
      assign.get(feet.fr)!.push({ p: w, n });
    } else assign.get(b.p[0] < 0 ? feet.fl : feet.fr)!.push({ p: w, n });
  });
  const rMax = 2 * r;
  let footR = r;
  for (const [foot, targets] of assign) {
    if (!targets.length) continue;
    const tree = growTree(targets, foot, r, rMax);
    footR = Math.max(footR, tree.r);
    treeCapsules(tree, core);
  }
  // the lattice envelope follows the branches only (not the feet and ground bars)
  const branchesOnly = core.clone();
  const rf = 1.4 * footR;
  for (const f of Object.values(feet)) {
    core.newChain();
    core.add([f[0], f[1], 0.15 * rf], [f[0], f[1], 0.15 * rf], rf, rf);
  }
  // ground bars tie the feet together (none across the front when a cable must pass)
  const rb = Math.max(r * 0.9, 1.6);
  const bar = (a: V3, b: V3) => {
    core.newChain();
    core.add([a[0], a[1], 0.4 * rb], [b[0], b[1], 0.4 * rb], rb, rb);
  };
  bar(feet.fl, feet.bl);
  bar(feet.fr, feet.br);
  bar(feet.bl, feet.br);
  if (!o.cable) bar(feet.fl, feet.fr);

  // --- field ---
  const lattice = o.style !== 'takken';
  const envScale = 2.4;
  const pat = lattice ? volumePattern({ kind: o.style as 'voronoi' | 'blobs' | 'gyroid', cell: o.cell, strut: Math.max(MIN_FEATURE * 1.5, r * 0.9), smooth: o.smooth, porosity: 0.5, seed: o.seed }) : null;
  const pads = back.filter((b) => b.pad > 0);

  const cIn = c + 0.1 * hb;
  const slotY0 = bb.min[1] - cOut - 3;
  const slotY1 = bb.max[1] + cOut + 3;
  const boundsCore = core.bounds(lattice ? envScale : 1, k + 2)!;
  // cradle + pads, in world coordinates
  const corners: V3[] = [];
  for (const x of [bb.min[0] - cOut, bb.max[0] + cOut])
    for (const y of [bb.min[1] - cOut, bb.max[1] + cOut]) for (const z of [bb.min[2] - cOut, lip + 1]) corners.push(toWorld([x, y, z]));
  for (const p of pads)
    for (const s of [-1, 1])
      for (const q of [0, 1, 2]) {
        const dv: V3 = [q === 0 ? s * (p.pad + cOut) : 0, q === 1 ? s * (p.pad + cOut) : 0, q === 2 ? s * (p.pad + cOut) : 0];
        corners.push(toWorld(add(p.p, dv)));
        if (p.to) corners.push(toWorld(add(p.to, dv)));
      }
  const bnd: Box3 = { min: [...boundsCore.min], max: [...boundsCore.max] };
  for (const p of corners)
    for (let q = 0; q < 3; q++) {
      bnd.min[q] = Math.min(bnd.min[q], p[q] - k - 2);
      bnd.max[q] = Math.max(bnd.max[q], p[q] + k + 2);
    }
  const { edge } = chooseEdge(bnd, o.quality, Math.min(t, lattice ? Math.max(MIN_FEATURE * 1.5, r * 0.9) : 2 * r));
  bnd.min[2] = -2 * edge;
  for (let q = 0; q < 2; q++) {
    bnd.min[q] -= 2 * edge;
    bnd.max[q] += 2 * edge;
  }
  bnd.max[2] += 2 * edge;
  core.index(1, k, 2 * edge + 1);
  // the same branches, fattened into a lattice envelope
  const env = lattice ? branchesOnly : null;
  env?.index(envScale, k * 2, 2 * edge + 1);
  const kEdge = o.smooth * t * 0.45;
  const far = 1.5 * hb + k;
  const f = (x: number, y: number, z: number) => {
    // body frame
    const yo = cb * y - sb * (z - tz);
    const zo = sb * y + cb * (z - tz);
    const d = grid.sample(x, yo, zo);
    let v = core.field(x, y, z, lattice ? 0.6 : 1, k);
    if (env && pat) v = smin(v, smax(env.field(x, y, z, envScale, k * 2), pat(x, y, z), kEdge), k);
    const shell = Math.max(cIn - d, d - cOut);
    if (shell < far) {
      let hold = smax(shell, zo - lip, kEdge);
      for (const p of pads) {
        const dp = p.to ? segDist(x, yo, zo, p.p, p.to) - p.pad : Math.hypot(x - p.p[0], yo - p.p[1], zo - p.p[2]) - p.pad;
        hold = smin(hold, Math.max(shell, dp), k);
      }
      v = smin(v, hold, k);
    }
    v = Math.max(v, cIn - d);
    if (o.cable && zo < 1 && yo > slotY0 && yo < slotY1) v = Math.max(v, slotHalf - Math.abs(x));
    return Math.max(v, -edge - z);
  };
  let solid = mesh(M, f, bnd, edge).trimByPlane([0, 0, 1], 0);
  solid = finish(solid, 'standaard', warnings);

  // --- stability check on the real footprint ---
  const standVol = solid.volume();
  const standCom = centroidOf(solid);
  const mo = objVol * OBJECT_DENSITY;
  const ms = standVol * STAND_DENSITY;
  const com: V3 = [0, 1, 2].map((q) => (objCom[q] * mo + standCom[q] * ms) / (mo + ms)) as V3;
  const foot = solid.slice(0.3).hull().toPolygons();
  const marginReal = foot.length ? insideMargin(foot[0] as [number, number][], com[0], com[1]) : -1;
  if (marginReal < 0)
    throw new UserError('Deze standaard zou omvallen: het zwaartepunt ligt buiten het steunvlak. Kies een steilere hoek, een lagere steun of minder hoogte.');
  if (marginReal < 5) warnings.push(`Het zwaartepunt ligt maar ${marginReal.toFixed(1)} mm binnen het steunvlak: de standaard kiept snel. Kies een kleinere hoek met de verticaal.`);
  const steep = overhangShare(solid);
  tips.push(
    lattice
      ? 'Print staand zoals getoond. Het lattice-patroon heeft hier en daar overhang: zet tree supports (organisch) aan.'
      : steep > 0.08
        ? 'Print staand zoals getoond. De takken lopen grotendeels onder 45° of steiler; zet voor de bovenste steunen tree supports aan.'
        : 'Print staand zoals getoond: de takken lopen steil genoeg om zonder support te printen.',
  );
  if (o.cable) tips.push(`De kabelsleuf is ${o.cableWidth} mm breed: meet de stekker van je kabel na.`);
  const info: [string, string][] = [
    ['Hoek', `${o.angle}° met de tafel`],
    ['Stabiliteit', `zwaartepunt ${marginReal.toFixed(0)} mm binnen het steunvlak (aanname: voorwerp ${OBJECT_DENSITY} g/cm³)`],
    ['Steunpunten', `${rest === 2 ? 'rugsteun over de breedte' : 'één rugsteun'}, ${pads.length - rest} extra takken, ${cradle.length + back.length - pads.length} aan de onderrand`],
  ];
  return { parts: [{ name: 'Standaard', solid, print: rotX(0) }], edge, warnings, tips, info, bodyMatrix, margin: marginReal, centerOfMass: com };
}

function segDist(x: number, y: number, z: number, a: V3, b: V3) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const px = x - a[0], py = y - a[1], pz = z - a[2];
  const bb = bx * bx + by * by + bz * bz;
  const t = bb > 1e-12 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / bb)) : 0;
  return Math.hypot(px - bx * t, py - by * t, pz - bz * t);
}

/** Centre of volume of a closed solid (divergence theorem). */
export function centroidOf(m: Manifold): V3 {
  const mesh = m.getMesh();
  const P = mesh.vertProperties;
  const n = mesh.numProp;
  const I = mesh.triVerts;
  let v = 0;
  const c: V3 = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * n, b = I[t + 1] * n, d = I[t + 2] * n;
    const vol = (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
    v += vol;
    for (let q = 0; q < 3; q++) c[q] += (vol * (P[a + q] + P[b + q] + P[d + q])) / 4;
  }
  return v ? (c.map((x) => x / v) as V3) : [0, 0, 0];
}

/** Signed distance of (x, y) inside a convex polygon (positive inside). */
export function insideMargin(poly: [number, number][], x: number, y: number) {
  let best = Infinity;
  let inside = true;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  const s = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const ex = x2 - x1, ey = y2 - y1;
    const l = Math.hypot(ex, ey) || 1;
    const side = (s * (ex * (y - y1) - ey * (x - x1))) / l;
    if (side < 0) inside = false;
    best = Math.min(best, Math.abs(side));
  }
  return inside ? best : -best;
}

/** Share of the surface that faces down more steeply than 45° (excluding the bed). */
export function overhangShare(m: Manifold) {
  const mesh = m.getMesh();
  const P = mesh.vertProperties;
  const n = mesh.numProp;
  const I = mesh.triVerts;
  let total = 0;
  let over = 0;
  const lim = -Math.SQRT1_2;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * n, b = I[t + 1] * n, c = I[t + 2] * n;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    total += l;
    if (Math.min(P[a + 2], P[b + 2], P[c + 2]) < 0.3) continue;
    if (nz / l < lim) over += l;
  }
  return total ? over / total : 0;
}
