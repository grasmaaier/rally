import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { AssetRef, AssetStore, ParamDef, Params } from '../core/types';
import { num, str } from '../core/types';
import { UserError } from '../core/types';
import { keep } from '../core/registry';
import { type M4, TAU, applyM4, asMat4, clamp, countersunk, deg, filletExtrude, hexagon, mul, roundedRect, rotX, rotY, rotZ, translation } from './helpers';
import { solidOfSurface, type Surface } from './surface';
import { type ShapeSpec, effectiveSpec, radialShape, shapeAssets, shapeParams, shapeSpecFrom } from './shapes2d';

/**
 * Printable furniture legs: a body of revolution (any shapes2d section, a
 * height profile, optional twist and splay) on a flat mounting plate with
 * countersunk holes for 4 mm wood screws.
 *
 * Legs are built in print orientation: the plate lies on the bed with its
 * wood side down and the foot points up, so the body never needs support.
 * Every profile is passed through a slope limiter, so whatever the user picks
 * the body never overhangs more than 45° in that orientation.
 */

export const LEG_PROFILES = [
  { value: 'straight', label: 'Recht' },
  { value: 'taper', label: 'Taps toelopend' },
  { value: 'scandi', label: 'Scandinavisch (slank, met sok)' },
  { value: 'bun', label: 'Bolpoot' },
  { value: 'hourglass', label: 'Zandloper' },
  { value: 'stepped', label: 'Getrapt' },
];

/** Sections that make sense for a leg (no hearts or drops). */
export const LEG_SECTIONS = ['circle', 'squircle', 'polygon', 'star', 'cross', 'petals', 'flower', 'scallop', 'gear', 'clover', 'cloud', 'blob', 'superformula'];

export interface LegSpec {
  /** Print height: floor to the wood (top face of the plate). */
  height: number;
  /** Body diameter just under the plate (bounding circle of the section). */
  diameter: number;
  profile: string;
  /** Foot size relative to the top (taper, scandi, stepped, hourglass). */
  foot: number;
  /** Ball size relative to the top (bun foot). */
  ball: number;
  /** Waist relative to the top (hourglass). */
  waist: number;
  section: ShapeSpec;
  /** Twist of the section over the whole height, degrees. */
  twist: number;
  /** Lean of the body away from vertical, degrees; the plate stays flat. */
  splay: number;
  /** Direction of the lean in the part frame, degrees. */
  lean: number;
  /** 'round' | 'square' | 'shape' */
  plate: string;
  plateT: number;
  holes: number;
  /** 'auto' | 'none' | 'm8' | 'dowel8' | 'dowel10' */
  core: string;
  /** 'felt' | 'level' | 'plain' | 'screw' (pilot hole for a screw from below, used for columns) */
  bottom: string;
}

export interface Leg {
  /** Print orientation: wood side of the plate at z = 0, foot up at z = height. */
  solid: Manifold;
  spec: LegSpec;
  /** Plate outline bounds in the part frame. */
  plateBox: { minX: number; maxX: number; minY: number; maxY: number };
  /** Farthest point of the plate from the leg axis. */
  plateR: number;
  plateLabel: string;
  holes: Vec2[];
  /** Foot centre (part frame, xy). */
  foot: Vec2;
  /** Radius of the circle that fits inside the foot face. */
  footR: number;
  /** Felt pad diameter that fits the recess (0 = none). */
  feltD: number;
  core: { label: string; rod: number } | null;
  /** Twist that was actually used (degrees). */
  twist: number;
  warnings: string[];
}

const SCREW = { shaft: 4.5, head: 8.6 };
const EDGE = 3.2;
/** Plate material around a screw hole. */
const LOBE = SCREW.head / 2 + EDGE;
/** Clearance between a countersink and the body (room for the screw head and bit). */
const CLEAR = SCREW.head / 2 + 0.8;
/** How far below the plate a screwdriver needs a straight path. */
const DRIVER_ZONE = 50;
const FELT_SIZES = [10, 12, 15, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 60];
const NUT_M8 = { af: 13, h: 6.5, bolt: 8.6 };
const CORES: Record<string, { d: number; label: string }> = {
  m8: { d: 8.6, label: 'M8-draadeind' },
  dowel8: { d: 8.3, label: 'houten deuvel Ø8' },
  dowel10: { d: 10.3, label: 'houten deuvel Ø10' },
};

// ---------------------------------------------------------------------------
// Height profiles: radius at axial height y above the foot (0 … L).

