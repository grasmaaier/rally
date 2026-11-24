import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { BuildOutput, InfoBlock, ParamDef, Params, PartOut, Preset, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { keep } from '../core/registry';
import { fitsOn, usable } from '../core/printer';
import { SCREWS, TAU, applyM4, asMat4, clamp, hexagon, identity, mul, rotX, rotY, rotZ, teardrop, translation, type M4 } from '../geom/helpers';
import { heights, ringsOf, wallSolid } from '../geom/thread';
import { mountCutters, rateSection, sectionModulus } from './wallhooks';

// ---------------------------------------------------------------------------
// Speaker holders ("Speakerhouders"): wall mounts for small satellite speakers
// with a threaded insert (1/4"-20 camera thread, M5 or M6), in two styles:
//
// 1. Wall plate with an arm, ending in a pan + tilt joint:
//    bracket (plate + arm + boss) → yoke (disc + tongue, turns on the boss: pan)
//    → head (speaker plate + two cheeks around the tongue: tilt) → speaker.
//    Pan: one bolt along the pan axis; its head sits in a knob under (or on top
//    of) the boss, the nut slides into a slot in the tongue. Tightening the knob
//    clamps the yoke disc on the boss (a 45° cone centres it). Tilt: a bolt
//    through cheek, tongue, cheek; knob on one cheek, nut in a hex pocket in the
//    other: tightening squeezes the cheeks onto the tongue (friction lock).
//    The speaker bolt is a bought hex bolt captured in a small knob between the
//    cheeks: turn the knob and the bolt screws into the speaker.
//    For a back insert the joint hangs under the arm (the speaker's lower half
//    can then swing back freely when it tilts down).
//
// 2. A wall shelf with a turntable: the shelf is a strong truss profile, a
//    plateau turns on a sleeve through the shelf top. One bolt from below (head
//    in the knob+sleeve) clamps speaker, plateau and sleeve together, so the
//    whole lot turns in the shelf hole; a thumbscrew through the front lip
//    presses on the plateau edge to lock the rotation.
//
// Use coordinates (U): x along the wall, y out of the wall (room = +y), z up.
// The assembled view shows U turned 180° about z (the room towards the camera).
//
// Print orientations (all support-free, loads along the layers):
// - bracket and shelf print on their side (U x = print up): the whole arm and
//   plate lie in the layers, so bending never peels layers apart. Holes through
//   the plate lie horizontal: teardrops pointing up (U +x). The cable channel
//   opens on the print-top side, so it never needs a bridge.
// - yoke stands on its disc; head lies on its speaker plate; knobs on their
//   bearing face; cover strips and pads flat.
// - only exception: the optional printed thread (see isoStud).
//
// Cable (arm): an open channel along the side of the arm and down the plate
// (or straight through the plate into the wall), closed by cover strips that
// slide into a 45° dovetail, so a cable with its plug can be laid in.

type V3 = [number, number, number];

// ---- hardware ---------------------------------------------------------------

export interface Bolt {
  label: string;
  d: number;
  pitch: number;
  /** Clearance hole. */
  clear: number;
  headAF: number;
  headH: number;
  nutAF: number;
  nutH: number;
  /** Stock lengths (mm). */
  lengths: number[];
  inch?: boolean;
}

const MM_LENGTHS = [10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100];
const INCH_LENGTHS = [0.5, 0.625, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const INCH_LABELS = ['1/2"', '5/8"', '3/4"', '1"', '1-1/4"', '1-1/2"', '1-3/4"', '2"', '2-1/2"', '3"'];

export const BOLTS: Record<string, Bolt> = {
  '1/4-20': { label: '1/4"-20 UNC', d: 6.35, pitch: 1.27, clear: 6.9, headAF: 11.11, headH: 4.2, nutAF: 11.11, nutH: 5.6, lengths: INCH_LENGTHS.map((v) => v * 25.4), inch: true },
  M5: { label: 'M5', d: 5, pitch: 0.8, clear: 5.5, headAF: 8, headH: 3.5, nutAF: 8, nutH: 4, lengths: MM_LENGTHS },
  M6: { label: 'M6', d: 6, pitch: 1, clear: 6.5, headAF: 10, headH: 4, nutAF: 10, nutH: 5, lengths: MM_LENGTHS },
};

const fmt = (v: number, d = 0) => v.toFixed(d).replace('.', ',');

export function boltLabel(b: Bolt, L: number): string {
  if (b.inch) {
    const i = b.lengths.findIndex((l) => Math.abs(l - L) < 0.01);
    return `${b.label} × ${INCH_LABELS[i] ?? fmt(L / 25.4, 2) + '"'} (${fmt(L, 1)} mm)`;
  }
  return `${b.label} × ${fmt(L)}`;
}

/** Shortest stock length of at least `need` mm. */
function stockLength(b: Bolt, need: number): number {
  const L = b.lengths.find((l) => l >= need - 1e-6);
  if (L === undefined) throw new UserError(`Er is een bout ${b.label} van ${Math.ceil(need)} mm nodig; zo lang zijn ze niet gangbaar. Kies kleinere maten.`);
  return L;
}

/** A bought bolt whose head is held in a printed knob. */
export interface KnobBolt {
  L: number;
  /** Knob floor under the head. */
  floor: number;
  /** Knob height = floor + head pocket. */
  H: number;
}

/**
 * `grip` = length from the knob's bearing face to where the bolt end must be.
 * The knob floor (between head and bearing face) takes up the whole difference
 * to the stock length, so the bolt end is always exactly where it was planned
 * (never deeper into the speaker).
 */
function knobBolt(b: Bolt, grip: number, minFloor = 2.6): KnobBolt {
  const L = stockLength(b, grip + minFloor);
  const floor = L - grip;
  return { L, floor, H: floor + b.headH + 0.4 };
}

const WOOD_SCREW: Record<string, { d: number; label: string }> = { M4: { d: 4, label: '4' }, M5: { d: 5, label: '5' } };

// ---- small geometry helpers ------------------------------------------------

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Column-major matrix with the given axes (images of x, y, z) and origin. */
export const frameM = (x: V3, y: V3, z: V3, o: V3 = [0, 0, 0]): M4 => [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];

/** Frame whose z axis is `z` (unit), x chosen perpendicular. */
function frameZ(z: V3, o: V3): M4 {
  const ref: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x0 = cross(ref, z);
  const l = Math.hypot(...x0);
  const x: V3 = [x0[0] / l, x0[1] / l, x0[2] / l];
  return frameM(x, cross(z, x), z, o);
}

export function invRigid(m: M4): M4 {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = applyM4(r, [m[12], m[13], m[14]]);
  r[12] = -t[0];
  r[13] = -t[1];
  r[14] = -t[2];
  return r;
}

const tf = (m: Manifold, mat: M4) => m.transform(asMat4(mat));

function ccw(pts: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a >= 0 ? pts : [...pts].reverse();
}

function poly(M: ManifoldToplevel, pts: Vec2[]): CrossSection {
  return keep(new M.CrossSection([ccw(pts)]));
}

function insetConvex(M: ManifoldToplevel, pts: Vec2[], e: number): Vec2[] {
  if (e <= 1e-6) return pts;
  const polys = poly(M, pts).offset(-e, 'Miter', 2).toPolygons();
  return polys.length ? polys[0] : pts;
}

/**
 * Convex polygon (u, v) extruded along w from w0 to w1 with 45° chamfers of
 * e0/e1 at the ends; `map` turns (u, v, w) into use coordinates.
 */
function chamferPrism(M: ManifoldToplevel, pts: Vec2[], w0: number, w1: number, e0: number, e1: number, map: (u: number, v: number, w: number) => V3): Manifold {
  const pts3: V3[] = [];
  const minDim = (() => {
    const us = pts.map((q) => q[0]);
    const vs = pts.map((q) => q[1]);
    return Math.min(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs));
  })();
  const cap = Math.max(0, Math.min(minDim / 2.4, (w1 - w0) / 2.2));
  e0 = Math.min(e0, cap);
  e1 = Math.min(e1, cap);
  const layer = (q: Vec2[], w: number) => q.forEach(([u, v]) => pts3.push(map(u, v, w)));
  layer(insetConvex(M, pts, e0), w0);
  if (e0 > 0) layer(pts, w0 + e0);
  if (e1 > 0) layer(pts, w1 - e1);
  layer(insetConvex(M, pts, e1), w1);
  return M.Manifold.hull(pts3);
}

const rectPts = (u0: number, u1: number, v0: number, v1: number): Vec2[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

function circlePts(cx: number, cy: number, r: number, n = 40): Vec2[] {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((TAU * i) / n), cy + r * Math.sin((TAU * i) / n)] as Vec2);
}

/** Teardrop prism of radius r from `o` along unit `dir`, point towards unit `up`. */
function tdPrism(M: ManifoldToplevel, r: number, o: V3, dir: V3, up: V3, len: number): Manifold {
  return tf(teardrop(M, r, 32).extrude(len), frameM(cross(up, dir), up, dir, o));
}

/**
 * Hex prism (across flats `af`) along `dir` for a nut lying horizontal when
 * printed: one corner towards `up` and a 45° roof over the two upper faces
 * (which would otherwise be 30° overhangs).
 */
function hexPrism(M: ManifoldToplevel, af: number, o: V3, dir: V3, up: V3, len: number): Manifold {
  const r = af / Math.sqrt(3);
  const roofed = M.CrossSection.hull([hexagon(M, af), poly(M, [[-0.866 * r, 0.5 * r], [0.866 * r, 0.5 * r], [0, 0.5 * r + 0.866 * r]])]);
  return tf(roofed.extrude(len), frameM(cross(up, dir), up, dir, o));
}

/** Polygon (a, b) prism from `o` along `dir`, a → `ua`, b → `ub` (ua × ub = dir). */
function profilePrism(M: ManifoldToplevel, pts: Vec2[], o: V3, ua: V3, ub: V3, len: number): Manifold {
  return tf(poly(M, pts).extrude(len), frameM(ua, ub, cross(ua, ub), o));
}

/** Points of a rounded rectangle centred on (cx, cy). */
function roundRectPts(w: number, h: number, r: number, cx = 0, cy = 0, segs = 6): Vec2[] {
  r = clamp(r, 0.01, Math.min(w, h) / 2 - 0.01);
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= segs; i++) {
      const a = ((a0 + (90 * i) / segs) * Math.PI) / 180;
      out.push([cx + x + r * Math.cos(a), cy + y + r * Math.sin(a)]);
    }
  return out;
}

// ---- knobs -------------------------------------------------------------------

/**
 * Knob in its own frame: bearing face at z = 0, top at z = H. With a pocket the
 * bolt head (or nut) drops in from the top and the shaft leaves through the
 * bearing face. Printed on the bearing face: flat, no bridges.
 */
function knobSolid(M: ManifoldToplevel, D: number, H: number, hole: number, pocketAF: number, pocketDepth: number): Manifold {
  const R = D / 2;
  // an even number of scallops keeps the knob symmetric (its bounding box centred on the bolt)
  const n = 2 * clamp(Math.round(D / 7.2), 3, 6);
  const rs = D * 0.12;
  const scallops = Array.from({ length: n }, (_, i) => M.CrossSection.circle(rs, 20).translate([(R + rs * 0.35) * Math.cos((TAU * i) / n), (R + rs * 0.35) * Math.sin((TAU * i) / n)]));
  const outline = M.CrossSection.circle(R, 64).subtract(M.CrossSection.union(scallops));
  const c = Math.min(1, H / 4);
  const envelope = M.Manifold.union([
    M.Manifold.cylinder(c + 0.01, R - c, R, 64),
    M.Manifold.cylinder(Math.max(0.02, H - 2 * c), R, R, 64).translate([0, 0, c]),
    M.Manifold.cylinder(c, R, R - c, 64).translate([0, 0, H - c]),
  ]);
  let k = outline.extrude(H).intersect(envelope);
  const cuts: Manifold[] = [];
  if (hole > 0) cuts.push(M.Manifold.cylinder(H + 2, hole / 2, hole / 2, 32).translate([0, 0, -1]));
  if (pocketAF > 0) cuts.push(hexagon(M, pocketAF).extrude(pocketDepth + 1).translate([0, 0, H - pocketDepth]));
  if (cuts.length) k = k.subtract(M.Manifold.union(cuts));
  return k;
}

