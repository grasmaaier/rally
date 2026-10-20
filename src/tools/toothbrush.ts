import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { BuildOutput, InfoBlock, Params, PartOut, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { keep } from '../core/registry';
import { DEFAULT_PRINTER, fitsOn, usable } from '../core/printer';
import { clamp, filletExtrude, roundedRect, teardrop } from '../geom/helpers';

// ---------------------------------------------------------------------------
// Coordinates: X along the wall, Z up, the back of the plate at y = 0 and the
// holders sticking out towards -Y. The holder prints exactly as it hangs
// (plate standing on its bottom edge), so the engine only recentres it.
// Module code works in a local frame: x around the module centre, y = 0 at
// the front face of the plate (forward = -y) and z = 0 at the module top.

const H2 = Math.SQRT1_2;

// ---- brands ---------------------------------------------------------------

export interface BrushDims {
  label: string;
  short: string;
  /** Handle cross-section (width along the wall, depth away from it). */
  handleW: number;
  handleD: number;
  /** Width just under the handle: the part that hangs in the fork slot. */
  neckW: number;
  /** Width of the bristle head (hangs below the fork). */
  headW: number;
  /** Outer diameter of the base of a brush head (for the sockets). */
  headBase: number;
  /** Diameter of the storage peg that fits into a brush head. */
  pegD: number;
  chargerD: number;
  chargerH: number;
  /** Total length with head, and the length of the head (for the ghosts). */
  length: number;
  headLen: number;
}

export const BRANDS: Record<string, BrushDims> = {
  sonicare: { label: 'Philips Sonicare', short: 'Sonicare', handleW: 28, handleD: 30, neckW: 11, headW: 13, headBase: 12.5, pegD: 4.2, chargerD: 60, chargerH: 22, length: 255, headLen: 80 },
  oralb: { label: 'Oral-B Pro / Vitality / Smart / Genius', short: 'Oral-B', handleW: 31, handleD: 34, neckW: 13, headW: 17, headBase: 13.5, pegD: 6.2, chargerD: 56, chargerH: 28, length: 235, headLen: 70 },
  oralbio: { label: 'Oral-B iO', short: 'Oral-B iO', handleW: 31, handleD: 33, neckW: 12.5, headW: 17, headBase: 13, pegD: 6.2, chargerD: 62, chargerH: 16, length: 245, headLen: 72 },
};

const BRAND_OPTIONS = [
  { value: 'sonicare', label: 'Philips Sonicare (richtwaarde)' },
  { value: 'oralb', label: 'Oral-B Pro/Vitality/Smart/Genius (richtwaarde)' },
  { value: 'oralbio', label: 'Oral-B iO (richtwaarde)' },
  { value: 'custom', label: 'Eigen maat' },
];

function brushDims(p: Params, brand: string): BrushDims {
  const b = BRANDS[brand];
  if (b) return b;
  return {
    label: 'Eigen maat',
    short: 'Eigen maat',
    handleW: num(p, 'handleW'),
    handleD: num(p, 'handleD'),
    neckW: num(p, 'neckW'),
    headW: num(p, 'headW'),
    headBase: num(p, 'headBase'),
    pegD: num(p, 'pegD'),
    chargerD: num(p, 'chargerD'),
    chargerH: num(p, 'chargerH'),
    length: 240,
    headLen: 75,
  };
}

// ---- suction cups ---------------------------------------------------------

export interface CupDims {
  label: string;
  short: string;
  cupD: number;
  headD: number;
  headH: number;
  neckD: number;
  neckL: number;
  /** Distance wall - back of the plate with the cup pressed on. */
  standoff: number;
}

export const CUPS: Record<string, CupDims> = {
  ha011: { label: 'Bambu HA011 40 mm', short: 'HA011 Ø40', cupD: 40, headD: 12, headH: 3, neckD: 6, neckL: 3.5, standoff: 8 },
  g40: { label: 'Generieke zuignap 40 mm', short: 'Ø40', cupD: 40, headD: 11, headH: 2.5, neckD: 5.5, neckL: 3, standoff: 7 },
  g30: { label: 'Generieke zuignap 30 mm', short: 'Ø30', cupD: 30, headD: 9, headH: 2.5, neckD: 4.5, neckL: 2.5, standoff: 5 },
};

function cupDims(p: Params): CupDims {
  const mount = str(p, 'mount');
  const c = CUPS[str(p, 'cup')];
  if (mount === 'keyhole' && c) return c;
  return {
    label: mount === 'keyhole' ? 'Eigen maat' : mount === 'hook' ? 'Zuignap met haakje' : 'Zuignap met gat',
    short: `Ø${num(p, 'cupD')}${mount === 'hook' ? ' met haakje' : mount === 'pin' ? ' met gat' : ''}`,
    cupD: num(p, 'cupD'),
    headD: num(p, 'cupHeadD'),
    headH: num(p, 'cupHeadH'),
    neckD: num(p, 'cupNeckD'),
    neckL: num(p, 'cupNeckL'),
    standoff: num(p, 'standoff'),
  };
}

// ---- small geometry helpers ----------------------------------------------

function area(pts: Vec2[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function poly(M: ManifoldToplevel, pts: Vec2[]): CrossSection {
  return keep(new M.CrossSection([area(pts) < 0 ? [...pts].reverse() : pts]));
}

/** Rounded oval (superellipse) w x d around (cx, cy), CCW. */
function ovalPts(w: number, d: number, cx: number, cy: number, segs = 72, n = 2.6): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (Math.PI * 2 * i) / segs;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([cx + (w / 2) * Math.sign(c) * Math.abs(c) ** (2 / n), cy + (d / 2) * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return pts;
}

const oval = (M: ManifoldToplevel, w: number, d: number, cx: number, cy: number) => poly(M, ovalPts(w, d, cx, cy));

const at = (pts: Vec2[], z: number) => pts.map(([x, y]) => [x, y, z] as Vec3);

function circlePts(r: number, cx: number, cy: number, segs = 40): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) pts.push([cx + r * Math.cos((Math.PI * 2 * i) / segs), cy + r * Math.sin((Math.PI * 2 * i) / segs)]);
  return pts;
}

/** Axis-aligned rectangle x0..x1, y0..y1. */
const rect = (M: ManifoldToplevel, x0: number, x1: number, y0: number, y1: number) => M.CrossSection.square([x1 - x0, y1 - y0]).translate([x0, y0]);

/** Footprint with square back (into the plate) and rounded front corners. */
function shelfFootprint(M: ManifoldToplevel, width: number, depth: number, r: number) {
  r = clamp(r, 0.5, Math.min(width / 2, depth) - 0.1);
  return M.CrossSection.hull([
    M.CrossSection.circle(r, 24).translate([-width / 2 + r, -depth + r]),
    M.CrossSection.circle(r, 24).translate([width / 2 - r, -depth + r]),
    rect(M, -width / 2, width / 2, -1, 0.6),
  ]);
}

/**
 * Footprint extruded up to zTop with a 45° underside rising from the plate
 * (z = zA at the plate face, one mm higher per mm forward), so every
 * protruding holder prints without support.
 */
function chin(fp: CrossSection, zA: number, zTop: number): Manifold {
  return fp
    .extrude(zTop - zA + 1)
    .translate([0, 0, zA - 1])
    .trimByPlane([0, H2, H2], zA * H2);
}

/** 2D outline in the XZ plane (2D y = world z) as a prism from y0 to y1. */
function xzPrism(cs: CrossSection, y0: number, y1: number): Manifold {
  return cs.extrude(y1 - y0).rotate([90, 0, 0]).translate([0, y1, 0]);
}

/** Vertical stadium (2D, XZ) from z0 to z1 with teardrop tops so it prints in a vertical wall. */
function tearSlot(M: ManifoldToplevel, r: number, x: number, z0: number, z1: number): CrossSection {
  const a = teardrop(M, r, 40).translate([x, z0]);
  if (z1 - z0 < 0.01) return a;
  return M.CrossSection.hull([a, teardrop(M, r, 40).translate([x, z1])]);
}

type Ghost = Extract<SceneItem, { kind: 'box' }>;

function ghost(size: [number, number, number], x: number, y: number, z0: number, color: string, label: string): Ghost {
  return { kind: 'box', size, position: [x - size[0] / 2, y - size[1] / 2, z0], color, material: 'ghost', label };
}

const BRUSH = '#7fa7d9';
const HEAD = '#f2f2f2';
const CHARGER = '#9aa0a6';
const CUP = '#79c7b8';
const WALL = '#d8d2c8';
const PASTE = '#e39a9a';

// ---- holder modules -------------------------------------------------------

interface Opts {
  clr: number;
  wall: number;
  ringH: number;
  chargerRing: boolean;
}

interface Module {
  label: string;
  width: number;
  /** Lowest z (local, module top = 0). */
  bottom: number;
  /** Protrusion in front of the plate. */
  depth: number;
  build(M: ManifoldToplevel): Manifold;
  ghosts: Ghost[];
  note?: string;
}

/** Upright cup: open ring on a 45° funnel with a drain hole. */
function ringModule(b: BrushDims, o: Opts): Module {
  const iw = b.handleW + 2 * o.clr;
  const id = b.handleD + 2 * o.clr;
  const w = o.wall;
  const rd = clamp(Math.min(iw, id) / 2 - 5, 3, 7);
  const dz = Math.min(iw, id) / 2 - rd;
  const sc = id / 2 + w;
  const depth = sc + id / 2 + w;
  const zSeat = -o.ringH;
  const zf0 = zSeat - dz;
  const zA = zf0 - sc - rd - Math.max(0, (id - iw) / 2) - w * 1.5 - 1;
  return {
    label: 'Beker',
    width: iw + 2 * w,
    bottom: zA - 0.6,
    depth,
    build(M) {
      const fp = M.CrossSection.union([oval(M, iw + 2 * w, id + 2 * w, 0, -sc), rect(M, -(iw / 2 + w), iw / 2 + w, -sc, 0.6)]);
      const outer = chin(fp, zA, 0);
      const inner = ovalPts(iw, id, 0, -sc);
      const tube = oval(M, iw, id, 0, -sc).extrude(o.ringH + 1).translate([0, 0, zSeat]);
      const funnel = M.Manifold.hull([...at(inner, zSeat + 0.01), ...at(circlePts(rd, 0, -sc), zf0)]);
      const drain = M.Manifold.cylinder(zf0 - zA + 4, rd, rd, 40).translate([0, -sc, zA - 3]);
      return outer.subtract(M.Manifold.union([tube, funnel, drain]));
    },
    ghosts: [ghost([b.handleW, b.handleD, b.length], 0, -sc, zSeat, BRUSH, `${b.label} (handvat)`)],
  };
}

/**
 * Hanging fork: the brush hangs head-down, the neck in an open slot with a
 * lead-in, the handle shoulder in a shallow recess on top.
 */
function forkModule(
  b: { label: string; handleW: number; handleD: number; neckW: number; headW: number; length: number; headLen: number },
  o: Opts,
  recess: number,
  colors: [string, string] = [BRUSH, HEAD],
): Module {
  const nw = b.neckW + 2 * o.clr;
  const hg = Math.max(b.headW + 3, nw + 1);
  const iw = b.handleW + 2 * o.clr;
  const id = b.handleD + 2 * o.clr;
  const w = o.wall;
  const forkT = 7;
  const sc = Math.max(id / 2 + 2, hg / 2 + 2, nw / 2 + 3);
  const sf = sc + Math.max(id / 2 + w, nw / 2 + 8);
  const width = Math.max(iw + 2 * w, hg + 12);
  const zA = -forkT - sf - 1;
  const th = (hg - nw) / 2;
  const li = clamp(nw * 0.3, 2, 5);
  return {
    label: 'Ophangvork',
    width,
    bottom: zA - 0.6,
    depth: sf,
    build(M) {
      const outer = chin(shelfFootprint(M, width, sf, Math.min(8, width / 4)), zA, 0);
      const slot = M.CrossSection.union([
        M.CrossSection.hull([M.CrossSection.circle(nw / 2, 40).translate([0, -sc]), rect(M, -nw / 2, nw / 2, -sf - 2, -sf + 1)]),
        poly(M, [[-nw / 2, -sf + li * 1.5], [-nw / 2 - li, -sf - 0.5], [nw / 2 + li, -sf - 0.5], [nw / 2, -sf + li * 1.5]]),
      ]);
      const cuts: Manifold[] = [slot.extrude(forkT + 2).translate([0, 0, -forkT - 1])];
      const stadium = (r: number, z: number) => [...at(circlePts(r, 0, -sc), z), ...at(circlePts(r, 0, -sf - 3), z)];
      cuts.push(M.Manifold.hull([...stadium(nw / 2, -forkT + 0.2), ...stadium(hg / 2, -forkT - th)]));
      cuts.push(M.Manifold.hull([...stadium(hg / 2, -forkT - th + 0.01), ...stadium(hg / 2, zA - 2)]));
      if (recess > 0) cuts.push(oval(M, iw, id, 0, -sc).extrude(recess + 1).translate([0, 0, -recess]));
      return outer.subtract(M.Manifold.union(cuts));
    },
    ghosts: [
      ghost([b.handleW, b.handleD, b.length - b.headLen], 0, -sc, -recess, colors[0], `${b.label} (handvat)`),
      ghost([b.headW, b.headW, b.headLen], 0, -sc, -recess - b.headLen, colors[1], `${b.label} (opzetborstel)`),
    ],
  };
}

/** Shelf for the charging puck with a cable slit and drains, plus an optional ring that steadies the brush. */
function chargerModule(b: BrushDims, o: Opts): Module {
  const w = o.wall;
  const dc = b.chargerD + 2 * Math.max(0.5, o.clr);
  const lip = clamp(b.chargerH * 0.35, 3, 8);
  const ft = 3;
  const sc = dc / 2 + w;
  const depth = sc + dc / 2 + w;
  const iw = b.handleW + 2 * o.clr + 2;
  const id = b.handleD + 2 * o.clr + 2;
  const ringT = 9;
  let zFloor = -lip;
  let zAr = 0;
  if (o.chargerRing) {
    // the ring's chin must stay clear of the charger below it
    const sMaxR = sc + id / 2 + w;
    zAr = -ringT - sMaxR - 1;
    zFloor = Math.min(zAr + w - 1.5, -ringT - 40) - b.chargerH;
  }
  const puckTop = zFloor + b.chargerH;
  const zA = zFloor - ft - depth - 1;
  const cable = 4.6;
  return {
    label: 'Opladerplank',
    width: dc + 2 * w,
    bottom: zA - 0.6,
    depth,
    build(M) {
      const fp = M.CrossSection.union([M.CrossSection.circle(dc / 2 + w, 96).translate([0, -sc]), rect(M, -(dc / 2 + w), dc / 2 + w, -sc, 0.6)]);
      const shelf = chin(fp, zA, zFloor + lip);
      const cuts: Manifold[] = [M.Manifold.cylinder(lip + 1, dc / 2, dc / 2, 96).translate([0, -sc, zFloor])];
      // open slit from the middle of the puck down and out under the shelf: press the cable in from below
      cuts.push(M.Manifold.cube([cable, sc - w + 0.01, zFloor - zA + 4]).translate([-cable / 2, -sc, zA - 3]));
      for (const a of [30, 150, 210, 330]) {
        const r = dc * 0.32;
        const x = r * Math.cos((a * Math.PI) / 180);
        const y = -sc + r * Math.sin((a * Math.PI) / 180);
        cuts.push(M.Manifold.cylinder(zFloor - zA + 4, 2, 2, 20).translate([x, y, zA - 3]));
      }
      const pieces = [shelf.subtract(M.Manifold.union(cuts))];
      if (o.chargerRing) {
        const rfp = M.CrossSection.union([oval(M, iw + 2 * w, id + 2 * w, 0, -sc), rect(M, -(iw / 2 + w), iw / 2 + w, -sc, 0.6)]);
        pieces.push(chin(rfp, zAr, 0).subtract(oval(M, iw, id, 0, -sc).extrude(-zAr + 4).translate([0, 0, zAr - 3])));
      }
      return M.Manifold.union(pieces);
    },
    ghosts: [
      ghost([b.chargerD, b.chargerD, b.chargerH], 0, -sc, zFloor, CHARGER, 'Oplader'),
      ghost([b.handleW, b.handleD, b.length], 0, -sc, puckTop, BRUSH, `${b.label} (handvat)`),
    ],
  };
}

/** Storage for spare brush heads: upright pegs or sockets with drains. */
function headsModule(n: number, store: string, b: BrushDims, o: Opts, spacing: number, deep: boolean): Module {
  const rows = Math.min(n, n > 3 ? (deep ? 3 : 2) : deep ? 2 : 1);
  const cols = Math.ceil(n / rows);
  const holeD = b.headBase + 2 * o.clr;
  const sp = Math.max(spacing, store === 'holes' ? holeD + 3 : b.pegD + 8, b.headW + 2);
  const width = cols * sp + 2;
  const depth = rows * sp + 2;
  const pegs = store === 'pegs';
  const pegH = 12;
  const shelfT = pegs ? 5 : 12;
  const zTop = pegs ? -pegH : 0;
  const zA = zTop - shelfT - depth - 1;
  const spots: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    // centre a short last row
    spots.push([(c - (inRow - 1) / 2) * sp, -(1 + sp / 2 + r * sp)]);
  }
  return {
    label: 'Opzetborstels',
    width,
    bottom: zA - 0.6,
    depth,
    build(M) {
      const outer = chin(shelfFootprint(M, width, depth, 5), zA, zTop);
      const cuts: Manifold[] = [];
      const add: Manifold[] = [];
      for (const [x, y] of spots) {
        if (pegs) {
          const r = b.pegD / 2;
          add.push(M.Manifold.cylinder(pegH - 1.2, r, r, 32).translate([x, y, zTop - 0.5]));
          add.push(M.Manifold.cylinder(1.7, r, Math.max(0.6, r - 1), 32).translate([x, y, zTop + pegH - 1.7]));
          cuts.push(M.Manifold.cylinder(zTop - zA + 4, 1.8, 1.8, 16).translate([x + sp * 0.36, y - sp * 0.36, zA - 3]));
        } else {
          const r = holeD / 2;
          cuts.push(M.Manifold.cylinder(9.01, r, r, 48).translate([x, y, zTop - 9]));
          cuts.push(M.Manifold.cylinder(1, r, r + 1, 48).translate([x, y, zTop - 0.99]));
          cuts.push(M.Manifold.cylinder(zTop - zA + 4, 2.5, 2.5, 20).translate([x, y, zA - 3]));
        }
      }
      return M.Manifold.union([outer.subtract(M.Manifold.union(cuts)), ...add]);
    },
    ghosts: spots.map(([x, y]) => ghost([b.headW, b.headW, b.headLen * 0.8], x, y, pegs ? zTop + 2 : zTop - 8, HEAD, 'Opzetborstel')),
  };
}

// ---- layout -----------------------------------------------------------------

const BRUSH_TYPES = ['ring', 'fork', 'charger'];

function opts(p: Params): Opts {
  return { clr: num(p, 'clearance'), wall: num(p, 'wall'), ringH: num(p, 'ringH'), chargerRing: bool(p, 'chargerRing') };
}

function activeBrushes(p: Params) {
  const n = clamp(Math.round(num(p, 'count')), 1, 3);
  return Array.from({ length: n }, (_, i) => {
    const brand = str(p, `brand${i + 1}`);
    const type = str(p, `type${i + 1}`);
    return { brand, type: BRUSH_TYPES.includes(type) ? type : 'ring', dims: brushDims(p, brand) };
  });
}

function checkBrush(b: BrushDims) {
  if (b.neckW > Math.min(b.handleW, b.handleD) - 4)
    throw new UserError(`${b.label}: de hals (${b.neckW} mm) moet minstens 4 mm smaller zijn dan het handvat, anders zakt de borstel door de vork.`);
}

function buildModules(p: Params, deep = false): Module[] {
  const o = opts(p);
  const mods: Module[] = [];
  for (const { type, dims } of activeBrushes(p)) {
    if (type === 'fork') {
      checkBrush(dims);
      mods.push(forkModule(dims, o, 2.5));
    } else if (type === 'charger') mods.push(chargerModule(dims, o));
    else mods.push(ringModule(dims, o));
  }
  const heads = Math.round(num(p, 'heads'));
  if (heads > 0) mods.push(headsModule(heads, str(p, 'headStore'), activeBrushes(p)[0].dims, o, num(p, 'headSpacing'), deep));
  if (bool(p, 'paste')) {
    const cap = num(p, 'capD');
    const tubeT = num(p, 'tubeT');
    const m = forkModule({ label: 'Tandpasta', handleW: cap + 8, handleD: tubeT, neckW: cap, headW: cap - 2, length: 190, headLen: 20 }, o, 0, [PASTE, PASTE]);
    m.label = 'Tandpasta';
    mods.push(m);
  }
  return mods;
}

export interface MountPlan {
  kind: 'keyhole' | 'hook' | 'pin';
  cup: CupDims;
  /** Plate thickness. */
  T: number;
  /** Local plate thickness at the slot (keyhole: neck length - 0.2). */
  thin: number;
  /** Radius of the entry hole / pocket and of the neck slot (incl. clearance). */
  rHead: number;
  rNeck: number;
  /** z of the entry hole and of the top of the slot (where the cup ends up), above the module tops. */
  zEntry: number;
  zTop: number;
  /** Plate height needed above the module tops. */
  strip: number;
}

export function mountPlan(p: Params): MountPlan {
  const kind = (['keyhole', 'hook', 'pin'].includes(str(p, 'mount')) ? str(p, 'mount') : 'keyhole') as MountPlan['kind'];
  const cup = cupDims(p);
  const clr = num(p, 'cupClearance');
  const plateT = num(p, 'plateT');
  if (kind === 'keyhole') {
    if (cup.neckD > cup.headD - 2) throw new UserError('De kop van de zuignap moet minstens 2 mm breder zijn dan de hals, anders houdt het sleutelgat niets vast.');
    const rHead = cup.headD / 2 + clr;
    const rNeck = cup.neckD / 2 + clr * 0.6;
    const thin = Math.max(1.2, cup.neckL - 0.2);
    const T = Math.max(plateT, thin + cup.headH + 0.8);
    const zEntry = rHead + 3;
    const zTop = zEntry + rHead + rNeck + 2;
    return { kind, cup, T, thin, rHead, rNeck, zEntry, zTop, strip: zTop + Math.max(rHead * Math.SQRT2 + 4, cup.cupD / 2 - 3) };
  }
  if (kind === 'hook') {
    const rNeck = num(p, 'eyeD') / 2 + clr * 0.5;
    const rHead = rNeck + 3;
    const thin = num(p, 'eyeT');
    const T = Math.max(plateT, thin + 2);
    const zEntry = rHead + 3;
    const zTop = zEntry + rNeck * 1.6;
    return { kind, cup, T, thin, rHead, rNeck, zEntry, zTop, strip: zTop + Math.max(rHead * Math.SQRT2 + 4, cup.cupD / 2 - 3) };
  }
  const r = num(p, 'pinD') / 2;
  const zTop = Math.max(2 * r + 6, cup.cupD / 2 - 8);
  return { kind, cup, T: plateT, thin: plateT, rHead: r, rNeck: r, zEntry: zTop, zTop, strip: zTop + Math.max(r + 6, cup.cupD / 2 - 3) };
}

export interface HolderLayout {
  mount: MountPlan;
  modules: Module[];
  /** Module centres along X. */
  xs: number[];
  W: number;
  /** Plate from zBottom to zTopPlate (module tops at z = 0). */
  zBottom: number;
  zTopPlate: number;
  cupXs: number[];
  depth: number;
}

export function holderLayout(p: Params, printer: PrinterProfile = DEFAULT_PRINTER): HolderLayout {
  const L = layoutWith(p, false);
  const u = usable(printer);
  // too wide: store the spare heads in more rows (deeper instead of wider)
  if (L.W > Math.max(u.x, u.y) && num(p, 'heads') > 1) return layoutWith(p, true);
  return L;
}

function layoutWith(p: Params, deep: boolean): HolderLayout {
  const mount = mountPlan(p);
  const modules = buildModules(p, deep);
  const gap = num(p, 'gap');
  const margin = 6;
  const R = num(p, 'plateR');
  const span = modules.reduce((s, m) => s + m.width, 0) + gap * (modules.length - 1);
  const cupD = mount.cup.cupD;
  let W = Math.max(span + 2 * margin, 2 * R + 40, 2 * mount.rHead + 24, cupD + 8);
  const choice = str(p, 'cups');
  // a charger shelf carries the most weight: always two cups or more
  const heavy = activeBrushes(p).some((b) => b.type === 'charger');
  const n = choice === 'auto' ? (W < 75 && !heavy ? 1 : W < 210 ? 2 : 3) : clamp(Math.round(Number(choice)) || 2, 1, 3);
  // widen the plate a little when the cups need it
  W = Math.max(W, n * (cupD + 4) + 4);
  const xs: number[] = [];
  let x = -span / 2;
  for (const m of modules) {
    xs.push(x + m.width / 2);
    x += m.width + gap;
  }
  const edge = W / 2 - cupD / 2 - 2;
  const cupXs = n === 1 ? [0] : Array.from({ length: n }, (_, i) => -edge + (2 * edge * i) / (n - 1));
  const zBottom = Math.min(...modules.map((m) => m.bottom)) - 3;
  const depth = mount.T + Math.max(...modules.map((m) => m.depth)) + mount.cup.standoff;
  return { mount, modules, xs, W, zBottom, zTopPlate: mount.strip, cupXs, depth };
}

/** Cutter (or added pin) for one cup at x, in plate coordinates (back of the plate at y = 0). */
function mountCut(M: ManifoldToplevel, mp: MountPlan, x: number): { cut?: Manifold; add?: Manifold } {
  if (mp.kind === 'pin') {
    const r = mp.rHead;
    // teardrop pin with its tip clipped flat so it still fits a round hole
    // solid horizontal pin: the point faces down so its underside is 45°
    const prof = teardrop(M, r, 32).rotate(180).intersect(rect(M, -r - 1, r + 1, -r, r + 1));
    const L = clamp(Math.min(mp.cup.neckL, mp.cup.standoff - 1), 1.5, 20);
    return { add: xzPrism(prof.translate([x, mp.zTop]), -0.5, L) };
  }
  const through = M.CrossSection.union([tearSlot(M, mp.rNeck, x, mp.zEntry, mp.zTop), ...(mp.kind === 'keyhole' ? [teardrop(M, mp.rHead, 48).translate([x, mp.zEntry])] : [])]);
  const pocket = tearSlot(M, mp.rHead, x, mp.zEntry, mp.zTop);
  return { cut: M.Manifold.union([xzPrism(through, -mp.T - 1, 1), xzPrism(pocket, -mp.T - 1, -mp.thin)]) };
}

/**
 * Plate outline in XZ: rounded top corners, bottom corners that end in a 45°
 * chamfer (a "teardrop" corner) so the upright plate has no overhang.
 */
function plateOutline(M: ManifoldToplevel, W: number, z0: number, z1: number, r: number): CrossSection {
  const pts: Vec2[] = [];
  const seg = 10;
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + ((a1 - a0) * i) / seg) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  const k = r * (Math.SQRT2 - 1);
  pts.push([W / 2 - r + k, z0]);
  arc(W / 2 - r, z0 + r, -45, 0);
  arc(W / 2 - r, z1 - r, 0, 90);
  arc(-W / 2 + r, z1 - r, 90, 180);
  arc(-W / 2 + r, z0 + r, 180, 225);
  pts.push([-W / 2 + r - k, z0]);
  return poly(M, pts);
}

