import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { InfoBlock, ParamDef, Params, PartOut, Preset, PrinterProfile } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { keep } from '../core/registry';
import { fitsOn, usable } from '../core/printer';
import { SCREWS, TAU, asMat4, clamp, filletExtrude, teardrop } from '../geom/helpers';
import { effectiveSpec, shapeCross } from '../geom/shapes2d';
import { CUPS } from './toothbrush';

// ---------------------------------------------------------------------------
// Wall hooks ("Wandhaak") for the knobs & handles tool.
//
// Use coordinates: x out of the wall (back of the plate at x = 0), y up,
// z along the wall. Hooks with a side profile (single, double, J, ball) are a
// profile in the xy plane lofted along z: they print lying on their side
// (z up), so the layers run through the whole arm and are never pulled apart
// by the load. The key rail stands on its bottom edge (use y = print z): its
// arms lie flat on the bed. Pegs print standing on their back (x = print z)
// with the screw through their axis carrying the bending.
//
// Holes in the back plate lie horizontal when printed, so they are teardrops
// (point towards print-up) and every pocket has 45° walls: all support-free.

export const HOOK_STYLES = [
  { value: 'single', label: 'Enkele haak' },
  { value: 'double', label: 'Dubbele haak (kapstok)' },
  { value: 'ball', label: 'Jashaak met bol' },
  { value: 'j', label: 'J-haak (diep)' },
  { value: 'rail', label: 'Sleutelrekje (meerdere haakjes)' },
  { value: 'peg', label: 'Minimalistische pin' },
  { value: 'knob', label: 'Knop als haak (zelfde vorm als de knoppen)' },
];

/** 3M Command strips — guide values, measure your own strips. */
export const COMMAND_STRIPS: Record<string, { label: string; w: number; l: number; tab: number; kg: number }> = {
  medium: { label: 'Command medium', w: 19, l: 70, tab: 16, kg: 1.3 },
  large: { label: 'Command large', w: 19, l: 92, tab: 16, kg: 2.2 },
};

/** Conservative holding force per suction cup on smooth tiles (kg). */
const CUP_KG: Record<string, number> = { ha011: 1, g40: 1, g30: 0.5 };

/**
 * Allowed long-term bending stress (MPa) along the layers, with a safety factor
 * of about 5 on the flexural strength of 100% infill prints and room for creep.
 * Across the layers (peel) a printed part holds about a third of that.
 */
export const STRESS = { PETG: 8, PLA: 6.5 };
const PEEL = 0.35;

const N_CIRCLE = 28;

type Up = 'a' | 'b';

// ---- 2D helpers in the wall plane (a = along the wall = use z, b = up = use y) ----

/** Teardrop of radius r at (a, b), point towards print-up. */
function td(M: ManifoldToplevel, r: number, a: number, b: number, up: Up): CrossSection {
  const t = teardrop(M, r, 32);
  return (up === 'a' ? t.rotate(-90) : t).translate([a, b]);
}

/** Slot (hull of teardrops) from b0 to b1 at a. */
function slot(M: ManifoldToplevel, r: number, a: number, b0: number, b1: number, up: Up): CrossSection {
  if (Math.abs(b1 - b0) < 0.01) return td(M, r, a, b0, up);
  return M.CrossSection.hull([td(M, r, a, b0, up), td(M, r, a, b1, up)]);
}

/**
 * A wall-plane shape as a prism from x0 (back) to x1 (front). With `scale`
 * the shape (centred on the origin, placed at `at`) shrinks towards x0.
 */
function prismX(cs: CrossSection, x0: number, x1: number, at: Vec2 = [0, 0], scale = 1): Manifold {
  const h = x1 - x0;
  const ex = scale === 1 ? cs.extrude(h) : cs.extrude(h, 0, 0, [scale, scale]);
  return ex.transform(asMat4([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, x1, at[1], at[0], 1]));
}

/**
 * Rectangle recess in the back face (x = 0) with 45° walls, open below b0:
 * width w along the wall around a, from b0 up to b1, depth d.
 */
function recess(M: ManifoldToplevel, a: number, w: number, b0: number, b1: number, d: number): Manifold {
  const pts: Vec3[] = [];
  const back = 0.6;
  for (const da of [-1, 1]) {
    pts.push([-back, b0, a + da * (w / 2 + back)], [-back, b1 + back, a + da * (w / 2 + back)]);
    pts.push([d, b0, a + da * (w / 2 - d)], [d, b1 - d, a + da * (w / 2 - d)]);
  }
  return M.Manifold.hull(pts);
}

/** 45° roof (ridge along b) over a flat ceiling at a = aTop, b0..b1, x0..x1. */
function tent(M: ManifoldToplevel, aTop: number, b0: number, b1: number, x0: number, x1: number): Manifold {
  const h = (x1 - x0) / 2;
  const xm = (x0 + x1) / 2;
  const a0 = aTop - 0.02;
  return M.Manifold.hull([[x0, b0, a0], [x1, b0, a0], [x0, b1, a0], [x1, b1, a0], [xm, b0, a0 + h], [xm, b1, a0 + h]]);
}

// ---- mounting -------------------------------------------------------------

export interface MountSpec {
  kind: string;
  /** Minimum plate thickness. */
  T: number;
  /** Vertical room the mount needs around its position (below, above). */
  below: number;
  above: number;
  /** Half width along the wall. */
  half: number;
  /** Load the mount can take per fixing (kg). */
  kg: number;
  label: string;
}

function screwOf(p: Params) {
  return SCREWS[str(p, 'screw')] ?? SCREWS.M4;
}

const CAP_DEPTH = 2.2;

export function mountSpec(p: Params): MountSpec {
  const kind = str(p, 'whMount');
  const s = screwOf(p);
  const headR = s.headD / 2 + 0.3;
  const plateT = num(p, 'whPlateT');
  if (kind === 'keyhole') {
    const kh = keyholeDims(p);
    return { kind, T: Math.max(plateT, kh.lip + kh.pocket + 1.6), below: kh.rHead + 1.5, above: kh.travel + kh.rHead + 1.5, half: kh.rHead * Math.SQRT2 + kh.pocket / 2 + 1.2, kg: 5, label: `sleutelgat voor ${s.label} schroef` };
  }
  if (kind === 'suction') {
    const kh = keyholeDims(p);
    const cup = CUPS[str(p, 'whCup')] ?? CUPS.ha011;
    return { kind, T: Math.max(plateT, kh.lip + kh.pocket + 1.6), below: Math.max(kh.rHead + 1.5, cup.cupD / 2), above: kh.travel + kh.rHead + 1.5, half: kh.rHead * Math.SQRT2 + kh.pocket / 2 + 1.2, kg: CUP_KG[str(p, 'whCup')] ?? 1, label: `zuignap ${cup.label}` };
  }
  if (kind === 'adhesive') {
    const c = COMMAND_STRIPS[str(p, 'whCmd')] ?? COMMAND_STRIPS.medium;
    return { kind, T: Math.max(plateT, 3), below: 0, above: c.l - c.tab, half: c.w / 2 + 0.8, kg: c.kg, label: `${c.label}-strip` };
  }
  if (kind === 'insert') {
    return { kind, T: Math.max(plateT, s.insertL + 2.5), below: s.insertD, above: s.insertD, half: s.insertD * 0.8 + 1.2, kg: s.label === 'M3' ? 5 : s.label === 'M4' ? 8 : 10, label: `${s.label} inzetmoer met stokeinde` };
  }
  const cap = bool(p, 'whCap');
  const capR = headR + 0.8;
  return {
    kind: 'screws',
    T: Math.max(plateT, (headR - s.clear / 2) + (cap ? CAP_DEPTH : 0) + 1.6),
    below: (cap ? capR : headR) + 2,
    above: (cap ? capR : headR) + 2,
    half: (cap ? capR : headR) * Math.SQRT2 + 1.2,
    kg: 10,
    label: `verzonken ${s.label === 'M3' ? '3' : s.label === 'M4' ? '4' : '5'} mm schroef`,
  };
}