/** Distance from helix coordinate u to the nearest crest centre (0 … pitch/2). */
function crestDist(P: number, u: number) {
  const w = ((u % P) + P) % P;
  return Math.min(w, P - w);
}

/**
 * Printed external thread that mates with a metal insert: ISO-like 60°
 * profile, major diameter reduced by `clearance` per side and a 45° lead-in at
 * the tip. Axis z from 0 to `len`. The flanks are 30° from horizontal, so the
 * underside of each ridge is formally an overhang; it is under 0.5 mm wide and
 * prints without support at fine layers. A 45° profile would need no such
 * exception but would hardly engage a 60° metal thread (≈ 0.2 mm), so this is
 * the only place where the tool accepts a small overhang (and it warns).
 */
export function isoStud(M: ManifoldToplevel, b: Bolt, len: number, clearance = 0.2): Manifold {
  const P = b.pitch;
  const R = b.d / 2 - clearance;
  const depth = 0.6134 * P;
  const segs = 96;
  const r = (z: number, th: number) => {
    const w = crestDist(P, z - (P * th) / TAU);
    const prof = Math.max(R - depth, R - Math.max(0, w - P / 16) * Math.sqrt(3));
    return Math.min(prof, R - depth - 0.15 + (len - z));
  };
  return wallSolid(M, { segs, rings: ringsOf(heights(0, len, P / 12), r) }, null);
}

// ---- parameters helpers ------------------------------------------------------------

export function speakerBolt(p: Params): Bolt {
  return BOLTS[str(p, 'thread')] ?? BOLTS['1/4-20'];
}

function clampBolt(p: Params): Bolt {
  return BOLTS[str(p, 'clampBolt')] ?? BOLTS.M6;
}

/** Fake wall-hook parameters so the tested fixing cutters of the wall hooks can be reused. */
function wallParams(p: Params, T: number, kind = str(p, 'mount')): Params {
  return { whMount: kind === 'keyhole' ? 'keyhole' : 'screws', screw: SCREWS[str(p, 'screw')] ? str(p, 'screw') : 'M4', whCap: false, whPlateT: T, whCup: 'ha011' };
}

/** Room a fixing needs around its point (below / above, along the wall). */
function fixingRoom(p: Params, kind = str(p, 'mount')) {
  const s = SCREWS[str(p, 'screw')] ?? SCREWS.M4;
  if (kind === 'keyhole') {
    const rHead = s.headD / 2 + 0.6;
    const rShank = s.clear / 2 + 0.1;
    const travel = rHead + rShank + 1.5;
    // the slot runs down from the entry hole to the hanging point b; lip 2.4 + head pocket 3.4 + 1.6 behind
    // it, as the wall hooks' keyholes (whose cutters are reused); the pocket has a 45° tent roof
    return { below: travel + rHead + 1.5, above: rHead + 1.5, half: rHead, apex: rHead * Math.SQRT2 + 1.7 + 0.3, T: 2.4 + 3.4 + 1.6 };
  }
  const headR = s.headD / 2 + 0.3;
  return { below: headR + 2, above: headR + 2, half: headR, apex: headR * Math.SQRT2 + 0.3, T: headR - s.clear / 2 + 1.6 };
}

// ---------------------------------------------------------------------------
// Arm style

export interface ArmGeo {
  back: boolean;
  /** Joint hangs under the arm (back insert). */
  inverted: boolean;
  W: number;
  Rb: number;
  Ha: number;
  L: number;
  Tp: number;
  zTop: number;
  zBot: number;
  gs: number;
  /** Fixing points (x, z) on the plate: the ones above the arm first, the last one below it. */
  fix: Vec2[];
  screwX: number;
  cable: string;
  cableD: number;
  wc: number;
  s0: number;
  tr: number;
  dc: number;
  zc: number;
  ypc: number;
  cb: Bolt;
  sb: Bolt;
  printed: boolean;
  td: number;
  hs: number;
  Rs0: number;
  zn: number;
  ha: number;
  rt: number;
  rc: number;
  Tt: number;
  g: number;
  xin: number;
  tc: number;
  xout: number;
  Yb: number;
  dp: number;
  tp: number;
  tpad: number;
  pw: number;
  ph: number;
  /** Speaker face distance from the tilt axis. */
  ds: number;
  /** Bolt engagement in the speaker. */
  e: number;
  spk: { W: number; D: number; H: number; kg: number; zIns: number };
  speakerKnob: KnobBolt & { D: number };
  panKnob: KnobBolt & { D: number };
  tiltKnob: KnobBolt & { D: number };
  notes: string[];
}

const CHANNEL = { o0: 0.8, tr: 2, cl: 0.15 };

export function armGeometry(p: Params): ArmGeo {
  const notes: string[] = [];
  const back = str(p, 'insertPos') !== 'bottom';
  const cb = clampBolt(p);
  const sb = speakerBolt(p);
  const printed = str(p, 'connect') === 'printed';
  const spk = { W: num(p, 'spkW'), D: num(p, 'spkD'), H: num(p, 'spkH'), kg: num(p, 'spkKg'), zIns: num(p, 'insertZ') };
  if (back) {
    const zMax = spk.H - 12;
    const zMin = 12;
    if (spk.zIns > zMax || spk.zIns < zMin) {
      spk.zIns = clamp(spk.zIns, zMin, Math.max(zMin, zMax));
      notes.push(`De hoogte van het draadgat is op ${fmt(spk.zIns)} mm gezet: het moet binnen de achterkant van de speaker liggen.`);
    }
  }
  const W = num(p, 'armW');
  const Rb = W / 2;
  const cable = str(p, 'cable');
  const cableD = num(p, 'cableD');
  const wc = cableD + 1;
  const { o0, tr } = CHANNEL;
  const s0 = wc / 2 + o0;
  const dc = tr + cableD + 1.5;
  let Ha = num(p, 'armH');
  if (cable !== 'none' && Ha < 2 * (s0 + tr) + 7) {
    Ha = Math.ceil(2 * (s0 + tr) + 7);
    notes.push(`De arm is ${Ha} mm hoog gemaakt zodat de kabelgoot erin past.`);
  }
  // fixings
  const room = fixingRoom(p);
  let Tp = Math.max(9, room.T + 3.5);
  if (cable === 'down') Tp = Math.max(Tp, 2 * (s0 + tr) + 4.5);
  const ypc = Tp / 2;
  let screwX = 0;
  if (cable === 'down') screwX = Math.min(0, Rb - dc - 1 - room.apex);
  if (screwX - room.half < -Rb + 1.2) throw new UserError(`De arm is te smal voor deze kabeldikte en schroeven: maak de arm minstens ${Math.ceil(2 * (room.half + room.apex + dc + 2.2) / 2) * 2} mm breed, kies een dunnere kabel of een kleinere schroef.`);
  const Lmin = Math.ceil(Tp + Rb + 6);
  let L = num(p, 'armLen');
  if (L < Lmin) {
    L = Lmin;
    notes.push(`De arm is ${L} mm lang gemaakt (korter kan niet met deze breedte en muurplaat).`);
  }
  const gs = clamp((L - Rb - Tp) * 0.5, 2, 12);
  const n = clamp(Math.round(num(p, 'screws')), 2, 3);
  const fix: Vec2[] = [];
  const b1 = gs + room.below + 1;
  fix.push([screwX, b1]);
  let zTop = b1 + room.above + 2;
  if (n === 3) {
    const b2 = zTop + room.below + 2;
    fix.push([screwX, b2]);
    zTop = b2 + room.above + 2;
  }
  const b0 = -Ha - gs - room.above - 1;
  fix.push([screwX, b0]);
  const zBot = b0 - room.below - 2;
  const zc = -Ha / 2;
  // ---- joint
  const td = 6;
  const hs = 3;
  const rbC = cb.clear / 2 + 0.1;
  const Rs0 = rbC + 2 + hs;
  const zn = td + 2.5;
  const ha = Math.ceil((zn + cb.nutH + 0.4 + (cb.nutAF + 0.4) / 2 + 2 + rbC) * 2) / 2;
  const rt = cb === BOLTS.M6 ? 11 : 10;
  const rc = Math.min(14, ha - td - 1.5);
  const g = 0.25;
  // the speaker-bolt knob sits between the cheeks: the tongue sets the room
  const scallop = 0.12 * 21 * 0.65;
  const knobMinD = 2 * (sb.headAF / Math.sqrt(3) + 0.08 + scallop + 1.6);
  const Tt = Math.max(cb.nutAF + 0.4 + 5.2, 21, Math.ceil(knobMinD + 1.5 - 2 * g));
  const xin = Tt / 2 + g;
  const tc = Math.max(7, cb.nutH + 3.5);
  const xout = xin + tc;
  // the speaker bolt
  const tp = 6;
  const tpad = bool(p, 'pad') ? 2 : 0;
  const depthIns = num(p, 'insertDepth');
  let e = depthIns - 1;
  let speakerKnob: KnobBolt & { D: number };
  const Dk = Math.floor((2 * xin - 1.5) * 2) / 2;
  if (printed) {
    speakerKnob = { L: tp + tpad + e, floor: 0, H: 9, D: Dk };
  } else {
    const kb = knobBolt(sb, tp + tpad + e);
    // a long jump between stock lengths: take a little less engagement instead of a thick knob floor
    if (kb.floor > 6 && e - (kb.floor - 6) >= 4) {
      e -= kb.floor - 6;
      kb.floor = 6;
      kb.H = kb.floor + sb.headH + 0.4;
    }
    speakerKnob = { ...kb, D: Dk };
  }
  if (e < 3.5) throw new UserError('Het draadgat in de speaker is te ondiep voor een bout: er moeten minstens 4 mm draad pakken.');
  const travel = e + 0.5;
  const dp = Math.ceil((rt + 1.5 + speakerKnob.H + travel + 0.5) * 2) / 2;
  const ds = dp + tp + tpad;
  // the tongue foot stays inside the disc (inside its top chamfer) and within reach of the head plate
  const Yb = Math.max(4, Math.min(Math.sqrt(Math.max(0, (Rb - 1.2) ** 2 - (Tt / 2) ** 2)), Math.sqrt(Math.max(0, (dp - 2) ** 2 - (ha - td) ** 2))));
  // plate under/behind the speaker: smaller than the speaker face, big enough for the cheeks
  const face = back ? Math.min(spk.W, spk.H) : Math.min(spk.W, spk.D);
  // (a smaller plate leaves more room to tilt: its edge swings towards the arm)
  const pw = clamp(face * 0.55, 2 * xout + 6, 64);
  let ph = pw;
  if (back) ph = clamp(Math.min(2 * spk.zIns, 2 * (spk.H - spk.zIns)) - 8, 2 * rc + 6, pw);
  // pan bolt: knob under the boss, through boss and disc, nut in the tongue
  const panKb = knobBolt(cb, Ha + zn + cb.nutH + 1.5);
  const panKnob = { ...panKb, D: Math.min(32, 2 * Rb - 2) };
  // tilt bolt: knob on one cheek, nut in the other
  const pocket = cb.nutH + 0.4;
  const tiltGrip = 2 * tc + 2 * g + Tt - pocket + cb.nutH + 1.5;
  const tiltKb = knobBolt(cb, tiltGrip);
  const tiltKnob = { ...tiltKb, D: 2 * rc };
  return {
    back, inverted: back, W, Rb, Ha, L, Tp, zTop, zBot, gs, fix, screwX, cable, cableD, wc, s0, tr, dc, zc, ypc, cb, sb, printed,
    td, hs, Rs0, zn, ha, rt, rc, Tt, g, xin, tc, xout, Yb, dp, tp, tpad, pw, ph, ds, e, spk, speakerKnob, panKnob, tiltKnob, notes,
  };
}