/** Back plate with keyholes and standoff pads, in plate coordinates (module tops at z = 0). */
function backPlate(M: ManifoldToplevel, L: HolderLayout, R: number, cupXs: number[], zBottom: number, zTop: number, W: number, pads: boolean): Manifold {
  const mp = L.mount;
  const H = zTop - zBottom;
  const r = Math.min(R, W / 2 - 1, H / 2 - 1);
  const outline = plateOutline(M, W, zBottom, zTop, r);
  // rounded front edges; the bottom 1.5 mm stays square so nothing overhangs right above the bed
  let plate = M.Manifold.union([
    filletExtrude(M, outline, mp.T, 0.4, 1.2, 0.4).rotate([90, 0, 0]),
    xzPrism(outline.intersect(rect(M, -W, W, zBottom - 1, zBottom + 1.5)), -mp.T, 0),
  ]);
  const cuts: Manifold[] = [];
  const adds: Manifold[] = [plate];
  for (const x of cupXs) {
    const c = mountCut(M, mp, x);
    if (c.cut) cuts.push(c.cut);
    if (c.add) adds.push(c.add);
  }
  if (pads) {
    // standoff pads at the bottom back: keep the plate parallel to the wall, top sloped so water runs off
    const s = mp.cup.standoff;
    const ph = Math.max(10, s + 4);
    const padXs = W >= 2 * r + 40 ? [-(W / 2 - r - 10), W / 2 - r - 10] : [0];
    const pw = padXs.length === 2 ? 16 : clamp(W - 2 * r - 4, 8, 30);
    for (const px of padXs) {
      const pts: Vec3[] = [];
      for (const dx of [-pw / 2, pw / 2])
        pts.push([px + dx, -0.5, zBottom], [px + dx, s, zBottom], [px + dx, s, zBottom + ph - s], [px + dx, -0.5, zBottom + ph]);
      adds.push(M.Manifold.hull(pts));
    }
  }
  plate = M.Manifold.union(adds);
  return cuts.length ? plate.subtract(M.Manifold.union(cuts)) : plate;
}

