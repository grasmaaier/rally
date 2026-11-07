import type { Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import { keep } from '../core/registry';
import { SCREWS, TAU, asMat4, clamp, fixingHole, fromArrays, hexagon, mul, rotX, rotateOnto, roundedRect, smoothstep, translation, type M4 } from '../geom/helpers';
import { soften, softPrism } from '../geom/soft';

// ---------------------------------------------------------------------------
// Playful knobs for a kids' room. Every shape prints door-side down (the
// beehive front-side down) without support: lathed profiles are clamped to 45°
// per column, and balls / ellipsoids are cut where their side reaches 45°.

export const KID_SHAPES = [
  { value: 'donut', label: 'Donut' },
  { value: 'macaron', label: 'Macaron' },
  { value: 'bal', label: 'Bal' },
  { value: 'toren', label: 'Stapeltoren' },
  { value: 'korf', label: 'Bijenkorf' },
  { value: 'bellen', label: 'Bellenbloem' },
  { value: 'beer', label: 'Berenkop' },
  { value: 'paddenstoel', label: 'Paddenstoel met stippen' },
  { value: 'regenboog', label: 'Regenboog' },
  { value: 'blokbol', label: 'Bal op blokje' },
  { value: 'cilbol', label: 'Bal op rolletje' },
  { value: 'zeskant', label: 'Kegel op zeskant' },
];

/** Bambu PLA Matte colours that suit a kids' room (hex as in src/core/filaments.ts). */
export const KID_COLORS = [
  { value: '#e8afcf', label: 'Sakura-roze' },
  { value: '#a3d8e1', label: 'IJsblauw' },
  { value: '#f7d959', label: 'Citroengeel' },
  { value: '#c2e189', label: 'Appelgroen' },
  { value: '#ae96d4', label: 'Lilapaars' },
  { value: '#f99963', label: 'Mandarijnoranje' },
  { value: '#ffffff', label: 'Ivoorwit' },
  { value: '#d3b7a7', label: 'Lattebruin' },
  { value: '#e8dbb7', label: 'Woestijnbruin' },
  { value: '#56b7e6', label: 'Hemelsblauw' },
  { value: '#61c680', label: 'Grasgroen' },
  { value: '#de4343', label: 'Scharlakenrood' },
];

export type KidUse = 'rings' | 'petals' | 'bands' | 'dots';
/** The one extra setting a shape has. */
export const KID_USES: Record<string, KidUse | undefined> = { toren: 'rings', korf: 'rings', bellen: 'petals', regenboog: 'bands', paddenstoel: 'dots' };

export interface KidSpec {
  shape: string;
  /** Overall width (mm). */
  D: number;
  /** Height factor: 1 = the standard proportions. */
  tall: number;
  rings: number;
  petals: number;
  bands: number;
  dots: number;
  screw: string;
  mount: string;
}

/** A suggested colour from a print height on (colour change on a layer). */
export interface ColorStep {
  from: number;
  what: string;
  color: string;
}

export interface KidKnob {
  solid: Manifold;
  /** Print → use: door face at z = 0, front towards +z, screw on the z axis. */
  toUse: M4;
  height: number;
  tips: string[];
  warnings: string[];
  colors: ColorStep[];
}

interface Draft {
  solid: Manifold;
  /** Print height. */
  H: number;
  /** Material above the door face where the screw goes. */
  avail: number;
  /** Screw position (print coordinates) when it is not on the z axis. */
  at?: Vec2;
  /** Printed front-down: the door face is the top. */
  flip?: boolean;
  colors: ColorStep[];
  tips?: string[];
}

interface Ctx {
  holeR: number;
  /** Radius of the hole above the nut pocket (an insert counts as the hole all the way up). */
  shaftR: number;
  /** Hole depth the fixing needs. */
  need: number;
  /** Height of the nut / insert pocket at the door face. */
  pocket: number;
  warnings: string[];
}

type Builder = (M: ManifoldToplevel, k: KidSpec, c: Ctx) => Draft;

const PASTEL = ['Sakura-roze', 'Mandarijnoranje', 'Citroengeel', 'Appelgroen', 'IJsblauw', 'Lilapaars'];
const RAINBOW = ['Scharlakenrood', 'Mandarijnoranje', 'Citroengeel', 'Grasgroen', 'Hemelsblauw'];

/** Radius of the hole a fixing needs (nut: corner of the hex). */
export function kidHoleR(screw: string, mount: string) {
  const s = SCREWS[screw] ?? SCREWS.M4;
  return mount === 'nut' ? (s.nutAF + 0.3) / Math.sqrt(3) : mount === 'insert' ? s.insertD / 2 : s.pilot / 2;
}

// ---- geometry helpers ------------------------------------------------------

/** Balls sit a little lower than their 45° point, so the tessellated faces near the bed stay under 45°. */
const CUT = 0.96;
/** Centre height of an ellipsoid (ax, ay, b) on the bed, cut where its side reaches 45°. */
const lift = (ax: number, ay: number, b: number) => (CUT * b * b) / Math.hypot(Math.max(ax, ay), b);
const segsOf = (r: number) => clamp(Math.round(r * 2) * 4, 32, 112);
const latheSegs = (D: number) => clamp(Math.round(D * 3), 72, 160);
const hash = (i: number) => {
  const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  return x - Math.floor(x);
};

function ellipsoid(M: ManifoldToplevel, ax: number, ay: number, b: number, at: Vec3): Manifold {
  return M.Manifold.sphere(1, segsOf(Math.max(ax, ay, b))).scale([ax, ay, b]).translate(at);
}

/** Ellipsoid with a keel down to a point straight below it: its underside is carried at 45°. */
function drop(M: ManifoldToplevel, ax: number, ay: number, b: number, at: Vec3): Manifold {
  const k = Math.hypot(Math.max(ax, ay), b) / CUT;
  return M.Manifold.hull([ellipsoid(M, ax, ay, b, at), [at[0], at[1], at[2] - k]]);
}

/**
 * Solid of revolution from an (r, z) profile that runs from the axis at the
 * bottom round the outside to the axis at the top. `bump` adds radial relief.
 * Per column the radius may grow at most as fast as z (45°), so it never
 * needs support: steeper undersides become 45° chamfers.
 */
function lathe(M: ManifoldToplevel, prof: Vec2[], segs: number, bump?: (th: number, z: number) => number): Manifold {
  const pts: Vec2[] = [];
  for (const q of prof) {
    const l = pts[pts.length - 1];
    if (l && Math.abs(l[0] - q[0]) < 1e-3 && Math.abs(l[1] - q[1]) < 1e-3) continue;
    pts.push(q);
  }
  const z0 = pts[0][1];
  const zTop = pts[pts.length - 1][1];
  const ring = pts.slice(1, -1);
  const K = ring.length;
  const S = segs;
  const R = new Float64Array(K * S);
  for (let j = 0; j < S; j++) {
    const th = (TAU * j) / S;
    for (let k = 0; k < K; k++) {
      const [r0, z] = ring[k];
      const r = Math.max(0.05, r0 + (bump ? bump(th, z) : 0));
      const lim = k === 0 ? (z > z0 + 1e-6 ? z - z0 : Infinity) : R[(k - 1) * S + j] + Math.max(0, z - ring[k - 1][1]);
      R[k * S + j] = Math.min(r, lim);
    }
  }
  const pos: number[] = [0, 0, z0];
  for (let k = 0; k < K; k++) {
    const z = ring[k][1];
    for (let j = 0; j < S; j++) {
      const th = (TAU * j) / S;
      const r = R[k * S + j];
      pos.push(r * Math.cos(th), r * Math.sin(th), z);
    }
  }
  pos.push(0, 0, zTop);
  const top = 1 + K * S;
  const v = (k: number, j: number) => 1 + k * S + (j % S);
  const tri: number[] = [];
  for (let j = 0; j < S; j++) tri.push(0, v(0, j + 1), v(0, j));
  for (let k = 0; k < K - 1; k++)
    for (let j = 0; j < S; j++) {
      const a = v(k, j);
      const b = v(k, j + 1);
      const c = v(k + 1, j + 1);
      const d = v(k + 1, j);
      tri.push(a, b, c, a, c, d);
    }
  for (let j = 0; j < S; j++) tri.push(top, v(K - 1, j), v(K - 1, j + 1));
  return fromArrays(M, pos, tri);
}

/** Taller: stretch (sides only get steeper). Lower: sink into the bed, so nothing gets flatter than 45°. */
function tallen(solid: Manifold, H: number, t: number) {
  if (t >= 1) return { solid: solid.scale([1, 1, t]), H: H * t, z: (z: number) => z * t };
  const sink = (1 - t) * H;
  return { solid: solid.translate([0, 0, -sink]).trimByPlane([0, 0, 1], 0), H: H - sink, z: (z: number) => z - sink };
}

/** Profile of stacked rounded rings (radius per ring, bottom first). */
function ringStack(radii: number[], hk: number): Vec2[] {
  const g = 0.32 * hk;
  const out: Vec2[] = [];
  radii.forEach((Rk, k) => {
    for (let i = 0; i <= 16; i++) {
      const u = (1 - Math.cos((Math.PI * i) / 16)) / 2;
      out.push([Rk - g + g * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)), (k + u) * hk]);
    }
  });
  return out;
}