/** Cross-section of the cable channel with its dovetail rebate (a = out of the surface, b = across). */
function channelProfile(g: Pick<ArmGeo, 'wc' | 's0' | 'tr' | 'dc'>): Vec2[] {
  const { wc, s0, tr, dc } = g;
  return [[1, s0 - 1], [-tr, s0 + tr], [-tr, wc / 2], [-dc, wc / 2], [-dc, -wc / 2], [-tr, -wc / 2], [-tr, -s0 - tr], [1, -(s0 - 1)]];
}

/** The boss section (x, y): round, with a 45° flat on the print-bed side (U −x). */
function bossSection(R: number, L: number): Vec2[] {
  const pts: Vec2[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const a = (-135 + (270 * i) / n) * (Math.PI / 180);
    pts.push([R * Math.cos(a), L + R * Math.sin(a)]);
  }
  pts.push([-R, L + R * (Math.SQRT2 - 1)]);
  pts.push([-R, L - R * (Math.SQRT2 - 1)]);
  return pts;
}

export function bracketSolid(M: ManifoldToplevel, p: Params, g: ArmGeo): Manifold {
  const { W, Rb, Ha, L, Tp, zTop, zBot, gs } = g;
  const X = (u: number, v: number, w: number): V3 => [w, u, v];
  const e = 1.5;
  const pieces: Manifold[] = [
    chamferPrism(M, rectPts(0, Tp, zBot, zTop), -W / 2, W / 2, e, e, X),
    chamferPrism(M, rectPts(Tp - 1, L, -Ha, 0), -W / 2, W / 2, e, e, X),
    chamferPrism(M, [[Tp - 1, -1], [Tp + gs, -1], [Tp - 1, gs]], -W / 2, W / 2, e, e, X),
    chamferPrism(M, [[Tp - 1, -Ha + 1], [Tp - 1, -Ha - gs], [Tp + gs, -Ha + 1]], -W / 2, W / 2, e, e, X),
    chamferPrism(M, bossSection(Rb, L), -Ha, 0, e, e, (u, v, w) => [u, v, w]),
  ];
  // centring cone on the joint face of the boss
  const sp = M.Manifold.cylinder(g.hs + 0.01, g.Rs0, g.Rs0 - g.hs, 48);
  pieces.push(g.inverted ? sp.rotate([180, 0, 0]).translate([0, L, -Ha + 0.01]) : sp.translate([0, L, -0.01]));
  const solid = M.Manifold.union(pieces);
  const cuts: Manifold[] = [];
  // pan bolt (horizontal when printed: teardrop pointing up = U +x)
  cuts.push(tdPrism(M, g.cb.clear / 2 + 0.1, [0, L, -Ha - g.hs - 1], [0, 0, 1], [1, 0, 0], Ha + 2 * g.hs + 2));
  // cable channel on the U +x side (print top)
  if (g.cable !== 'none') {
    const prof = channelProfile(g);
    const yTip = L + Rb + 1;
    const yStart = g.cable === 'down' ? g.ypc - (g.s0 + g.tr) : -1;
    // a → +x, b → −z: extrusion along +y
    cuts.push(profilePrism(M, prof, [W / 2, yStart, g.zc], [1, 0, 0], [0, 0, -1], yTip - yStart));
    if (g.cable === 'down') {
      const zFrom = g.zc + g.s0 + g.tr;
      // a → +x, b → −y: extrusion along −z
      cuts.push(profilePrism(M, prof, [W / 2, g.ypc, zFrom], [1, 0, 0], [0, -1, 0], zFrom - zBot + 1));
    }
  }
  // wall fixings (wall-hook frame: x out of the wall, y up, z along the wall)
  const fromWall = frameM([0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const fx = mountCutters(M, wallParams(p, Tp), Tp, g.fix.map(([x, z]) => [x, z] as Vec2), 'a');
  for (const c of fx) cuts.push(tf(c, fromWall));
  return solid.subtract(M.Manifold.union(cuts));
}

export function yokeSolid(M: ManifoldToplevel, g: ArmGeo): Manifold {
  const { Rb, td, Tt, ha, rt, Yb, cb, zn, Rs0 } = g;
  const disc = M.Manifold.union([
    M.Manifold.cylinder(0.81, Rb - 0.8, Rb, 72),
    M.Manifold.cylinder(td - 1.6, Rb, Rb, 72).translate([0, 0, 0.8]),
    M.Manifold.cylinder(0.8, Rb, Rb - 0.8, 72).translate([0, 0, td - 0.8]),
  ]);
  const tpts: V3[] = [];
  for (const x of [-Tt / 2, Tt / 2]) {
    for (const [y, z] of circlePts(0, ha, rt, 48)) tpts.push([x, y, z]);
    for (const [y, z] of rectPts(-Yb, Yb, td - 1.4, td - 0.9)) tpts.push([x, y, z]);
  }
  const solid = M.Manifold.union([disc, M.Manifold.hull(tpts)]);
  const rbC = cb.clear / 2 + 0.1;
  const rr = Rs0 + 0.3;
  const af = cb.nutAF + 0.4;
  const h = cb.nutH + 0.4;
  const slot: Vec2[] = [[-af / 2, zn], [af / 2, zn], [af / 2, zn + h], [0, zn + h + af / 2], [-af / 2, zn + h]];
  const yEnd = cb.nutAF / Math.sqrt(3) + 0.4;
  const cuts = [
    M.Manifold.cylinder(rr - rbC + 0.01, rr, rbC, 48).translate([0, 0, -0.01]),
    M.Manifold.cylinder(zn + 1, rbC, rbC, 32).translate([0, 0, -0.5]),
    // nut slot from the back (−y), roofed at 45°: a → x, b → z, extruded along −y
    profilePrism(M, slot, [0, yEnd, 0], [1, 0, 0], [0, 0, 1], yEnd + Yb + 2),
    tdPrism(M, rbC, [-Tt / 2 - 1, 0, ha], [1, 0, 0], [0, 0, 1], Tt + 2),
  ];
  return solid.subtract(M.Manifold.union(cuts));
}

/**
 * Where the cheeks meet the plate (y range in the plate frame). For a back
 * insert the yoke disc lies on the +y side of the head: there the cheek edge
 * rises from its round end towards the plate, so it does not swing into the
 * disc when the speaker tilts up.
 */
function cheekSpan(g: ArmGeo): [number, number] {
  const s = Math.min(g.ph / 2 - 1.5, g.rc + 8);
  return [-s, g.back ? Math.min(s, g.rc * 0.35) : s];
}

/** Head in its plate frame P: tilt axis = x through the origin, speaker plate normal +z. */
export function headSolid(M: ManifoldToplevel, g: ArmGeo): Manifold {
  const { dp, tp, pw, ph, xin, xout, rc, cb, sb } = g;
  const plate = chamferPrism(M, roundRectPts(pw, ph, 6), dp, dp + tp, 0.8, 1, (u, v, w) => [u, v, w]);
  const [s0, s1] = cheekSpan(g);
  const cheeks: Manifold[] = [];
  for (const side of [-1, 1]) {
    const pts: V3[] = [];
    for (const [x, r] of [[xin, rc], [xout - 1, rc], [xout, rc - 1]] as [number, number][]) for (const [y, z] of circlePts(0, 0, r, 40)) pts.push([side * x, y, z]);
    for (const x of [xin, xout - 1]) for (const y of [s0, s1]) pts.push([side * x, y, dp + 0.5]);
    for (const y of [s0 + 1, s1 - 1]) pts.push([side * xout, y, dp + 0.5]);
    cheeks.push(M.Manifold.hull(pts));
  }
  const solid = M.Manifold.union([plate, ...cheeks]);
  const up: V3 = [0, 0, -1];
  const rbC = cb.clear / 2 + 0.1;
  const pocket = cb.nutH + 0.4;
  const cuts = [
    tdPrism(M, rbC, [-xout - 1, 0, 0], [1, 0, 0], up, 2 * xout + 2),
    hexPrism(M, cb.nutAF + 0.3, [xout - pocket, 0, 0], [1, 0, 0], up, pocket + 1),
    M.Manifold.cylinder(tp + 2, (g.printed ? sb.d / 2 + 0.4 : sb.clear / 2 + 0.1), undefined, 40).translate([0, 0, dp - 1]),
  ];
  return solid.subtract(M.Manifold.union(cuts));
}

function speakerKnobSolid(M: ManifoldToplevel, g: ArmGeo): Manifold {
  const k = g.speakerKnob;
  if (g.printed) {
    const knob = knobSolid(M, k.D, k.H, 0, 0, 0);
    const stud = isoStud(M, g.sb, k.L + 0.6).translate([0, 0, -0.6]).rotate([180, 0, 0]);
    return M.Manifold.union([knob, stud]);
  }
  return knobSolid(M, k.D, k.H, g.sb.clear, g.sb.headAF + 0.15, g.sb.headH + 0.4);
}

/** Dovetail cover strip (printed flat on its wide side), length along +x. */
function coverStrip(M: ManifoldToplevel, g: Pick<ArmGeo, 's0' | 'tr'>, len: number): Manifold {
  const { cl } = CHANNEL;
  const t = g.tr - 0.05;
  const wB = g.s0 + g.tr - cl;
  const wT = g.s0 + 0.05 - cl;
  const pts: Vec2[] = [[-wB, 0], [wB, 0], [wT, t], [-wT, t]];
  // across → y, height → z, length → x
  return tf(poly(M, pts).extrude(len), frameM([0, 1, 0], [0, 0, 1], [1, 0, 0]));
}

// ---- poses (U frame) ------------------------------------------------------------

/** Joint frame J: origin on the boss joint face, z away from the boss. */
function jointFrame(g: ArmGeo): M4 {
  return g.inverted ? mul(translation(0, g.L, -g.Ha), rotY(180)) : translation(0, g.L, 0);
}

export function yokePose(g: ArmGeo, pan: number): M4 {
  return mul(jointFrame(g), rotZ(g.inverted ? -pan : pan));
}

/** Plate frame P → U for the given pan/tilt (degrees, U sense: tilt < 0 = aimed down). */
export function headPose(g: ArmGeo, pan: number, tilt: number): M4 {
  const fromP = g.back ? rotX(-90) : identity();
  return mul(yokePose(g, pan), mul(translation(0, 0, g.ha), mul(rotX(g.inverted ? -tilt : tilt), fromP)));
}

/** Speaker box in the plate frame P (min, max). */
function speakerBoxP(g: ArmGeo): { min: V3; max: V3 } {
  const { W, D, H, zIns } = g.spk;
  if (g.back) return { min: [-W / 2, -zIns, g.ds], max: [W / 2, H - zIns, g.ds + D] };
  return { min: [-W / 2, -D / 2, g.ds], max: [W / 2, D / 2, g.ds + H] };
}

function boxSamples(min: V3, max: V3, n = 6): V3[] {
  const out: V3[] = [];
  const lerp3 = (i: number, j: number, k: number): V3 => [min[0] + ((max[0] - min[0]) * i) / n, min[1] + ((max[1] - min[1]) * j) / n, min[2] + ((max[2] - min[2]) * k) / n];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++)
      for (let k = 0; k <= n; k++) if (i === 0 || i === n || j === 0 || j === n || k === 0 || k === n) out.push(lerp3(i, j, k));
  return out;
}

/** Points on the speaker and the head plate that must stay clear of the arm, plate and wall. */
function movingSamples(g: ArmGeo): V3[] {
  const b = speakerBoxP(g);
  const pts = boxSamples(b.min, b.max, 7);
  for (const x of [-g.pw / 2, 0, g.pw / 2]) for (const y of [-g.ph / 2, 0, g.ph / 2]) for (const z of [g.dp, g.dp + g.tp]) pts.push([x, y, z]);
  // the cheeks: round ends, the edges where they meet the plate, and points along their edges
  const [s0, s1] = cheekSpan(g);
  for (const x of [-g.xout, -g.xin, g.xin, g.xout]) {
    for (const [y, z] of circlePts(0, 0, g.rc, 24)) pts.push([x, y, z]);
    for (const y of [s0, s1]) for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * TAU;
      const yc = g.rc * Math.cos(a);
      const zc = g.rc * Math.sin(a);
      for (const t of [0.25, 0.5, 0.75, 1]) pts.push([x, yc + (y - yc) * t, zc + (g.dp - zc) * t]);
    }
  }
  return pts;
}