function profileRadius(spec: LegSpec, y: number, L: number, R: number): number {
  const t = clamp(y / L, 0, 1);
  const Rf = R * spec.foot;
  switch (spec.profile) {
    case 'taper':
      return Rf + (R - Rf) * t;
    case 'scandi': {
      // straight collar under the plate, long taper, a slightly wider "sock" at the foot
      const collar = clamp(L * 0.1, 5, 30);
      if (y >= L - collar) return R;
      const taper = (yy: number) => Rf + (R - Rf) * clamp(yy / (L - collar), 0, 1);
      const sock = clamp(L * 0.09, 6, 24);
      return y < sock ? taper(sock) + clamp(R * 0.04, 0.6, 1.2) : taper(y);
    }
    case 'bun': {
      // a ball cut flat at the floor; above its equator the neck keeps the top radius
      const Rb = R * spec.ball;
      const yc = Math.min(Rb * 0.72, L * 0.45);
      const ball = Math.sqrt(Math.max(0, Rb * Rb - (y - yc) ** 2));
      return y < yc ? ball : Math.max(ball, R);
    }
    case 'hourglass': {
      const Rw = R * spec.waist;
      const end = t >= 0.5 ? R : Rf;
      return Rw + (end - Rw) * Math.pow(Math.abs(2 * t - 1), 1.7);
    }
    case 'stepped': {
      const k = Math.min(2, Math.floor((1 - t) * 3));
      return R - ((R - Rf) * k) / 2;
    }
    default:
      return R;
  }
}

// ---------------------------------------------------------------------------
// Small 2D helpers (plain JS, no WASM objects)

type P = [number, number];

function convexHull(pts: P[]): P[] {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function segDist(px: number, py: number, a: P, b: P) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const h = l2 > 0 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - a[0] - dx * h, py - a[1] - dy * h);
}

/** Distance from a point to a CCW convex polygon (0 inside). */
function hullDist(h: P[], x: number, y: number): number {
  let inside = true;
  let d = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) inside = false;
    d = Math.min(d, segDist(x, y, a, b));
  }
  return inside ? 0 : d;
}

// ---------------------------------------------------------------------------

/** Rotation that tilts +Z by `splay` degrees toward direction `lean` (degrees) without spinning the section. */
export function splayMatrix(splay: number, lean: number): M4 {
  return mul(rotZ(lean), mul(rotY(splay), rotZ(-lean)));
}

function segmentsFor(sec: ShapeSpec, maxD: number): { segs: number; step: number } {
  const smooth = Math.round(clamp((Math.PI * maxD) / 1.6, 72, 256) / 8) * 8;
  const n = Math.max(2, Math.round(sec.count));
  switch (sec.shape) {
    case 'circle':
      return { segs: smooth, step: 8 };
    case 'polygon':
    case 'star':
    case 'cross':
    case 'petals':
    case 'flower':
    case 'scallop':
    case 'gear':
    case 'clover': {
      // pattern features must land on vertices: a multiple of 2n around
      const k = 2 * (sec.shape === 'polygon' ? Math.max(3, n) : n);
      const per = sec.shape === 'polygon' ? 24 : 16;
      return { segs: Math.min(Math.max(480, k), Math.ceil(Math.max(smooth, n * per) / k) * k), step: k };
    }
    default:
      return { segs: Math.max(smooth, 192), step: 8 };
  }
}

/**
 * Build one leg. Throws a UserError for impossible sizes; everything else is
 * adapted (with a warning) so the leg always prints without support.
 */