const ringColors = (n: number, hk: number): ColorStep[] =>
  Array.from({ length: n }, (_, i) => ({ from: i * hk, what: `ring ${i + 1}`, color: PASTEL[i % PASTEL.length] }));

/** Half annulus (an arch) with straight legs reaching `legs` below its centre line. */
function arch(M: ManifoldToplevel, ro: number, ri: number, legs: number) {
  const n = 72;
  const pts: Vec2[] = [[ro, -legs]];
  for (let i = 0; i <= n; i++) pts.push([ro * Math.cos((Math.PI * i) / n), ro * Math.sin((Math.PI * i) / n)]);
  pts.push([-ro, -legs], [-ri, -legs]);
  for (let i = n; i >= 0; i--) pts.push([ri * Math.cos((Math.PI * i) / n), ri * Math.sin((Math.PI * i) / n)]);
  pts.push([ri, -legs]);
  return keep(new M.CrossSection([pts]));
}

// ---- shapes ----------------------------------------------------------------

const donut: Builder = (M, k, c) => {
  const R = k.D / 2;
  const a = 0.4 * R;
  const cr = 0.6 * R;
  const b = 1.15 * a * k.tall;
  const zc = (b * b) / Math.hypot(a, b);
  const H = zc + b;
  const u0 = -Math.atan2(b, a);
  const prof: Vec2[] = [[0, 0]];
  for (let i = 0; i <= 56; i++) {
    const u = u0 + ((Math.PI / 2 - u0) * i) / 56;
    prof.push([cr + a * Math.cos(u), zc + b * Math.sin(u)]);
  }
  // the hole of the donut is a shallow crater; its floor carries the screw
  const zf = clamp(c.need + 1.6, zc + 0.35 * b, zc + 0.8 * b);
  const kk = 0.3 * b;
  const tube = (r: number) => {
    const q = (r - cr) / a;
    return q * q < 1 ? zc + b * Math.sqrt(1 - q * q) : -1e3;
  };
  const smax = (x: number, y: number) => {
    const h = clamp(0.5 + (0.5 * (x - y)) / kk, 0, 1);
    return y + (x - y) * h + kk * h * (1 - h);
  };
  for (let i = 1; i <= 48; i++) {
    const r = cr * (1 - i / 48);
    prof.push([r, smax(tube(r), zf)]);
  }
  return {
    solid: lathe(M, prof, latheSegs(k.D)),
    H,
    avail: zf,
    colors: [
      { from: 0, what: 'deeg', color: 'Lattebruin' },
      { from: zc + 0.2 * b, what: 'glazuur', color: 'Sakura-roze' },
    ],
  };
};