/** True when nothing of the speaker/head hits the bracket, the pan knob, the yoke disc or the wall. */
export function poseClear(g: ArmGeo, pan: number, tilt: number, samples = movingSamples(g)): boolean {
  const m = headPose(g, pan, tilt);
  const { W, L, Ha, Tp, zTop, zBot, gs, Rb } = g;
  const m2 = 2.5;
  const knobZ = g.inverted ? [0, g.panKnob.H + 6] : [-Ha - g.panKnob.H - 6, -Ha];
  const discZ = g.inverted ? [-Ha - g.td - 0.6, -Ha] : [0, g.td + 0.6];
  for (const q of samples) {
    const [x, y, z] = applyM4(m, q);
    if (y < 2) return false;
    if (Math.abs(x) < W / 2 + m2) {
      if (y < L + m2 && z > -Ha - m2 && z < m2) return false;
      if (y < Tp + m2 && z > zBot - m2 && z < zTop + m2) return false;
      if (y < Tp + gs + m2 && z > -Ha - gs - m2 && z < gs + m2) return false;
    }
    const rr = Math.hypot(x, y - L);
    if (rr < Rb + m2 && z > -Ha - m2 && z < m2) return false;
    if (rr < g.panKnob.D / 2 + m2 && z > knobZ[0] && z < knobZ[1]) return false;
    if (rr < Rb + 1.2 && z > discZ[0] && z < discZ[1]) return false;
  }
  return true;
}

export interface Ranges {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
}

/** Collision-free pan range (at the given tilt) and tilt range (straight out), in 1° steps. */
export function armRanges(g: ArmGeo, tiltForPan = 0): Ranges {
  const s = movingSamples(g);
  const walk = (from: number, to: number, ok: (a: number) => boolean) => {
    const step = to > from ? 1 : -1;
    let last = from;
    for (let a = from + step; step > 0 ? a <= to : a >= to; a += step) {
      if (!ok(a)) break;
      last = a;
    }
    return last;
  };
  const tiltMin = walk(0, -45, (t) => poseClear(g, 0, t, s));
  const tiltMax = walk(0, 30, (t) => poseClear(g, 0, t, s));
  const tp = clamp(tiltForPan, tiltMin, tiltMax);
  const okPan = poseClear(g, 0, tp, s);
  const panMax = okPan ? walk(0, 90, (a) => poseClear(g, a, tp, s)) : 0;
  const panMin = okPan ? walk(0, -90, (a) => poseClear(g, a, tp, s)) : 0;
  return { panMin, panMax, tiltMin, tiltMax };
}

/** Shortest arm for which the speaker clears everything straight out (for the error message). */
function minArmFor(g: ArmGeo): number {
  for (let L = g.L + 10; L <= 400; L += 10) {
    const g2 = { ...g, L };
    if (poseClear(g2, 0, 0)) return L;
  }
  return 400;
}

// ---------------------------------------------------------------------------
// Shelf style

export interface ShelfGeo {
  fixing: 'bolt' | 'rim' | 'both';
  boltFix: boolean;
  rim: boolean;
  printed: boolean;
  /** Pivot bolt: the speaker thread with bolt fixing, else the clamp bolt. */
  pb: Bolt;
  cb: Bolt;
  Rp: number;
  tpl: number;
  tpad: number;
  rimH: number;
  rimT: number;
  wedge: number;
  Tb: number;
  ttop: number;
  yc: number;
  ych: number;
  rch: number;
  Ds: number;
  Ws: number;
  Xs: number;
  Hs: number;
  zf: number;
  zBot: number;
  tl: number;
  hLip: number;
  zLock: number;
  lock: boolean;
  topC: number;
  nutDepth: number;
  topFix: Vec2[];
  botFix: Vec2[];
  zs1: number;
  rAcc: number;
  cable: string;
  zEx: number;
  dsl: number;
  Lsl: number;
  e: number;
  pivot: KnobBolt & { D: number; Hk: number };
  lockKnob: KnobBolt & { D: number };
  spk: { W: number; D: number; H: number; kg: number };
  notes: string[];
}

export function shelfGeometry(p: Params): ShelfGeo {
  const notes: string[] = [];
  const fixing = (['bolt', 'rim', 'both'].includes(str(p, 'shelfFix')) ? str(p, 'shelfFix') : 'both') as ShelfGeo['fixing'];
  const boltFix = fixing !== 'rim';
  const rim = fixing !== 'bolt';
  const printed = boltFix && str(p, 'connect') === 'printed';
  const cb = clampBolt(p);
  const pb = boltFix ? speakerBolt(p) : cb;
  const spk = { W: num(p, 'spkW'), D: num(p, 'spkD'), H: num(p, 'spkH'), kg: num(p, 'spkKg') };
  const rimT = 2.4;
  const rimC = 1;
  let Rp = num(p, 'plateD') / 2;
  if (rim) {
    const need = Math.max(spk.W, spk.D) / 2 + rimC + rimT + 1.5;
    if (Rp < need) {
      Rp = Math.ceil(need);
      notes.push(`Het plateau is ${2 * Rp} mm gemaakt zodat de rand om de speaker past.`);
    }
  }
  const tpl = Math.max(12, Math.ceil(cb.nutAF + 0.3 + 2.6));
  const tpad = bool(p, 'pad') ? 2 : 0;
  let wedge = num(p, 'wedge');
  if (wedge > 0 && boltFix) {
    wedge = 0;
    notes.push('De kantelwig kan alleen met "Alleen een opstaande rand": een bout moet haaks door het plateau.');
  }
  const rimH = rim ? num(p, 'rimH') : 0;
  // plateau top in the middle (higher with a wedge)
  const topC = tpl + Rp * Math.tan((wedge * Math.PI) / 180);
  // the nut (rim only) sits upright on the bolt, its top this far under the middle of the top (under the sloped top too)
  const nutDepth = 2 + (cb.nutAF / Math.sqrt(3) + 0.2) * Math.tan((wedge * Math.PI) / 180);
  const kind = str(p, 'mount');
  const room = fixingRoom(p);
  const roomS = fixingRoom(p, 'screws');
  const Tb = Math.max(8, room.T + 3);
  const ttop = 8;
  const cable = str(p, 'cable');
  const rch = Math.max(5, num(p, 'cableD') / 2 + 2);
  const ych = Tb + 3 + rch;
  let yc = Tb + 2 * rch + 9 + Rp;
  // the speaker must clear the wall straight out
  if (yc < spk.D / 2 + 4) {
    yc = Math.ceil(spk.D / 2 + 4);
    notes.push('Het plateau staat verder van de muur zodat de speaker er recht vooruit niet tegenaan komt.');
  }
  const lock = bool(p, 'lock');
  const tl = Math.max(8, cb.nutH + 0.4 + 4);
  const Ds = yc + Rp + 1.5 + tl;
  const Ws = Math.max(2 * Rp + 8, 70);
  const pivotD = Math.min(32, 2 * Rp - 10);
  const Xs = Math.max(Tb + 22, yc - pivotD / 2 - 5);
  const Hs = clamp(Xs * 1.1, 50, 130);
  const zf = -Hs;
  const hLip = tpl - 0.6;
  const zLock = tpl / 2 - 1;
  // fixings: two at the top in the cavity (screwdriver through holes in the strut), one below the strut foot
  const rAcc = roomS.half + 1.5;
  const zs1 = -ttop - 1 - rAcc * Math.SQRT2;
  const xs = Ws >= 76 ? Ws / 4 : 0;
  const topFix: Vec2[] = xs > 0 ? [[-xs, zs1], [xs, zs1]] : [[0, zs1]];
  const zb = zf - 6 - roomS.above;
  const botFix: Vec2[] = [[0, zb]];
  const zBot = zb - roomS.below - 2;
  if (kind === 'keyhole' && zs1 - room.below < zf + 4) throw new UserError('Voor sleutelgaten is de plank te klein: kies een groter plateau of verzonken schroeven.');
  const zEx = Math.min(zs1 - roomS.half - rch - 5, (zs1 + zf) / 2);
  // pivot sleeve + knob
  const dsl = pb.clear + 8;
  const Lsl = ttop + 0.6;
  const cone = Math.max(0, (pivotD - dsl) / 2);
  let e = 0;
  let pivot: ShelfGeo['pivot'];
  const minBody = pb.headH + 0.4 + 3 + cone;
  if (boltFix) {
    e = num(p, 'insertDepth') - 1;
    if (e < 3.5) throw new UserError('Het draadgat in de speaker is te ondiep voor een bout: er moeten minstens 4 mm draad pakken.');
    const reach = tpl + tpad + e;
    if (printed) {
      pivot = { L: reach, floor: 0, H: cone + 9, D: pivotD, Hk: cone + 9 };
    } else {
      // distance from the head (pocket floor) to the bolt end = L
      const L = stockLength(pb, Lsl + minBody - pb.headH - 0.4 + reach);
      const Hk = L - reach - Lsl + pb.headH + 0.4;
      pivot = { L, floor: Hk - pb.headH - 0.4, H: Hk, D: pivotD, Hk };
    }
  } else {
    // rim only: the pivot bolt ends just past a nut in a pocket in the plateau top
    const reach = topC - nutDepth + 0.9;
    const L = stockLength(pb, Lsl + minBody - pb.headH - 0.4 + reach);
    const Hk = L - reach - Lsl + pb.headH + 0.4;
    pivot = { L, floor: Hk - pb.headH - 0.4, H: Hk, D: pivotD, Hk };
  }
  const lockKb = knobBolt(cb, tl + 1.5 + 1);
  const lockKnob = { ...lockKb, D: 26 };
  return {
    fixing, boltFix, rim, printed, pb, cb, Rp, tpl, tpad, rimH, rimT, wedge, Tb, ttop, yc, ych, rch, Ds, Ws, Xs, Hs, zf, zBot, tl, hLip, zLock, lock, topC, nutDepth,
    topFix, botFix, zs1, rAcc, cable, zEx, dsl, Lsl, e, pivot, lockKnob, spk, notes,
  };
}