export function buildLeg(M: ManifoldToplevel, spec: LegSpec, assets?: AssetStore): Leg {
  const warnings: string[] = [];
  const H = spec.height;
  const T = spec.plateT;
  const R = spec.diameter / 2;
  if (H < T + 10) throw new UserError(`Een poot moet minstens ${Math.ceil(T + 10)} mm hoog zijn (inclusief de montageplaat van ${T} mm).`);
  const splay = clamp(spec.splay, 0, 15);
  const a = deg(splay);
  const L = H / Math.cos(a);
  const lean = spec.lean;
  const Rs = splayMatrix(splay, lean);
  const sec = effectiveSpec(spec.section);
  const s = radialShape(sec, assets);
  const NS = 720;
  const sv = Array.from({ length: NS }, (_, i) => s((TAU * i) / NS));
  const minS = Math.min(...sv);
  const isRound = sec.shape === 'circle';
  let twist = isRound ? 0 : deg(spec.twist);

  // steepest outward slope (radius growth per mm going up in print) that stays under 45° with the lean
  const kMax = Math.tan(deg(45 - splay));
  const kProf = twist !== 0 ? kMax * 0.85 : kMax;

  const bottom = spec.bottom;
  const rr = splay > 0 ? 0 : clamp(R * spec.foot * 0.1, 0.8, 2.5);
  let featR = 0;
  let featDepth = 0;
  if (bottom === 'level') {
    featR = (NUT_M8.af + 0.4) / Math.sqrt(3);
    featDepth = NUT_M8.h + 0.6 + 25;
  } else if (bottom === 'screw') {
    featR = 1.7;
    featDepth = 26;
  }
  if (featDepth > L - T - 6) throw new UserError(`De poot is te kort voor ${bottom === 'level' ? 'een stelvoet' : 'een schroef in de voet'}: maak hem minstens ${Math.ceil(featDepth + T + 6)} mm hoog.`);
  const Rneed = featR > 0 ? (featR + 1.8 + rr) / minS : 0;
  const fillet = clamp(R * 0.15, 1.5, 4);

  // radius table along the axis (u = 0 at the plate's wood side, u = L at the floor)
  const ext = a > 0 ? R * 2 * Math.tan(a) + 2 : 0;
  const du = 0.25;
  const N = Math.ceil((L + ext) / du) + 1;
  const us = new Float64Array(N);
  const rs = new Float64Array(N);
  let thickened = false;
  for (let i = 0; i < N; i++) {
    const u = Math.min(i * du, L + ext);
    us[i] = u;
    const y = Math.max(0, L - u);
    let r = profileRadius(spec, y, L, R);
    // concave fillet into the plate
    const d = u - T;
    r += d < 0 ? fillet : d < fillet ? fillet - Math.sqrt(fillet * fillet - (fillet - d) ** 2) : 0;
    // enough material around a nut or screw in the foot
    if (Rneed > 0) {
      const fl = Rneed - Math.max(0, y - featDepth - 2) * kProf;
      if (fl > r + 0.05) {
        if (y <= featDepth) thickened = true;
        r = fl;
      }
    }
    // rounded foot edge
    if (rr > 0 && y < rr) r -= rr - Math.sqrt(rr * rr - (rr - y) ** 2);
    r = Math.max(r, 2.5);
    if (i > 0) r = Math.min(r, rs[i - 1] + (u - us[i - 1]) * kProf);
    rs[i] = r;
  }
  if (thickened) warnings.push(bottom === 'level' ? 'De voet is wat dikker gemaakt zodat de M8-moer van de stelvoet erin past.' : 'De voet is wat dikker gemaakt zodat de schroef er stevig in zit.');
  const Rat = (u: number) => {
    const x = clamp(u / du, 0, N - 1);
    const i = Math.min(N - 2, Math.floor(x));
    return rs[i] + (rs[i + 1] - rs[i]) * (x - i);
  };
  let Rmax = 0;
  for (let i = 0; i < N; i++) Rmax = Math.max(Rmax, rs[i]);

  // Twist: the flank of a pattern that turns overhangs by about R·dφ/du.
  // Scale the twist down when that would exceed 45° anywhere.
  if (twist !== 0) {
    const dth = TAU / NS;
    const worst = (c: number) => {
      const phiP = (twist * c) / L;
      let g = -Infinity;
      for (let i = 4; i < N; i += 4) {
        if (us[i] > L) break;
        const slope = (rs[i] - rs[i - 4]) / (us[i] - us[i - 4]);
        const Ru = rs[i];
        for (let j = 0; j < NS; j += 2) {
          const sj = sv[j];
          const ds = (sv[(j + 1) % NS] - sv[(j - 1 + NS) % NS]) / (2 * dth);
          const v = (slope * sj - Ru * ds * phiP) / Math.sqrt(1 + (ds / sj) ** 2);
          if (v > g) g = v;
        }
      }
      return g;
    };
    if (worst(1) > kMax + 1e-3) {
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (worst(mid) > kMax) hi = mid;
        else lo = mid;
      }
      const before = Math.round(Math.abs(spec.twist));
      twist *= lo;
      warnings.push(`Draaiing verminderd van ${before}° naar ${Math.round(Math.abs((twist * 180) / Math.PI))}° zodat de poot zonder support print.`);
    }
  }
  const phiAt = (u: number) => twist * clamp(u / L, 0, 1);

  // rings: keep the radius within 0.03 mm and the twist within ~1 mm between rings
  const ringIdx: number[] = [0];
  for (let i0 = 0; i0 < N - 1; ) {
    let best = i0 + 1;
    for (let j = i0 + 2; j < N; j++) {
      if (us[j] - us[i0] > 8) break;
      if (Math.abs(phiAt(us[j]) - phiAt(us[i0])) * Rmax > 1) break;
      let ok = true;
      for (let m = i0 + 1; m < j && ok; m++) {
        const f = (us[m] - us[i0]) / (us[j] - us[i0]);
        if (Math.abs(rs[i0] + (rs[j] - rs[i0]) * f - rs[m]) > 0.03) ok = false;
      }
      if (!ok) break;
      best = j;
    }
    ringIdx.push(best);
    i0 = best;
  }
  const zList = ringIdx.map((i) => us[i]);
  const rList = ringIdx.map((i) => rs[i]);
  const rings = zList.length;
  let { segs, step } = segmentsFor(sec, 2 * Rmax);
  const budget = 90000;
  if (segs * rings > budget) segs = Math.max(step, Math.floor(budget / rings / step) * step);

  // body: rings at parameter z = ring index, then moved to their real heights
  const S: Surface = {
    r: (z, th) => rList[Math.round(z)] * s(th),
    phi: (z) => phiAt(zList[Math.round(z)]),
  };
  let body = solidOfSurface(M, S, 0, rings - 1, segs, rings).warpBatch((v, n) => {
    for (let i = 0; i < n; i++) v[3 * i + 2] = zList[Math.round(v[3 * i + 2])];
  });
  if (a > 0) body = body.transform(asMat4(Rs));

  const ringPts = (u: number, count: number): P[] => {
    const r = Rat(u);
    const ph = phiAt(u);
    const out: P[] = [];
    for (let j = 0; j < count; j++) {
      const th = (TAU * j) / count;
      const rr2 = r * s(th);
      const v = applyM4(Rs, [rr2 * Math.cos(th + ph), rr2 * Math.sin(th + ph), u]);
      out.push([v[0], v[1]]);
    }
    return out;
  };

  // keep-out zone for the screws: everything a screwdriver passes on its way up
  const zoneU = Math.min(L + ext, (T + DRIVER_ZONE) / Math.cos(a));
  const keepPts: P[] = [];
  for (const u of zList) if (u <= zoneU) keepPts.push(...ringPts(u, segs));
  keepPts.push(...ringPts(zoneU, segs));
  const hull = convexHull(keepPts);
  // body where it meets the plate
  const uTop = a > 0 ? T / Math.cos(a) + Rmax * Math.tan(a) + 0.5 : 0;
  const baseRings = a > 0 ? [0, uTop / 2, uTop].map((u) => ringPts(u, segs)) : [ringPts(0, segs)];
  const basePts = baseRings.flat();
  const baseMaxR = Math.max(...basePts.map(([x, y]) => Math.hypot(x, y)));
  const baseMaxXY = Math.max(...basePts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));

  // screw holes on a common circle, turned to keep the plate small
  const n = clamp(Math.round(spec.holes), 3, 4);
  const rhoFor = (g: number) => {
    const ux = Math.cos(g);
    const uy = Math.sin(g);
    let lo = 0;
    let hi = 2000;
    for (let it = 0; it < 32; it++) {
      const mid = (lo + hi) / 2;
      if (hullDist(hull, mid * ux, mid * uy) >= CLEAR) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const pref = splay > 0 ? lean + 180 / n : n === 4 ? 45 : 90;
  const offsets = [0];
  for (let d = 3; d < 180 / n; d += 3) offsets.push(d, -d);
  let best: { holes: P[]; rho: number; score: number } | null = null;
  for (const off of offsets) {
    const b = deg(pref + off);
    const angles = Array.from({ length: n }, (_, k) => b + (TAU * k) / n);
    const rho = Math.max(...angles.map(rhoFor));
    const holes = angles.map((g) => [rho * Math.cos(g), rho * Math.sin(g)] as P);
    let score: number;
    if (spec.plate === 'square') score = Math.max(...holes.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)) + LOBE), baseMaxXY + EDGE);
    else if (spec.plate === 'shape') score = rho;
    else score = Math.max(rho + LOBE, baseMaxR + EDGE);
    if (!best || score < best.score - 0.25) best = { holes, rho, score };
  }
  const { holes, rho } = best!;

  // plate
  let plateCs: CrossSection;
  let plateBox: Leg['plateBox'];
  let plateR: number;
  let plateLabel: string;
  if (spec.plate === 'square') {
    const h = best!.score;
    plateCs = roundedRect(M, 2 * h, 2 * h, Math.min(8, h * 0.35), 8);
    plateBox = { minX: -h, maxX: h, minY: -h, maxY: h };
    plateR = h * Math.SQRT2;
    plateLabel = `vierkant ${Math.round(2 * h)} × ${Math.round(2 * h)} mm`;
  } else if (spec.plate === 'shape') {
    const base = M.CrossSection.union(baseRings.map((pts) => keep(new M.CrossSection([pts], 'Positive')))).offset(EDGE, 'Round');
    const lobes = holes.map((hp) => M.CrossSection.hull([base, M.CrossSection.circle(LOBE, 48).translate(hp)]));
    plateCs = M.CrossSection.union([base, ...lobes]).offset(4, 'Round').offset(-4, 'Round');
    const b = plateCs.bounds();
    plateBox = { minX: b.min[0], maxX: b.max[0], minY: b.min[1], maxY: b.max[1] };
    plateR = Math.max(rho + LOBE, baseMaxR + EDGE) + 0.5;
    plateLabel = `vormvolgend ${Math.round(b.max[0] - b.min[0])} × ${Math.round(b.max[1] - b.min[1])} mm`;
  } else {
    const r = best!.score;
    plateCs = M.CrossSection.circle(r, 128);
    plateBox = { minX: -r, maxX: r, minY: -r, maxY: r };
    plateR = r;
    plateLabel = `rond Ø${Math.round(2 * r)} mm`;
  }
  const plate = filletExtrude(M, plateCs, T, 0.4, Math.min(1.6, T * 0.3));

  const cutters: Manifold[] = [];
  for (const [x, y] of holes) cutters.push(countersunk(M, SCREW.shaft, SCREW.head, T).rotate([180, 0, 0]).translate([x, y, T]));

  // foot
  const footV = applyM4(Rs, [0, 0, L]);
  const foot: Vec2 = [footV[0], footV[1]];
  const footR = Rat(L) * minS;
  let feltD = 0;
  if (bottom === 'felt') {
    feltD = [...FELT_SIZES].reverse().find((d) => d <= 2 * footR - 3) ?? 0;
    if (feltD > 0) cutters.push(M.Manifold.cylinder(3, feltD / 2 + 0.3, feltD / 2 + 0.3, 64).translate([foot[0], foot[1], H - 1.5]));
    else warnings.push('De voet is te smal voor een viltje: plak er een klein rond viltje of anti-slipdopje onder.');
  }
  const axis = (m: Manifold) => (a > 0 ? m.transform(asMat4(Rs)) : m);
  if (bottom === 'level') {
    // nut pressed in from the foot, bolt of the levelling foot goes up into the leg
    const extra = featR * Math.tan(a);
    cutters.push(axis(hexagon(M, NUT_M8.af + 0.4).extrude(NUT_M8.h + 0.6 + extra + ext + 2).translate([0, 0, L - NUT_M8.h - 0.6 - extra])));
    cutters.push(axis(M.Manifold.cylinder(featDepth + 1, NUT_M8.bolt / 2, NUT_M8.bolt / 2, 32).translate([0, 0, L - featDepth])));
  } else if (bottom === 'screw') {
    cutters.push(axis(M.Manifold.cylinder(featDepth + ext + 2, 1.65, 1.65, 24).translate([0, 0, L - featDepth])));
  }

  // core: a threaded rod or dowel along the axis, inserted from the plate side
  let core: Leg['core'] = null;
  const coreKind = spec.core === 'auto' ? (H >= 140 ? 'm8' : 'none') : spec.core;
  const cs = CORES[coreKind];
  if (cs) {
    const rc = cs.d / 2;
    const end = L - (bottom === 'felt' && feltD > 0 ? 1.5 : featDepth) - 5 - rc;
    let fits = end >= 30;
    for (let u = 0; fits && u <= end + rc; u += 1) if (Rat(u) * minS < rc + 1.6) fits = false;
    if (fits) {
      const tip = M.Manifold.cylinder(rc, rc, 0.05, 32).translate([0, 0, end]);
      cutters.push(axis(M.Manifold.union([M.Manifold.cylinder(end + 1, rc, rc, 32).translate([0, 0, -1]), tip])));
      core = { label: cs.label, rod: Math.max(20, Math.floor((end - 2) / 5) * 5) };
    } else if (spec.core !== 'auto') {
      warnings.push(`De poot is te dun voor een ${cs.label}: de versterking is weggelaten.`);
    }
  }

  let solid = M.Manifold.union([plate, body]);
  if (a > 0) solid = solid.trimByPlane([0, 0, 1], 0).trimByPlane([0, 0, -1], -H);
  if (cutters.length) solid = solid.subtract(M.Manifold.union(cutters));
  return { solid, spec, plateBox, plateR, plateLabel, holes, foot, footR, feltD, core, twist: (twist * 180) / Math.PI, warnings };
}