function keyholeDims(p: Params) {
  if (str(p, 'whMount') === 'suction') {
    const cup = CUPS[str(p, 'whCup')] ?? CUPS.ha011;
    const clr = 0.4;
    const rHead = cup.headD / 2 + clr;
    const rShank = cup.neckD / 2 + 0.25;
    return { rHead, rShank, lip: Math.max(1.2, cup.neckL - 0.2), pocket: cup.headH + 0.6, travel: rHead + rShank + 1 };
  }
  const s = screwOf(p);
  const rHead = s.headD / 2 + 0.6;
  const rShank = s.clear / 2 + 0.1;
  return { rHead, rShank, lip: 2.4, pocket: 3.4, travel: rHead + rShank + 1.5 };
}

/**
 * Cutters (and extra parts) for the fixings at wall-plane positions `at`
 * (a, b) in a plate from x = 0 (wall) to x = T. For keyholes b is where the
 * screw ends up (top of the slot).
 */
export function mountCutters(M: ManifoldToplevel, p: Params, T: number, at: Vec2[], up: Up): Manifold[] {
  const kind = str(p, 'whMount');
  const s = screwOf(p);
  const cuts: Manifold[] = [];
  for (const [a, b] of at) {
    if (kind === 'keyhole' || kind === 'suction') {
      const k = keyholeDims(p);
      const bE = b - k.travel;
      cuts.push(prismX(M.CrossSection.union([td(M, k.rHead, a, bE, up), slot(M, k.rShank, a, bE, b, up)]), -1, k.lip + 0.01));
      cuts.push(prismX(slot(M, k.rHead, a, bE, b, up), k.lip, k.lip + k.pocket));
      if (up === 'a') {
        // the slots lie horizontal when printed: a 45° tent over their flat tops instead of a bridge
        cuts.push(tent(M, a + k.rShank * Math.SQRT2, bE, b, -1, k.lip + 0.01));
        cuts.push(tent(M, a + k.rHead * Math.SQRT2, bE, b, k.lip, k.lip + k.pocket));
      }
    } else if (kind === 'insert') {
      cuts.push(prismX(td(M, s.insertD / 2, a, b, up), -1, s.insertL + 0.3));
      cuts.push(prismX(td(M, s.clear / 2, a, b, up), -1, Math.min(T - 1.2, s.insertL + 3)));
    } else if (kind === 'screws') {
      const headR = s.headD / 2 + 0.3;
      const shaftR = s.clear / 2;
      const cap = bool(p, 'whCap');
      const xHead = cap ? T - CAP_DEPTH : T;
      const sink = headR - shaftR;
      cuts.push(prismX(td(M, shaftR, a, b, up), -1, xHead));
      cuts.push(prismX(td(M, headR, 0, 0, up), xHead - sink, xHead, [a, b], shaftR / headR));
      cuts.push(prismX(td(M, cap ? headR + 0.8 : headR, a, b, up), xHead - 0.01, T + 1));
    }
  }
  return cuts;
}

/** Press-in cover cap for a countersunk screw recess (teardrop, like the recess); printed face down. */
function coverCap(M: ManifoldToplevel, p: Params): Manifold {
  const s = screwOf(p);
  const r = s.headD / 2 + 0.3 + 0.8 - 0.15;
  return filletExtrude(M, teardrop(M, r, 32), CAP_DEPTH - 0.1, 0.6, 0);
}

// ---- lofted convex pieces (side-printed hooks) ------------------------------

type Piece = { kind: 'caps'; c: [number, number, number][] } | { kind: 'box'; x0: number; x1: number; y0: number; y1: number; r: number };

function circlePts(x: number, y: number, r: number, z: number, out: Vec3[], n = N_CIRCLE) {
  for (let i = 0; i < n; i++) out.push([x + r * Math.cos((TAU * i) / n), y + r * Math.sin((TAU * i) / n), z]);
}

function layerPts(pc: Piece, ins: number, z: number, out: Vec3[]) {
  if (pc.kind === 'caps') {
    for (const [x, y, r] of pc.c) circlePts(x, y, Math.max(0.35, r - ins), z, out);
    return;
  }
  const ix = Math.min(ins, (pc.x1 - pc.x0) / 2 - 0.3);
  const iy = Math.min(ins, (pc.y1 - pc.y0) / 2 - 0.3);
  const x0 = pc.x0 + ix;
  const x1 = pc.x1 - ix;
  const y0 = pc.y0 + iy;
  const y1 = pc.y1 - iy;
  // square at the wall side, rounded at the front
  const r = clamp(pc.r - Math.min(ix, iy) * 0.5, 0.2, Math.min(x1 - x0, (y1 - y0) / 2) - 0.05);
  out.push([x0, y0, z], [x0, y1, z]);
  for (let i = 0; i <= 6; i++) {
    const t = (Math.PI / 2) * (i / 6);
    out.push([x1 - r + r * Math.cos(t), y1 - r + r * Math.sin(t), z]);
    out.push([x1 - r + r * Math.cos(-t), y0 + r + r * Math.sin(-t), z]);
  }
}

/**
 * Edge profile along the width: a teardrop fillet at the bed side (round down
 * to 45°, then a 45° chamfer) and a full round on top. [z, inset] pairs.
 */
export function edgeLayers(W: number, e: number): [number, number][] {
  e = clamp(e, 0, W / 2.2);
  if (e < 0.3) return [[0, 0], [W, 0]];
  const L: [number, number][] = [[0, 0.586 * e]];
  for (const phi of [45, 30, 15, 0]) {
    const f = (phi * Math.PI) / 180;
    L.push([e * (1 - Math.sin(f)), e * (1 - Math.cos(f))]);
  }
  for (let i = 0; i <= 6; i++) {
    const f = ((i * 15) * Math.PI) / 180;
    L.push([W - e * (1 - Math.sin(f)), e * (1 - Math.cos(f))]);
  }
  return L.filter((l, i) => i === 0 || l[0] > L[i - 1][0] + 1e-6);
}

function loft(M: ManifoldToplevel, pieces: Piece[], layers: [number, number][]): Manifold {
  const solids: Manifold[] = [];
  for (const pc of pieces)
    for (let i = 0; i < layers.length - 1; i++) {
      const pts: Vec3[] = [];
      layerPts(pc, layers[i][1], layers[i][0], pts);
      layerPts(pc, layers[i + 1][1], layers[i + 1][0], pts);
      solids.push(M.Manifold.hull(pts));
    }
  return M.Manifold.union(solids);
}

/** Circles along a polyline, as hull pieces (each consecutive pair is convex). */
function stroke(path: [number, number, number][]): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < path.length - 1; i++) out.push({ kind: 'caps', c: [path[i], path[i + 1]] });
  return out;
}

// ---- arm shapes ----------------------------------------------------------

interface Arm {
  pieces: Piece[];
  /** Extent in front of the plate (for screw access and plate size). */
  yMin: number;
  yMax: number;
  xMax: number;
  /** Lowest point the plate has to reach to carry the arm. */
  rootLow: number;
  rootHigh: number;
  /** Lever (mm) and section height (mm) at the root, for the load estimate. */
  lever: number;
  t: number;
}