export function shelfSolid(M: ManifoldToplevel, p: Params, s: ShelfGeo): Manifold {
  const { Tb, ttop, Ds, Ws, Xs, zf, zBot, tl, hLip, yc } = s;
  const X = (u: number, v: number, w: number): V3 => [w, u, v];
  const e = 1.5;
  // strut: a slab from the back plate (at zf) up to the shelf underside (at Xs)
  const p0: Vec2 = [Tb, zf];
  const p1: Vec2 = [Xs, -ttop];
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const d: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  const nn: Vec2 = [-d[1], d[0]];
  const a: Vec2 = [p0[0] - d[0] * 4, p0[1] - d[1] * 4];
  const b: Vec2 = [p1[0] + d[0] * 4, p1[1] + d[1] * 4];
  const ts = 3.2;
  const strut: Vec2[] = [[a[0] + nn[0] * ts, a[1] + nn[1] * ts], [a[0] - nn[0] * ts, a[1] - nn[1] * ts], [b[0] - nn[0] * ts, b[1] - nn[1] * ts], [b[0] + nn[0] * ts, b[1] + nn[1] * ts]];
  const clip = (pts: Vec2[]) => pts.map(([u, v]) => [Math.max(0.2, u), Math.min(-0.2, v)] as Vec2);
  const pieces = [
    chamferPrism(M, rectPts(0, Tb, zBot, 0), -Ws / 2, Ws / 2, e, e, X),
    chamferPrism(M, rectPts(Tb - 1, Ds, -ttop, 0), -Ws / 2, Ws / 2, e, e, X),
    chamferPrism(M, clip(strut), -Ws / 2, Ws / 2, e, e, X),
  ];
  if (s.lock) pieces.push(chamferPrism(M, rectPts(Ds - tl, Ds, -ttop + 0.5, hLip), -Ws / 2, Ws / 2, e, e, X));
  else pieces.push(chamferPrism(M, rectPts(Ds - 5, Ds, -ttop + 0.5, 3), -Ws / 2, Ws / 2, e, e, X));
  const solid = M.Manifold.union(pieces);
  const up: V3 = [1, 0, 0];
  const cuts: Manifold[] = [];
  // pivot hole for the sleeve
  cuts.push(tdPrism(M, s.dsl / 2 + 0.4, [0, yc, -ttop - 1], [0, 0, 1], up, ttop + 2));
  // cable: through the shelf top behind the plateau, then into the wall or straight down
  if (s.cable !== 'none') {
    if (s.cable === 'down') cuts.push(tdPrism(M, s.rch, [0, s.ych, zBot - 1], [0, 0, 1], up, -zBot + 2));
    else {
      cuts.push(tdPrism(M, s.rch, [0, s.ych, -ttop - 1], [0, 0, 1], up, ttop + 2));
      cuts.push(tdPrism(M, s.rch, [0, -1, s.zEx], [0, 1, 0], up, Tb + 2));
    }
  }
  // edge lock: bolt through the lip, nut in a pocket on the plateau side
  if (s.lock) {
    const cb = s.cb;
    cuts.push(tdPrism(M, cb.clear / 2 + 0.1, [0, Ds - tl - 1, s.zLock], [0, 1, 0], up, tl + 2));
    cuts.push(hexPrism(M, cb.nutAF + 0.3, [0, Ds - tl - 1, s.zLock], [0, 1, 0], up, cb.nutH + 0.4 + 1));
  }
  // screwdriver access through the strut to the top fixings
  for (const [x, z] of s.topFix) cuts.push(tdPrism(M, s.rAcc, [x, Tb + 0.6, z], [0, 1, 0], up, Xs + 10 - Tb));
  const fromWall = frameM([0, 1, 0], [0, 0, 1], [1, 0, 0]);
  for (const c of mountCutters(M, wallParams(p, Tb), Tb, s.topFix, 'a')) cuts.push(tf(c, fromWall));
  for (const c of mountCutters(M, wallParams(p, Tb, 'screws'), Tb, s.botFix, 'a')) cuts.push(tf(c, fromWall));
  return solid.subtract(M.Manifold.union(cuts));
}

/** Plateau in its own frame: centre on the axis, bottom at z = 0, front = +y. */
export function plateauSolid(M: ManifoldToplevel, s: ShelfGeo): Manifold {
  const { Rp, tpl, wedge, rim, rimH, rimT, spk, pb } = s;
  const tanW = Math.tan((wedge * Math.PI) / 180);
  const topAt = (y: number) => tpl + (Rp - y) * tanW;
  const circ = circlePts(0, 0, Rp, 96);
  let body: Manifold;
  if (wedge > 0) {
    const pts: V3[] = [];
    for (const [x, y] of circ) pts.push([x, y, 0], [x, y, topAt(y)]);
    body = M.Manifold.hull(pts);
  } else {
    body = chamferPrism(M, circ, 0, tpl, 0.8, 1, (u, v, w) => [u, v, w]);
  }
  const parts: Manifold[] = [body];
  const tilt = mul(translation(0, 0, topAt(0)), rotX(-wedge));
  if (rim && rimH > 0) {
    const iw = spk.W + 2;
    const id = spk.D + 2;
    const gap = Math.max(12, 2 * s.rch + 4);
    const ring = poly(M, roundRectPts(iw + 2 * rimT, id + 2 * rimT, 6))
      .subtract(poly(M, roundRectPts(iw, id, 4)))
      .intersect(M.CrossSection.circle(Rp - 0.6, 96))
      .subtract(M.CrossSection.square([gap, Rp + 2]).translate([-gap / 2, -Rp - 2]));
    if (!ring.isEmpty()) {
      const below = 2 * Rp * tanW + 1;
      const r3 = tf(ring.extrude(rimH + below).translate([0, 0, -below]), tilt);
      // perpendicular to the (tilted) top; whatever leans out past the disc is cut off vertically
      parts.push(r3.intersect(M.Manifold.cylinder(4 * Rp + rimH + 50, Rp - 0.3, Rp - 0.3, 96).translate([0, 0, 0.5])));
    }
  }
  let solid = M.Manifold.union(parts);
  const cuts: Manifold[] = [M.Manifold.cylinder(tpl + 4 * Rp * tanW + 4, (s.printed ? pb.d / 2 + 0.4 : pb.clear / 2 + 0.2), undefined, 40).translate([0, 0, -1])];
  // the nut pocket follows the (vertical) bolt, also under a sloped top
  if (!s.boltFix) cuts.push(hexagon(M, pb.nutAF + 0.3).extrude(pb.nutH + s.nutDepth + 2 * Rp * tanW + 5).translate([0, 0, s.topC - s.nutDepth - pb.nutH - 0.2]));
  solid = solid.subtract(M.Manifold.union(cuts));
  return solid;
}

/** Pivot knob with sleeve: sleeve top (bears on the plateau) at z = 0, knob below it along +z. */
export function pivotSolid(M: ManifoldToplevel, s: ShelfGeo): Manifold {
  const { dsl, Lsl, pivot, pb } = s;
  const D = pivot.D;
  const cone = Math.max(0, (D - dsl) / 2);
  // printed sleeve-down the cone carries the knob's chamfered face; printed knob-down it must stay inside the grip scallops
  const rTop = s.printed ? D / 2 - 0.12 * D * 0.65 - 0.4 : D / 2 - Math.min(1, pivot.Hk / 4);
  const sleeve = M.Manifold.union([
    M.Manifold.cylinder(0.61, dsl / 2 - 0.6, dsl / 2, 48),
    M.Manifold.cylinder(Lsl - 0.6 + 0.01, dsl / 2, dsl / 2, 48).translate([0, 0, 0.6]),
  ]);
  const cn = M.Manifold.cylinder(cone + 0.01, dsl / 2, Math.max(dsl / 2, rTop), 64).translate([0, 0, Lsl]);
  const kb = knobSolid(M, D, Math.max(2, pivot.Hk - cone), 0, 0, 0).translate([0, 0, Lsl + cone]);
  let solid = M.Manifold.union([sleeve, cn, kb]);
  const total = Lsl + cone + Math.max(2, pivot.Hk - cone);
  if (s.printed) {
    const stud = isoStud(M, pb, pivot.L + 0.6).translate([0, 0, -0.6]).rotate([180, 0, 0]);
    solid = M.Manifold.union([solid, stud]);
  } else {
    solid = solid.subtract(M.Manifold.union([
      M.Manifold.cylinder(total + 2, pb.clear / 2 + 0.1, undefined, 32).translate([0, 0, -1]),
      hexagon(M, pb.headAF + 0.15).extrude(pb.headH + 0.4 + 1).translate([0, 0, total - pb.headH - 0.4]),
    ]));
  }
  return solid;
}

// ---------------------------------------------------------------------------
// Build

const C_PART = '#d6d9de';
const C_KNOB = '#3b4048';
const C_PAD = '#2a2a2a';

interface Placed {
  part: PartOut;
  /** Use-frame pose of the part's own frame (U). */
  pose?: M4;
  /** Part frame → print orientation. */
  print: M4;
}

const toScene = rotZ(180);

function boxMesh(min: V3, max: V3, m: M4) {
  const c: V3[] = [];
  for (const z of [min[2], max[2]]) for (const y of [min[1], max[1]]) for (const x of [min[0], max[0]]) c.push(applyM4(m, [x, y, z]));
  const positions = new Float32Array(c.flat());
  const idx = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions, indices: new Uint32Array(idx) };
}

function finish(placed: Placed[], ghosts: SceneItem[]): { parts: PartOut[]; scene: SceneItem[] } {
  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  placed.forEach((pl, i) => {
    parts.push({ ...pl.part, solid: tf(pl.part.solid, pl.print) });
    if (pl.pose) scene.push({ kind: 'part', part: i, matrix: mul(toScene, mul(pl.pose, invRigid(pl.print))) });
  });
  return { parts, scene: [...scene, ...ghosts] };
}

function checkFit(printer: PrinterProfile, parts: PartOut[], hint: (name: string) => string) {
  for (const pt of parts) {
    const b = pt.solid.boundingBox();
    const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if (!fitsOn(printer, size)) throw new UserError(`${pt.name} (${size.map((v) => fmt(v)).join(' × ')} mm) past niet op de ${printer.name}. ${hint(pt.name)}`);
  }
}

function wallGhost(x0: number, x1: number, z0: number, z1: number): SceneItem {
  return { kind: 'box', size: [x1 - x0, 12, z1 - z0], position: [x0, 0, z0], color: '#d8d2c8', material: 'ghost', label: 'Muur' };
}

function speakerGhost(min: V3, max: V3, m: M4): SceneItem {
  return { kind: 'mesh', mesh: boxMesh(min, max, mul(toScene, m)), color: '#9aa4b2', material: 'ghost', label: 'Speaker' };
}

function friction(clampN: number, mu: number, rIn: number, rOut: number, faces: number) {
  const rm = (2 / 3) * ((rOut ** 3 - rIn ** 3) / Math.max(1e-6, rOut ** 2 - rIn ** 2));
  return (faces * mu * clampN * rm) / 1000;
}

/** Bolt preload (N) from a hand-tightened knob: torque ≈ 25 N·mm per mm of knob diameter (0,8 N·m on 32 mm), F = T / (0.2·d). */
function preload(knobD: number, b: Bolt) {
  const torqueNmm = clamp(knobD * 25, 250, 1000);
  return torqueNmm / (0.2 * b.d);
}

