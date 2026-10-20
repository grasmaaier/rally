import { TAU, clamp, lerp } from '../geom/helpers';
import { sectionFn } from '../geom/surface';
import type { LathePattern } from '../geom/lathe';

// ---------------------------------------------------------------------------
// Lamp hardware (typical catalogue sizes; check your own parts)

/** Hollow threaded lamp tube M10x1: Ø10 mm, bore with clearance. */
export const BORE_R = 5.2;
/** Smallest outer radius of a stacked segment: Ø22 contact face around the tube. */
export const CORE_R = 11;
/** Self-centring cone between segments: spigot (on the lower part) and recess. */
export const SPIGOT = { r0: 8, r1: 6.2, h: 1.8 };
export const RECESS = { r0: 8.3, depth: 8.3 - BORE_R };
/** Solid material a face needs around the tube to take a recess. */
export const RECESS_HUB = RECESS.depth + 1;
/** Blind holes for the posts of a spacer. */
export const POST_HOLE = 4;

export interface Socket {
  label: string;
  /** Body diameter and height from the mounting face (M10 nipple) to the mouth. */
  d: number;
  h: number;
  /** How far the bulb cap sits inside the socket. */
  insert: number;
  /** Radius of the bulb cap where the glass starts. */
  capR: number;
  mass: number;
}

export const SOCKETS: Record<string, Socket> = {
  e27: { label: 'E27', d: 40, h: 58, insert: 22, capR: 13.5, mass: 35 },
  e14: { label: 'E14', d: 29, h: 45, insert: 18, capR: 7.5, mass: 20 },
  g9: { label: 'G9', d: 22, h: 26, insert: 6, capR: 8, mass: 15 },
};

export interface Bulb {
  label: string;
  socket: string;
  /** Largest diameter and total length including the cap. */
  d: number;
  l: number;
  mass: number;
  /** Bulbs that look good bare (globes). */
  globe?: boolean;
}

export const BULBS: Record<string, Bulb> = {
  a60: { label: 'A60 peer — Ø60 × 105', socket: 'e27', d: 60, l: 105, mass: 35 },
  st64: { label: 'ST64 edison — Ø64 × 140', socket: 'e27', d: 64, l: 140, mass: 40 },
  p45e27: { label: 'P45 kogel — Ø45 × 78', socket: 'e27', d: 45, l: 78, mass: 25 },
  g80: { label: 'G80 globe — Ø80 × 120', socket: 'e27', d: 80, l: 120, mass: 55, globe: true },
  g95: { label: 'G95 globe — Ø95 × 135', socket: 'e27', d: 95, l: 135, mass: 70, globe: true },
  g125: { label: 'G125 globe — Ø125 × 170', socket: 'e27', d: 125, l: 170, mass: 120, globe: true },
  p45: { label: 'P45 kogel — Ø45 × 80', socket: 'e14', d: 45, l: 80, mass: 22 },
  g45: { label: 'G45 bol — Ø45 × 75', socket: 'e14', d: 45, l: 75, mass: 22, globe: true },
  c35: { label: 'C35 kaars — Ø35 × 98', socket: 'e14', d: 35, l: 98, mass: 20 },
  g9: { label: 'G9 capsule — Ø16 × 50', socket: 'g9', d: 16, l: 50, mass: 8 },
};

export const bulbOptions = (socket: string) =>
  Object.entries(BULBS)
    .filter(([, b]) => b.socket === socket)
    .map(([value, b]) => ({ value, label: b.label }));

/**
 * The glass of a bulb in the socket: radius at distance `t` from the socket
 * mouth (0 ≤ t ≤ length). A neck from the cap widens into a sphere at the tip.
 */
export function bulbGlass(b: Bulb, s: Socket) {
  const length = Math.max(10, b.l - s.insert);
  const R = b.d / 2;
  const zc = Math.max(0, length - R);
  const r0 = Math.min(R, s.capR);
  const r = (t: number) => {
    if (t >= zc) return Math.sqrt(Math.max(0, R * R - (t - zc) ** 2));
    return r0 + (R - r0) * Math.sin((Math.PI / 2) * (t / Math.max(1e-6, zc)));
  };
  return { length, r };
}

// ---------------------------------------------------------------------------
// Segment shapes