const bal: Builder = (M, k) => {
  const R = k.D / 2;
  const b = 0.92 * R * k.tall;
  const zc = (b * b) / Math.hypot(R, b);
  const u0 = -Math.atan2(b, R);
  const prof: Vec2[] = [[0, 0]];
  for (let i = 0; i < 64; i++) {
    const u = u0 + ((Math.PI / 2 - u0) * i) / 64;
    prof.push([R * Math.cos(u), zc + b * Math.sin(u)]);
  }
  prof.push([0, zc + b]);
  return { solid: lathe(M, prof, latheSegs(k.D)), H: zc + b, avail: zc + b, colors: [] };
};

const macaron: Builder = (M, k) => {
  const R = k.D / 2;
  const H = 0.56 * k.D * k.tall;
  const hs1 = 0.36 * H;
  const z2 = hs1 + 0.26 * H;
  const Rf = R - 0.05 * k.D;
  const step = (a: number, b: number) => {
    const n = Math.max(1, Math.ceil((b - a) / 0.2));
    return Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);
  };
  const prof: Vec2[] = [[0, 0]];
  // bottom shell: a rounded edge from the bed (45°) to its widest, then the ruffled foot
  const ex = 0.3 * R;
  const ez = 0.5 * hs1;
  const zE = (ez * ez) / Math.hypot(ex, ez);
  const u0 = -Math.atan2(ez, ex);
  for (let i = 0; i <= 16; i++) {
    const u = u0 * (1 - i / 16);
    prof.push([R - ex + ex * Math.cos(u), zE + ez * Math.sin(u)]);
  }
  const zF1 = Math.max(zE + 0.3, 0.5 * hs1);
  prof.push([R, zF1]);
  for (const z of step(zF1, hs1)) prof.push([R - 0.3, z]);
  // the filling bulges a little
  prof.push([Rf, hs1]);
  for (const z of step(hs1, z2)) prof.push([Rf + 0.35 * Math.sin((Math.PI * (z - hs1)) / (z2 - hs1)), z]);
  // top shell: the foot flares out at 45°, then the dome (a superellipse, flat on top)
  const zF2 = z2 + (R - 0.3 - Rf);
  prof.push([R - 0.3, zF2]);
  const zD = zF2 + 0.3 * (H - zF2);
  for (const z of step(zF2, zD)) prof.push([R - 0.3, z]);
  for (let i = 1; i <= 40; i++) {
    const s = Math.sin((Math.PI / 2) * (i / 40));
    prof.push([i === 40 ? 0 : R * Math.pow(1 - Math.pow(s, 2.2), 1 / 2.2), zD + (H - zD) * s]);
  }
  // the ruffled feet ("pied"): irregular little pleats
  const nR = Math.max(18, Math.round((TAU * R) / 2.4));
  const win = (z: number, a: number, b: number) => smoothstep(a, a + 0.3 * (b - a), z) * (1 - smoothstep(b - 0.25 * (b - a), b, z));
  const bump = (th: number, z: number) => {
    const w = win(z, zF1, hs1) + win(z, zF2, zD);
    if (w <= 0) return 0;
    const ph = nR * th + 0.9 * Math.sin(3 * th + 0.4) + 0.6 * Math.sin(7 * th + 1.3);
    const amp = 1.1 * (0.75 + 0.25 * Math.sin(5 * th + 2.1));
    return amp * w * (0.5 + 0.5 * Math.sin(ph)) ** 1.5;
  };
  return {
    solid: lathe(M, prof, Math.max(192, nR * 6), bump),
    H,
    avail: H,
    colors: [
      { from: 0, what: 'onderste koekje', color: 'Sakura-roze' },
      { from: hs1, what: 'vulling', color: 'Ivoorwit' },
      { from: z2, what: 'bovenste koekje', color: 'Sakura-roze' },
    ],
  };
};

