import type { Vec2 } from 'manifold-3d';
import { clamp, deg, smoothstep } from '../geom/helpers';
import { resample, unitNormals, type Loop } from '../geom/soft';

// ---------------------------------------------------------------------------
// Hardware (typical catalogue sizes; the user can override the socket and bulb)

/**
 * Dutch flush box (inbouwdoos): drilled Ø68, device screw lugs 60 mm apart
 * for M3.5 screws (the standard switch/socket pattern).
 */
export const FLUSH_BOX = { holeD: 68, innerD: 60, depth: 45, spacing: 60, clear: 4.0, headD: 7.4 };
/** WAGO 221-413 lever connector, current datasheet: 18.8 × 8.4 × 18.6 mm (w × h × d). */
export const WAGO = { w: 18.8, h: 8.4, d: 18.6 };
/** Wall-plug screws 4 mm, countersunk (plug 6 mm). */
export const PLUG = { clear: 4.6, headD: 8.6 };
/** Housing lock screws: M3 countersunk (90°), self-tapping into the plate. */
export const LOCK = { clear: 3.4, headD: 6.4, pilot: 2.6, len: 16 };
/** Socket bracket screws: M3 pan head, self-tapping into the plate. */
export const BRACKET_SCREW = { clear: 3.4, pilot: 2.6 };

/**
 * Ceramic G9 lampholders. Guide values from catalogues:
 * - round porcelain G9 on an M10×1 nipple (e.g. Starled): body Ø20.2 × 25 mm, M10×1 thread;
 * - ceramic G9 with fixing holes for M3 screws (e.g. Vossloh-Schwabe 502004).
 * G9 pins are 9 mm apart.
 */
export const G9_GUIDE = {
  m10: { d: 20.2, h: 25 },
  screws: { d: 22, h: 20, spacing: 24 },
  nut: { d: 17, h: 3 },
  nipple: { d: 10, len: 8, hole: 10.5 },
};
/** G9 LED capsule: Ø16 × 50 mm including the pins; the pins sit ~8 mm deep in the socket. */
export const G9_LED = { d: 16, l: 50, insert: 8 };

// ---------------------------------------------------------------------------
// Outlines (plan view). Frame: x along the wall, y = distance from the wall
// (y ≥ 0), the back of every outline lies flat on y = 0. Loops are CCW and
// start at the back-left corner (−xb, 0).

export const SHAPES = [
  { value: 'pil', label: 'Pil (stadion)' },
  { value: 'rond', label: 'Rond (afgeplatte achterkant)' },
  { value: 'halfrond', label: 'Halve maan (halve ellips)' },
  { value: 'rechthoek', label: 'Rechthoek / vierkant (afgerond)' },
  { value: 'golf', label: 'Organisch golvend' },
];

export interface OutlineSpec {
  shape: string;
  W: number;
  D: number;
  /** Front corner radius (rechthoek). */
  corner: number;
  /** Number of waves and their depth in % of the size (golf). */
  waves: number;
  waveDepth: number;
}

export interface Outline {
  loop: Loop;
  /** Half the width of the flat back. */
  xb: number;
  W: number;
  D: number;
  notes: string[];
}

function arc(out: Vec2[], cx: number, cy: number, r: number, a0: number, a1: number) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / deg(2)));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

/** Drop consecutive (near-)duplicates and a closing point equal to the first. */
function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