function armBuild(p: Params, ctx: { M: ManifoldToplevel; printer: PrinterProfile }): BuildOutput {
  const { M, printer } = ctx;
  const g = armGeometry(p);
  const tips: string[] = [];
  const warnings: string[] = [];
  const notes = [...g.notes];
  const n = clamp(Math.round(num(p, 'count')), 1, 4);
  if (!poseClear(g, 0, 0)) {
    const need = minArmFor(g);
    throw new UserError(
      need <= 250
        ? `De speaker raakt zo de arm, de muurplaat of de muur. Maak de arm langer (minstens ≈ ${need} mm) of kies een kleinere speaker.`
        : 'Deze speaker is te groot voor een arm: hij raakt de muur. Kies het plankje met draaiplateau of controleer de maten.',
    );
  }
  const R = armRanges(g, num(p, 'tilt'));
  const tilt = clamp(num(p, 'tilt'), R.tiltMin, R.tiltMax);
  const pan = clamp(num(p, 'pan'), R.panMin, R.panMax);
  if (tilt !== num(p, 'tilt') || pan !== num(p, 'pan')) warnings.push(`Het voorbeeld staat op ${pan}° draaien en ${tilt}° kantelen: verder kan de speaker niet zonder de arm of de muur te raken.`);
  const placed: Placed[] = [];
  const add = (part: PartOut, print: M4, pose?: M4) => placed.push({ part: { quantity: n, ...part }, print, pose });
  // bracket (side print: U x = print up)
  add({ name: 'Muurbeugel met arm', solid: bracketSolid(M, p, g), color: C_PART, material: 'petg-hf' }, rotY(-90), identity());
  add({ name: 'Draaistuk', solid: yokeSolid(M, g), color: C_PART, material: 'petg-hf' }, identity(), yokePose(g, pan));
  const hp = headPose(g, pan, tilt);
  add({ name: 'Speakerkop', solid: headSolid(M, g), color: C_PART, material: 'petg-hf' }, rotX(180), hp);
  // knobs (K frame: bearing face z = 0, z away from the part)
  const panFace: V3 = g.inverted ? [0, g.L, 0] : [0, g.L, -g.Ha];
  add({ name: 'Knop draaien', solid: knobSolid(M, g.panKnob.D, g.panKnob.H, g.cb.clear, g.cb.headAF + 0.15, g.cb.headH + 0.4), color: C_KNOB, material: 'petg-hf' }, identity(), frameZ(g.inverted ? [0, 0, 1] : [0, 0, -1], panFace));
  add({ name: 'Knop kantelen', solid: knobSolid(M, g.tiltKnob.D, g.tiltKnob.H, g.cb.clear, g.cb.headAF + 0.15, g.cb.headH + 0.4), color: C_KNOB, material: 'petg-hf' }, identity(), mul(hp, frameZ([-1, 0, 0], [-g.xout, 0, 0])));
  add({ name: g.printed ? 'Speakerknop met geprinte draad' : 'Speakerknop', solid: speakerKnobSolid(M, g), color: C_KNOB, material: 'petg-hf' }, g.printed ? rotX(180) : identity(), mul(hp, frameZ([0, 0, -1], [0, 0, g.dp])));
  if (g.tpad > 0) {
    const pad = poly(M, roundRectPts(g.pw - 2, g.ph - 2, 5)).subtract(M.CrossSection.circle(g.sb.clear / 2 + 0.3, 32)).extrude(g.tpad);
    add({ name: 'Kussentje (TPU)', solid: pad, color: C_PAD, material: 'tpu-95a-hf', purpose: 'flexible' }, identity(), mul(hp, translation(0, 0, g.dp + g.tp)));
  }
  if (g.cable !== 'none') {
    const yS = g.cable === 'down' ? g.ypc - (g.s0 + g.tr) + 0.2 : 0;
    const armLen = g.L - yS;
    // strip frame: length along +x, wide side on z = 0 → use: x → +y (along the arm), z → −x (into the channel)
    const stripPose = (o: V3, along: V3) => frameM(along, cross([1, 0, 0], along), [1, 0, 0], o);
    add({ name: 'Kabelafdekking arm', solid: coverStrip(M, g, armLen), color: C_PART, material: 'petg-hf' }, identity(), stripPose([g.W / 2 - g.tr, yS, g.zc], [0, 1, 0]));
    if (g.cable === 'down') {
      const zTopStrip = g.zc - (g.s0 + g.tr) - 0.2;
      const plen = zTopStrip - g.zBot;
      add({ name: 'Kabelafdekking muurplaat', solid: coverStrip(M, g, plen), color: C_PART, material: 'petg-hf' }, identity(), stripPose([g.W / 2 - g.tr, g.ypc, zTopStrip], [0, 0, -1]));
    }
  }
  const { parts, scene } = finish(placed, []);
  checkFit(printer, parts, (name) => {
    if (!name.startsWith('Muurbeugel')) return 'Kies kleinere maten.';
    const u = usable(printer);
    const maxL = Math.floor(Math.max(u.x, u.y) - g.Rb - 2);
    return `Maak de arm korter (op deze printer kan hij ongeveer ${Math.max(0, maxL)} mm lang worden).`;
  });
  // ghosts: wall and speaker
  const sb = speakerBoxP(g);
  const spMin = sb.min;
  const spMax = sb.max;
  const zLow = Math.min(g.zBot, g.inverted ? -g.Ha - g.ha - g.spk.zIns : -g.Ha) - 60;
  const zHigh = Math.max(g.zTop, g.inverted ? 0 + g.spk.H : g.ha + g.ds + g.spk.H) + 60;
  const half = Math.max(160, g.spk.W + g.L);
  scene.push(wallGhost(-half, half, zLow, zHigh));
  scene.push(speakerGhost(spMin, spMax, hp));
  // ---- load
  const kg = g.spk.kg;
  const Ns = kg * 9.81;
  const reach = g.back ? g.ds + g.spk.D / 2 : 0;
  const lever = g.L + reach;
  const moment = (Ns * lever) / 1000;
  const prof = channelProfile(g);
  let section = M.CrossSection.square([g.W, g.Ha]).translate([-g.W / 2, -g.Ha]);
  if (g.cable !== 'none') section = section.subtract(poly(M, prof.map(([a, b]) => [g.W / 2 + a, g.zc - b] as Vec2)));
  const S = sectionModulus(section);
  const keyhole = str(p, 'mount') === 'keyhole';
  const perFix = keyhole ? 5 : 10;
  const top = g.fix.slice(0, g.fix.length - 1);
  const zPivot = g.zBot;
  const mountMoment = top.reduce((acc, [, z]) => acc + perFix * 9.81 * (z - zPivot), 0) / 1000;
  const mountKg = (mountMoment * 1000) / Math.max(5, lever) / 9.81;
  const rating = rateSection(S, lever, false, mountKg, `de muurbevestiging (${top.length}× ${keyhole ? 'sleutelgat' : 'schroef'} boven de arm)`);
  const fTop = (moment * 1000) / Math.max(5, top[0][1] - zPivot) / top.length;
  // joints
  const fTilt = preload(g.tiltKnob.D, g.cb);
  const tiltHold = friction(fTilt, 0.25, g.cb.clear / 2 + 0.5, Math.min(g.rc, g.rt) - 0.5, 2);
  // back insert: the speaker hangs in front of the axis; bottom insert: it stands on it, worst at 45° tilt
  const comArm = g.back ? g.ds + g.spk.D / 2 : (g.ds + g.spk.H / 2) * Math.SQRT1_2;
  const tiltNeed = (Ns * comArm) / 1000;
  const fPan = preload(g.panKnob.D, g.cb);
  const panHold = friction(fPan, 0.25, g.Rs0 + 0.5, g.Rb - 1, 1);
  if (kg > rating.petg) warnings.push(`Een speaker van ${fmt(kg, 1)} kg is meer dan de richtwaarde van deze houder (${fmt(rating.petg, 1)} kg in PETG). Maak de arm korter of hoger, of gebruik meer schroeven.`);
  if (tiltHold < tiltNeed * 1.5) warnings.push(`De kantelklem houdt ≈ ${fmt(tiltHold, 1)} N·m en de speaker trekt met ≈ ${fmt(tiltNeed, 1)} N·m: weinig marge. Kies M6-klembouten of een lichtere/kleinere speaker.`);
  if (g.printed) warnings.push('Geprinte draad: de lagen liggen dwars op de bout, dus die breekt veel eerder dan een stalen bout. Alleen voor lichte speakers (tot ± 0,5 kg), draai hem met gevoel vast en controleer hem af en toe.');
  if (R.panMax < 90 || R.panMin > -90) notes.push(`Draaien kan van ${R.panMin}° tot ${R.panMax}° voordat de speaker de muur of de arm raakt${g.L < 200 ? '; met een langere arm kan het verder' : ''}.`);
  // ---- info
  const info: InfoBlock[] = [];
  info.push({
    kind: 'kv',
    title: 'Speakerhouder',
    rows: [
      ['Uitvoering', g.back ? 'arm met kantelkop, speaker aan de achterkant vast (kop hangt onder de arm)' : 'arm met kantelkop, speaker staat op de kop (draadgat onderin)'],
      ['Arm', `${g.L} mm van de muur tot het draaipunt, ${g.W} × ${g.Ha} mm`],
      ['Muurplaat', `${g.W} × ${fmt(g.zTop - g.zBot)} mm, ${fmt(g.Tp, 1)} mm dik`],
      ['Draaien', `${R.panMin}° … +${R.panMax}° (voorbeeld ${pan}°)`],
      ['Kantelen', `${R.tiltMin}° … +${R.tiltMax}° (voorbeeld ${tilt}°; min = omlaag)`],
      ['Speaker', `${g.spk.W} × ${g.spk.D} × ${g.spk.H} mm, ${fmt(kg, 1)} kg`],
    ],
  });
  const wood = WOOD_SCREW[str(p, 'screw')] ?? WOOD_SCREW.M4;
  const screwLen = Math.ceil((g.Tp + 32) / 5) * 5;
  const hw: (string | number)[][] = [];
  hw.push(['Speakerbout', n, g.printed ? `geen: de knop heeft geprinte ${g.sb.label}-draad (${fmt(g.speakerKnob.L, 1)} mm)` : `zeskantbout ${boltLabel(g.sb, g.speakerKnob.L)}; de kop zit in de speakerknop, ${fmt(g.e, 1)} mm draad in de speaker`]);
  hw.push(['Kantelbout + moer', n, `zeskantbout ${boltLabel(g.cb, g.tiltKnob.L)} + moer ${g.cb.label}`]);
  hw.push(['Draaibout + moer', n, `zeskantbout ${boltLabel(g.cb, g.panKnob.L)} + moer ${g.cb.label}`]);
  hw.push(['Houtschroeven + pluggen', n * g.fix.length, `${keyhole ? 'bolle/platte kop' : 'verzonken kop'} ${wood.label} × ${screwLen} mm met plug ${wood.label === '4' ? 6 : 8} mm${keyhole ? ' (onderste schroef: verzonken)' : ''}`]);
  hw.push(['Optioneel', n * 2, `sluitring ${g.cb.label} onder de klemknoppen (glijdt soepeler)`]);
  info.push({ kind: 'table', title: 'Benodigdheden (per bestelling)', headers: ['Wat', 'Aantal', 'Maat / opmerking'], rows: hw });
  info.push({
    kind: 'kv',
    title: 'Belasting',
    rows: [
      ['Moment op de muur', `≈ ${fmt(moment, 2)} N·m (${fmt(kg, 1)} kg op ${fmt(lever)} mm)`],
      ['Trekkracht bovenste schroef', `≈ ${fmt(fTop, 0)} N (${fmt(fTop / 9.81, 1)} kg)`],
      ['Draagvermogen (richtwaarde)', `≈ ${fmt(rating.petg, 1)} kg in PETG · ${fmt(rating.pla, 1)} kg in PLA`],
      ['Beperkt door', rating.limit],
      ['Kantelklem', `houdt ≈ ${fmt(tiltHold, 1)} N·m, nodig ≈ ${fmt(tiltNeed, 2)} N·m`],
      ['Draaiklem', `houdt ≈ ${fmt(panHold, 1)} N·m (wrijving, knoppen met de hand vast)`],
      ['Uitgangspunt', 'PETG, 4 wanden en 40% infill; schroeven in steen of beton met plug. In gipsplaat: hollewandpluggen.'],
    ],
  });
  const steps = [
    `Druk de kop van de speakerbout in de zeskant van de speakerknop (eventueel een druppel lijm) en steek de bout van achter door de speakerkop${g.tpad ? ' en het kussentje' : ''}.`,
    'Schuif een moer in de gleuf aan de achterkant van het draaistuk en zet het draaistuk op de kegel van de arm.',
    'Steek de draaibout (kop in de knop draaien) van onder door de arm en draai hem in die moer. Nog niet vast.',
    'Leg een moer in de zeskant van de speakerkop, zet de kop met de wangen over de tong van het draaistuk en steek de kantelbout (kop in de knop kantelen) erdoor.',
    `Schroef de muurbeugel ${keyhole ? 'over de schroefkoppen (sleutelgaten) en zet de onderste schroef vast' : 'met de verzonken schroeven en pluggen tegen de muur'}; gebruik de beugel als boormal.`,
    g.cable === 'none' ? 'Sluit de kabel aan.' : g.cable === 'down' ? 'Leg de kabel in de goot langs de arm en omlaag langs de muurplaat en schuif de afdekstrips in de zwaluwstaart: de lange vanaf de punt van de arm, de korte van onder.' : 'Leg de kabel in de goot langs de arm, door de muurplaat de muur in (boor daar een gat), en schuif de afdekstrip vanaf de punt van de arm in de zwaluwstaart.',
    'Houd de speaker tegen het kussentje en draai de speakerknop tot hij vastzit. Richt de speaker en zet de knoppen draaien en kantelen met de hand vast.',
  ];
  info.push({ kind: 'text', title: 'Montage', text: steps.map((t, i) => `${i + 1}. ${t}`).join('\n') });
  tips.push('Printstand: de muurbeugel op zijn zijkant (de kabelgoot boven), het draaistuk op zijn schijf, de speakerkop op de speakerplaat, de knoppen op hun platte kant. Alles zonder support; de lagen lopen door de arm, zodat het gewicht ze nooit uit elkaar trekt.');
  tips.push('Print in PETG (taaier dan PLA, kruipt minder onder blijvende last): 4 wanden, 40% infill voor beugel, draaistuk en kop; knoppen mogen 25%.');
  if (g.tpad) tips.push('Het kussentje in TPU 95A: het beschermt de speaker en geeft grip, zodat de speaker niet om de bout draait.');
  tips.push(`De klembouten zijn gekochte ${g.cb.label}-bouten met moeren: de koppen klemmen in de knoppen (druk ze erin, een druppel lijm helpt).`);
  if (g.printed) tips.push('Print de knop met geprinte draad rechtop (draad omhoog) met 0,12 mm lagen en 100% infill; de kleine flanken van de draad lukken zo zonder support. Draai hem eerst een keer in en uit om de draad schoon te maken.');
  if (g.sb.inch) tips.push('1/4"-20 bouten (camerabout) vind je bij fotozaken of online; een kort cameraschroefje met platte kop past ook als de kop in de knop past.');
  return { parts, scene, info, tips: [...notes, ...tips], warnings, defaultView: 'assembly' };
}