// ---------------------------------------------------------------------------
// Placing legs in an assembled view

/**
 * Scene matrix for a leg standing on the floor with the wood side of its
 * plate at height `zTop`, turned so that its lean points toward `alpha`
 * degrees (for a straight leg: just its rotation).
 */
export function legMatrix(leg: Leg, x: number, y: number, zTop: number, alpha: number): M4 {
  return mul(translation(x, y, zTop), mul(rotZ(alpha + leg.spec.lean), rotX(180)));
}

/** Plate footprint around the leg axis in the scene for a leg turned toward `alpha`. */
export function plateExtent(leg: Leg, alpha: number) {
  const m = mul(rotZ(alpha + leg.spec.lean), rotX(180));
  const b = leg.plateBox;
  const pts = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ].map(([x, y]) => applyM4(m, [x, y, 0] as Vec3));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// ---------------------------------------------------------------------------
// Form controls

export function legParams(show: (p: Params) => boolean): ParamDef[] {
  const prof = (...k: string[]) => (p: Params) => show(p) && k.includes(str(p, 'legProfile'));
  return [
    { type: 'group', label: 'Pootvorm', show },
    { type: 'select', key: 'legProfile', label: 'Profiel', options: LEG_PROFILES, default: 'taper', show },
    { type: 'number', key: 'legD', label: 'Dikte bovenaan', min: 16, max: 120, step: 1, unit: 'mm', default: 40, show },
    { type: 'number', key: 'legFoot', label: 'Dikte onderaan', min: 30, max: 100, step: 1, unit: '%', default: 60, show: prof('taper', 'scandi', 'stepped', 'hourglass') },
    { type: 'number', key: 'legBall', label: 'Bol', min: 100, max: 170, step: 1, unit: '%', default: 135, show: prof('bun'), help: 'Hoe dik de bol is ten opzichte van de bovenkant.' },
    { type: 'number', key: 'legWaist', label: 'Taille', min: 35, max: 95, step: 1, unit: '%', default: 60, show: prof('hourglass') },
    ...shapeParams('legSec', { shape: 'circle', count: 6, depth: 25, rounding: 50 }, { label: 'Doorsnede', custom: true, show, only: LEG_SECTIONS }),
    { type: 'number', key: 'legTwist', label: 'Draaiing', min: -360, max: 360, step: 5, unit: '°', default: 0, show, help: 'Mooi bij een ster, kruis of bloem als doorsnede.' },
    { type: 'number', key: 'legSplay', label: 'Schuin naar buiten', min: 0, max: 15, step: 1, unit: '°', default: 0, show, help: 'De poot helt naar buiten, de montageplaat blijft vlak.' },
    { type: 'group', label: 'Montage van de poten', show },
    {
      type: 'select', key: 'legPlate', label: 'Montageplaat', default: 'round', show,
      options: [
        { value: 'round', label: 'Rond' },
        { value: 'square', label: 'Vierkant' },
        { value: 'shape', label: 'Volgt de vorm (met lobben)' },
      ],
    },
    { type: 'number', key: 'legPlateT', label: 'Dikte montageplaat', min: 4, max: 10, step: 0.5, unit: 'mm', default: 5, show },
    {
      type: 'select', key: 'legHoles', label: 'Schroefgaten per poot', default: '4', show,
      options: [
        { value: '3', label: '3' },
        { value: '4', label: '4' },
      ],
    },
    {
      type: 'select', key: 'legCore', label: 'Versterking in de kern', default: 'auto', show,
      help: 'Een M8-draadeind of houten deuvel door het midden maakt lange poten veel sterker.',
      options: [
        { value: 'auto', label: 'Automatisch (M8 vanaf 14 cm)' },
        { value: 'none', label: 'Geen' },
        { value: 'm8', label: 'M8-draadeind' },
        { value: 'dowel8', label: 'Houten deuvel Ø8' },
        { value: 'dowel10', label: 'Houten deuvel Ø10' },
      ],
    },
    {
      type: 'select', key: 'legBottom', label: 'Onderkant', default: 'felt', show,
      options: [
        { value: 'felt', label: 'Uitsparing voor een viltje' },
        { value: 'level', label: 'Stelvoet M8 (moer in de voet)' },
        { value: 'plain', label: 'Vlak' },
      ],
    },
  ];
}