/** Stacking-ring toy: rings that get smaller towards the front, a ball on top. */
const toren: Builder = (M, k) => {
  const R = k.D / 2;
  const n = clamp(Math.round(k.rings), 3, 6);
  const rb = 0.36 * R;
  const hk = Math.max(2.4, (0.95 * k.D * k.tall - 1.45 * rb) / n);
  const Hr = n * hk;
  const zb = Hr + 0.45 * rb;
  const H = zb + rb;
  const radii = Array.from({ length: n }, (_, i) => R * (1 - (0.42 * i) / (n - 1)));
  const prof: Vec2[] = [[0, 0], ...ringStack(radii, hk)];
  const p0 = Math.asin((Hr - zb) / rb);
  for (let i = 0; i < 28; i++) {
    const ph = p0 + ((Math.PI / 2 - p0) * i) / 28;
    prof.push([rb * Math.cos(ph), zb + rb * Math.sin(ph)]);
  }
  prof.push([0, H]);
  return { solid: lathe(M, prof, latheSegs(k.D)), H, avail: H, colors: [...ringColors(n, hk), { from: Hr, what: 'bolletje', color: 'Ivoorwit' }] };
};

/** Beehive: rings that get smaller towards the door. Printed front-down, the door face on top. */
const korf: Builder = (M, k, c) => {
  const R = k.D / 2;
  const n = clamp(Math.round(k.rings), 3, 6);
  const hk = Math.max(2.4, (0.8 * k.D * k.tall) / n);
  const g = 0.32 * hk;
  const H = n * hk;
  const rLast = Math.min(R, Math.max(0.55 * R, c.holeR + 2 + g));
  const radii = Array.from({ length: n }, (_, i) => R + ((rLast - R) * i) / (n - 1));
  return {
    solid: lathe(M, [[0, 0], ...ringStack(radii, hk), [0, H]], latheSegs(k.D)),
    H,
    avail: H,
    flip: true,
    colors: ringColors(n, hk),
    tips: ['Geprint met de voorkant op het bed: die wordt mooi vlak (met het patroon van je printplaat). De deurkant met het schroefgat ligt boven.'],
  };
};