function shelfBuild(p: Params, ctx: { M: ManifoldToplevel; printer: PrinterProfile }): BuildOutput {
  const { M, printer } = ctx;
  const s = shelfGeometry(p);
  const notes = [...s.notes];
  const warnings: string[] = [];
  const tips: string[] = [];
  const n = clamp(Math.round(num(p, 'count')), 1, 4);
  // rotation range: the speaker corners stay in front of the wall
  const { W, D, H, kg } = s.spk;
  const topC = s.topC;
  const corners: Vec2[] = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  const clearAt = (a: number) => corners.every(([x, y]) => s.yc + x * Math.sin((a * Math.PI) / 180) + y * Math.cos((a * Math.PI) / 180) >= 2);
  let panMax = 0;
  while (panMax < 180 && clearAt(panMax + 1)) panMax++;
  const panReq = num(p, 'pan');
  const pan = clamp(panReq, -panMax, panMax);
  if (pan !== panReq) warnings.push(`Het voorbeeld staat op ${pan}°: verder raakt de speaker de muur.`);
  const placed: Placed[] = [];
  const add = (part: PartOut, print: M4, pose?: M4) => placed.push({ part: { quantity: n, ...part }, print, pose });
  add({ name: 'Plank', solid: shelfSolid(M, p, s), color: C_PART, material: 'petg-hf' }, rotY(-90), identity());
  const plat = mul(translation(0, s.yc, 0), rotZ(pan));
  add({ name: 'Draaiplateau', solid: plateauSolid(M, s), color: C_PART, material: 'petg-hf' }, identity(), plat);
  add({ name: s.printed ? 'Draaiknop met bus en geprinte draad' : 'Draaiknop met bus', solid: pivotSolid(M, s), color: C_KNOB, material: 'petg-hf' }, s.printed ? rotX(180) : identity(), mul(plat, rotX(180)));
  if (s.lock) add({ name: 'Klemknop', solid: knobSolid(M, s.lockKnob.D, s.lockKnob.H, s.cb.clear, s.cb.headAF + 0.15, s.cb.headH + 0.4), color: C_KNOB, material: 'petg-hf' }, identity(), frameZ([0, 1, 0], [0, s.Ds, s.zLock]));
  const onTop = mul(plat, mul(translation(0, 0, topC), rotX(-s.wedge)));
  if (s.tpad > 0) {
    const fp = poly(M, roundRectPts(Math.min(W - 4, 2 * s.Rp - 6), Math.min(D - 4, 2 * s.Rp - 6), 5)).intersect(M.CrossSection.circle(s.Rp - 3, 72));
    const pad = (s.boltFix ? fp.subtract(M.CrossSection.circle(s.pb.clear / 2 + 0.3, 32)) : fp).extrude(s.tpad);
    add({ name: 'Kussentje (TPU)', solid: pad, color: C_PAD, material: 'tpu-95a-hf', purpose: 'flexible' }, identity(), onTop);
  }
  const { parts, scene } = finish(placed, []);
  const forced = s.rim && 2 * s.Rp > num(p, 'plateD');
  checkFit(printer, parts, (name) =>
    name !== 'Plank' && name !== 'Draaiplateau'
      ? 'Kies kleinere maten.'
      : forced
        ? 'De rand om deze speaker maakt het plateau zo groot: kies "Bout in de onderkant" (zonder rand) of een grotere printer.'
        : 'Kies een kleiner draaiplateau (of een kleinere speaker).',
  );
  scene.push(wallGhost(-Math.max(150, s.Ws), Math.max(150, s.Ws), s.zBot - 60, topC + s.tpad + H + 60));
  scene.push(speakerGhost([-W / 2, -D / 2, s.tpad], [W / 2, D / 2, s.tpad + H], onTop));
  // ---- load (moment on the wall, top fixings in tension around the bottom edge)
  const Ns = kg * 9.81;
  const lever = s.yc;
  const moment = (Ns * lever) / 1000;
  const keyhole = str(p, 'mount') === 'keyhole';
  const perFix = keyhole ? 5 : 10;
  const mountMoment = (s.topFix.length * perFix * 9.81 * (s.zs1 - s.zBot)) / 1000;
  const mountKg = (mountMoment * 1000) / lever / 9.81;
  // shelf top as a cantilever beyond the strut joint (in-layer)
  const cant = Math.max(5, s.yc - s.Xs);
  const top = rateSection((s.Ws * s.ttop * s.ttop) / 6, cant, false, mountKg, `de muurbevestiging (${s.topFix.length}× ${keyhole ? 'sleutelgat' : 'schroef'} boven)`);
  if (kg > top.petg) warnings.push(`Een speaker van ${fmt(kg, 1)} kg is meer dan de richtwaarde (${fmt(top.petg, 1)} kg in PETG): gebruik verzonken schroeven in steen of een kleiner plateau.`);
  if (s.printed) warnings.push('Geprinte draad: de lagen liggen dwars op de bout, dus die breekt veel eerder dan een stalen bout. Alleen voor lichte speakers (tot ± 0,5 kg) en draai met gevoel vast.');
  if (!s.boltFix && s.rimH < 8) warnings.push('Een lage rand houdt de speaker alleen tegen schuiven; met een stoot kan hij eraf. Kies een hogere rand of zet hem ook met een bout vast.');
  if (panMax < 180) notes.push(`Draaien kan ±${panMax}° voordat de speaker de muur raakt.`);
  const lockHold = s.lock ? (0.3 * preload(s.lockKnob.D, s.cb) * 0.6 * s.Rp) / 1000 : 0;
  const info: InfoBlock[] = [];
  info.push({
    kind: 'kv',
    title: 'Speakerplankje',
    rows: [
      ['Plank', `${fmt(s.Ws)} breed × ${fmt(s.Ds)} diep, steun ${fmt(s.Hs)} mm omlaag`],
      ['Draaiplateau', `Ø ${2 * s.Rp} mm, ${s.tpl} mm dik${s.rim ? `, rand ${s.rimH} mm` : ''}${s.wedge ? `, kantelwig ${s.wedge}°` : ''}`],
      ['Speaker vast met', s.fixing === 'rim' ? 'de opstaande rand' : s.fixing === 'bolt' ? `een ${s.pb.label}-bout in de onderkant` : `een ${s.pb.label}-bout in de onderkant + rand`],
      ['Draaien', panMax >= 180 ? 'helemaal rond' : `±${panMax}° (voorbeeld ${pan}°)`],
      ['Speaker', `${W} × ${D} × ${H} mm, ${fmt(kg, 1)} kg`],
    ],
  });
  const wood = WOOD_SCREW[str(p, 'screw')] ?? WOOD_SCREW.M4;
  const screwLen = Math.ceil((s.Tb + 32) / 5) * 5;
  const hw: (string | number)[][] = [];
  if (s.boltFix) hw.push(['Speakerbout (draaias)', n, s.printed ? `geen: de draaiknop heeft geprinte ${s.pb.label}-draad` : `zeskantbout ${boltLabel(s.pb, s.pivot.L)}; de kop zit in de draaiknop, ${fmt(s.e, 1)} mm draad in de speaker`]);
  else hw.push(['Draaias', n, `zeskantbout ${boltLabel(s.pb, s.pivot.L)} + moer ${s.pb.label} (in het plateau, onder de speaker)`]);
  if (s.lock) hw.push(['Klembout + moer', n, `zeskantbout ${boltLabel(s.cb, s.lockKnob.L)} + moer ${s.cb.label}`]);
  hw.push(['Houtschroeven + pluggen', n * (s.topFix.length + s.botFix.length), `${keyhole ? 'boven sleutelgaten (bolle kop), onder verzonken' : 'verzonken kop'} ${wood.label} × ${screwLen} mm met plug`]);
  info.push({ kind: 'table', title: 'Benodigdheden (per bestelling)', headers: ['Wat', 'Aantal', 'Maat / opmerking'], rows: hw });
  info.push({
    kind: 'kv',
    title: 'Belasting',
    rows: [
      ['Moment op de muur', `≈ ${fmt(moment, 2)} N·m (${fmt(kg, 1)} kg op ${fmt(lever)} mm)`],
      ['Draagvermogen (richtwaarde)', `≈ ${fmt(top.petg, 1)} kg in PETG · ${fmt(top.pla, 1)} kg in PLA`],
      ['Beperkt door', top.limit],
      ...(s.lock ? [['Klemknop', `houdt ≈ ${fmt(lockHold, 1)} N·m tegen draaien`] as [string, string]] : []),
      ['Uitgangspunt', 'PETG, 4 wanden en 30% infill; schroeven in steen of beton met plug.'],
    ],
  });
  const steps = [
    s.boltFix ? `Druk de kop van de bout in de zeskant onder in de draaiknop${s.printed ? '' : ' (een druppel lijm helpt)'}.` : `Druk de kop van de bout in de zeskant onder in de draaiknop en leg de moer in de zeskant bovenin het plateau.`,
    `Schroef de plank tegen de muur: eerst ${s.topFix.length === 2 ? 'de twee schroeven' : 'de schroef'} bovenin (de schroevendraaier past door de gaten in de schuine steun), dan de onderste.`,
    s.cable === 'none' ? 'Leg de kabel achter het plateau langs.' : s.cable === 'down' ? 'Steek de kabel door het gat achter het plateau: hij komt onder de steun naar buiten en loopt omlaag langs de muur.' : 'Steek de kabel door het gat achter het plateau en door het gat in de achterplaat de muur in (boor daar een gat).',
    `Zet het plateau op de plank${s.tpad ? ' met het kussentje erop' : ''}, steek de draaiknop van onder door de plank en het plateau.`,
    s.boltFix ? 'Zet de speaker erop en draai de draaiknop tot de bout de speaker vastzet: speaker, plateau en knop draaien nu samen.' : 'Draai de draaiknop vast in de moer en zet de speaker in de rand.',
    s.lock ? 'Richt de speaker en zet hem vast met de klemknop aan de voorkant.' : 'Richt de speaker; hij draait stroef genoeg om te blijven staan.',
  ];
  info.push({ kind: 'text', title: 'Montage', text: steps.map((t, i) => `${i + 1}. ${t}`).join('\n') });
  tips.push('Printstand: de plank op zijn zijkant (de steun ligt in de lagen, dus het gewicht trekt ze nooit uit elkaar), het plateau op zijn onderkant, de draaiknop op de bus, de klemknop op zijn platte kant. Alles zonder support.');
  tips.push('Print in PETG: 4 wanden, 30% infill voor de plank en het plateau.');
  if (s.tpad) tips.push('Het kussentje in TPU 95A geeft grip en dempt trillingen.');
  if (s.printed) tips.push('Print de draaiknop met geprinte draad rechtop (draad omhoog) met 0,12 mm lagen en 100% infill; de kleine flanken van de draad lukken zo zonder support.');
  return { parts, scene, info, tips: [...notes, ...tips], warnings, defaultView: 'assembly' };
}