export function legSpecFrom(p: Params, height: number, over: Partial<LegSpec> = {}): LegSpec {
  return {
    height,
    diameter: num(p, 'legD'),
    profile: str(p, 'legProfile'),
    foot: num(p, 'legFoot') / 100,
    ball: num(p, 'legBall') / 100,
    waist: num(p, 'legWaist') / 100,
    section: shapeSpecFrom(p, 'legSec'),
    twist: num(p, 'legTwist'),
    splay: num(p, 'legSplay'),
    lean: 0,
    plate: str(p, 'legPlate'),
    plateT: num(p, 'legPlateT'),
    holes: Number(str(p, 'legHoles')),
    core: str(p, 'legCore'),
    bottom: str(p, 'legBottom'),
    ...over,
  };
}

export function legAssets(p: Params): AssetRef[] {
  return shapeAssets(p, 'legSec');
}

/** Short description, e.g. "Taps toelopend, Ø40 mm, 120 mm hoog". */
export function legDescription(leg: Leg): string {
  const prof = LEG_PROFILES.find((o) => o.value === leg.spec.profile)?.label ?? leg.spec.profile;
  const extra = [leg.spec.splay > 0 ? `${leg.spec.splay}° schuin` : '', Math.abs(leg.twist) >= 1 ? `${Math.round(leg.twist)}° gedraaid` : ''].filter(Boolean).join(', ');
  return `${prof}, Ø${Math.round(leg.spec.diameter)} mm, ${Math.round(leg.spec.height)} mm hoog${extra ? `, ${extra}` : ''}`;
}

