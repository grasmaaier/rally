import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { TAU, catmull, clamp, fromArrays, smoothstep } from './helpers';

/**
 * A star-shaped surface of revolution: for every height z and pattern angle
 * th, `r(z, th)` is the distance from the Z axis. `phi(z)` rotates the whole
 * pattern (twist). Vertices are placed at angle th + phi(z), so pattern
 * features (star points, facets) follow the twist exactly.
 */
export interface Surface {
  r: (z: number, th: number) => number;
  phi: (z: number) => number;
}

function pushRing(S: Surface, z: number, segs: number, out: number[]) {
  const p = S.phi(z);
  for (let k = 0; k < segs; k++) {
    const th = (TAU * k) / segs;
    const rr = Math.max(0.05, S.r(z, th));
    out.push(rr * Math.cos(th + p), rr * Math.sin(th + p), z);
  }
}

function linspace(a: number, b: number, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

/** Side wall between consecutive rings. `inward` flips the winding for inner walls. */
function stitchRings(idx: number[], first: number, rings: number, segs: number, inward: boolean) {
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = first + i * segs + j;
      const b = first + i * segs + j1;
      const c = first + (i + 1) * segs + j1;
      const d = first + (i + 1) * segs + j;
      if (inward) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
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

/** Annulus between an outer and an inner ring; `up` = normal points to +Z. */
function rim(idx: number[], outer: number, inner: number, segs: number, up: boolean) {
  for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    const o0 = outer + j;
    const o1 = outer + j1;
    const i0 = inner + j;
    const i1 = inner + j1;
    if (up) idx.push(o0, o1, i1, o0, i1, i0);
    else idx.push(o0, i1, o1, o0, i0, i1);
  }
}

/**
 * Ring heights from z0 to z1: `rings` evenly spaced heights, merged with the
 * explicit heights in `zs` that fall inside (kinks of terraced profiles).
 */
export function ringHeights(z0: number, z1: number, rings: number, zs?: number[]): number[] {
  const even = linspace(z0, z1, Math.max(2, rings));
  if (!zs || zs.length === 0) return even;
  const all = [...even, ...zs.filter((z) => z > z0 + 0.02 && z < z1 - 0.02)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of all) if (!out.length || z - out[out.length - 1] > 0.02) out.push(z);
  out[out.length - 1] = z1;
  return out;
}

/** Closed solid bounded by the surface between z0 and z1 (flat caps). */
export function solidOfSurface(M: ManifoldToplevel, S: Surface, z0: number, z1: number, segs: number, rings: number, zs?: number[]): Manifold {
  const pos: number[] = [];
  const idx: number[] = [];
  const heights = ringHeights(z0, z1, rings, zs);
  rings = heights.length;
  for (const z of heights) pushRing(S, z, segs, pos);
  const bottom = pos.length / 3;
  pos.push(0, 0, z0);
  const top = pos.length / 3;
  pos.push(0, 0, z1);
  stitchRings(idx, 0, rings, segs, false);
  fan(idx, bottom, 0, segs, false);
  fan(idx, top, (rings - 1) * segs, segs, true);
  return fromArrays(M, pos, idx);
}

/**
 * Wall between an outer and an inner surface. With `floor` set, the bottom is
 * closed (solid between z0 and floor); without it the shell is an open tube.
 */
export function shellOfSurface(
  M: ManifoldToplevel,
  outer: Surface,
  inner: Surface,
  opts: { z0: number; z1: number; floor: number | null; segs: number; rings: number; zs?: number[] },
): Manifold {
  const { z0, z1, floor, segs, zs } = opts;
  const pos: number[] = [];
  const idx: number[] = [];
  const outerZ = ringHeights(z0, z1, opts.rings, zs);
  const rings = outerZ.length;
  for (const z of outerZ) pushRing(outer, z, segs, pos);
  const innerStart = pos.length / 3;
  const zi0 = floor ?? z0;
  const innerZ = ringHeights(zi0, z1, Math.max(2, Math.round((opts.rings * (z1 - zi0)) / (z1 - z0))), zs);
  const innerRings = innerZ.length;
  for (const z of innerZ) pushRing(inner, z, segs, pos);
  stitchRings(idx, 0, rings, segs, false);
  stitchRings(idx, innerStart, innerRings, segs, true);
  rim(idx, (rings - 1) * segs, innerStart + (innerRings - 1) * segs, segs, true);
  if (floor === null) {
    rim(idx, 0, innerStart, segs, false);
  } else {
    const c0 = pos.length / 3;
    pos.push(0, 0, z0);
    const c1 = pos.length / 3;
    pos.push(0, 0, floor);
    fan(idx, c0, 0, segs, false);
    fan(idx, c1, innerStart, segs, true);
  }
  return fromArrays(M, pos, idx);
}

/**
 * Inner surface at a (roughly) constant normal distance `wall` from `S`.
 * The radial inset is scaled by the local slope so steep features (star
 * points, flares) keep the requested wall thickness.
 */
export function insetSurface(S: Surface, wall: number | ((z: number) => number), minR = 0.6): Surface {
  const h = 0.05;
  const w = typeof wall === 'number' ? () => wall : wall;
  return {
    phi: S.phi,
    r: (z, th) => {
      const r = S.r(z, th);
      const dth = (S.r(z, th + 1e-3) - S.r(z, th - 1e-3)) / 2e-3;
      // derivative along z at constant *actual* angle (accounts for twist)
      const dphi = (S.phi(z + h) - S.phi(z - h)) / (2 * h);
      const dz = (S.r(z + h, th) - S.r(z - h, th)) / (2 * h) - dth * dphi;
      const f = clamp(Math.sqrt(1 + (dth / Math.max(r, 1e-3)) ** 2 + dz * dz), 1, 3);
      return Math.max(minR, r - w(z) * f);
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-section patterns, normalised so that the maximum radius is 1.

export type Section = 'round' | 'polygon' | 'flower' | 'star' | 'scallop' | 'gear';

const normCache = new Map<string, number>();

function rawSection(section: Section, n: number, depth: number, rounding: number, th: number): number {
  switch (section) {
    case 'polygon': {
      const p = 2.2 + (1 - rounding) ** 2 * 60;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const c = Math.cos(th - (TAU * i) / n);
        if (c > 0) sum += c ** p;
      }
      return 1 / Math.pow(Math.max(sum, 1e-9), 1 / p);
    }
    case 'flower':
      return 1 - (depth * (1 - Math.cos(n * th))) / 2;
    case 'star': {
      const u = (((n * th) / TAU) % 1 + 1) % 1;
      return 1 - depth * (1 - Math.abs(2 * u - 1));
    }
    case 'scallop':
      return 1 - depth * (1 - Math.abs(Math.cos((n * th) / 2)));
    case 'gear': {
      // trapezoidal teeth with soft flanks
      const u = (((n * th) / TAU) % 1 + 1) % 1;
      const tooth = smoothstep(0.1, 0.25, u) * (1 - smoothstep(0.5, 0.65, u));
      return 1 - depth * (1 - tooth);
    }
    default:
      return 1;
  }
}

export function sectionFn(section: Section, n: number, depth: number, rounding: number) {
  const key = `${section}|${n}|${depth.toFixed(4)}|${rounding.toFixed(4)}`;
  let norm = normCache.get(key);
  if (norm === undefined) {
    norm = 0;
    for (let i = 0; i < 1440; i++) norm = Math.max(norm, rawSection(section, n, depth, rounding, (TAU * i) / 1440));
    normCache.set(key, norm);
  }
  const k = norm;
  // vertices sample the same angles on every ring: memoise per angle
  const memo = new Map<number, number>();
  return (th: number) => {
    let v = memo.get(th);
    if (v === undefined) {
      if (memo.size > 200000) memo.clear();
      v = rawSection(section, n, depth, rounding, th) / k;
      memo.set(th, v);
    }
    return v;
  };
}

export interface ShapeOptions {
  height: number;
  /** Profile radii at evenly spaced heights, bottom to top. */
  radii: number[];
  /** A classic section id; any other id needs `sectionR`. */
  section: Section | string;
  count: number;
  depth: number;
  rounding: number;
  twist: number;
  twistMode: string;
  twistWaves: number;
  waveAmp: number;
  waveFreq: number;
  /** Normalised radial function (max 1) for sections from the shared shape library. */
  sectionR?: (th: number) => number;
  /** Segments around that `sectionR` needs to look crisp. */
  sectionSegs?: number;
  /** Profile style: 'smooth' (default), 'terraced', 'bubbles', 'wavy' or 'facet'. */
  profile?: string;
  /** Number of terraces / bubbles / rings / facets. */
  profileCount?: number;
  /** 0..1 */
  profileDepth?: number;
  /** Organic noise amount as a fraction of the radius (0..0.4). */
  organic?: number;
  /** Feature size of the organic noise in mm. */
  organicScale?: number;
  /** Variation of the noise and the facets. */
  seed?: number;
}

export const CLASSIC_SECTIONS = ['round', 'polygon', 'flower', 'star', 'scallop', 'gear'];

export function twistFn(o: Pick<ShapeOptions, 'height' | 'twist' | 'twistMode' | 'twistWaves'>) {
  const total = (o.twist * Math.PI) / 180;
  return (z: number) => {
    const t = clamp(z / o.height, 0, 1);
    switch (o.twistMode) {
      case 'ease':
        return total * t * t * (3 - 2 * t);
      case 'wave':
        return total * Math.sin(Math.PI * Math.max(1, o.twistWaves) * t);
      default:
        return total * t;
    }
  };
}

/**
 * Steep horizontal waves overhang too far to print (and make walls collapse).
 * Limit the amplitude so the wave flank stays under ~55°. Returns the options
 * to build with and whether the waves were toned down.
 */
export function limitWaves(o: ShapeOptions, maxSlope = 1.4): { opts: ShapeOptions; limited: boolean } {
  if (o.waveAmp <= 0) return { opts: o, limited: false };
  const rMax = Math.max(...o.radii);
  const maxAmp = (maxSlope * o.height) / (TAU * Math.max(1, o.waveFreq) * rMax);
  if (o.waveAmp <= maxAmp) return { opts: o, limited: false };
  return { opts: { ...o, waveAmp: maxAmp }, limited: true };
}

const sectionOf = (o: ShapeOptions) => o.sectionR ?? sectionFn(o.section as Section, Math.max(1, Math.round(o.count)), o.depth, o.rounding);

const isPlain = (o: ShapeOptions) => (!o.profile || o.profile === 'smooth') && !((o.organic ?? 0) > 0);

/** Surface for vases/pots from the user-facing shape options (no toning down; see `buildShape`). */
export function shapeSurface(o: ShapeOptions): Surface {
  if (!isPlain(o)) return composeSurface(o, profileOf(o), 1);
  const sec = sectionOf(o);
  const phi = twistFn(o);
  return {
    phi,
    r: (z, th) => {
      const t = clamp(z / o.height, 0, 1);
      const base = catmull(o.radii, t);
      const wave = 1 + o.waveAmp * Math.sin(TAU * o.waveFreq * t);
      return Math.max(1, base * wave * sec(th));
    },
  };
}

/** Pick mesh resolution so patterns, twist and waves stay smooth. */
export function resolutionFor(o: ShapeOptions, quality = 1): { segs: number; rings: number } {
  const n = Math.max(1, Math.round(o.count));
  let segs = 192;
  if (o.sectionR) {
    segs = Math.max(192, o.sectionSegs ?? 360);
  } else if (o.section !== 'round') {
    const per = o.section === 'polygon' ? 24 : o.section === 'star' ? 2 : 16;
    segs = Math.max(192, n * per);
    // star points must land on vertices: segs multiple of 2n
    if (o.section === 'star') segs = Math.ceil(Math.max(192, n * 8) / (2 * n)) * 2 * n;
  }
  segs = Math.min(720, Math.round(segs * quality));
  const twistDeg = Math.abs(o.twist) * (o.twistMode === 'wave' ? Math.max(1, o.twistWaves) * 2 : 1);
  let rings = Math.round(
    clamp(Math.max(o.height / 2, (twistDeg / (360 / segs)) * 0.35, (o.waveAmp > 0 ? o.waveFreq : 0) * 24, 40) * quality, 24, 400),
  );
  // keep each surface under a vertex budget so the preview stays interactive
  const budget = 90000 * quality;
  if (segs * rings > budget) {
    const k = Math.sqrt(budget / (segs * rings));
    const step = !o.sectionR && o.section === 'star' ? 2 * Math.max(1, Math.round(o.count)) : 1;
    segs = Math.max(step, Math.round((segs * k) / step) * step);
    rings = Math.max(24, Math.floor(budget / segs));
  }
  return { segs, rings };
}

// ---------------------------------------------------------------------------
// Abstract profiles and organic deformation

/** Steepest flank (radius change per mm of height) each profile style may have. */
const PROFILE_SLOPE: Record<string, number> = { terraced: 1, bubbles: 1.15, facet: 1.15 };

/** Overhang limit for walls printed upright (also in vase mode): tan(~55°). */
export const MAX_WALL_SLOPE = 1.4;

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded 3D gradient noise (improved Perlin), roughly in [-1, 1]. */
export function noise3(seed: number) {
  const rnd = mulberry32(Math.round(seed) * 7919 + 101);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number, z: number) => {
    const g = h & 15;
    const u = g < 8 ? x : y;
    const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
    return (g & 1 ? -u : u) + (g & 2 ? -v : v);
  };
  const L = (a: number, b: number, t: number) => a + t * (b - a);
  return (x: number, y: number, z: number) => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const Z = Math.floor(z);
    x -= X;
    y -= Y;
    z -= Z;
    const xi = X & 255;
    const yi = Y & 255;
    const zi = Z & 255;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = perm[xi] + yi;
    const AA = perm[A] + zi;
    const AB = perm[A + 1] + zi;
    const B = perm[xi + 1] + yi;
    const BA = perm[B] + zi;
    const BB = perm[B + 1] + zi;
    return L(
      L(L(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), L(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      L(
        L(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
        L(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  };
}

interface Profile {
  /** Radius of the profile (at section radius 1) at height z. */
  f: (z: number) => number;
  /** Heights where the profile bends (rings are placed there). */
  breaks: number[];
}

/** Heights where a sampled curve bends: drop points that a straight line already describes within `tol`. */
function bendPoints(zs: Float64Array, v: Float64Array, tol: number): number[] {
  const n = v.length;
  const keep = [0];
  let a = 0;
  for (let i = 2; i < n; i++) {
    for (let j = a + 1; j < i; j++) {
      const lin = v[a] + ((v[i] - v[a]) * (zs[j] - zs[a])) / (zs[i] - zs[a]);
      if (Math.abs(lin - v[j]) > tol) {
        a = i - 1;
        keep.push(a);
        break;
      }
    }
  }
  keep.push(n - 1);
  return keep.map((i) => zs[i]);
}

/**
 * The vertical profile with the chosen style applied. Terraces, bubbles and
 * facets are made printable by limiting every flank to the style's slope
 * (a min-plus "erosion" with a 45-50° cone): steps become chamfers and
 * pinches become V-grooves instead of overhangs.
 */
function profileOf(o: ShapeOptions): Profile {
  const H = o.height;
  const base = (z: number) => catmull(o.radii, clamp(z / H, 0, 1));
  const style = o.profile ?? 'smooth';
  const slope = PROFILE_SLOPE[style];
  if (!slope) return { f: base, breaks: [] };
  const n = Math.round(clamp(H / 0.1, 400, 3200));
  const dz = H / (n - 1);
  const zs = Float64Array.from({ length: n }, (_, i) => i * dz);
  const P = zs.map((z) => base(z));
  const d = clamp(o.profileDepth ?? 0.3, 0, 0.9);
  const rho = new Float64Array(n);
  if (style === 'terraced') {
    const N = Math.round(clamp(o.profileCount ?? 6, 2, 40));
    const tierH = H / N;
    for (let i = 0; i < n; i++) rho[i] = base((Math.min(N - 1, Math.floor(zs[i] / tierH)) + 0.5) * tierH);
    // a dip between the terraces; the erosion below turns it into a 45° V-groove
    for (let b = 1; b < N; b++) {
      const ib = Math.round((b * tierH) / dz);
      const D = d * Math.min(0.2 * base(b * tierH), 0.45 * tierH);
      rho[ib] = Math.min(rho[ib - 1], rho[ib + 1]) - D;
    }
  } else if (style === 'bubbles') {
    const N = Math.round(clamp(o.profileCount ?? 5, 1, 30));
    for (let i = 0; i < n; i++) {
      const u = ((zs[i] / H) * N) % 1;
      rho[i] = P[i] * (1 - d + d * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)));
    }
  } else {
    // facets: straight segments that zigzag inward, with some seeded variation
    const N = Math.round(clamp(o.profileCount ?? 6, 2, 40));
    const rnd = mulberry32(Math.round(o.seed ?? 7) * 31 + 5);
    const f = Array.from({ length: N + 1 }, (_, i) => 1 - d * (i % 2 ? 0.55 + 0.45 * rnd() : 0.12 * rnd()));
    for (let i = 0; i < n; i++) {
      const x = Math.min(N - 1e-9, (zs[i] / H) * N);
      const k = Math.floor(x);
      rho[i] = P[i] * (f[k] + (f[k + 1] - f[k]) * (x - k));
    }
  }
  // never deeper than the deepest recess: steep user profiles keep their shape
  let floor = Infinity;
  for (let i = 0; i < n; i++) floor = Math.min(floor, rho[i] / P[i]);
  const step = slope * dz;
  for (let i = 1; i < n; i++) rho[i] = Math.min(rho[i], rho[i - 1] + step);
  for (let i = n - 2; i >= 0; i--) rho[i] = Math.min(rho[i], rho[i + 1] + step);
  for (let i = 0; i < n; i++) rho[i] = Math.max(rho[i], P[i] * floor, 1);
  const f = (z: number) => {
    const x = clamp(z / dz, 0, n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    return rho[i] + (rho[i + 1] - rho[i]) * (x - i);
  };
  return { f, breaks: bendPoints(zs, rho, 0.04) };
}

/** The parts of a surface: the shaped base B and the deformation G (radius = B·(1 + k·G)). */
function surfaceParts(o: ShapeOptions, prof: Profile) {
  const sec = sectionOf(o);
  const H = o.height;
  const B = (z: number, th: number) => {
    const t = clamp(z / H, 0, 1);
    return prof.f(z) * (1 + o.waveAmp * Math.sin(TAU * o.waveFreq * t)) * sec(th);
  };
  const amount = clamp(o.organic ?? 0, 0, 0.4);
  const wavy = o.profile === 'wavy' ? clamp(o.profileDepth ?? 0.3, 0, 0.9) * 0.3 : 0;
  if (amount <= 0 && wavy <= 0) return { B, G: null };
  const noise = noise3(o.seed ?? 7);
  const scale = Math.max(5, o.organicScale ?? 40);
  const r0 = o.radii.reduce((a, b) => a + b, 0) / o.radii.length;
  const c = r0 / scale;
  const N = Math.round(clamp(o.profileCount ?? 6, 1, 30));
  const G = (z: number, th: number) => {
    let g = 0;
    if (amount > 0) {
      // noise on a cylinder: periodic around, smooth up and down
      const x = Math.cos(th) * c;
      const y = Math.sin(th) * c;
      const w = z / scale;
      const v = noise(x, y, w) + 0.5 * noise(2 * x + 5.2, 2 * y + 1.3, 2 * w + 7.7);
      g += amount * clamp(v * 1.1, -1, 1);
    }
    // rings that rise and fall around the vase (inward only, so the size stays as set)
    if (wavy > 0) g += (wavy * (Math.sin(TAU * N * (z / H) + 1.3 * Math.sin(3 * th)) - 1)) / 2;
    return g;
  };
  return { B, G };
}

function composeSurface(o: ShapeOptions, prof: Profile, k: number): Surface {
  const { B, G } = surfaceParts(o, prof);
  const phi = twistFn(o);
  if (!G || k <= 0) return { phi, r: (z, th) => Math.max(1, B(z, th)) };
  return { phi, r: (z, th) => Math.max(1, B(z, th) * (1 + k * G(z, th))) };
}

export interface ShapeBuild {
  S: Surface;
  /** Options actually built (waves may be toned down). */
  opts: ShapeOptions;
  segs: number;
  rings: number;
  /** Extra ring heights (profile kinks); pass them on to the surface builders. */
  zs?: number[];
  /** Horizontal waves were toned down. */
  limited: boolean;
  /** Fraction of the organic deformation / wavy rings that was kept (1 = all). */
  kept: number;
  /** Steepest wall of the shape without deformation (radius change per mm of height). */
  steepest: number;
}

/**
 * Build the vase/pot surface: profile style, organic noise and resolution.
 * The noise and the wavy rings are toned down until no wall overhangs more
 * than `maxSlope` (unless the profile itself is already that steep there).
 */
export function buildShape(o: ShapeOptions, quality = 1, maxSlope = MAX_WALL_SLOPE): ShapeBuild {
  const { opts, limited } = limitWaves(o, maxSlope);
  const plain = isPlain(opts);
  const prof = profileOf(opts);
  const { B, G } = surfaceParts(opts, prof);
  const phi = twistFn(opts);
  const H = opts.height;
  // sample the wall: radius change per mm of height at a fixed (world) angle
  const nA = G ? 120 : 72;
  const nZ = Math.round(clamp(H / (G ? 1.5 : 3), 30, 200));
  const h = Math.min(0.4, H / 400);
  let kept = 1;
  let steepest = 0;
  for (let ia = 0; ia < nA; ia++) {
    const a = (TAU * ia) / nA;
    for (let iz = 0; iz <= nZ; iz++) {
      const z = clamp((H * iz) / nZ, h, H - h);
      const t0 = a - phi(z);
      const tp = a - phi(z + h);
      const tm = a - phi(z - h);
      const b = B(z, t0);
      const bz = (B(z + h, tp) - B(z - h, tm)) / (2 * h);
      // a wall that also runs sideways (star flanks with twist) overhangs less
      const ba = (B(z, t0 + 0.01) - B(z, t0 - 0.01)) / 0.02 / Math.max(b, 1e-3);
      const lean = Math.sqrt(1 + ba * ba);
      steepest = Math.max(steepest, Math.abs(bz) / lean);
      if (!G) continue;
      const g = G(z, t0);
      const gz = (G(z + h, tp) - G(z - h, tm)) / (2 * h);
      // slope of B·(1 + k·G) is bz + k·e
      const e = bz * g + b * gz;
      // where the profile itself is already steep, allow a little extra (it is warned about)
      const allow = Math.max(maxSlope * lean, Math.abs(bz) + 0.25);
      if (e > 1e-9) kept = Math.min(kept, (allow - bz) / e);
      else if (e < -1e-9) kept = Math.min(kept, (allow + bz) / -e);
    }
  }
  kept = G ? clamp(kept * 0.97, 0, 1) : 1;
  if (kept > 0.96) kept = 1;
  if (kept < 0.03) kept = 0;
  const S = plain ? shapeSurface(opts) : composeSurface(opts, prof, kept);

  // resolution: the pattern, the noise features and the profile kinks
  let { segs, rings } = resolutionFor(opts, quality);
  if (plain) return { S, opts, segs, rings, limited, kept, steepest };
  const rMax = Math.max(...opts.radii);
  if ((opts.organic ?? 0) > 0 && kept > 0) {
    const feat = Math.max(5, opts.organicScale ?? 40) / 6;
    segs = Math.max(segs, Math.min(720, Math.round(((TAU * rMax) / feat) * quality)));
    rings = Math.max(rings, Math.round((H / feat) * quality));
  }
  const count = Math.round(clamp(opts.profileCount ?? 6, 1, 30));
  if (opts.profile === 'wavy') rings = Math.max(rings, Math.round(count * 16 * quality));
  if (opts.profile === 'bubbles') rings = Math.max(rings, Math.round(count * 14 * quality));
  let zs: number[] | undefined = prof.breaks.length > 2 ? prof.breaks : undefined;
  const budget = 90000 * quality;
  if (segs * (rings + (zs?.length ?? 0)) > budget) {
    rings = Math.max(16, Math.floor(budget / segs) - (zs?.length ?? 0));
    // too many kinks for the budget: keep every other one
    while (zs && zs.length > 64 && segs * (rings + zs.length) > budget * 1.4) zs = zs.filter((_, i) => i % 2 === 0);
  }
  return { S, opts, segs, rings: Math.min(rings, 600), zs, limited, kept, steepest };
}