/** Flower of capsule petals with ball ends round a raised heart. */
const bellen: Builder = (M, k, c) => {
  const R = k.D / 2;
  const N = clamp(Math.round(k.petals), 5, 8);
  const s = Math.sin(Math.PI / N);
  const rb = (R * s) / (1.2 + s);
  const rho2 = R - rb;
  const r1 = 0.7 * rb;
  const rho1 = 0.3 * R;
  const rc = 0.34 * R;
  const rh = 0.8 * rc;
  const zh = lift(rh, rh, rh);
  const zPetal = lift(rb, rb, rb) + rb;
  // the heart is carried by a smaller ball on the bed: high enough above it, the hull stays under 45°
  const zC = Math.max(zPetal - 0.4 * rc, zh + (rc - rh) / (Math.SQRT1_2 * CUT));
  const pieces: Manifold[] = [];
  for (let i = 0; i < N; i++) {
    const a = Math.PI / 2 + (TAU * i) / N;
    const [cx, cy] = [Math.cos(a), Math.sin(a)];
    pieces.push(
      M.Manifold.hull([
        M.Manifold.sphere(r1, segsOf(r1)).translate([rho1 * cx, rho1 * cy, lift(r1, r1, r1)]),
        M.Manifold.sphere(rb, segsOf(rb)).translate([rho2 * cx, rho2 * cy, lift(rb, rb, rb)]),
      ]),
    );
  }
  pieces.push(M.Manifold.hull([M.Manifold.sphere(rh, segsOf(rh)).translate([0, 0, zh]), M.Manifold.sphere(rc, segsOf(rc)).translate([0, 0, zC])]));
  // a collar round the nut / insert pocket, topped at 45°
  const rcol = c.holeR + 1.4;
  if (c.pocket > 0) pieces.push(M.Manifold.cylinder(c.pocket + 1, rcol, rcol, 48));
  pieces.push(M.Manifold.cylinder(rcol, rcol, 0, 48).translate([0, 0, c.pocket > 0 ? c.pocket + 1 : 0]));
  const tl = tallen(M.Manifold.union(pieces).trimByPlane([0, 0, 1], 0), zC + rc, k.tall);
  return {
    solid: tl.solid,
    H: tl.H,
    avail: tl.H,
    colors: [
      { from: 0, what: 'bellen', color: 'Sakura-roze' },
      { from: tl.z(zPetal), what: 'hartje', color: 'Citroengeel' },
    ],
  };
};