// ---- fit-test parts ---------------------------------------------------------

function fitTests(M: ManifoldToplevel, p: Params): BuildOutput {
  const mp = mountPlan(p);
  const o = opts(p);
  const parts: PartOut[] = [];
  const checks: string[] = [];
  // keyhole strip, printed upright like the real plate
  const W = Math.max(2 * mp.rHead + 16, 30);
  const top = mp.zTop + mp.rHead * Math.SQRT2 + 5;
  const L: HolderLayout = { mount: mp, modules: [], xs: [], W, zBottom: 0, zTopPlate: top, cupXs: [0], depth: mp.T };
  parts.push({ name: `Pasproef zuignap (${mp.cup.label})`, solid: backPlate(M, L, 4, [0], 0, top, W, false) });
  checks.push(
    mp.kind === 'keyhole'
      ? 'Sleutelgat: de kop gaat door het ronde gat, de hals schuift omhoog in de sleuf en de kop ligt verzonken in de uitsparing. Zit het te los of te strak? Pas "Speling zuignap" aan.'
      : mp.kind === 'hook'
        ? 'Oog: het haakje van de zuignap moet er met wat ruimte doorheen passen.'
        : 'Pen: de pen moet stevig in het gat van de zuignap klemmen.',
  );
  const brushes = activeBrushes(p);
  const brands = [...new Set(brushes.map((b) => b.brand))];
  for (const brand of brands) {
    const b = brushDims(p, brand);
    const iw = b.handleW + 2 * o.clr;
    const id = b.handleD + 2 * o.clr;
    const ring = oval(M, iw + 2 * o.wall, id + 2 * o.wall, 0, 0).subtract(oval(M, iw, id, 0, 0)).extrude(8);
    parts.push({ name: `Pasproef handvat ${b.label}`, solid: ring });
    // fork slot sample, flat on the bed
    const nw = b.neckW + 2 * o.clr;
    const fw = Math.max(nw + 16, 30);
    const fd = nw / 2 + 22;
    const li = clamp(nw * 0.3, 2, 5);
    const slot = M.CrossSection.union([
      M.CrossSection.hull([M.CrossSection.circle(nw / 2, 40).translate([0, 0]), rect(M, -nw / 2, nw / 2, -fd - 2, -fd + 1)]),
      poly(M, [[-nw / 2, -fd + li * 1.5], [-nw / 2 - li, -fd - 0.5], [nw / 2 + li, -fd - 0.5], [nw / 2, -fd + li * 1.5]]),
    ]);
    const plate = roundedRect(M, fw, fd + 12, 4).translate([0, -fd / 2 + 6]).subtract(slot);
    parts.push({ name: `Pasproef ophangvork ${b.label}`, solid: plate.extrude(5) });
  }
  checks.push('Handvatring: schuif hem over het handvat; hij moet er zonder klemmen overheen glijden (dit is de maat van de beker).');
  checks.push('Vorkje: de borstel moet met de hals (net onder het handvat) in de sleuf schuiven en op het handvat blijven hangen.');
  // brush-head sample: one peg and one socket
  const b0 = brushes[0].dims;
  const holeD = b0.headBase + 2 * o.clr;
  const sp = Math.max(holeD + 8, 22);
  const block = roundedRect(M, 2 * sp, sp, 4).extrude(12);
  const socket = M.Manifold.union([
    M.Manifold.cylinder(9.01, holeD / 2, holeD / 2, 48).translate([sp / 2, 0, 3]),
    M.Manifold.cylinder(1, holeD / 2, holeD / 2 + 1, 48).translate([sp / 2, 0, 11.01]),
    M.Manifold.cylinder(14, 2.5, 2.5, 20).translate([sp / 2, 0, -1]),
  ]);
  const r = b0.pegD / 2;
  const peg = M.Manifold.union([
    M.Manifold.cylinder(10.8, r, r, 32).translate([-sp / 2, 0, 11.5]),
    M.Manifold.cylinder(1.7, r, Math.max(0.6, r - 1), 32).translate([-sp / 2, 0, 22.3]),
  ]);
  parts.push({ name: `Pasproef opzetborstel ${b0.label}`, solid: M.Manifold.union([block.subtract(socket), peg]) });
  checks.push('Opzetborstel: probeer welke je fijner vindt, het pennetje of het gaatje.');
  for (const brand of [...new Set(brushes.filter((b) => b.type === 'charger').map((b) => b.brand))]) {
    const b = brushDims(p, brand);
    const dc = b.chargerD + 2 * Math.max(0.5, o.clr);
    parts.push({
      name: `Pasproef oplader ${b.label}`,
      solid: M.CrossSection.circle(dc / 2 + o.wall, 96).subtract(M.CrossSection.circle(dc / 2, 96)).extrude(5),
    });
    checks.push('Opladerring: de oplader moet er los in vallen.');
  }
  const info: InfoBlock[] = [
    { kind: 'text', title: 'Pasproef: zo controleer je', text: checks.join('\n') },
    { kind: 'kv', title: 'Maten (richtwaarde — meet je eigen borstel na)', rows: brandRows(p) },
  ];
  return {
    parts,
    info,
    tips: [
      'Print eerst deze kleine stukjes (een paar minuten per stuk) en pas daarna de maten of de speling aan.',
      'Print de pasproef in hetzelfde materiaal als de houder (PETG): PLA krimpt anders.',
    ],
    defaultView: 'plate',
  };
}