function build(p: Params, ctx: { M: ManifoldToplevel; printer: PrinterProfile }): BuildOutput {
  return str(p, 'style') === 'shelf' ? shelfBuild(p, ctx) : armBuild(p, ctx);
}

// ---------------------------------------------------------------------------
// Parameters

const isArm = (p: Params) => str(p, 'style') !== 'shelf';
const isShelf = (p: Params) => str(p, 'style') === 'shelf';
const usesBolt = (p: Params) => isArm(p) || str(p, 'shelfFix') !== 'rim';

export const SPEAKER_PARAMS: ParamDef[] = [
  { type: 'group', label: 'Ontwerp' },
  {
    type: 'select', key: 'style', label: 'Soort houder', default: 'arm',
    options: [
      { value: 'arm', label: 'Muurplaat met arm (draaien + kantelen)' },
      { value: 'shelf', label: 'Plankje met draaiplateau' },
    ],
  },
  { type: 'number', key: 'count', label: 'Aantal (speakers)', min: 1, max: 4, step: 1, default: 2 },
  { type: 'group', label: 'Speaker' },
  { type: 'number', key: 'spkW', label: 'Breedte speaker', min: 50, max: 300, step: 1, unit: 'mm', default: 110 },
  { type: 'number', key: 'spkD', label: 'Diepte speaker', min: 50, max: 300, step: 1, unit: 'mm', default: 110 },
  { type: 'number', key: 'spkH', label: 'Hoogte speaker', min: 50, max: 350, step: 1, unit: 'mm', default: 150 },
  { type: 'number', key: 'spkKg', label: 'Gewicht speaker', min: 0.2, max: 6, step: 0.1, unit: 'kg', default: 1 },
  {
    type: 'select', key: 'thread', label: 'Schroefdraad in de speaker', default: '1/4-20', show: usesBolt,
    options: [
      { value: '1/4-20', label: '1/4"-20 UNC (camerastatief)' },
      { value: 'M5', label: 'M5' },
      { value: 'M6', label: 'M6' },
    ],
    help: 'Twijfel je: een camerabout (1/4") is het meest gangbaar bij kleine speakers.',
  },
  {
    type: 'select', key: 'insertPos', label: 'Waar zit het draadgat?', default: 'back', show: isArm,
    options: [
      { value: 'back', label: 'Achterkant' },
      { value: 'bottom', label: 'Onderkant' },
    ],
  },
  { type: 'number', key: 'insertZ', label: 'Hoogte draadgat (vanaf de onderkant)', min: 10, max: 340, step: 1, unit: 'mm', default: 75, show: (p) => isArm(p) && str(p, 'insertPos') !== 'bottom' },
  { type: 'number', key: 'insertDepth', label: 'Diepte draadgat', min: 4, max: 20, step: 0.5, unit: 'mm', default: 8, show: usesBolt, help: 'Meet met een satéprikker. De bout gaat er 1 mm minder diep in, zodat hij nooit tegen de bodem drukt.' },
  {
    type: 'select', key: 'connect', label: 'Bevestiging aan de speaker', default: 'bolt', show: usesBolt,
    options: [
      { value: 'bolt', label: 'Gekochte bout in een geprinte knop (sterk)' },
      { value: 'printed', label: 'Geprinte draad (zwak, alleen lichte speakers)' },
    ],
  },
  { type: 'bool', key: 'pad', label: 'Zacht kussentje (TPU)', default: true, help: 'Beschermt de speaker en geeft grip.' },
  { type: 'group', label: 'Draaien & kantelen' },
  {
    type: 'select', key: 'clampBolt', label: 'Klembouten', default: 'M6', show: (p) => isArm(p) || bool(p, 'lock') || str(p, 'shelfFix') === 'rim',
    options: [
      { value: 'M6', label: 'M6 (sterkst)' },
      { value: 'M5', label: 'M5' },
    ],
  },
  { type: 'number', key: 'pan', label: 'Voorbeeld: draaien', min: -90, max: 90, step: 5, unit: '°', default: 25 },
  { type: 'number', key: 'tilt', label: 'Voorbeeld: kantelen', min: -45, max: 30, step: 5, unit: '°', default: -10, show: isArm, help: 'Min = omlaag gericht.' },
  { type: 'group', label: 'Muurplaat & arm', show: isArm },
  { type: 'number', key: 'armLen', label: 'Armlengte (muur tot draaipunt)', min: 30, max: 250, step: 5, unit: 'mm', default: 90, show: isArm, scale: true },
  { type: 'number', key: 'armW', label: 'Breedte arm', min: 30, max: 44, step: 1, unit: 'mm', default: 34, show: isArm },
  { type: 'number', key: 'armH', label: 'Hoogte arm', min: 18, max: 36, step: 1, unit: 'mm', default: 22, show: isArm },
  { type: 'number', key: 'screws', label: 'Aantal schroeven', min: 2, max: 3, step: 1, default: 2, show: isArm },
  { type: 'group', label: 'Plank', show: isShelf },
  { type: 'number', key: 'plateD', label: 'Diameter draaiplateau', min: 60, max: 200, step: 5, unit: 'mm', default: 110, show: isShelf },
  {
    type: 'select', key: 'shelfFix', label: 'Speaker vastzetten', default: 'both', show: isShelf,
    options: [
      { value: 'both', label: 'Bout in de onderkant + rand' },
      { value: 'bolt', label: 'Bout in de onderkant' },
      { value: 'rim', label: 'Alleen een opstaande rand' },
    ],
  },
  { type: 'number', key: 'rimH', label: 'Hoogte rand', min: 4, max: 30, step: 1, unit: 'mm', default: 10, show: (p) => isShelf(p) && str(p, 'shelfFix') !== 'bolt' },
  { type: 'number', key: 'wedge', label: 'Kantelwig (vast)', min: 0, max: 20, step: 1, unit: '°', default: 0, show: (p) => isShelf(p) && str(p, 'shelfFix') === 'rim', help: 'Laat de speaker iets voorover hellen.' },
  { type: 'bool', key: 'lock', label: 'Klemknop om het draaien vast te zetten', default: true, show: isShelf },
  { type: 'group', label: 'Kabel & muur' },
  {
    type: 'select', key: 'cable', label: 'Kabel', default: 'down',
    options: [
      { value: 'down', label: 'Verborgen, omlaag langs de muur' },
      { value: 'wall', label: 'Verborgen, de muur in' },
      { value: 'none', label: 'Geen kabelgoot' },
    ],
  },
  { type: 'number', key: 'cableD', label: 'Kabeldikte', min: 3, max: 12, step: 0.5, unit: 'mm', default: 6, show: (p) => str(p, 'cable') !== 'none', help: 'Dikte van de kabel (of de stekker als die erdoor moet bij een plank).' },
  {
    type: 'select', key: 'mount', label: 'Muurbevestiging', default: 'screws',
    options: [
      { value: 'screws', label: 'Verzonken schroeven + pluggen' },
      { value: 'keyhole', label: 'Sleutelgaten (onzichtbaar ophangen)' },
    ],
  },
  {
    type: 'select', key: 'screw', label: 'Schroefmaat', default: 'M4',
    options: [
      { value: 'M4', label: '4 mm houtschroef' },
      { value: 'M5', label: '5 mm houtschroef' },
    ],
  },
];

export const SPEAKER_PRESETS: Preset[] = [
  { name: 'Arm kort draaien+kantelen', values: { style: 'arm', armLen: 70, thread: '1/4-20', insertPos: 'back', spkW: 110, spkD: 110, spkH: 150, spkKg: 1, insertZ: 75, pan: 25, tilt: -10, cable: 'down', mount: 'screws' } },
  { name: 'Lange arm voor hoek', values: { style: 'arm', armLen: 200, thread: '1/4-20', insertPos: 'back', spkW: 110, spkD: 110, spkH: 150, spkKg: 1.2, insertZ: 90, pan: 45, tilt: -15, armH: 26, screws: 3, cable: 'wall', mount: 'screws' } },
  { name: 'Plankje met draaiplateau', values: { style: 'shelf', plateD: 120, shelfFix: 'both', rimH: 10, thread: '1/4-20', spkW: 110, spkD: 110, spkH: 150, spkKg: 1, pan: 20, lock: true, cable: 'down' } },
  { name: 'Bose-achtig kubusje (1/4")', values: { style: 'arm', armLen: 60, thread: '1/4-20', insertPos: 'back', spkW: 80, spkD: 80, spkH: 80, spkKg: 0.4, insertZ: 40, insertDepth: 7, armW: 30, armH: 20, clampBolt: 'M5', pan: 30, tilt: -15, cable: 'down', cableD: 4.5 } },
  { name: 'Staande speaker op de arm (M6 onderin)', values: { style: 'arm', armLen: 110, thread: 'M6', insertPos: 'bottom', spkW: 100, spkD: 120, spkH: 160, spkKg: 1.5, pan: -20, tilt: -15, cable: 'down' } },
];

export const speakersTool: ToolDef = {
  id: 'speakers',
  name: 'Speakerhouders',
  short: 'Speakers',
  icon: 'M6 4h8v16H6zM10 15a2 2 0 1 0 0 .01M10 8a1 1 0 1 0 0 .01M14 12h3l3-3v8l-3-3h-3',
  description:
    'Muurhouders voor kleine speakers met een schroefdraadgat (1/4"-20, M5 of M6): een muurplaat met arm en een kantelkop die draait en kantelt (vast te zetten met knoppen), of een plankje met een draaiplateau. De kabel loopt verborgen door de arm of de plank.',
  params: SPEAKER_PARAMS,
  presets: SPEAKER_PRESETS,
  build,
};