/** Arm thickness along the path: constant, or tapering for the soft look. */
const radiusAt = (soft: boolean, r0: number) => (u: number) => (soft ? r0 * (1.12 - 0.32 * u) : r0);

/** Out from (x0, y0), bend up with radius rb, straight up to the tip. */
function upturnPath(x0: number, y0: number, L: number, tip: number, r0: number, soft: boolean, xFront: number) {
  const rTip = soft ? r0 * 0.95 : r0;
  const xt = xFront + L - rTip;
  const pts: Vec2[] = [[x0, y0]];
  const rise = Math.max(0, tip - rTip);
  if (rise < 1) {
    pts.push([xt, y0]);
  } else {
    const rb = clamp(Math.min(rise, (xt - xFront) * 0.6), r0 * 0.6, 40);
    const xc = xt - rb;
    pts.push([Math.max(x0 + 0.5, xc), y0]);
    for (let i = 1; i <= 8; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / 8);
      pts.push([xc + rb * Math.cos(a), y0 + rb + rb * Math.sin(a)]);
    }
    if (rise > rb + 0.2) pts.push([xt, y0 + rise]);
  }
  // arc-length parameter for the taper
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len[len.length - 1] || 1;
  const rad = radiusAt(soft, r0);
  const path = pts.map((q, i) => [q[0], q[1], rad(len[i] / total)] as [number, number, number]);
  if (soft) path[path.length - 1][2] = r0 * 1.05;
  return path;
}

function armOf(p: Params, T: number): Arm {
  const style = str(p, 'whStyle');
  const soft = str(p, 'whLook') === 'soft';
  const L = num(p, 'whReach');
  const t = num(p, 'whThick');
  const r0 = t / 2;
  const tip = num(p, 'whTip');
  const pieces: Piece[] = [];
  // gusset where the arm leaves the plate: carries the bending into the plate
  const gusset = (y: number, g: number): Piece => ({ kind: 'caps', c: [[T - 1.2, y - r0 - g, 1.2], [T - 1.2, y + r0 + g, 1.2], [T + g, y, r0]] });
  const fromPath = (path: [number, number, number][]) => {
    pieces.push(...stroke(path));
    let yMin = Infinity, yMax = -Infinity, xMax = -Infinity;
    for (const [x, y, r] of path) {
      if (x + r > T) {
        yMin = Math.min(yMin, y - r);
        yMax = Math.max(yMax, y + r);
      }
      xMax = Math.max(xMax, x + r);
    }
    return { yMin, yMax, xMax };
  };
  if (style === 'j') {
    if (L < t * 2.2) throw new UserError(`Een J-haak met een arm van ${t} mm dik moet minstens ${Math.ceil(t * 2.2)} mm uitsteken.`);
    // the long leg of the J is the plate; the bowl hangs at its bottom
    const Rj = (L - r0) / 2;
    const xc = T - r0 + Rj;
    const rad = radiusAt(soft, r0);
    const path: [number, number, number][] = [];
    for (let i = 0; i <= 18; i++) {
      const a = Math.PI + (Math.PI * i) / 18;
      path.push([xc + Rj * Math.cos(a), Rj * Math.sin(a), rad(i / 24)]);
    }
    if (tip > 1) path.push([xc + Rj, tip, rad(1)]);
    if (soft) path[path.length - 1][2] = r0 * 1.05;
    const e = fromPath(path);
    return { pieces, ...e, rootLow: -Rj * 0.75 - r0, rootHigh: r0 + 2, lever: Rj + r0, t };
  }
  if (style === 'ball') {
    const rB = num(p, 'whBall') / 2;
    if (rB < r0 + 1) throw new UserError('De bol moet minstens 2 mm dikker zijn dan de arm.');
    const ang = (num(p, 'whAngle') * Math.PI) / 180;
    const xb = T + L - rB;
    if (xb - T < rB * 0.6 + 4) throw new UserError(`De arm is te kort voor een bol van ${2 * rB} mm: maak de uitsteek minstens ${Math.ceil(rB * 1.6 + 4)} mm.`);
    const yb = (xb - T) * Math.tan(ang);
    const rad = radiusAt(soft, r0);
    const path: [number, number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      path.push([T - r0 + (xb - T + r0) * u, yb * u, rad(u * 0.8)]);
    }
    const e = fromPath(path);
    pieces.push({ kind: 'caps', c: [[xb, yb, rB]] });
    pieces.push(gusset(0, Math.min(4, L / 5)));
    return { pieces, yMin: Math.min(e.yMin, yb - rB), yMax: Math.max(e.yMax, yb + rB), xMax: Math.max(e.xMax, xb + rB), rootLow: -r0 - 2, rootHigh: r0 + 2, lever: xb - T, t };
  }
  const e = fromPath(upturnPath(T - r0, 0, L, tip, r0, soft, T));
  pieces.push(gusset(0, Math.min(4, L / 5)));
  if (style === 'double') {
    // a shorter, higher hook for hats and scarves; clear of the lower tip
    const dy = Math.max(tip + t + 8, 2 * t + 10);
    const e2 = fromPath(upturnPath(T - r0, dy, Math.max(L * 0.55, t * 1.5), Math.max(tip * 0.6, 0), r0, soft, T));
    pieces.push(gusset(dy, Math.min(4, L / 6)));
    return { pieces, yMin: Math.min(e.yMin, e2.yMin), yMax: Math.max(e.yMax, e2.yMax), xMax: Math.max(e.xMax, e2.xMax), rootLow: -r0 - 2, rootHigh: dy + r0 + 2, lever: L, t };
  }
  return { pieces, ...e, rootLow: -r0 - 2, rootHigh: r0 + 2, lever: L, t };
}

// ---- load guidance ----------------------------------------------------------

export interface Rating {
  petg: number;
  pla: number;
  limit: string;
}

/** Load (kg) a section with modulus S (mm³) holds at `lever` mm, in- or across-layer, capped by the mount. */
export function rateSection(S: number, lever: number, peel: boolean, mountKg: number, mountLabel: string): Rating {
  const k = peel ? PEEL : 1;
  const kg = (sigma: number) => (sigma * k * S) / Math.max(5, lever) / 9.81;
  const petg = kg(STRESS.PETG);
  const pla = kg(STRESS.PLA);
  const cap = (v: number) => Math.min(v, mountKg);
  return { petg: cap(petg), pla: cap(pla), limit: petg > mountKg ? mountLabel : peel ? 'de laaghechting in de hals' : 'de arm (buiging)' };
}

/** Section modulus (mm³) of a cross-section for bending under a load along -b (y). */
export function sectionModulus(cs: CrossSection): number {
  let A = 0, Sy = 0;
  const polys = cs.toPolygons();
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const c = x0 * y1 - x1 * y0;
      A += c / 2;
      Sy += ((y0 + y1) * c) / 6;
    }
  if (Math.abs(A) < 1e-9) return 0;
  const yc = Sy / A;
  let I = 0, yMax = 0;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0a] = poly[i];
      const [x1, y1a] = poly[(i + 1) % poly.length];
      const y0 = y0a - yc;
      const y1 = y1a - yc;
      const c = x0 * y1 - x1 * y0;
      I += ((y0 * y0 + y0 * y1 + y1 * y1) * c) / 12;
      yMax = Math.max(yMax, Math.abs(y0));
    }
  return Math.abs(I) / Math.max(yMax, 1e-6);
}