function brandRows(p: Params): [string, string][] {
  const rows: [string, string][] = [];
  const seen = new Set<string>();
  const brushes = activeBrushes(p);
  for (const { brand, dims: b } of brushes) {
    if (seen.has(brand)) continue;
    seen.add(brand);
    const types = brushes.filter((x) => x.brand === brand).map((x) => x.type);
    rows.push([`${b.short} handvat`, `${b.handleW} × ${b.handleD} mm`]);
    if (types.includes('fork') || str(p, 'mode') === 'test') rows.push([`${b.short} hals / kop`, `${b.neckW} / ${b.headW} mm`]);
    if (types.includes('charger')) rows.push([`${b.short} oplader`, `Ø${b.chargerD} × ${b.chargerH} mm`]);
  }
  if (num(p, 'heads') > 0 || str(p, 'mode') === 'test') {
    const b = brushes[0].dims;
    rows.push([`${b.short} opzetborstel`, `voet Ø${b.headBase}, pen Ø${b.pegD} mm`]);
  }
  return rows;
}

// ---- build ------------------------------------------------------------------

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  if (str(p, 'mode') === 'test') return fitTests(M, p);
  const L = holderLayout(p, printer);
  const mp = L.mount;
  const H = L.zTopPlate - L.zBottom;
  const size: [number, number, number] = [L.W, L.depth, H];
  if (!fitsOn(printer, size)) {
    const u = usable(printer);
    throw new UserError(
      `De houder (${Math.round(L.W)} × ${Math.round(L.depth)} × ${Math.round(H)} mm) past niet op de printplaat (${u.x} × ${u.y} × ${u.z} mm). Gebruik minder houders of opzetborstels, of kleinere tussenruimtes.`,
    );
  }
  const pieces: Manifold[] = [backPlate(M, L, num(p, 'plateR'), L.cupXs, L.zBottom, L.zTopPlate, L.W, true)];
  const scene: SceneItem[] = [{ kind: 'part', part: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];
  L.modules.forEach((m, i) => {
    pieces.push(m.build(M).translate([L.xs[i], -mp.T, 0]));
    for (const g of m.ghosts) scene.push({ ...g, position: [g.position[0] + L.xs[i], g.position[1] - mp.T, g.position[2]] });
  });
  const solid = M.Manifold.union(pieces);
  const c = mp.cup;
  for (const x of L.cupXs) {
    scene.push(ghost([c.cupD, c.standoff, c.cupD], x, c.standoff / 2, mp.zTop - c.cupD / 2, CUP, 'Zuignap'));
  }
  // a piece of wall just big enough for the holder and its brushes
  const top = Math.max(L.zTopPlate, ...scene.map((s) => (s.kind === 'box' ? s.position[2] + s.size[2] : 0)));
  scene.push({ kind: 'box', size: [L.W + 40, 4, top - L.zBottom + 40], position: [-L.W / 2 - 20, c.standoff, L.zBottom - 20], color: WALL, material: 'ghost', label: 'Tegels / spiegel' });

  const brushes = activeBrushes(p);
  const tips: string[] = [
    'Print rechtop zoals hij hangt (de achterplaat staat op zijn onderrand). Alle uitsteeksels hebben een schuine onderkant van 45°, dus support is niet nodig.',
    'Gebruik PETG: dat kan beter tegen vocht en warmte in de badkamer dan PLA. 3 wanden, 15–20% infill en een brim van 5 mm zodat de hoge plaat goed blijft staan.',
  ];
  if (mp.kind === 'keyhole') {
    tips.push('Steek eerst de zuignappen in de houder: kop door het ronde gat, dan omlaag drukken tot de hals bovenin de sleuf zit. Druk daarna de hele houder in één keer tegen de muur, dan kloppen de afstanden altijd.');
  } else if (mp.kind === 'hook') {
    tips.push('Hang de houder met de ogen over de haakjes van de zuignappen. Zet de zuignappen precies op de afstand uit de tabel.');
  } else {
    tips.push('Druk de pennen achterop de houder in de gaten van de zuignappen en druk daarna de houder met zuignappen tegen de muur.');
  }
  tips.push(
    'Maak tegels of spiegel eerst vetvrij met alcohol, maak de zuignappen een beetje nat en druk ze stevig aan. Wacht even en trek voorzichtig aan de houder voordat je de borstel erin zet.',
    'Zuignappen koop je los: bijvoorbeeld de Bambu Lab "Suction Caps with Mushroom Head" (HA011) in de Bambu-webshop, of gewone zuignappen met paddenstoelkop uit de bouwmarkt of online.',
    'Zuignappen houden het best op glad, niet-poreus materiaal (tegels, glas, spiegel). Druk ze om de paar weken even opnieuw aan.',
  );
  if (brushes.some((b) => b.type === 'charger')) tips.push('De kabel van de oplader druk je van onderen in de smalle sleuf onder de plank; zo kun je hem er altijd weer uithalen zonder de stekker los te maken.');
  if (brushes.some((b) => b.type === 'fork')) tips.push('Ophangvork: schuif de borstel met de kop naar beneden van voren in de sleuf; het handvat zakt in het kuiltje en blijft zo staan.');
  const warnings: string[] = [];
  if (brushes.some((b) => BRANDS[b.brand])) warnings.push('De merkmaten zijn richtwaardes — meet je eigen borstel na of print eerst de pasproef.');
  if (H > 220) warnings.push(`De houder is ${Math.round(H)} mm hoog: gebruik zeker een brim, of print een kleinere variant.`);
  const info: InfoBlock[] = [
    {
      kind: 'kv',
      title: 'Houder',
      rows: [
        ['Maat (b × d × h)', `${Math.round(L.W)} × ${Math.round(L.depth - c.standoff)} × ${Math.round(H)} mm`],
        ['Zuignappen', `${L.cupXs.length} × ${c.short}`],
        ...(L.cupXs.length > 1 ? [['Hart-op-hart', `${Math.round(L.cupXs[1] - L.cupXs[0])} mm`] as [string, string]] : []),
        ['Plaatdikte', mp.kind === 'pin' ? `${mp.T.toFixed(1)} mm` : `${mp.T.toFixed(1)} mm, ${mp.thin.toFixed(1)} bij ${mp.kind === 'keyhole' ? 'de sleuf' : 'het oog'}`],
      ],
    },
    { kind: 'kv', title: 'Maten (richtwaarde — meet je eigen borstel na)', rows: brandRows(p) },
  ];
  if (mp.kind === 'keyhole') {
    info.push({
      kind: 'kv',
      title: 'Zuignap',
      rows: [
        ['Kop Ø / dikte', `${c.headD} / ${c.headH} mm`],
        ['Hals Ø / lengte', `${c.neckD} / ${c.neckL} mm`],
        ['Gat voor de kop', `Ø${(2 * mp.rHead).toFixed(1)} mm`],
        ['Sleuf voor de hals', `${(2 * mp.rNeck).toFixed(1)} mm breed`],
      ],
    });
  }
  return {
    parts: [{ name: 'Tandenborstelhouder', solid }],
    scene,
    info,
    tips,
    warnings,
    defaultView: 'assembly',
  };
}