/** Standard wood screw length for a plate on a board of thickness `boardT`. */
export function plateScrewLength(leg: Leg, boardT: number): number {
  const max = leg.spec.plateT + boardT - 3;
  return [10, 12, 16, 20, 25, 30, 35, 40].filter((l) => l <= max).pop() ?? 10;
}

/** Hardware for `count` legs screwed to a board of thickness `boardT`. */
export function legHardware(leg: Leg, count: number, boardT: number): [number, string, string][] {
  const rows: [number, string, string][] = [];
  rows.push([count * leg.holes.length, `Verzonken houtschroef 4 × ${plateScrewLength(leg, boardT)} mm`, `${leg.holes.length} per poot`]);
  if (leg.feltD > 0) rows.push([count, `Viltje Ø${leg.feltD} mm`, 'in de uitsparing onder de voet']);
  if (leg.spec.bottom === 'level') rows.push([count, 'Stelvoet M8 + moer M8', 'moer in de voet drukken']);
  if (leg.core) rows.push([count, `${leg.core.label} ${leg.core.rod} mm`, 'vóór het vastschroeven in de kern steken']);
  return rows;
}

/** Printing advice that applies to every leg. */
export function legTips(leg: Leg): string[] {
  const tips = [
    'Print de poten ondersteboven: de montageplaat ligt plat op het bed, zo is er nergens support nodig.',
    'Gebruik PETG of PLA+ met 4 wanden en 40% infill (gyroid): dan zijn de poten sterk genoeg om op te zitten.',
  ];
  if (leg.core) tips.push(`Steek een ${leg.core.label} van ${leg.core.rod} mm in de kern (eventueel met een druppel lijm) voordat je de plaat vastschroeft: lange poten worden zo veel stijver.`);
  else if (leg.spec.height >= 140) tips.push('Lange poot zonder versterking: kies bij "Versterking in de kern" een M8-draadeind voor extra stijfheid.');
  if (leg.spec.bottom === 'level') tips.push('Druk een M8-moer in de zeskantige uitsparing onder de voet (eventueel warm met de soldeerbout) en draai er een stelvoet in.');
  if (leg.spec.profile === 'scandi') tips.push('Mooi detail: schilder de "sok" onderaan in messing- of goudkleur.');
  return tips;
}