export const SHAPE_OPTIONS = [
  { value: 'bol', label: 'Bol (afgeplat)' },
  { value: 'kussen', label: 'Kussen / donut' },
  { value: 'cilinder', label: 'Cilinder' },
  { value: 'tol', label: 'Tol / zigzag' },
  { value: 'diabolo', label: 'Diabolo (zandloper)' },
  { value: 'kegel', label: 'Kegel' },
  { value: 'koepel', label: 'Koepel' },
  { value: 'boog', label: 'Boog (ronde top)' },
  { value: 'trap', label: 'Ziggurat / trap' },
  { value: 'bloem', label: 'Bloemschijf' },
  { value: 'tandwiel', label: 'Tandwielschijf' },
  { value: 'schijf', label: 'Platte schijf' },
  { value: 'hals', label: 'Afstandshouder — hals' },
  { value: 'stijlen', label: 'Afstandshouder — stijlen' },
  { value: 'kap', label: 'Kap (open lampenkap)' },
  { value: 'lamel', label: 'Lamel (open ring)' },
];

export const KAP_OPTIONS = [
  { value: 'cilinder', label: 'Cilinder' },
  { value: 'kegel', label: 'Kegel' },
  { value: 'klok', label: 'Klok' },
  { value: 'koepel', label: 'Koepel (halve bol)' },
  { value: 'trap', label: 'Ziggurat (getrapt)' },
];

export const TEXTURE_OPTIONS = [
  { value: 'glad', label: 'Glad' },
  { value: 'plisse', label: 'Plissé (fijne vouwen)' },
  { value: 'ribbels', label: 'Ribbels (afgerond)' },
  { value: 'ringen', label: 'Ringen (horizontaal)' },
];

export const COLOR_OPTIONS = [
  { value: '#f2efe8', label: 'Wit (doorschijnend)' },
  { value: '#c8693f', label: 'Terracotta' },
  { value: '#2f7f7a', label: 'Petrol / teal' },
  { value: '#d8c3a0', label: 'Zand' },
  { value: '#e8b931', label: 'Geel' },
  { value: '#c8352e', label: 'Rood' },
  { value: '#2f5aa8', label: 'Blauw' },
  { value: '#e7a3b0', label: 'Roze' },
  { value: '#8fae8b', label: 'Salie' },
  { value: '#e07b39', label: 'Oranje' },
  { value: '#9aa0a6', label: 'Grijs' },
  { value: '#2b2b2e', label: 'Zwart' },
];

/** Shapes with a count (peaks, steps, petals, teeth, posts). */
export const COUNTED = new Set(['tol', 'diabolo', 'trap', 'bloem', 'tandwiel', 'stijlen']);
/** Shapes without a pattern or flip. */
export const SPACERS = new Set(['hals', 'stijlen']);

export interface SegSpec {
  slot: number;
  shape: string;
  kap: string;
  D: number;
  H: number;
  /** 0..1 shape variant (see the help text of the parameter). */
  v: number;
  n: number;
  flip: boolean;
  tex: string;
  texN: number;
  color: string;
}

/**
 * Outer radius of a segment body in stack coordinates (z = 0 at its bottom,
 * before flipping). Solid shapes never get thinner than the Ø22 core.
 */
export function shapeRadius(s: SegSpec): (z: number) => number {
  const R = s.D / 2;
  const h = s.H;
  const v = clamp(s.v, 0, 1);
  const n = Math.max(1, Math.round(s.n));
  const core = Math.min(CORE_R, R);
  const fn = ((): ((t: number) => number) => {
    switch (s.shape) {
      case 'bol': {
        // ellipsoid cut flat at both ends; v = size of the flats
        const e = lerp(core, 0.85 * R, v);
        const b = h / 2 / Math.sqrt(Math.max(1e-6, 1 - (e / R) ** 2));
        return (t) => R * Math.sqrt(Math.max(0, 1 - (((t - 0.5) * h) / b) ** 2));
      }
      case 'kussen':
      case 'bloem': {
        // flat faces, round rim; v = how far the round reaches inward (petal depth for flowers)
        const a = clamp((s.shape === 'bloem' ? 0.9 : lerp(0.4, 1.6, v)) * (h / 2), 0.5, Math.max(0.5, R - core));
        return (t) => R - a + a * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
      }
      case 'cilinder':
      case 'schijf':
      case 'hals': {
        const rf = v * Math.min(h / 2, (R - core) * 0.9, 20);
        return (t) => {
          const d = Math.min(t, 1 - t) * h;
          return d >= rf ? R : R - rf + Math.sqrt(Math.max(0, rf * rf - (rf - d) ** 2));
        };
      }
      case 'tandwiel': {
        const c = Math.min(0.8, h / 4);
        return (t) => R - Math.max(0, c - Math.min(t, 1 - t) * h);
      }
      case 'tol':
      case 'diabolo': {
        // n peaks (tol) or n waists (diabolo); v = radius at the ends / waists
        const e = lerp(core, 0.9 * R, v);
        return (t) => {
          const u = (t * n) % 1;
          const tri = 1 - Math.abs(2 * u - 1);
          return s.shape === 'tol' ? e + (R - e) * tri : R - (R - e) * tri;
        };
      }
      case 'kegel': {
        const e = lerp(core, R, v);
        return (t) => lerp(R, e, t);
      }
      case 'koepel': {
        const e = lerp(core, 0.7 * R, v);
        return (t) => Math.max(e, R * Math.sqrt(Math.max(0, 1 - t * t)));
      }
      case 'boog': {
        // cylinder with a rounded top; v = height of the arch (relative to the radius)
        const a = Math.min(0.95 * h, lerp(0.3, 1, v) * R);
        const rh = R - core;
        return (t) => {
          const z = t * h;
          if (z <= h - a) return R;
          const w = (z - (h - a)) / a;
          return R - rh + rh * Math.sqrt(Math.max(0, 1 - w * w));
        };
      }
      case 'trap': {
        const N = Math.max(2, n);
        const e = lerp(core, R, v * 0.9);
        return (t) => R - ((R - e) * Math.min(N - 1, Math.floor(t * N))) / (N - 1);
      }
      default:
        return () => R;
    }
  })();
  return (z) => Math.max(core, fn(clamp(z / h, 0, 1)));
}