export function outlineOf(s: OutlineSpec, ds = 0.8): Outline {
  const notes: string[] = [];
  const W = s.W;
  let D = s.D;
  const pts: Vec2[] = [];
  let xb = W / 2;
  switch (s.shape) {
    case 'rond': {
      // a circle as wide as the lamp, flattened at the back
      const R = W / 2;
      const Dc = clamp(D, 1.1 * R, 1.84 * R);
      if (Math.abs(Dc - D) > 0.5) notes.push(`Rond: diepte aangepast naar ${Dc.toFixed(0)} mm (tussen 55% en 92% van de breedte; voor minder diepte kies je Halve maan).`);
      D = Dc;
      const y0 = D - R;
      xb = Math.sqrt(R * R - y0 * y0);
      const a0 = -Math.asin(y0 / R);
      pts.push([-xb, 0], [xb, 0]);
      arc(pts, 0, y0, R, a0, Math.PI - a0);
      break;
    }
    case 'halfrond': {
      const a = W / 2;
      pts.push([-a, 0], [a, 0]);
      const n = 180;
      for (let i = 1; i < n; i++) {
        const t = (Math.PI * i) / n;
        pts.push([a * Math.cos(t), D * Math.sin(t)]);
      }
      break;
    }
    case 'rechthoek': {
      const rf = clamp(s.corner, 1, Math.min(W / 2, D) - 0.5);
      pts.push([-W / 2, 0], [W / 2, 0], [W / 2, D - rf]);
      arc(pts, W / 2 - rf, D - rf, rf, 0, Math.PI / 2);
      arc(pts, -W / 2 + rf, D - rf, rf, Math.PI / 2, Math.PI);
      break;
    }
    case 'golf': {
      // half a superellipse with smooth waves that fade out towards the wall
      const a = W / 2;
      const n = 2.6;
      const k = Math.max(1, Math.round(s.waves));
      const A = clamp(s.waveDepth, 0, 25) / 100;
      const raw: Vec2[] = [];
      const N = 360;
      for (let i = 0; i <= N; i++) {
        const f = (Math.PI * i) / N;
        const c = Math.abs(Math.cos(f)) / a;
        const sn = Math.abs(Math.sin(f)) / D;
        const rb = 1 / Math.pow(c ** n + sn ** n, 1 / n);
        const fade = Math.pow(Math.sin(f), 1.5);
        const r = rb * (1 + A * fade * Math.cos(k * (f - Math.PI / 2)));
        raw.push([r * Math.cos(f), r * Math.sin(f)]);
      }
      let mx = 0;
      let my = 0;
      for (const [x, y] of raw) {
        mx = Math.max(mx, Math.abs(x));
        my = Math.max(my, y);
      }
      const sx = a / mx;
      const sy = D / my;
      xb = raw[0][0] * sx;
      pts.push([-xb, 0]);
      for (const [x, y] of raw) pts.push([x * sx, y * sy]);
      break;
    }
    default: {
      // pill: a stadium whose back quarter is cut off by the wall
      const R = Math.min(W / 2, D / 1.5);
      const Dc = Math.min(D, 1.8 * R);
      if (Dc < D - 0.5) notes.push(`Pil: diepte aangepast naar ${Dc.toFixed(0)} mm (een pil is breder dan diep; voor een diepe lamp kies je Rond).`);
      D = Dc;
      const y0 = D - R;
      const a = W / 2 - R;
      const h = Math.sqrt(Math.max(0, R * R - y0 * y0));
      xb = a + h;
      const t0 = -Math.asin(clamp(y0 / R, -1, 1));
      pts.push([-xb, 0], [xb, 0]);
      arc(pts, a, y0, R, t0, Math.PI / 2);
      arc(pts, -a, y0, R, Math.PI / 2, Math.PI - t0);
    }
  }
  const loop = resample(dedupe(pts), ds);
  return { loop, xb, W, D, notes };
}

// ---------------------------------------------------------------------------
// Loop queries

/** Largest y where the vertical line at x crosses the loop (the front wall at x), -Infinity if none. */
export function frontY(loop: Loop, x: number): number {
  let best = -Infinity;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n];
    if ((x0 <= x && x1 >= x) || (x1 <= x && x0 >= x)) {
      const t = Math.abs(x1 - x0) < 1e-12 ? 0 : (x - x0) / (x1 - x0);
      best = Math.max(best, y0 + (y1 - y0) * t);
    }
  }
  return best;
}

/** Smallest and largest x where the horizontal line at y crosses the loop. */
export function sideX(loop: Loop, y: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n];
    if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
      const t = Math.abs(y1 - y0) < 1e-12 ? 0 : (y - y0) / (y1 - y0);
      const x = x0 + (x1 - x0) * t;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return [lo, hi];
}

/** Front wall over an x range (most restrictive = smallest). */
export function frontYOver(loop: Loop, x0: number, x1: number): number {
  let m = Infinity;
  const n = Math.max(2, Math.ceil((x1 - x0) / 1));
  for (let i = 0; i <= n; i++) m = Math.min(m, frontY(loop, x0 + ((x1 - x0) * i) / n));
  return m;
}

/** Side walls over a y range (most restrictive). */
export function sideXOver(loop: Loop, y0: number, y1: number): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  const n = Math.max(2, Math.ceil((y1 - y0) / 1));
  for (let i = 0; i <= n; i++) {
    const [a, b] = sideX(loop, y0 + ((y1 - y0) * i) / n);
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  return [lo, hi];
}

/** Offset every vertex along its unit normal (positive = outward). */
export function offsetLoop(loop: Loop, d: number): Loop {
  const nrm = unitNormals(loop);
  return loop.map(([x, y], i) => [x + nrm[i][0] * d, y + nrm[i][1] * d] as Vec2);
}

// ---------------------------------------------------------------------------
// Relief on the outer face: vertical pleats or rounded ribs (the inner wall
// follows at the same thickness, so the wall stays uniform)

export interface ReliefSpec {
  kind: string;
  pitch: number;
  depth: number;
  /** No relief below this distance from the wall (attachment region). */
  yMin: number;
}