export function ratingInfo(r: Rating, perHook?: Rating): InfoBlock {
  const f = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const rows: [string, string][] = [['Draagvermogen (richtwaarde)', `≈ ${f(r.petg)} kg in PETG · ${f(r.pla)} kg in PLA`]];
  if (perHook) rows.push(['Per haakje', `≈ ${f(perHook.petg)} kg in PETG · ${f(perHook.pla)} kg in PLA`]);
  rows.push(['Beperkt door', r.limit]);
  rows.push(['Uitgangspunt', '100% infill (of 6 wanden), rustige belasting; halveer bij rukken of schokken (tassen, jassen die je eraf trekt)']);
  return { kind: 'kv', title: 'Belasting', rows };
}

export const LOAD_TIPS = [
  'Print in PETG: taaier dan PLA, kruipt minder onder blijvende belasting en wordt pas zacht rond 75 °C (PLA rond 55 °C, dus niet naast de verwarming of in de zon).',
  'Gebruik 100% infill of minstens 6 wandlussen: dan is de haak massief waar de kracht zit.',
];

// ---- side-printed hooks ----------------------------------------------------

interface HookOut {
  solid: Manifold;
  tips: string[];
  warnings: string[];
  extra: PartOut[];
  info: InfoBlock[];
}

function sideHook(M: ManifoldToplevel, p: Params, printer: PrinterProfile): HookOut {
  const tips: string[] = [];
  const warnings: string[] = [];
  const ms = mountSpec(p);
  const T = ms.T;
  if (T > num(p, 'whPlateT') + 0.05) tips.push(`De achterplaat is ${T.toFixed(1)} mm dik gemaakt: zoveel ruimte heeft de bevestiging nodig.`);
  const arm = armOf(p, T);
  const kind = ms.kind;
  const nFix = kind === 'adhesive' ? clamp(Math.round(num(p, 'whCmdN')), 1, 2) : kind === 'insert' ? 1 : clamp(Math.round(num(p, 'whScrewN')), 1, 2);
  let W = num(p, 'whWidth');
  const needW = kind === 'adhesive' ? nFix * (2 * ms.half) + (nFix - 1) * 2 + 3 : 2 * ms.half + 2;
  if (W < needW) {
    tips.push(`De haak is ${needW.toFixed(0)} mm breed gemaakt zodat de bevestiging past.`);
    W = needW;
  }
  const e = Math.min(num(p, 'whEdge'), W / 2.2);
  // where the fixings go: above the highest part of the arm (the screwdriver must reach
  // the head from the front) and, for a second one, below the lowest part
  let yTop = arm.rootHigh;
  let yBot = arm.rootLow;
  const at: Vec2[] = [];
  const cup = CUPS[str(p, 'whCup')] ?? CUPS.ha011;
  if (kind === 'screws') {
    const bt = arm.yMax + ms.below + 1;
    at.push([W / 2, bt]);
    yTop = Math.max(yTop, bt + ms.above);
    if (nFix === 2) {
      const bb = arm.yMin - ms.above - 1;
      at.push([W / 2, bb]);
      yBot = Math.min(yBot, bb - ms.below);
    }
  } else if (kind === 'keyhole' || kind === 'suction') {
    // hidden: the keyhole may sit right behind the arm; the plate leans on the wall below it
    const bt = Math.max(arm.rootHigh, 0) + ms.above - 1;
    at.push([W / 2, bt]);
    yTop = Math.max(yTop, bt + ms.below * (kind === 'suction' ? 0 : 1) + 2);
    if (kind === 'keyhole' && nFix === 2) {
      const bb = arm.rootLow - ms.below - 2;
      at.push([W / 2, bb]);
      yBot = Math.min(yBot, bb - ms.above);
    }
    if (kind === 'suction') {
      // the cup sits around the slot top; a pad at the bottom keeps the plate parallel to the wall
      yTop = Math.max(yTop, bt + keyholeDims(p).rHead + 2.5);
      yBot = Math.min(yBot, bt - cup.cupD / 2 - 14);
    }
  } else if (kind === 'insert') {
    at.push([W / 2, 0]);
  } else {
    // adhesive: strips from the plate bottom up, the pull tab hangs below the plate
    const len = ms.above;
    if (yTop - yBot < len + 3) yTop = yBot + len + 3;
  }
  const H = yTop - yBot;
  // the plate keeps its full thickness around the fixings (and a flat back for strips); the arm may be as round as asked
  const ePlate = kind === 'adhesive' ? Math.min(e, 1.5) : clamp(W / 2 - ms.half, 0.5, e);
  const plate = loft(M, [{ kind: 'box', x0: 0, x1: T, y0: yBot, y1: yTop, r: Math.min(T * 0.45, 3) }], edgeLayers(W, ePlate));
  let solid = M.Manifold.union([plate, loft(M, arm.pieces, edgeLayers(W, e))]).trimByPlane([1, 0, 0], 0);
  if (kind === 'suction') {
    const s = cup.standoff;
    const ph = Math.max(10, s + 4);
    solid = solid.add(loft(M, [{ kind: 'box', x0: -s, x1: 0.5, y0: yBot, y1: yBot + ph, r: 1 }], edgeLayers(W, Math.min(e, 2))));
    tips.push(`Het voetje onderaan staat ${s} mm van de muur, net als de aangedrukte zuignap: zo hangt de haak recht.`);
  }
  const cuts = mountCutters(M, p, T, at, 'a');
  if (kind === 'adhesive') {
    const c = COMMAND_STRIPS[str(p, 'whCmd')] ?? COMMAND_STRIPS.medium;
    const pitch = W / nFix;
    for (let i = 0; i < nFix; i++) cuts.push(recess(M, pitch * (i + 0.5), c.w + 1, yBot - 1, yBot + c.l - c.tab, 0.5));
  }
  if (cuts.length) solid = solid.subtract(M.Manifold.union(cuts));
  const extra: PartOut[] = [];
  if (kind === 'screws' && bool(p, 'whCap')) extra.push({ name: 'Afdekdopje', solid: coverCap(M, p), quantity: at.length });
  const b = solid.boundingBox();
  const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  if (!fitsOn(printer, size)) throw new UserError(`De haak (${size[0].toFixed(0)} × ${size[1].toFixed(0)} mm) past niet op de ${printer.name}. Maak hem kleiner.`);
  // load estimate: arm root section W × t, bent along the layers
  const S = (Math.max(1, W - 0.6 * e) * arm.t * arm.t) / 6;
  const rating = rateSection(S, arm.lever, false, ms.kg * (kind === 'suction' ? 1 : nFix), nFix > 1 ? `de bevestiging (${nFix}× ${ms.label})` : `de bevestiging (${ms.label})`);
  tips.unshift('Geprint op zijn kant: de printlagen lopen door de hele haak, dus de last trekt ze nooit uit elkaar. Geen support nodig.');
  return { solid, tips, warnings, extra, info: [ratingInfo(rating), { kind: 'kv', title: 'Maat', rows: [['Haak', `${size[0].toFixed(0)} uit de muur × ${H.toFixed(0)} hoog × ${W.toFixed(0)} breed mm`]] }] };
}

// ---- key rail (prints standing on its bottom edge) -------------------------