// ---------------------------------------------------------------------------
// Ring stand: a cylindrical skirt under a round board, split into arc segments
// with vertical dovetails when it does not fit the bed in one piece.

export interface RingSpec {
  /** Outer radius of the skirt. */
  radius: number;
  /** Floor to the wood. */
  height: number;
  wall: number;
  /** 'none' | 'diamonds' | 'slots' */
  pattern: string;
  /** Usable bed size. */
  bed: { x: number; y: number };
}

export interface Ring {
  /** One segment in print orientation: flange (wood side) at z = 0, centred on angle 0 around the Z axis. */
  solid: Manifold;
  segments: number;
  /** Angle of one segment, degrees. */
  angle: number;
  holesPerSegment: number;
  /** Radius of the screw holes in the flange. */
  holeRadius: number;
  /** Bounding box of a segment on the bed. */
  size: [number, number];
  warnings: string[];
}

const RING_FLANGE = { w: 13, t: 4 };
const DOVE = { root: 4.5, tip: 8, len: 5, clear: 0.25 };

/** Bounding box of an annulus sector of half-angle `h` (radians), centred on +X. */
function sectorBox(ro: number, ri: number, h: number): [number, number] {
  if (h >= Math.PI - 1e-9) return [2 * ro, 2 * ro];
  const ys = Math.min(h, Math.PI / 2);
  const wy = 2 * ro * Math.sin(ys);
  const maxX = ro;
  const minX = h > Math.PI / 2 ? ro * Math.cos(h) : ri * Math.cos(h);
  return [maxX - minX, wy];
}