const beer: Builder = (M, k, c) => {
  const Rh = k.D / 2.1;
  const ay = 0.94 * Rh;
  const bh = 0.72 * Rh;
  const zh = lift(Rh, ay, bh);
  const surf = (x: number, y: number) => zh + bh * Math.sqrt(Math.max(0, 1 - (x / Rh) ** 2 - (y / ay) ** 2));
  const parts: Manifold[] = [ellipsoid(M, Rh, ay, bh, [0, 0, zh])];
  // round ears with a dimple
  const re = 0.36 * Rh;
  const ce = 1.2 * re;
  const ze = lift(re, re, ce);
  for (const sx of [-1, 1]) {
    const dx = sx * Math.sin((42 * Math.PI) / 180);
    const dy = Math.cos((42 * Math.PI) / 180);
    const ex = 0.98 * Rh * dx;
    const ey = 0.98 * ay * dy;
    const dimple = M.Manifold.sphere(0.55 * re, segsOf(0.55 * re)).translate([ex + 0.18 * re * dx, ey + 0.18 * re * dy, ze + ce + 0.3 * re]);
    parts.push(ellipsoid(M, re, re, ce, [ex, ey, ze]).subtract(dimple));
  }
  // snout and nose: drops that sink into the face
  const [sa, sb, sc] = [0.36 * Rh, 0.29 * Rh, 0.26 * Rh];
  const ys = -0.34 * ay;
  const zs = surf(0, ys) - 0.4 * sc;
  parts.push(drop(M, sa, sb, sc, [0, ys, zs]));
  const [na, nb, nc] = [0.13 * Rh, 0.1 * Rh, 0.09 * Rh];
  const zn = zs + sc * Math.sqrt(1 - 0.09) - 0.3 * nc;
  parts.push(drop(M, na, nb, nc, [0, ys - 0.3 * sb, zn]));
  const eye = { x: 0.34 * Rh, y: 0.12 * ay, r: 0.075 * Rh };
  const eyes = [-1, 1].map((sx) => M.Manifold.cylinder(8, eye.r, eye.r, 24).translate([sx * eye.x, eye.y, surf(eye.x, eye.y) - 1.6]));
  const raw = M.Manifold.union(parts).subtract(M.Manifold.union(eyes)).trimByPlane([0, 0, 1], 0);
  const tl = tallen(raw, raw.boundingBox().max[2], k.tall);
  // on a small head a wide hole runs on under the eye sockets: it stops 1.2 mm below them
  const underEyes = c.shaftR + 1.2 > Math.hypot(eye.x, eye.y) - eye.r;
  return {
    solid: tl.solid,
    H: tl.H,
    avail: tl.z(underEyes ? Math.min(zh + bh, surf(eye.x, eye.y) - 1.2) : zh + bh),
    colors: [],
    tips: ['Een lichte snuit? Kleur hem in Bambu Studio met het kleurpenseel (slim vullen) in een tweede kleur.'],
  };
};

const paddenstoel: Builder = (M, k, c) => {
  const R = k.D / 2;
  const rs = Math.max(0.34 * R, c.holeR + 2.4);
  const hs = 0.16 * k.D * k.tall;
  const e = 0.16 * R;
  const hd = 0.52 * R * k.tall;
  const zr = hs + R - e + Math.SQRT2 * e - rs;
  const H = zr + hd;
  const prof: Vec2[] = [[0, 0]];
  for (let i = 0; i <= 12; i++) {
    const z = (hs * i) / 12;
    prof.push([rs * (1 + 0.12 * (1 - smoothstep(0, 0.6 * hs, z))), z]);
  }
  // the underside of the cap is a 45° cone up to the rounded rim
  const k45 = Math.SQRT1_2 * e;
  prof.push([R - e + k45, zr - k45]);
  for (let i = 1; i <= 10; i++) {
    const ph = -Math.PI / 4 + ((Math.PI / 4) * i) / 10;
    prof.push([R - e + e * Math.cos(ph), zr + e * Math.sin(ph)]);
  }
  for (let i = 1; i <= 40; i++) {
    const v = (Math.PI / 2) * (i / 40);
    prof.push([i === 40 ? 0 : R * Math.cos(v), zr + hd * Math.sin(v)]);
  }
  const pieces = [lathe(M, prof, latheSegs(k.D))];
  // dots: flat lenses on the cap, one near the top and a ring round it
  const nd = clamp(Math.round(k.dots), 0, 9);
  const spots: [number, number, number][] = nd > 0 ? [[0.12 * R, 0.6, 1.05]] : [];
  for (let i = 1; i < nd; i++) spots.push([0.6 * R * (0.95 + 0.1 * hash(i)), (TAU * (i - 1)) / (nd - 1) + 0.2 * (hash(i + 7) - 0.5), 0.8 + 0.35 * hash(i + 3)]);
  for (const [rho, th, size] of spots) {
    const ad = 0.16 * R * size;
    const cd = 0.4 * ad;
    const v = Math.acos(clamp(rho / R, 0, 1));
    const n0: Vec3 = [(Math.cos(v) / R) * Math.cos(th), (Math.cos(v) / R) * Math.sin(th), Math.sin(v) / hd];
    const l = Math.hypot(...n0);
    const n: Vec3 = [n0[0] / l, n0[1] / l, n0[2] / l];
    const P: Vec3 = [rho * Math.cos(th), rho * Math.sin(th), zr + hd * Math.sin(v)];
    const at = mul(translation(P[0] - 0.35 * cd * n[0], P[1] - 0.35 * cd * n[1], P[2] - 0.35 * cd * n[2]), rotateOnto([0, 0, 1], n));
    pieces.push(M.Manifold.sphere(1, 40).scale([ad, ad, cd]).transform(asMat4(at)));
  }
  return {
    solid: M.Manifold.union(pieces),
    H,
    avail: H,
    colors: [
      { from: 0, what: 'steel', color: 'Ivoorwit' },
      { from: hs, what: 'hoed', color: 'Scharlakenrood' },
    ],
    tips: nd > 0 ? ['Witte stippen: kleur ze in Bambu Studio met het kleurpenseel; "slim vullen" pakt een hele stip in één klik.'] : [],
  };
};