// ---- parameters ---------------------------------------------------------------

const isHolder = (p: Params) => str(p, 'mode') !== 'test';
const brushShown = (i: number) => (p: Params) => num(p, 'count') >= i;
const anyBrand = (brand: string) => (p: Params) => activeBrushes(p).some((b) => b.brand === brand);
const anyType = (type: string) => (p: Params) => isHolder(p) && activeBrushes(p).some((b) => b.type === type);
const mountIs = (...m: string[]) => (p: Params) => m.includes(str(p, 'mount'));
const customCup = (p: Params) => mountIs('keyhole')(p) && str(p, 'cup') === 'custom';

const TYPE_OPTIONS = [
  { value: 'ring', label: 'Ring/beker (rechtop)' },
  { value: 'fork', label: 'Ophangvork (kop omlaag)' },
  { value: 'charger', label: 'Opladerplank' },
];

const brushParams = (i: number, brand: string, type: string): ToolDef['params'] => [
  { type: 'group', label: `Borstel ${i}`, show: brushShown(i) },
  { type: 'select', key: `brand${i}`, label: 'Merk', default: brand, options: BRAND_OPTIONS, show: brushShown(i), help: 'Merkmaten zijn richtwaardes — meet je eigen borstel na of print de pasproef.' },
  { type: 'select', key: `type${i}`, label: 'Houder', default: type, options: TYPE_OPTIONS, show: (p) => brushShown(i)(p) && isHolder(p) },
];