export function buildRing(M: ManifoldToplevel, spec: RingSpec, minSegments = 1): Ring {
  const warnings: string[] = [];
  const Ro = spec.radius;
  const H = spec.height;
  const w = spec.wall;
  const Ri = Ro - w;
  const Rf = Ri - RING_FLANGE.w;
  if (Rf < 15) throw new UserError('Het plankje is te klein voor een ring: kies poten of een groter plankje.');
  if (H < RING_FLANGE.t + 8) throw new UserError(`Een ring moet minstens ${RING_FLANGE.t + 8} mm hoog zijn: maak de verhoging hoger.`);
  const postT = 8;
  const postLen = DOVE.len + 7;
  // fewest segments whose bounding box fits the bed (either way round)
  const fits = (sz: [number, number]) => (sz[0] <= spec.bed.x && sz[1] <= spec.bed.y) || (sz[1] <= spec.bed.x && sz[0] <= spec.bed.y);
  let n = Math.max(1, minSegments);
  let size: [number, number] = [2 * Ro, 2 * Ro];
  for (; n <= 64; n++) {
    if (n === 1) {
      size = [2 * Ro, 2 * Ro];
    } else {
      const h = Math.PI / n;
      const b = sectorBox(Ro, Rf, h);
      // the tongue sticks out past one end
      size = [b[0] + 2, b[1] + DOVE.len + 2];
    }
    if (fits(size)) break;
  }
  if (n > 64) throw new UserError('De ring is te groot om in stukken te printen.');
  const ang = TAU / n;
  const segPts = (r0: number, r1: number, a0: number, a1: number): Vec2[] => {
    const k = Math.max(8, Math.ceil(((a1 - a0) * r1) / 2));
    const pts: Vec2[] = [];
    for (let i = 0; i <= k; i++) {
      const a = a0 + ((a1 - a0) * i) / k;
      pts.push([r1 * Math.cos(a), r1 * Math.sin(a)]);
    }
    for (let i = k; i >= 0; i--) {
      const a = a0 + ((a1 - a0) * i) / k;
      pts.push([r0 * Math.cos(a), r0 * Math.sin(a)]);
    }
    return pts;
  };
  const annulus = (r0: number, r1: number, a0: number, a1: number) => {
    if (n === 1) return M.CrossSection.circle(r1, 256).subtract(M.CrossSection.circle(r0, 256));
    return keep(new M.CrossSection([segPts(r0, r1, a0, a1)], 'Positive'));
  };
  const h = ang / 2;
  const wallCs = annulus(Ri, Ro, -h, h);
  const flangeCs = annulus(Rf, Ro - 0.01, -h, h);
  const pieces: Manifold[] = [wallCs.extrude(H), filletExtrude(M, flangeCs, RING_FLANGE.t, 0.4, 0)];
  const cutters: Manifold[] = [];
  let tongue: Manifold | null = null;
  if (n > 1) {
    // posts at both ends hold the dovetail
    const pa = postLen / Ri;
    pieces.push(annulus(Ri - postT, Ri + 0.01, h - pa, h).extrude(H));
    pieces.push(annulus(Ri - postT, Ri + 0.01, -h, -h + pa).extrude(H));
    const rc = Ro - (w + postT) / 2;
    const dove = (e: number, grow: number) => {
      const pts: Vec2[] = [
        [rc - DOVE.root / 2 - grow, -0.5],
        [rc + DOVE.root / 2 + grow, -0.5],
        [rc + DOVE.tip / 2 + grow, DOVE.len + grow],
        [rc - DOVE.tip / 2 - grow, DOVE.len + grow],
      ];
      return keep(new M.CrossSection([pts], 'Positive')).rotate((e * 180) / Math.PI);
    };
    tongue = dove(h, 0).extrude(H);
    cutters.push(dove(-h, DOVE.clear).extrude(H + 2).translate([0, 0, -1]));
  }
  // decorative windows in the wall (pointed both ends so they print without support)
  const zone0 = RING_FLANGE.t + 5;
  const zone1 = H - 5;
  if (spec.pattern !== 'none' && zone1 - zone0 >= 12) {
    const hd = zone1 - zone0;
    const wd = spec.pattern === 'slots' ? clamp(hd * 0.2, 4, 9) : clamp(hd / 1.6, 6, 26);
    const pitch = wd * (spec.pattern === 'slots' ? 2.2 : 1.7);
    const free = n > 1 ? ang * Ro - 2 * (postLen + 4) : TAU * Ro;
    const count = Math.floor(free / pitch);
    if (count >= 1) {
      const shape: Vec2[] =
        spec.pattern === 'slots'
          ? [
              [0, -hd / 2],
              [wd / 2, -hd / 2 + wd / 2],
              [wd / 2, hd / 2 - wd / 2],
              [0, hd / 2],
              [-wd / 2, hd / 2 - wd / 2],
              [-wd / 2, -hd / 2 + wd / 2],
            ]
          : [
              [0, -hd / 2],
              [wd / 2, 0],
              [0, hd / 2],
              [-wd / 2, 0],
            ];
      const prism = keep(new M.CrossSection([shape], 'Positive')).extrude(w + 2).translate([0, 0, -1]);
      // prism: x = tangent, y = height, z = radial → place at the wall
      const base = prism.transform(asMat4(mul(translation(Ri, 0, (zone0 + zone1) / 2), [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1])));
      const step = n > 1 ? (free / count) / Ro : TAU / count;
      const start = n > 1 ? -((count - 1) * step) / 2 : 0;
      const wins: Manifold[] = [];
      for (let i = 0; i < count; i++) wins.push(base.rotate([0, 0, ((start + i * step) * 180) / Math.PI]));
      cutters.push(M.Manifold.union(wins));
    }
  }
  // countersunk holes in the flange, clear of the posts
  const hr = (Rf + Ri) / 2;
  const holeSpan = n > 1 ? ang - 2 * ((postLen + 8) / hr) : TAU;
  const holes = Math.max(2, Math.round((holeSpan * hr) / 110) + (n > 1 ? 1 : 0));
  const holeAngles: number[] = [];
  if (n > 1) for (let i = 0; i < holes; i++) holeAngles.push(-holeSpan / 2 + (holeSpan * i) / (holes - 1));
  else for (let i = 0; i < Math.max(3, holes); i++) holeAngles.push((TAU * i) / Math.max(3, holes));
  for (const a of holeAngles) cutters.push(countersunk(M, SCREW.shaft, SCREW.head, RING_FLANGE.t).rotate([180, 0, 0]).translate([hr * Math.cos(a), hr * Math.sin(a), RING_FLANGE.t]));
  let solid = M.Manifold.union(tongue ? [...pieces, tongue] : pieces);
  if (cutters.length) solid = solid.subtract(M.Manifold.union(cutters));
  const b = solid.boundingBox();
  size = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
  if (!fits(size)) {
    // the estimate was a little optimistic: one more segment
    if (n < 64) return buildRing(M, spec, n + 1);
    warnings.push('Een ringsegment is net te groot voor het bed.');
  }
  return { solid, segments: n, angle: (ang * 180) / Math.PI, holesPerSegment: holeAngles.length, holeRadius: hr, size, warnings };
}