/** A rainbow lying on the door: bands that rise towards the inside. The screw sits in the middle of the arch. */
const regenboog: Builder = (M, k, c) => {
  const R = k.D / 2;
  const span = 2 * c.holeR + 3.2;
  const rin = R - 0.3 * R >= span ? 0.3 * R : Math.max(0.12 * R, R - span);
  if (R - rin < span - 0.01) c.warnings.push('De regenboog is te smal voor dit schroefgat: kies een bredere knop of een kleinere bevestiging.');
  const n = clamp(Math.round(k.bands), 3, 5);
  const w = (R - rin) / n;
  const legs = 0.18 * R;
  const H = 0.5 * k.D * k.tall;
  const hOf = (i: number) => H * (0.55 + (0.45 * i) / (n - 1));
  // the screw goes under the tall inner bands (deepest hole), with a wall of 2 mm to the inside
  const yh = Math.min(rin + c.holeR + 2, (R + rin) / 2);
  const pieces: Manifold[] = [];
  for (let i = 0; i < n; i++) {
    const ro = R - i * w;
    // each band runs on 1 mm under its taller inner neighbour: no grooves on the bed between the bands
    const ri = i === n - 1 ? rin : Math.max(rin, R - (i + 1) * w - 1);
    // round leg ends; the top rounding must stay below their radius or the top face folds over
    const cv = 0.45 * (ro - ri);
    pieces.push(softPrism(M, soften(arch(M, ro, ri, legs), cv, 0), hOf(i), { rTop: Math.min(1.2, 0.4 * w, 0.75 * cv), chamfer: 0.4 }));
  }
  let avail = H;
  for (let i = 0; i < n; i++) {
    if (R - (i + 1) * w < yh + c.holeR + 0.8 && R - i * w > yh - c.holeR - 0.8) avail = Math.min(avail, hOf(i));
  }
  return {
    solid: M.Manifold.union(pieces),
    H,
    avail,
    at: [0, yh],
    colors: Array.from({ length: n }, (_, i) => ({ from: i === 0 ? 0 : hOf(i - 1), what: `boog ${i + 1}`, color: RAINBOW[i] })),
    tips: ['Eén schroef midden in de boog: een stukje dubbelzijdig tape onder de pootjes houdt hem recht.'],
  };
};

/** A ball on a soft block (or a short cylinder). */
const ballOn = (round: boolean): Builder => (M, k) => {
  const W = k.D;
  const hb = 0.32 * k.D * k.tall;
  // fine corners: softPrism limits the top rounding to the local curvature it measures
  const cs = round ? M.CrossSection.circle(W / 2, latheSegs(k.D)) : roundedRect(M, W, W, 0.18 * W, 32);
  const base = softPrism(M, cs, hb, { rTop: Math.min(0.13 * W, 0.45 * hb), chamfer: 0.4 });
  const rB = 0.36 * k.D;
  // the ball sinks into the block down to its 45° point
  const zB = hb - 0.4 + CUT * Math.SQRT1_2 * rB;
  const H = zB + rB;
  return {
    solid: M.Manifold.union([base, M.Manifold.sphere(rB, segsOf(rB)).translate([0, 0, zB])]),
    H,
    avail: H,
    colors: [
      { from: 0, what: round ? 'rolletje' : 'blokje', color: 'IJsblauw' },
      { from: hb, what: 'bal', color: 'Citroengeel' },
    ],
  };
};

