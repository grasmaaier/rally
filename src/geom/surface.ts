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

/** Closed solid bounded by the surface between z0 and z1 (flat caps). */
export function solidOfSurface(M: ManifoldToplevel, S: Surface, z0: number, z1: number, segs: number, rings: number): Manifold {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const z of linspace(z0, z1, rings)) pushRing(S, z, segs, pos);
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
  opts: { z0: number; z1: number; floor: number | null; segs: number; rings: number },
): Manifold {
  const { z0, z1, floor, segs, rings } = opts;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const z of linspace(z0, z1, rings)) pushRing(outer, z, segs, pos);
  const innerStart = pos.length / 3;
  const zi0 = floor ?? z0;
  const innerRings = Math.max(2, Math.round((rings * (z1 - zi0)) / (z1 - z0)));
  for (const z of linspace(zi0, z1, innerRings)) pushRing(inner, z, segs, pos);
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
  section: Section;
  count: number;
  depth: number;
  rounding: number;
  twist: number;
  twistMode: string;
  twistWaves: number;
  waveAmp: number;
  waveFreq: number;
}

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

/** Surface for vases/pots from the user-facing shape options. */
export function shapeSurface(o: ShapeOptions): Surface {
  const sec = sectionFn(o.section, Math.max(1, Math.round(o.count)), o.depth, o.rounding);
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
  if (o.section !== 'round') {
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
    const step = o.section === 'star' ? 2 * Math.max(1, Math.round(o.count)) : 1;
    segs = Math.max(step, Math.round((segs * k) / step) * step);
    rings = Math.max(24, Math.floor(budget / segs));
  }
  return { segs, rings };
}