/** Plate outline in the wall plane with round top corners and 45° bottom corners. */
function railOutline(M: ManifoldToplevel, L: number, H: number, r: number): CrossSection {
  const pts: Vec2[] = [];
  r = Math.min(r, L / 2 - 0.5, H / 2 - 0.5);
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = ((a0 + ((a1 - a0) * i) / 8) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  const k = r * (Math.SQRT2 - 1);
  pts.push([L - r + k, 0]);
  arc(L - r, r, -45, 0);
  arc(L - r, H - r, 0, 90);
  arc(r, H - r, 90, 180);
  arc(r, r, 180, 225);
  pts.push([r - k, 0]);
  return keep(new M.CrossSection([pts]));
}

/** Side profile (x out, y up) of one rail hook: flat on the bed, 45° outer bend, upright tip. */
function railFinger(M: ManifoldToplevel, T: number, L: number, t: number, tip: number, soft: boolean): CrossSection {
  const xt = T + L;
  const tipTop = Math.max(t, tip + t * 0.5);
  const c = Math.min(t * 0.9, L * 0.4, tipTop * 0.5);
  const tt = t * 0.85;
  const pts: Vec2[] = [[T - 1, 0], [xt - c, 0], [xt, c], [xt, tipTop], [xt - tt, tipTop], [xt - tt, t], [T - 1, t]];
  let cs = keep(new M.CrossSection([pts]));
  // round the top of the tip, fillet the inner bend
  cs = cs.offset(1.2, 'Round', 2, 24).offset(-1.2, 'Round', 2, 24);
  if (soft) {
    // a drop on the tip: round on top, 45° below so it prints without support
    const rb = t * 0.62;
    const drop = teardrop(M, rb, 32).rotate(180).translate([xt - tt / 2, tipTop]);
    cs = cs.add(drop);
  } else {
    const cap = M.CrossSection.circle(tt / 2, 32).translate([xt - tt / 2, tipTop]);
    cs = cs.add(cap.intersect(M.CrossSection.square([tt + 2, tt]).translate([xt - tt - 1, tipTop])));
  }
  return cs.intersect(M.CrossSection.square([L + T + 20, tipTop + t * 2 + 10]).translate([0, 0]));
}

function rail(M: ManifoldToplevel, p: Params, printer: PrinterProfile): HookOut {
  const tips: string[] = [];
  const warnings: string[] = [];
  const ms = mountSpec(p);
  const kind = ms.kind;
  const T = ms.T;
  const n = clamp(Math.round(num(p, 'whCount')), 2, 12);
  const pitch = num(p, 'whPitch');
  const t = num(p, 'whThick');
  const soft = str(p, 'whLook') === 'soft';
  const reach = num(p, 'whReach');
  const tip = num(p, 'whTip');
  let wf = num(p, 'whWidth');
  if (wf > pitch - 6) {
    wf = Math.max(6, pitch - 6);
    tips.push(`De haakjes zijn ${wf.toFixed(0)} mm breed gemaakt, zodat er tussen twee haakjes ruimte blijft.`);
  }
  if (pitch - wf < 6) throw new UserError('De afstand tussen de haakjes is te klein: maak hem minstens 12 mm.');
  const cup = CUPS[str(p, 'whCup')] ?? CUPS.ha011;
  const nFix = kind === 'suction' ? 2 : kind === 'adhesive' ? clamp(Math.round(num(p, 'whCmdN')), 1, 4) : clamp(Math.round(num(p, 'whScrewN')), 1, 2) === 1 && n <= 3 ? 1 : 2;
  const endM = kind === 'suction' ? cup.cupD / 2 + 2 : kind === 'adhesive' ? 6 : 2 * ms.half + 4;
  const span = (n - 1) * pitch + wf;
  const Lr = span + 2 * Math.max(endM, 6);
  const u = usable(printer);
  if (Lr > Math.max(u.x, u.y)) throw new UserError(`Het rekje wordt ${Lr.toFixed(0)} mm lang en past niet op de ${printer.name} (max. ${Math.max(u.x, u.y)} mm). Kies minder haakjes of een kleinere afstand.`);
  // height: the arm at the bottom, the fixings above it
  const kh = keyholeDims(p);
  const yFix = kind === 'adhesive' ? 0 : t + 2 + (kind === 'screws' || kind === 'insert' ? ms.below : kh.rHead + kh.travel + 1);
  let Hr = Math.max(num(p, 'whRailH'), t + 12);
  if (kind === 'adhesive') Hr = Math.max(Hr, ms.above + 3);
  else Hr = Math.max(Hr, yFix + (kind === 'screws' || kind === 'insert' ? ms.above : kh.rHead * Math.SQRT2 + 2.5));
  if (Hr > num(p, 'whRailH') + 0.05) tips.push(`Het rekje is ${Hr.toFixed(0)} mm hoog gemaakt: zoveel ruimte heeft de bevestiging nodig.`);
  // plate: wall-plane outline (a along, b up) as a prism through x = 0..T
  const plate = prismX(railOutline(M, Lr, Hr, Math.min(6, Hr / 3)), 0, T);
  const fingers: Manifold[] = [];
  const prof = railFinger(M, T, reach, t, tip, soft);
  const x0 = (Lr - span) / 2;
  for (let i = 0; i < n; i++) fingers.push(prof.extrude(wf).translate([0, 0, x0 + i * pitch]));
  let solid = M.Manifold.union([plate, ...fingers]);
  // fixings between the outer hooks and the ends
  // fixings between the outer hooks and the ends (strips spread evenly)
  const endA = Math.max(ms.half + 2, endM / 2 + 1);
  const twoFit = kind !== 'suction' || Lr - 2 * endA >= cup.cupD + 2;
  const fixA = nFix === 1 || !twoFit ? [Lr / 2] : kind === 'adhesive' ? Array.from({ length: nFix }, (_, i) => Lr * ((i + 0.5) / nFix)) : [endA, Lr - endA];
  const at: Vec2[] = fixA.map((a) => [a, yFix] as Vec2);
  const cuts = mountCutters(M, p, T, at, 'b');
  if (kind === 'adhesive') {
    const c = COMMAND_STRIPS[str(p, 'whCmd')] ?? COMMAND_STRIPS.medium;
    for (const a of fixA) cuts.push(recess(M, a, c.w + 1, -1, c.l - c.tab, 0.5));
    if (nFix * (c.w + 3) > Lr) throw new UserError('Zoveel plakstrips passen niet op dit rekje: kies er minder.');
  }
  if (kind === 'suction') {
    // pads at the bottom back, as deep as the cups stand off the wall
    const s = cup.standoff;
    for (const a of [Math.min(12, Lr / 4), Lr - Math.min(12, Lr / 4)]) solid = solid.add(M.Manifold.cube([s + 0.5, Math.max(8, s + 2), 12]).translate([-s, 0, a - 6]));
    tips.push(`De voetjes onderaan staan ${s} mm van de muur, net als de aangedrukte zuignappen: zo hangt het rekje recht.`);
  }
  if (cuts.length) solid = solid.subtract(M.Manifold.union(cuts));
  const extra: PartOut[] = [];
  if (kind === 'screws' && bool(p, 'whCap')) extra.push({ name: 'Afdekdopje', solid: coverCap(M, p), quantity: at.length });
  // print standing on the bottom edge: use y → print z
  solid = solid.rotate([90, 0, 0]);
  const S = (wf * t * t) / 6;
  const per = rateSection(S, reach, false, Infinity, '');
  const total = rateSection(S * n, reach, false, ms.kg * nFix, `de bevestiging (${nFix}× ${ms.label})`);
  tips.unshift('Geprint staand op de onderkant: de haakjes liggen plat op het bed en de lagen lopen door elk haakje heen. Geen support nodig.');
  if (Lr > 200) tips.push('Lang en smal: zet een rand (brim) van 5 mm aan, dan blijft het rekje goed op het bed liggen.');
  return { solid, tips, warnings, extra, info: [ratingInfo(total, per), { kind: 'kv', title: 'Maat', rows: [['Rekje', `${Lr.toFixed(0)} × ${Hr.toFixed(0)} mm, ${n} haakjes om de ${pitch} mm`]] }] };
}

// ---- minimalist peg (prints standing on its back) -------------------------

function pegSection(M: ManifoldToplevel, p: Params, D: number): CrossSection {
  const shape = str(p, 'whPegShape');
  if (shape === 'pill') {
    const h = D * 1.6;
    return M.CrossSection.hull([M.CrossSection.circle(D / 2, 48).translate([0, -(h - D) / 2]), M.CrossSection.circle(D / 2, 48).translate([0, (h - D) / 2])]);
  }
  if (shape === 'pebble') {
    const spec = effectiveSpec({ shape: 'blob', count: 3, depth: 0.05 + 0.4 * (num(p, 'whPegDepth') / 100), rounding: 0.5, seed: num(p, 'whSeed'), m: 4, n1: 1, n2: 1, n3: 1 });
    return shapeCross(M, spec, D, undefined, 180).scale([1, 0.8]).rotate(90);
  }
  return M.CrossSection.circle(D / 2, 64);
}

function maxRadius(cs: CrossSection) {
  let r = 0;
  for (const poly of cs.toPolygons()) for (const [x, y] of poly) r = Math.max(r, Math.hypot(x, y));
  return r;
}

function peg(M: ManifoldToplevel, p: Params): HookOut {
  const tips: string[] = [];
  const warnings: string[] = [];
  const kind = str(p, 'whMount');
  if (kind === 'suction') throw new UserError('Een pin kan niet aan een zuignap: die heeft een voetje onderaan nodig. Kies een enkele haak, een J-haak of het sleutelrekje voor zuignappen.');
  const s = screwOf(p);
  let D = num(p, 'whPegD');
  const minD = kind === 'screws' ? s.headD + 7 : kind === 'insert' ? s.insertD + 5 : 10;
  if (D < minD) {
    D = minD;
    tips.push(`De pin is ${D.toFixed(0)} mm dik gemaakt zodat de schroef erin past.`);
  }
  const L = num(p, 'whPegL');
  const hs = num(p, 'whHeadScale') / 100;
  const S0 = pegSection(M, p, D);
  const R = maxRadius(S0);
  const fs = 1.45;
  // the back flange: also big enough for a keyhole or a Command strip
  let flange = S0.scale([fs, fs]);
  let flangeT = 3;
  const kh = keyholeDims(p);
  if (kind === 'keyhole') {
    const box = M.CrossSection.hull([M.CrossSection.circle(kh.rHead + 2.5, 32).translate([0, -kh.travel / 2]), M.CrossSection.circle(kh.rHead + 2.5, 32).translate([0, kh.travel / 2])]);
    flange = M.CrossSection.hull([flange, box]);
    flangeT = kh.lip + kh.pocket + kh.rHead + 1.6;
  } else if (kind === 'adhesive') {
    const c = COMMAND_STRIPS[str(p, 'whCmd')] ?? COMMAND_STRIPS.medium;
    const la = c.l - c.tab;
    flange = M.CrossSection.hull([flange, M.CrossSection.square([c.w + 3, la + 2]).translate([-(c.w + 3) / 2, -(la + 2) / 2])]);
  }
  const Rf = maxRadius(flange);
  const zTaper = flangeT + Math.max(1.5, (Rf - R) * 0.6);
  const headH = Math.max(4, Math.min(L * 0.3, 12));
  const flare = R * (hs - 1) + 0.4;
  const zHead = L - headH;
  const zFlare = zHead - flare;
  if (zFlare < zTaper + 3) throw new UserError(`De pin is te kort voor deze kop: maak hem minstens ${Math.ceil(zTaper + 3 + flare + headH)} mm lang of de kop kleiner.`);
  const pieces: Manifold[] = [
    flange.extrude(flangeT + 0.01),
    M.Manifold.hull([flange.extrude(0.01).translate([0, 0, flangeT]), S0.extrude(0.01).translate([0, 0, zTaper])]),
    S0.extrude(zFlare - zTaper + 0.02).translate([0, 0, zTaper - 0.01]),
    hs > 1.001 ? S0.extrude(flare + 0.02, 0, 0, [hs, hs]).translate([0, 0, zFlare - 0.01]) : S0.extrude(flare + 0.02).translate([0, 0, zFlare - 0.01]),
    filletExtrude(M, S0.scale([hs, hs]), headH, 0, Math.min(num(p, 'whEdge') + 1, headH * 0.8, R * hs * 0.8)).translate([0, 0, zHead]),
  ];
  let solid = M.Manifold.union(pieces);
  const extra: PartOut[] = [];
  const cuts: Manifold[] = [];
  if (kind === 'screws') {
    // the screw runs through the axis and carries the bending; its head sits deep in a counterbore
    const grip = Math.min(8, L * 0.3);
    const rh = s.headD / 2 + 0.5;
    cuts.push(M.Manifold.cylinder(grip + 0.02, s.clear / 2, s.clear / 2, 32).translate([0, 0, -0.01]));
    cuts.push(M.Manifold.cylinder(L - grip + 1, rh, rh, 40).translate([0, 0, grip]));
    if (bool(p, 'whCap')) {
      const rc = rh + 1.5;
      cuts.push(M.Manifold.cylinder(CAP_DEPTH + 1, rc, rc, 48).translate([0, 0, L - CAP_DEPTH]));
      // printed face down: a disc that fills the recess and a stem that clamps in the counterbore
      const disc = filletExtrude(M, M.CrossSection.circle(rc - 0.15, 48), CAP_DEPTH - 0.1, 0.6, 0);
      const stem = M.Manifold.cylinder(4, rh - 0.1, rh - 0.1, 40).translate([0, 0, CAP_DEPTH - 0.11]);
      extra.push({ name: 'Afdekdopje', solid: M.Manifold.union([disc, stem]), quantity: 1 });
    }
    tips.push(`Schroef: ${s.label === 'M3' ? '3' : s.label === 'M4' ? '4' : '5'} × ${Math.ceil((grip + 30) / 5) * 5} mm met platte of bolle kop, met plug. De schroef draagt de last, de pin wordt er alleen tegen de muur gedrukt.`);
  } else if (kind === 'insert') {
    // insert bore, then the screw clearance; cone tops so the blind hole has no flat ceiling
    const rI = s.insertD / 2;
    const rC = s.clear / 2;
    const lI = s.insertL + 0.3;
    const lC = Math.min(L - 6, lI + 4);
    cuts.push(M.Manifold.union([
      M.Manifold.cylinder(lI + 0.01, rI, rI, 40).translate([0, 0, -0.01]),
      M.Manifold.cylinder(rI - rC + 0.01, rI, rC, 40).translate([0, 0, lI]),
      M.Manifold.cylinder(Math.max(0.1, lC - lI), rC, rC, 32).translate([0, 0, lI]),
      M.Manifold.cylinder(rC, rC, 0.05, 32).translate([0, 0, Math.max(lI + 0.1, lC)]),
    ]));
    tips.push(`Druk een ${s.label} inzetmoer in de achterkant en draai de pin op een stokeinde of draadeind ${s.label} in een plug.`);
  } else if (kind === 'keyhole') {
    const bE = -kh.travel / 2;
    const b1 = kh.travel / 2;
    const stad = (r: number) => M.CrossSection.hull([M.CrossSection.circle(r, 32).translate([0, bE]), M.CrossSection.circle(r, 32).translate([0, b1])]);
    cuts.push(M.CrossSection.union([M.CrossSection.circle(kh.rHead, 40).translate([0, bE]), stad(kh.rShank)]).extrude(kh.lip + 0.02).translate([0, 0, -0.01]));
    // head pocket with a 45° roof so it prints without support
    const zt = kh.lip + kh.pocket;
    const pts: Vec3[] = [];
    for (const poly of stad(kh.rHead).toPolygons()) for (const [x, y] of poly) pts.push([x, y, kh.lip], [x, y, zt]);
    pts.push([0, bE, zt + kh.rHead], [0, b1, zt + kh.rHead]);
    cuts.push(M.Manifold.hull(pts));
    tips.push('Sleutelgat: draai de schroef zo ver in dat de kop ongeveer 3 mm uit de muur steekt, zet de pin over de kop en schuif hem omlaag.');
  } else if (kind === 'adhesive') {
    tips.push('Plak de strip op de vlakke achterkant, met het treklipje naar beneden en buiten de rand.');
  }
  if (cuts.length) solid = solid.subtract(M.Manifold.union(cuts));
  // bending at the flange: across the layers (they are parallel to the wall)
  const Sm = sectionModulus(S0);
  const ms = mountSpec(p);
  const lever = L - headH / 2;
  const rating = rateSection(Sm, lever, true, ms.kg, `de bevestiging (${ms.label})`);
  if (kind === 'screws') {
    // the screw through the axis takes the bending (steel core at ~120 MPa); the plastic only adds a little
    const core = s.clear - 0.9;
    const steelKg = (((Math.PI * core ** 3) / 32) * 120) / Math.max(5, lever) / 9.81;
    const plastic = rateSection(Sm, lever, true, Infinity, '');
    rating.petg = Math.min(ms.kg, steelKg + plastic.petg);
    rating.pla = Math.min(ms.kg, steelKg + plastic.pla);
    rating.limit = rating.petg >= ms.kg ? `de bevestiging (${ms.label})` : 'de schroef door de pin';
  }
  tips.unshift('Geprint staand op de achterkant: de kop loopt onder 45° uit, dus er is geen support nodig.');
  if (kind !== 'screws') warnings.push('Zonder schroef door de pin trekt de last aan de printlagen: hang er alleen lichte dingen aan (sleutels, een tasje), of kies "Verzonken schroeven".');
  const b = solid.boundingBox();
  return { solid, tips, warnings, extra, info: [ratingInfo(rating), { kind: 'kv', title: 'Maat', rows: [['Pin', `${(b.max[0] - b.min[0]).toFixed(0)} × ${(b.max[1] - b.min[1]).toFixed(0)} mm, ${L} mm uit de muur`]] }] };
}

// ---- entry points -----------------------------------------------------------

export function wallHook(M: ManifoldToplevel, p: Params, printer: PrinterProfile): HookOut {
  const style = str(p, 'whStyle');
  const res = style === 'rail' ? rail(M, p, printer) : style === 'peg' ? peg(M, p) : sideHook(M, p, printer);
  const kind = str(p, 'whMount');
  const s = screwOf(p);
  if (kind === 'screws') res.tips.push(`Bevestig met verzonken houtschroeven Ø${s.label === 'M3' ? '3' : s.label === 'M4' ? '4' : '5'} mm en pluggen.${bool(p, 'whCap') ? ' Druk daarna het dopje in de verdieping over de schroefkop.' : ''}`);
  if (kind === 'keyhole' && style !== 'peg') res.tips.push('Sleutelgat: draai de schroef zo ver in dat de kop ongeveer 3 mm uit de muur steekt; haak de haak met het ronde gat over de kop en schuif hem omlaag.');
  if (kind === 'suction') res.tips.push('Steek de paddenstoelkop van de zuignap door het ronde gat, schuif hem omhoog in de sleuf en druk de haak met zuignap op een schone, gladde tegel.');
  if (kind === 'adhesive') {
    const c = COMMAND_STRIPS[str(p, 'whCmd')] ?? COMMAND_STRIPS.medium;
    res.tips.push(`Uitsparing voor ${c.label}-strips: ${c.w} × ${c.l} mm met treklipje van ${c.tab} mm (richtwaarden; meet je eigen strips na). 3M geeft ${c.kg} kg per strip op, alleen op gladde, geverfde of betegelde muren.`);
  }
  if (kind === 'insert' && style !== 'peg') res.tips.push(`Druk een ${s.label} inzetmoer (Ø${s.insertD} mm) met de soldeerbout in de achterkant en draai de haak op een stokeinde of draadeind in een plug.`);
  res.tips.push(...LOAD_TIPS);
  return res;
}

/** Load estimate for a cabinet knob used as a wall peg (neck in peel, layers parallel to the wall). */
export function knobHookInfo(M: ManifoldToplevel, p: Params): { info: InfoBlock; tips: string[] } {
  const Dn = Math.min(num(p, 'neckD'), num(p, 'baseD'), num(p, 'knobD'));
  const S = sectionModulus(M.CrossSection.circle(Dn / 2, 48));
  const s = SCREWS[str(p, 'screw')] ?? SCREWS.M4;
  const rating = rateSection(S, num(p, 'knobH') * 0.75, true, str(p, 'mount') === 'tap' ? 4 : 8, `de schroefdraad in de knop (${s.label})`);
  return {
    info: ratingInfo(rating),
    tips: [
      `Als wandhaak: draai een stokeinde of draadeind ${s.label} in een plug in de muur en draai de knop erop. Met een inzetmoer (heat-set) is hij het sterkst.`,
      'De lagen van een knop liggen evenwijdig aan de muur, dus de hals is zijn zwakke plek: hang er een sjaal of tas aan, geen zware winterjas.',
      ...LOAD_TIPS,
    ],
  };
}

// ---- parameters ---------------------------------------------------------------

const isWall = (p: Params) => str(p, 'type') === 'wallhook';
const whIs = (...st: string[]) => (p: Params) => isWall(p) && st.includes(str(p, 'whStyle'));
const notKnob = (p: Params) => isWall(p) && str(p, 'whStyle') !== 'knob';
const mountIs = (...m: string[]) => (p: Params) => notKnob(p) && m.includes(str(p, 'whMount'));

export const WALLHOOK_PARAMS: ParamDef[] = [
  { type: 'group', label: 'Wandhaak', show: isWall },
  { type: 'select', key: 'whStyle', label: 'Model haak', default: 'single', show: isWall, options: HOOK_STYLES },
  {
    type: 'select', key: 'whLook', label: 'Uitstraling', default: 'classic', show: whIs('single', 'double', 'j', 'ball', 'rail'),
    options: [
      { value: 'classic', label: 'Klassiek (gelijk dik)' },
      { value: 'soft', label: 'Zacht (taps met druppelpunt)' },
    ],
  },
  { type: 'number', key: 'whReach', label: 'Uitsteek uit de muur', min: 15, max: 120, step: 1, unit: 'mm', default: 45, show: whIs('single', 'double', 'j', 'ball', 'rail') },
  { type: 'number', key: 'whThick', label: 'Dikte arm', min: 5, max: 20, step: 0.5, unit: 'mm', default: 9, show: whIs('single', 'double', 'j', 'ball', 'rail') },
  { type: 'number', key: 'whTip', label: 'Hoogte punt', min: 0, max: 60, step: 1, unit: 'mm', default: 16, show: whIs('single', 'double', 'j', 'rail'), help: 'Hoe ver de punt van de haak omhoog komt; 0 = rechte arm.' },
  { type: 'number', key: 'whBall', label: 'Diameter bol', min: 12, max: 40, step: 1, unit: 'mm', default: 22, show: whIs('ball') },
  { type: 'number', key: 'whAngle', label: 'Hoek arm omhoog', min: 0, max: 60, step: 5, unit: '°', default: 30, show: whIs('ball') },
  { type: 'number', key: 'whWidth', label: 'Breedte (haakje)', min: 8, max: 40, step: 1, unit: 'mm', default: 20, show: whIs('single', 'double', 'j', 'ball', 'rail') },
  { type: 'number', key: 'whEdge', label: 'Afronding randen', min: 0, max: 12, step: 0.5, unit: 'mm', default: 3, show: whIs('single', 'double', 'j', 'ball', 'peg'), help: 'Groot = een zachte, ronde haak (tot de helft van de breedte).' },
  { type: 'number', key: 'whPlateT', label: 'Dikte achterplaat', min: 3, max: 12, step: 0.5, unit: 'mm', default: 5, show: whIs('single', 'double', 'j', 'ball', 'rail') },
  { type: 'number', key: 'whCount', label: 'Aantal haakjes', min: 2, max: 12, step: 1, default: 5, show: whIs('rail') },
  { type: 'number', key: 'whPitch', label: 'Afstand tussen haakjes', min: 16, max: 80, step: 1, unit: 'mm', default: 32, show: whIs('rail') },
  { type: 'number', key: 'whRailH', label: 'Hoogte rekje', min: 15, max: 80, step: 1, unit: 'mm', default: 28, show: whIs('rail') },
  {
    type: 'select', key: 'whPegShape', label: 'Doorsnede pin', default: 'round', show: whIs('peg'),
    options: [
      { value: 'round', label: 'Rond' },
      { value: 'pill', label: 'Pil (staand ovaal)' },
      { value: 'pebble', label: 'Kiezel (organisch)' },
    ],
  },
  { type: 'number', key: 'whPegD', label: 'Dikte pin', min: 10, max: 40, step: 0.5, unit: 'mm', default: 18, show: whIs('peg') },
  { type: 'number', key: 'whPegL', label: 'Lengte pin', min: 20, max: 90, step: 1, unit: 'mm', default: 45, show: whIs('peg') },
  { type: 'number', key: 'whHeadScale', label: 'Kop (verdikking voorkant)', min: 100, max: 150, step: 5, unit: '%', default: 125, show: whIs('peg') },
  { type: 'number', key: 'whPegDepth', label: 'Grilligheid kiezel', min: 0, max: 100, step: 5, unit: '%', default: 40, show: (p) => whIs('peg')(p) && str(p, 'whPegShape') === 'pebble' },
  { type: 'number', key: 'whSeed', label: 'Variant (willekeurig getal)', min: 1, max: 999, step: 1, default: 5, show: (p) => whIs('peg')(p) && str(p, 'whPegShape') === 'pebble' },
  { type: 'group', label: 'Ophangen', show: notKnob },
  {
    type: 'select', key: 'whMount', label: 'Bevestiging', default: 'screws', show: notKnob,
    options: [
      { value: 'screws', label: 'Verzonken schroeven' },
      { value: 'keyhole', label: 'Sleutelgat (onzichtbaar ophangen)' },
      { value: 'adhesive', label: 'Plakstrip (3M Command)' },
      { value: 'suction', label: 'Zuignap (paddenstoelkop)' },
      { value: 'insert', label: 'Inzetmoer + stokeinde' },
    ],
  },
  { type: 'number', key: 'whScrewN', label: 'Aantal schroeven', min: 1, max: 2, step: 1, default: 2, show: mountIs('screws', 'keyhole') },
  { type: 'bool', key: 'whCap', label: 'Afdekdopje over de schroef', default: false, show: mountIs('screws') },
  {
    type: 'select', key: 'whCmd', label: 'Plakstrip', default: 'medium', show: mountIs('adhesive'),
    options: [
      { value: 'medium', label: 'Command medium (≈19 × 70 mm, richtwaarde)' },
      { value: 'large', label: 'Command large (≈19 × 92 mm, richtwaarde)' },
    ],
  },
  { type: 'number', key: 'whCmdN', label: 'Aantal strips', min: 1, max: 4, step: 1, default: 1, show: mountIs('adhesive') },
  {
    type: 'select', key: 'whCup', label: 'Zuignap', default: 'ha011', show: mountIs('suction'),
    options: Object.entries(CUPS).map(([value, c]) => ({ value, label: c.label })),
  },
];

export const WALLHOOK_PRESETS: Preset[] = [
  { name: 'Kapstok (dubbele haak)', values: { type: 'wallhook', whStyle: 'double', whLook: 'classic', whReach: 55, whThick: 10, whTip: 18, whWidth: 22, whEdge: 4, whMount: 'screws', whScrewN: 2, screw: 'M4', whCap: true } },
  { name: 'Jashaak met bol', values: { type: 'wallhook', whStyle: 'ball', whLook: 'soft', whReach: 60, whThick: 10, whBall: 24, whAngle: 30, whWidth: 22, whEdge: 6, whMount: 'screws', whScrewN: 1, screw: 'M4' } },
  { name: 'Sleutelrekje', values: { type: 'wallhook', whStyle: 'rail', whLook: 'soft', whCount: 5, whPitch: 30, whReach: 28, whThick: 6, whTip: 10, whWidth: 10, whRailH: 28, whMount: 'screws', whScrewN: 2, screw: 'M4', whCap: true } },
  { name: 'Handdoekhaak (zuignap)', values: { type: 'wallhook', whStyle: 'j', whLook: 'soft', whReach: 40, whThick: 9, whTip: 10, whWidth: 20, whEdge: 5, whMount: 'suction', whCup: 'ha011' } },
  { name: 'Plakhaakje (Command)', values: { type: 'wallhook', whStyle: 'single', whLook: 'soft', whReach: 32, whThick: 7, whTip: 12, whWidth: 24, whEdge: 4, whMount: 'adhesive', whCmd: 'medium', whCmdN: 1 } },
  { name: 'Minimal peg', values: { type: 'wallhook', whStyle: 'peg', whPegShape: 'round', whPegD: 18, whPegL: 45, whHeadScale: 125, whEdge: 3, whMount: 'screws', screw: 'M4', whCap: true } },
  { name: 'Kiezelpin', values: { type: 'wallhook', whStyle: 'peg', whPegShape: 'pebble', whPegD: 24, whPegL: 40, whHeadScale: 115, whPegDepth: 50, whSeed: 5, whEdge: 4, whMount: 'screws', screw: 'M4' } },
  { name: 'Wandhaak bij Kiezelknop', values: { type: 'wallhook', whStyle: 'knob', style: 'pebble', knobD: 36, knobH: 25, baseD: 18, neckD: 14, headH: 11, puff: 90, edge: 3, headDepth: 40, headSeed: 5, screw: 'M4', mount: 'insert' } },
  { name: 'Wandhaak bij Bloemknop', values: { type: 'wallhook', whStyle: 'knob', style: 'bloom', knobD: 40, knobH: 30, baseD: 20, neckD: 15, headH: 12, puff: 60, edge: 3, headCount: 5, headDepth: 55, headRounding: 70, headAngle: 90, screw: 'M4', mount: 'insert' } },
];