const zeskant: Builder = (M, k, c) => {
  const AF = (Math.sqrt(3) / 2) * k.D;
  const hb = 0.32 * k.D * k.tall;
  // the top rounding stays below the corner radius, or the top face folds over
  const rTop = Math.min(0.08 * k.D, 0.45 * hb);
  const base = softPrism(M, soften(hexagon(M, AF), 0.1 * k.D, 0), hb, { rTop, chamfer: 0.4 });
  const r0 = Math.min(0.36 * k.D, AF / 2 - rTop - 0.6);
  const r1 = 0.1 * k.D;
  const H = hb + 0.5 * k.D * k.tall;
  const zc = H - r1;
  const cone = M.Manifold.hull([
    M.Manifold.cylinder(0.3, r0, r0, latheSegs(k.D)).translate([0, 0, hb - 0.3]),
    M.Manifold.sphere(r1, segsOf(r1)).translate([0, 0, zc]),
  ]);
  // the cone narrows: the hole ends where 1.2 mm of wall is left round it (the line from the
  // cone foot to the ball's equator lies inside the cone, so this is on the safe side)
  const rWall = c.shaftR + 1.2;
  const avail = rWall >= r0 ? hb : Math.min(H, hb + ((r0 - rWall) / (r0 - r1)) * (zc - hb) + 1.6);
  return {
    solid: M.Manifold.union([base, cone]),
    H,
    avail,
    colors: [
      { from: 0, what: 'zeskant', color: 'Lilapaars' },
      { from: hb, what: 'kegel', color: 'Mandarijnoranje' },
    ],
  };
};

const BUILDERS: Record<string, Builder> = {
  donut,
  macaron,
  bal,
  toren,
  korf,
  bellen,
  beer,
  paddenstoel,
  regenboog,
  blokbol: ballOn(false),
  cilbol: ballOn(true),
  zeskant,
};

export function buildKid(M: ManifoldToplevel, k: KidSpec): KidKnob {
  const s = SCREWS[k.screw] ?? SCREWS.M4;
  const need = k.mount === 'nut' ? s.nutH + 4 : k.mount === 'insert' ? s.insertL + 1 : 8;
  const pocket = k.mount === 'nut' ? s.nutH + 0.41 : k.mount === 'insert' ? s.insertL : 0;
  const shaftR = k.mount === 'nut' ? s.clear / 2 : k.mount === 'insert' ? s.insertD / 2 : s.pilot / 2;
  const warnings: string[] = [];
  const d = (BUILDERS[k.shape] ?? donut)(M, k, { holeR: kidHoleR(k.screw, k.mount), shaftR, need, pocket, warnings });
  const shapeWarned = warnings.length > 0;
  const depth = Math.max(3, Math.min(16, d.avail - 1.6));
  if (depth < need - 0.05) warnings.push(`Het schroefgat is maar ${depth.toFixed(1)} mm diep: maak de knop hoger of breder voor meer grip.`);
  let cut = fixingHole(M, k.screw, k.mount, depth);
  if (d.flip) cut = cut.rotate([180, 0, 0]).translate([0, 0, d.H]);
  const [hx, hy] = d.at ?? [0, 0];
  const solid = d.solid.subtract(cut.translate([hx, hy, 0]));
  // a blind hole leaves one closed body: anything else means the fixing breaks out somewhere
  if (!shapeWarned && (solid.genus() !== d.solid.genus() || solid.decompose().length > 1))
    warnings.push('Het schroefgat komt door de knop naar buiten: kies een bredere of hogere knop, of een kleinere bevestiging.');
  const toUse = d.flip ? mul(translation(0, 0, d.H), rotX(180)) : translation(-hx, -hy, 0);
  const tips = d.flip ? [...(d.tips ?? [])] : ['Geprint met de deurkant op het bed: alle onderkanten lopen onder 45°, dus er is geen support nodig.', ...(d.tips ?? [])];
  return { solid, toUse, height: d.H, tips, warnings, colors: d.colors };
}