export const toothbrushTool: ToolDef = {
  id: 'tandenborstel',
  name: 'Tandenborstelhouders',
  short: 'Tandenborstels',
  icon: 'M9 3h2v6H9zM8 9h4l-.5 12h-3zM15 4v16M13 8h4M13 12h4',
  description:
    'Wandhouders voor elektrische tandenborstels (Philips Sonicare, Oral-B, Oral-B iO of eigen maat) die met zuignappen aan tegels of spiegel hangen: beker, ophangvork of opladerplank, plus opzetborstels en tandpasta. Met pasproef.',
  params: [
    { type: 'group', label: 'Ontwerp' },
    {
      type: 'select', key: 'mode', label: 'Wat wil je printen?', default: 'holder',
      options: [
        { value: 'holder', label: 'Houder' },
        { value: 'test', label: 'Pasproef (kleine testprintjes)' },
      ],
      help: 'De pasproef maakt kleine stukjes om de zuignap, het handvat, de vork en de opzetborstels te passen.',
    },
    { type: 'number', key: 'count', label: 'Aantal borstels', min: 1, max: 3, step: 1, default: 1 },
    ...brushParams(1, 'sonicare', 'ring'),
    ...brushParams(2, 'oralb', 'ring'),
    ...brushParams(3, 'oralbio', 'ring'),
    { type: 'group', label: 'Eigen maat borstel', show: anyBrand('custom') },
    { type: 'number', key: 'handleW', label: 'Handvat breedte', min: 20, max: 45, step: 0.5, unit: 'mm', default: 30, show: anyBrand('custom') },
    { type: 'number', key: 'handleD', label: 'Handvat diepte', min: 20, max: 45, step: 0.5, unit: 'mm', default: 32, show: anyBrand('custom') },
    { type: 'number', key: 'neckW', label: 'Hals onder het handvat', min: 7, max: 20, step: 0.5, unit: 'mm', default: 12, show: anyBrand('custom'), help: 'Breedte van de borstel net onder het handvat; dit deel hangt in de ophangvork.' },
    { type: 'number', key: 'headW', label: 'Breedte borstelkop', min: 8, max: 25, step: 0.5, unit: 'mm', default: 16, show: anyBrand('custom') },
    { type: 'number', key: 'headBase', label: 'Voet opzetborstel Ø', min: 8, max: 20, step: 0.5, unit: 'mm', default: 13, show: anyBrand('custom') },
    { type: 'number', key: 'pegD', label: 'Pennetje opzetborstel Ø', min: 3, max: 9, step: 0.1, unit: 'mm', default: 5, show: anyBrand('custom') },
    { type: 'number', key: 'chargerD', label: 'Oplader Ø', min: 40, max: 80, step: 0.5, unit: 'mm', default: 58, show: anyBrand('custom') },
    { type: 'number', key: 'chargerH', label: 'Oplader hoogte', min: 6, max: 45, step: 0.5, unit: 'mm', default: 24, show: anyBrand('custom') },
    { type: 'group', label: 'Opzetborstels & tandpasta', show: isHolder },
    { type: 'number', key: 'heads', label: 'Reserve opzetborstels', min: 0, max: 6, step: 1, default: 0, show: isHolder },
    {
      type: 'select', key: 'headStore', label: 'Bewaren op', default: 'pegs', show: (p) => isHolder(p) && num(p, 'heads') > 0,
      options: [
        { value: 'pegs', label: 'Pennetjes' },
        { value: 'holes', label: 'Gaatjes' },
      ],
    },
    { type: 'number', key: 'headSpacing', label: 'Tussenafstand', min: 16, max: 34, step: 1, unit: 'mm', default: 21, show: (p) => isHolder(p) && num(p, 'heads') > 0 },
    { type: 'bool', key: 'paste', label: 'Tandpastahouder', default: false, show: isHolder, help: 'De tube hangt met de dop naar beneden in een open vork.' },
    { type: 'number', key: 'capD', label: 'Dop Ø', min: 15, max: 45, step: 0.5, unit: 'mm', default: 30, show: (p) => isHolder(p) && bool(p, 'paste') },
    { type: 'number', key: 'tubeT', label: 'Dikte tube bij de dop', min: 20, max: 50, step: 0.5, unit: 'mm', default: 34, show: (p) => isHolder(p) && bool(p, 'paste') },
    { type: 'group', label: 'Zuignappen' },
    {
      type: 'select', key: 'mount', label: 'Soort zuignap', default: 'keyhole',
      options: [
        { value: 'keyhole', label: 'Paddenstoelkop (sleutelgat)' },
        { value: 'hook', label: 'Met haakje (oog in de plaat)' },
        { value: 'pin', label: 'Met gat in de knop (pen achterop)' },
      ],
    },
    {
      type: 'select', key: 'cup', label: 'Zuignap', default: 'ha011', show: mountIs('keyhole'),
      options: [
        { value: 'ha011', label: 'Bambu HA011 40 mm (richtwaarde)' },
        { value: 'g40', label: 'Generieke zuignap 40 mm' },
        { value: 'g30', label: 'Generieke zuignap 30 mm' },
        { value: 'custom', label: 'Eigen maat' },
      ],
    },
    { type: 'number', key: 'cupD', label: 'Zuignap Ø', min: 20, max: 60, step: 1, unit: 'mm', default: 40, show: (p) => customCup(p) || !mountIs('keyhole')(p) },
    { type: 'number', key: 'cupHeadD', label: 'Kop Ø', min: 6, max: 20, step: 0.1, unit: 'mm', default: 12, show: customCup },
    { type: 'number', key: 'cupHeadH', label: 'Kop dikte', min: 1.5, max: 6, step: 0.1, unit: 'mm', default: 3, show: customCup },
    { type: 'number', key: 'cupNeckD', label: 'Hals Ø', min: 3, max: 12, step: 0.1, unit: 'mm', default: 6, show: customCup },
    { type: 'number', key: 'cupNeckL', label: 'Hals lengte', min: 1.5, max: 8, step: 0.1, unit: 'mm', default: 3.5, show: (p) => customCup(p) || mountIs('pin')(p), help: 'Bij een pen: hoe diep de pen in de zuignap gaat.' },
    { type: 'number', key: 'standoff', label: 'Afstand tot de muur', min: 3, max: 20, step: 0.5, unit: 'mm', default: 8, show: (p) => customCup(p) || !mountIs('keyhole')(p), help: 'Hoe ver de achterkant van de houder van de muur staat met de zuignap aangedrukt.' },
    { type: 'number', key: 'eyeD', label: 'Oog Ø (haakje)', min: 3, max: 12, step: 0.5, unit: 'mm', default: 6, show: mountIs('hook') },
    { type: 'number', key: 'eyeT', label: 'Plaatdikte bij het oog', min: 1.5, max: 6, step: 0.5, unit: 'mm', default: 3, show: mountIs('hook') },
    { type: 'number', key: 'pinD', label: 'Pen Ø', min: 3, max: 10, step: 0.1, unit: 'mm', default: 5, show: mountIs('pin') },
    { type: 'number', key: 'cupClearance', label: 'Speling zuignap', min: 0.1, max: 1, step: 0.05, unit: 'mm', default: 0.4 },
    {
      type: 'select', key: 'cups', label: 'Aantal zuignappen', default: 'auto', show: isHolder,
      options: [
        { value: 'auto', label: 'Automatisch (naar breedte)' },
        { value: '1', label: '1' },
        { value: '2', label: '2' },
        { value: '3', label: '3' },
      ],
    },
    { type: 'group', label: 'Maatvoering' },
    { type: 'number', key: 'clearance', label: 'Speling rond handvat', min: 0.2, max: 2, step: 0.1, unit: 'mm', default: 0.8 },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4 },
    { type: 'number', key: 'ringH', label: 'Hoogte beker', min: 20, max: 80, step: 1, unit: 'mm', default: 42, show: anyType('ring') },
    { type: 'bool', key: 'chargerRing', label: 'Steunring boven de oplader', default: true, show: anyType('charger') },
    { type: 'number', key: 'plateT', label: 'Dikte achterplaat', min: 4, max: 10, step: 0.5, unit: 'mm', default: 5, show: isHolder },
    { type: 'number', key: 'plateR', label: 'Afronding hoeken', min: 2, max: 20, step: 1, unit: 'mm', default: 10, show: isHolder },
    { type: 'number', key: 'gap', label: 'Ruimte tussen houders', min: 4, max: 30, step: 1, unit: 'mm', default: 8, show: isHolder },
  ],
  presets: [
    { name: 'Sonicare enkel (ring)', values: { mode: 'holder', count: 1, brand1: 'sonicare', type1: 'ring', heads: 0, paste: false } },
    { name: 'Sonicare + 2 opzetborstels', values: { mode: 'holder', count: 1, brand1: 'sonicare', type1: 'ring', heads: 2, headStore: 'pegs', paste: false } },
    { name: 'Oral-B met oplader', values: { mode: 'holder', count: 1, brand1: 'oralb', type1: 'charger', chargerRing: true, heads: 2, headStore: 'holes', paste: false } },
    { name: 'Oral-B iO duo', values: { mode: 'holder', count: 2, brand1: 'oralbio', type1: 'fork', brand2: 'oralbio', type2: 'fork', heads: 2, headStore: 'holes', paste: false } },
    {
      name: 'Gezin (3 borstels)',
      values: { mode: 'holder', count: 3, brand1: 'oralb', type1: 'ring', brand2: 'oralb', type2: 'ring', brand3: 'sonicare', type3: 'ring', heads: 6, headStore: 'holes', paste: true, cups: 'auto' },
    },
    { name: 'Tandpasta & borstel (haakjes)', values: { mode: 'holder', count: 1, brand1: 'sonicare', type1: 'fork', heads: 0, paste: true, mount: 'hook', cupD: 40, standoff: 8, eyeD: 6 } },
    { name: 'Pasproef', values: { mode: 'test', count: 2, brand1: 'sonicare', type1: 'ring', brand2: 'oralb', type2: 'charger' } },
  ],
  build,
};