/**
 * Outer radius of a shade with its open rim at z = 0 and its closed top
 * (ceiling around the tube) at z = H. `topR` is the smallest radius at the
 * top (room for the socket).
 */
export function kapRadius(s: SegSpec, topR: number): (z: number) => number {
  const R = Math.max(s.D / 2, topR);
  const h = s.H;
  const v = clamp(s.v, 0, 1);
  const e = Math.min(R, Math.max(topR, lerp(topR, R, v)));
  const fn = ((): ((t: number) => number) => {
    switch (s.kap) {
      case 'kegel':
        return (t) => lerp(R, e, t);
      case 'klok':
        return (t) => e + (R - e) * (1 - t) ** 2;
      case 'koepel':
        return (t) => R * Math.sqrt(Math.max(0, 1 - t * t));
      case 'trap': {
        const N = Math.max(2, Math.round(s.n));
        return (t) => R - ((R - e) * Math.min(N - 1, Math.floor(t * N))) / (N - 1);
      }
      default:
        return () => R;
    }
  })();
  return (z) => Math.max(topR, fn(clamp(z / h, 0, 1)));
}

/** Horizontal rings: radius factor (1 at the middle of a bead, lower at the joints). */
export function ringFactor(s: SegSpec, texDepth: number, R: number): (z: number) => number {
  if (s.tex !== 'ringen') return () => 1;
  const n = Math.round(clamp(s.texN, 1, Math.max(1, s.H / 3)));
  const k = clamp(texDepth / Math.max(R, 1), 0, 0.3);
  return (z) => {
    const u = ((clamp(z / s.H, 0, 1) * n) % 1 + 1) % 1;
    return 1 - k * (1 - Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)));
  };
}

/** Pattern around a segment: petals / teeth of the outline and vertical pleats. */
export function patternFor(s: SegSpec, texDepth: number): LathePattern {
  const R = s.D / 2;
  let base = Math.round(clamp((TAU * R) / 1.4, 96, 360));
  let outline: ((th: number) => number) | null = null;
  if (s.shape === 'bloem' || s.shape === 'tandwiel') {
    const n = Math.round(clamp(s.n, s.shape === 'bloem' ? 3 : 6, s.shape === 'bloem' ? 16 : 48));
    const depth = s.shape === 'bloem' ? lerp(0.12, 0.45, s.v) : lerp(0.08, 0.3, s.v);
    outline = sectionFn(s.shape === 'bloem' ? 'flower' : 'gear', n, depth, 0);
    base = Math.max(base, n * 16);
  }
  const vertical = s.tex === 'plisse' || s.tex === 'ribbels';
  let segs = base;
  let pleat: ((th: number) => number) | null = null;
  if (vertical) {
    const nT = Math.round(clamp(s.texN, 8, 180));
    const k = clamp(texDepth / Math.max(R, 1), 0, 0.25);
    let per = Math.max(1, Math.round(base / (2 * nT)));
    const round = s.tex === 'ribbels' && 6 * nT <= 720;
    if (round) per = Math.max(3, per);
    segs = 2 * nT * per;
    pleat = round
      ? (th) => 1 - (k * (1 - Math.cos(nT * th))) / 2
      : (th) => {
          const u = ((nT * th) / TAU) % 1;
          return 1 - k * (1 - Math.abs(2 * u - 1));
        };
  }
  if (!outline && !pleat) return { fn: () => 1, segs, min: 1 };
  const o = outline;
  const pl = pleat;
  const fn = (th: number) => (o ? o(th) : 1) * (pl ? pl(th) : 1);
  let min = 1;
  for (let j = 0; j < segs; j++) min = Math.min(min, fn((TAU * j) / segs));
  return { fn, segs, min };
}