/** Outer loop with pleats/ribs pushed outward; vertices behind yMin stay on the outline. */
export function reliefLoop(base: Loop, s: ReliefSpec): Loop {
  if ((s.kind !== 'plisse' && s.kind !== 'ribbels') || s.depth <= 0) return base;
  const pitch = Math.max(2, s.pitch);
  const loop = resample(base, clamp(pitch / 10, 0.3, 0.8));
  const nrm = unitNormals(loop);
  const n = loop.length;
  const w = loop.map(([, y]) => smoothstep(s.yMin, s.yMin + 6, y));
  // arc length over the weighted (front) region only, so the pleats fit it exactly
  const seg: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n];
    seg.push(Math.hypot(x1 - x0, y1 - y0));
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++)
    if (w[i] > 0.001) {
      if (first < 0) first = i;
      last = i;
    }
  if (first < 0) return base;
  let L = 0;
  for (let i = first; i < last; i++) L += seg[i];
  if (L < pitch * 2) return base;
  const count = Math.max(2, Math.round(L / pitch));
  let s0 = 0;
  return loop.map(([x, y], i) => {
    if (i < first || i > last) return [x, y] as Vec2;
    const u = (s0 / L) * count;
    if (i < last) s0 += seg[i];
    const f = u - Math.floor(u);
    const bump = s.kind === 'plisse' ? 1 - Math.abs(2 * f - 1) : 0.5 * (1 - Math.cos(2 * Math.PI * f));
    const d = s.depth * bump * w[i];
    return [x + nrm[i][0] * d, y + nrm[i][1] * d] as Vec2;
  });
}

// ---------------------------------------------------------------------------
// Perforations: support-free holes in a vertical wall and their lattice

/**
 * Hole outline in the wall plane (u along the wall, v up), centred on (0, 0).
 * Diamond: 45° flanks top and bottom. Teardrop: a circle with a 45° point on
 * top (`both`: also at the bottom, for a part that prints upside down).
 */
export function holePoly(shape: string, size: number, both = false): Vec2[] {
  if (shape === 'druppel') {
    const r = size * 0.42;
    const pts: Vec2[] = [];
    // from the right 45° tangent point around the bottom to the left one, then the tip
    const n = 20;
    if (!both) {
      for (let i = 0; i <= n; i++) {
        const a = Math.PI / 4 - (1.5 * Math.PI * i) / n;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      pts.push([0, r * Math.SQRT2]);
      return pts.reverse();
    }
    // lens: 45° tips top and bottom, round sides
    const out: Vec2[] = [[0, -r * Math.SQRT2]];
    for (let i = 0; i <= n / 2; i++) {
      const a = -Math.PI / 4 + (Math.PI / 2) * (i / (n / 2));
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    out.push([0, r * Math.SQRT2]);
    for (let i = 0; i <= n / 2; i++) {
      const a = (3 * Math.PI) / 4 + (Math.PI / 2) * (i / (n / 2));
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return out;
  }
  const h = size / 2;
  return [
    [0, -h],
    [h, 0],
    [0, h],
    [-h, 0],
  ];
}

function inside(poly: Vec2[], p: Vec2): boolean {
  // convex CCW polygon
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Smallest distance between two convex polygons (0 when they overlap). */
export function polyGap(a: Vec2[], b: Vec2[]): number {
  if (a.some((p) => inside(b, p)) || b.some((p) => inside(a, p))) return 0;
  let m = Infinity;
  for (const [P, Q] of [
    [a, b],
    [b, a],
  ])
    for (const p of P) for (let i = 0; i < Q.length; i++) m = Math.min(m, segDist(p, Q[i], Q[(i + 1) % Q.length]));
  return m;
}

const shift = (poly: Vec2[], dx: number, dy: number) => poly.map(([x, y]) => [x + dx, y + dy] as Vec2);

/**
 * Staggered lattice for the holes: rows `pz` apart, holes `ps` apart along
 * the wall, every other row shifted by ps/2. The smallest pitch that keeps
 * every web (to all neighbours) at least `web` wide.
 */
export function holeLattice(shape: string, size: number, web: number): { poly: Vec2[]; ps: number; pz: number } {
  const poly = holePoly(shape, size);
  const webOf = (q: number) =>
    Math.min(polyGap(poly, shift(poly, 2 * q, 0)), polyGap(poly, shift(poly, q, q)), polyGap(poly, shift(poly, -q, q)), polyGap(poly, shift(poly, 0, 2 * q)));
  let lo = size * 0.25;
  let hi = size * 2 + web * 3;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (webOf(m) >= web) hi = m;
    else lo = m;
  }
  return { poly, ps: 2 * hi, pz: hi };
}

/** Narrowest web of a lattice with the given pitches (for checks and tests). */
export function latticeWeb(poly: Vec2[], ps: number, pz: number): number {
  return Math.min(polyGap(poly, shift(poly, ps, 0)), polyGap(poly, shift(poly, ps / 2, pz)), polyGap(poly, shift(poly, -ps / 2, pz)), polyGap(poly, shift(poly, 0, 2 * pz)));
}
