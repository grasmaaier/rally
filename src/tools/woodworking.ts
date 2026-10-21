import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { Font } from 'opentype.js';
import { keep } from '../core/registry';
import { fitsOn, usable } from '../core/printer';
import type { AssetRef, BuildOutput, InfoBlock, Params, PartOut, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { countersunk, deg, filletExtrude, roundedRect, teardrop } from '../geom/helpers';
import { sizeForHeight, textCross } from '../geom/text';

// ---------------------------------------------------------------------------
// Woodworking shop aids: set-up gauges, marking templates, push sticks, jigs.
// Every part is a flat profile or a stack of vertical walls, so it prints
// without support in the orientation it is built in.

const FONT = 'bundled:montserrat';
/** Depth of labels engraved into an upward face. */
const ENGRAVE_TOP = 0.6;
/** Depth of labels engraved into the bed face (two layers; the slicer bridges the strokes). */
const ENGRAVE_BED = 0.4;
const SQRT2 = Math.SQRT2;

interface Ctx {
  M: ManifoldToplevel;
  p: Params;
  printer: PrinterProfile;
  font: Font | null;
  tips: string[];
  warnings: string[];
  info: InfoBlock[];
}

/** Dutch number formatting: 22.5 → "22,5". */
export function fmt(v: number, digits = 2): string {
  const f = 10 ** digits;
  return String(Math.round(v * f) / f).replace('.', ',');
}

/**
 * Parse a list of numbers typed by the user. Dutch decimal commas are
 * supported: "15; 22,5; 30" and "15 22,5 30" both give [15, 22.5, 30];
 * "15, 22.5, 30" (comma + space) is also understood.
 */
export function parseList(s: string): number[] {
  const t = s.trim();
  let tokens: string[];
  if (t.includes(';')) tokens = t.split(';');
  else if (/,\s/.test(t)) tokens = t.split(/,\s+/);
  else tokens = t.split(/[\s/|]+/);
  const out: number[] = [];
  for (const tok of tokens) {
    const clean = tok.replace(/mm|°|ø|Ø/gi, '').trim().replace(',', '.');
    if (!clean) continue;
    const v = Number(clean);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Sorted unique values of a user list, validated against a range. */
function listParam(p: Params, key: string, what: string, lo: number, hi: number, max: number): number[] {
  const raw = parseList(str(p, key));
  if (raw.length === 0) throw new UserError(`Vul minstens één ${what} in, gescheiden door een puntkomma (bijv. "3; 4; 5").`);
  for (const v of raw) if (v < lo || v > hi) throw new UserError(`${what[0].toUpperCase()}${what.slice(1)} ${fmt(v)} valt buiten ${fmt(lo)}–${fmt(hi)}.`);
  const vals = [...new Set(raw.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  if (vals.length > max) throw new UserError(`Maximaal ${max} waarden; je gaf er ${vals.length}.`);
  return vals;
}

/** CCW polygon cross-section (orientation fixed automatically). */
function poly(M: ManifoldToplevel, pts: Vec2[]): CrossSection {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return keep(new M.CrossSection([a < 0 ? [...pts].reverse() : pts]));
}

const rect = (M: ManifoldToplevel, x0: number, y0: number, x1: number, y1: number) =>
  M.CrossSection.square([x1 - x0, y1 - y0]).translate([x0, y0]);

/** Circle whose polygon flats lie on radius r (holes come out at least r). */
function hole(M: ManifoldToplevel, r: number, x = 0, y = 0, segs = 48): CrossSection {
  return M.CrossSection.circle(r / Math.cos(Math.PI / segs), segs).translate([x, y]);
}

/** Rounded slot between two points (a stadium). */
function slot(M: ManifoldToplevel, r: number, a: Vec2, b: Vec2): CrossSection {
  return M.CrossSection.hull([hole(M, r, a[0], a[1], 32), hole(M, r, b[0], b[1], 32)]);
}

/** Label outline (centred on the origin) scaled down when wider than maxW. */
function label(ctx: Ctx, text: string, h: number, maxW = Infinity): CrossSection | null {
  if (!ctx.font || !text.trim()) return null;
  let cs = textCross(ctx.M, ctx.font, text, sizeForHeight(ctx.font, h));
  if (cs.isEmpty()) return null;
  const b = cs.bounds();
  const w = b.max[0] - b.min[0];
  if (w > maxW && maxW > 0) cs = cs.scale([maxW / w, maxW / w]);
  return cs;
}

/** Engrave labels into an upward face at height zTop. */
function engraveTop(M: ManifoldToplevel, solid: Manifold, marks: CrossSection[], zTop: number, depth = ENGRAVE_TOP): Manifold {
  if (marks.length === 0) return solid;
  return solid.subtract(M.CrossSection.union(marks).extrude(depth + 0.05).translate([0, 0, zTop - depth]));
}

/**
 * Engrave labels into the bed face (z = 0), mirrored so they read correctly
 * when the tool is turned over for use. Each mark is mirrored about its own
 * centre `at`.
 */
function engraveBed(M: ManifoldToplevel, solid: Manifold, marks: { cs: CrossSection; at: Vec2; rot?: number }[], depth = ENGRAVE_BED): Manifold {
  if (marks.length === 0) return solid;
  const placed = marks.map((m) => m.cs.rotate(m.rot ?? 0).mirror([1, 0]).translate(m.at));
  return solid.subtract(M.CrossSection.union(placed).extrude(depth + 0.05).translate([0, 0, -0.05]));
}

/**
 * Make sure a part fits the selected printer. Flat parts that are too long
 * are turned in the plane of the bed (diagonal) before giving up.
 */
function fit(ctx: Ctx, solid: Manifold, name: string): Manifold {
  const size = (m: Manifold): [number, number, number] => {
    const b = m.boundingBox();
    return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  };
  const s0 = size(solid);
  if (fitsOn(ctx.printer, s0)) return solid;
  const u = usable(ctx.printer);
  if (s0[2] <= u.z) {
    for (let a = 5; a < 90; a += 5) {
      const r = solid.rotate([0, 0, a]);
      if (fitsOn(ctx.printer, size(r))) {
        ctx.tips.push(`${name} ligt ${a}° gedraaid op het bed om op de ${ctx.printer.name} te passen.`);
        return r;
      }
    }
  }
  throw new UserError(
    `${name} (${Math.round(s0[0])} × ${Math.round(s0[1])} × ${Math.round(s0[2])} mm) past niet op het printbed van de ${ctx.printer.name}. Maak hem kleiner.`,
  );
}

const strongTip = 'Sterk printen: PETG of PLA, 4 wanden, 30–40% infill (gyroid). Gebruik een goed afgesteld bed: de randen zijn je referentie.';
const accuracyTip = 'Maatvast: controleer na het printen met een schuifmaat of winkelhaak. Zet "elephant foot"-compensatie aan (0,15 mm) zodat de onderrand niet uitloopt.';

// ---------------------------------------------------------------------------
// 1. Angle set-up gauge (blade tilt, mitre gauge, router fence)

export interface BevelFinger {
  /** Displayed value (tilt or edge angle). */
  value: number;
  /** Angle in the material between the bottom reference edge and the flank. */
  theta: number;
  /** Left (vertical) side of the finger. */
  a: number;
  /** Bottom right corner, where the angled flank starts. */
  c: number;
  /** Width of the finger at its top. */
  top: number;
  label: string;
}

export function bevelLayout(p: Params) {
  const tilt = str(p, 'bvMode') !== 'edge';
  const vals = tilt ? listParam(p, 'bvAngles', 'hoek', 0, 75, 12) : listParam(p, 'bvAngles', 'hoek', 15, 90, 12);
  const H = num(p, 'bvEdge');
  const hl = 5;
  const fingers: BevelFinger[] = [];
  let x = 0;
  for (const value of vals) {
    const theta = tilt ? 90 - value : value;
    const lab = `${fmt(value)}°`;
    const top = Math.max(7, 0.72 * hl * lab.length + 3);
    const run = H / Math.tan(deg(theta));
    const a = x;
    const c = a + top + run;
    fingers.push({ value, theta, a, c, top, label: lab });
    // the saw blade (≤ 4 mm with tooth set) must fit in the gap at the table
    x = c + 4 / Math.sin(deg(theta)) + 1.5;
  }
  const S = hl + 6;
  const W = fingers[fingers.length - 1].c;
  return { tilt, fingers, H, S, W, hl, T: num(p, 'bvThick') };
}

function buildBevel(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const L = bevelLayout(p);
  const shapes: CrossSection[] = [rect(M, 0, L.H, L.W, L.H + L.S)];
  for (const f of L.fingers) {
    const run1 = (L.H + 1) / Math.tan(deg(f.theta));
    shapes.push(poly(M, [[f.a, 0], [f.c, 0], [f.c - run1, L.H + 1], [f.a, L.H + 1]]));
  }
  let outline = M.CrossSection.union(shapes);
  if (L.W > 45) outline = outline.subtract(hole(M, 2.6, L.W - 6, L.H + L.S / 2));
  let solid = outline.extrude(L.T);
  const marks: CrossSection[] = [];
  for (const f of L.fingers) {
    const cs = label(ctx, f.label, L.hl, f.top - 2);
    if (cs) marks.push(cs.translate([f.a + f.top / 2, L.H - 2 - L.hl / 2]));
  }
  const sq = label(ctx, L.tilt ? '0°' : '90°', L.hl - 1);
  if (sq) {
    const b = sq.bounds();
    marks.push(sq.translate([2.5 - b.min[0], L.H + L.S / 2]));
  }
  solid = engraveTop(M, solid, marks, L.T);
  solid = fit(ctx, solid, 'Hoekmal');
  ctx.tips.push(
    L.tilt
      ? 'De getallen zijn de stand van het zaagblad (0° = haaks, zoals de schaal van je zaag). Zet de onderrand op de zaagtafel en kantel het blad tot het vlak tegen de schuine rand ligt (tussen de tanden).'
      : 'De getallen zijn de hoek tussen de onderrand en de schuine rand. Leg de onderrand tegen de aanslag of de tafel en zet het blad of de verstekgeleider tegen de schuine rand.',
    `De schuine randen zijn ${L.H} mm hoog: zet het zaagblad niet hoger dan dat. De linker buitenrand is haaks (${L.tilt ? '0°' : '90°'}).`,
    'Plat geprint is de hoek in het XY-vlak: dat is de nauwkeurigste richting van de printer. Controleer de haakse rand met een goede winkelhaak.',
    accuracyTip,
  );
  ctx.info.push({
    kind: 'table',
    title: 'Hoeken',
    headers: [L.tilt ? 'Zaagbladstand' : 'Hoek', 'Hoek tussen de randen'],
    rows: L.fingers.map((f) => [`${fmt(f.value)}°`, `${fmt(f.theta)}°`]),
  });
  return { parts: [{ name: 'Hoekmal', solid }] };
}

// ---------------------------------------------------------------------------
// 2. Dovetail marker (saddle with a slope on each face leg)

export function dovetailLayout(p: Params) {
  const nA = Number(str(p, 'dtA')) || 6;
  const nBraw = Number(str(p, 'dtB'));
  const nB = Number.isFinite(nBraw) && nBraw > 0 ? nBraw : 0;
  return { nA, nB, W: num(p, 'dtW'), Lf: num(p, 'dtLen'), He: num(p, 'dtEnd'), t: num(p, 'dtThick') };
}

function buildDovetail(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const { nA, nB, W, Lf, He, t } = dovetailLayout(p);
  const e = t;
  const legA = poly(M, [[-W / 2, 0], [W / 2, 0], [W / 2 + Lf / nA, Lf], [-W / 2 - Lf / nA, Lf]]);
  const faces: CrossSection[] = [legA];
  if (nB > 0) faces.push(poly(M, [[-W / 2, -e], [W / 2, -e], [W / 2 + Lf / nB, -e - Lf], [-W / 2 - Lf / nB, -e - Lf]]));
  const endLeg = rect(M, -W / 2, -e, W / 2, 0);
  let solid = M.Manifold.union([M.CrossSection.union([...faces, endLeg]).extrude(t), endLeg.extrude(t + He)]);
  const marks: { cs: CrossSection; at: Vec2 }[] = [];
  const csA = label(ctx, `1:${fmt(nA)}`, 6, W - 4);
  if (csA) marks.push({ cs: csA, at: [0, Lf / 2 + 2] });
  if (nB > 0) {
    const csB = label(ctx, `1:${fmt(nB)}`, 6, W - 4);
    if (csB) marks.push({ cs: csB, at: [0, -e - Lf / 2 - 2] });
  }
  solid = engraveBed(M, solid, marks);
  solid = fit(ctx, solid, 'Zwaluwstaartmal');
  const deg1 = (n: number) => fmt((Math.atan(1 / n) * 180) / Math.PI, 1);
  ctx.tips.push(
    'Haak de staande lip over de kopse kant van de plank; het vlakke deel ligt op het hout. Teken langs de schuine kanten (zwaluwstaart) en langs de rechte kanten van de lip (haaks over de kop).',
    'Vuistregel: 1:6 (≈9,5°) voor zacht hout, 1:8 (≈7,1°) voor hard hout. 1:7 is een goed compromis.',
    'Het onderste vlak (op het bed) is na het omdraaien je bovenkant: daar staan de verhoudingen in.',
  );
  ctx.info.push({
    kind: 'kv',
    title: 'Hellingen',
    rows: [[`Zijde A`, `1:${fmt(nA)} = ${deg1(nA)}°`], ...(nB > 0 ? [[`Zijde B`, `1:${fmt(nB)} = ${deg1(nB)}°`] as [string, string]] : [])],
  });
  return { parts: [{ name: 'Zwaluwstaartmal', solid }] };
}

// ---------------------------------------------------------------------------
// 3. Chamfer gauge: 90° notches that fit over an arris with a given chamfer

export function chamferLayout(p: Params) {
  const sizes = listParam(p, 'chSizes', 'maat', 0.5, 15, 10);
  const hl = 4.5;
  const notches = [] as { c: number; k: number; d: number; xc: number }[];
  let x = 5;
  for (const c of sizes) {
    const k = c / SQRT2;
    const d = k + 6;
    const w = Math.max(2 * d, 0.72 * hl * fmt(c).length + 2);
    notches.push({ c, k, d, xc: x + w / 2 });
    x += w + 5;
  }
  const dMax = Math.max(...notches.map((n) => n.d));
  const Hp = dMax + hl + 7;
  return { notches, Hp, W: x, hl, T: num(p, 'chThick') };
}

function buildChamfer(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const L = chamferLayout(p);
  let outline = rect(M, 0, 0, L.W, L.Hp);
  const cuts: CrossSection[] = [];
  for (const n of L.notches) {
    const yb = L.Hp - n.d + n.k;
    cuts.push(poly(M, [[n.xc - n.d - 1, L.Hp + 1], [n.xc - n.k, yb], [n.xc + n.k, yb], [n.xc + n.d + 1, L.Hp + 1]]));
  }
  outline = outline.subtract(M.CrossSection.union(cuts));
  let solid = outline.extrude(L.T);
  const marks: CrossSection[] = [];
  for (const n of L.notches) {
    const cs = label(ctx, fmt(n.c), L.hl, 2 * n.d);
    if (cs) marks.push(cs.translate([n.xc, L.Hp - n.d - 2 - L.hl / 2]));
  }
  solid = engraveTop(M, solid, marks, L.T);
  solid = fit(ctx, solid, 'Afschuinmal');
  ctx.tips.push(
    'Elke inkeping past precies over een hoek met een vellingkant van het getal in mm (gemeten langs elk vlak). Zet de mal op de hoek: past hij zonder spleet, dan klopt de vellingkant.',
    'Handig om een afschuinfrees of schaaf in te stellen: frees een proefstuk tot de mal sluit.',
  );
  return { parts: [{ name: 'Afschuinmal', solid }] };
}

// ---------------------------------------------------------------------------
// 4. Centre finder for round stock: 90° V with a straight edge on the bisector

export function centerRoundLayout(p: Params) {
  const R = num(p, 'crMax') / 2;
  const w = 5;
  const A = R + 12;
  const Yb = R * (1 + SQRT2) + 10;
  return { R, w, A, Yb, t: num(p, 'crThick'), hf: num(p, 'crFence'), blade: 14 };
}

function buildCenterRound(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const L = centerRoundLayout(p);
  const right = rect(M, 0, -L.w, L.A, 0).rotate(45);
  const left = rect(M, 0, 0, L.A, L.w).rotate(135);
  const knee = poly(M, [[0, 0], [L.w / SQRT2, -L.w / SQRT2], [0, -L.w * SQRT2], [-L.w / SQRT2, -L.w / SQRT2]]);
  const fences = M.CrossSection.union([right, left, knee]);
  const plate = poly(M, [[0, 0], [0, L.Yb], [-L.blade, L.Yb], [-L.A / SQRT2, L.A / SQRT2]]);
  let solid = M.Manifold.union([M.CrossSection.union([plate, fences]).extrude(L.t), fences.extrude(L.t + L.hf)]);
  solid = solid.subtract(M.Manifold.cylinder(L.t + 2, 3, 3, 32).translate([-L.blade / 2 - 1, L.Yb - 8, -1]));
  solid = fit(ctx, solid, 'Middelpuntzoeker');
  ctx.tips.push(
    'Leg de vlakke plaat op de kopse kant en druk de staande randen tegen de omtrek. Trek een lijn langs de rechte kant van de plaat, draai het werkstuk een kwartslag en trek nog een lijn: het snijpunt is het midden.',
    `Werkt voor rond hout van ongeveer Ø6 tot Ø${fmt(2 * L.R)} mm. De rechte kant ligt precies op de bissectrice van de 90°-V.`,
  );
  return { parts: [{ name: 'Middelpuntzoeker', solid }] };
}

// ---------------------------------------------------------------------------
// 5. Centre line marker for board edges: two pins with a pencil hole midway

export function centerEdgeLayout(p: Params) {
  const steel = str(p, 'cePin') === 'steel';
  const pinD = steel ? num(p, 'ceSteelD') : num(p, 'cePinD');
  const s = num(p, 'ceMax') + pinD + 1;
  const pencil = num(p, 'cePencil');
  const wb = Math.max(pinD, pencil) + 12;
  const Lb = s + pinD + 12;
  return { steel, pinD, s, pencil, wb, Lb, tb: 8, pinH: num(p, 'cePinH') };
}

function buildCenterEdge(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const L = centerEdgeLayout(p);
  let bar = roundedRect(M, L.Lb, L.wb, L.wb / 2 - 0.01, 16).subtract(hole(M, L.pencil / 2));
  if (L.steel) bar = bar.subtract(M.CrossSection.union([hole(M, (L.pinD - 0.1) / 2, -L.s / 2, 0), hole(M, (L.pinD - 0.1) / 2, L.s / 2, 0)]));
  let solid = filletExtrude(M, bar, L.tb, 0, 1);
  if (!L.steel) {
    const r = L.pinD / 2;
    const pin = M.Manifold.union([
      M.Manifold.cylinder(L.pinH - 0.8, r, r, 48).translate([0, 0, L.tb - 0.01]),
      M.Manifold.cylinder(0.8, r, r - 0.8, 48).translate([0, 0, L.tb + L.pinH - 0.81]),
      M.Manifold.cylinder(1.5, r + 1.5, r, 48).translate([0, 0, L.tb - 0.01]),
    ]);
    solid = M.Manifold.union([solid, pin.translate([-L.s / 2, 0, 0]), pin.translate([L.s / 2, 0, 0])]);
  }
  solid = fit(ctx, solid, 'Middenlijnmal');
  ctx.tips.push(
    'Zet de mal op de kant van de plank, draai hem tot beide pennen tegen de zijvlakken liggen en schuif hem langs de kant met het potlood in het gat: de lijn komt precies in het midden, ongeacht de plankdikte.',
    `Voor planken tot ${fmt(num(p, 'ceMax'))} mm dik. Potloodgat Ø${fmt(L.pencil)} mm: past het potlood te los, wikkel er een laagje tape om.`,
  );
  if (L.steel) ctx.tips.push(`Druk twee stalen paspennen of deuvels Ø${fmt(L.pinD)} mm in de gaten (perspassing; gat ${fmt(L.pinD - 0.1)} mm). Lengte ≈ ${Math.round(L.tb + L.pinH)} mm.`);
  else ctx.tips.push('De pennen staan rechtop geprint. Print met 100% infill voor de pennen (modifier in Bambu Studio) of kies stalen pennen.');
  return { parts: [{ name: 'Middenlijnmal', solid }] };
}

// ---------------------------------------------------------------------------
// 6. Push stick (classic with heel notch, or a long "shoe")

export function pushStickProfile(M: ManifoldToplevel, p: Params): { outline: CrossSection; length: number; height: number } {
  const L = num(p, 'psLen');
  const hn = num(p, 'psHeel');
  if (str(p, 'psStyle') === 'shoe') {
    const Hb = 26;
    const hw = 12;
    const handL = Math.min(130, L * 0.55);
    const handH = 52;
    const x0 = -L + 6;
    const body = poly(M, [[-L, 0], [0, 0], [0, Hb - 10], [-10, Hb], [-L, Hb]]);
    const heel = rect(M, -L, -hn, -L + hw, 0.01);
    const handle = M.CrossSection.union([roundedRect(M, handL, handH, 14).translate([x0 + handL / 2, Hb + handH / 2 - 6]), rect(M, x0, Hb - 2, x0 + handL, Hb + 10)]);
    const grip = roundedRect(M, handL - 26, 26, 9).translate([x0 + handL / 2, Hb + 6 + 13]);
    const outline = M.CrossSection.union([body, heel, handle]).subtract(grip);
    return { outline, length: L, height: Hb + handH - 6 + hn };
  }
  const phi = deg(num(p, 'psAngle'));
  const tl = 25;
  const hl = 15;
  const u: Vec2 = [-Math.cos(phi), Math.sin(phi)];
  const n: Vec2 = [Math.sin(phi), Math.cos(phi)];
  // band width: room for the hand hole, and a front nose at least 12 mm above the toe
  const wB = Math.max(56, (hn + 12 + (tl + hl) * Math.tan(phi)) * Math.cos(phi));
  const Lb = (L - tl - hl + (wB / 2) * Math.sin(phi) - wB / 2) / Math.cos(phi);
  const at = (s: number, t: number): Vec2 => [-hl + s * u[0] + t * n[0], s * u[1] + t * n[1]];
  const s0 = -(tl + hl + wB) * 2;
  const band = poly(M, [at(s0, 0), at(Lb, 0), at(Lb, wB), at(s0, wB)]);
  const end = M.CrossSection.circle(wB / 2, 64).translate(at(Lb, wB / 2));
  const big = 4 * L;
  const clip = rect(M, -big, 0, tl, big);
  const notch = rect(M, 0, -1, tl + 1, hn);
  const handLen = Math.min(100, Lb - 50);
  const sh = Lb - handLen / 2 - 16;
  const grip = slot(M, 14, at(sh - handLen / 2 + 14, wB / 2), at(sh + handLen / 2 - 14, wB / 2));
  const outline = M.CrossSection.union([band, end]).intersect(clip).subtract(notch).subtract(grip);
  const b = outline.bounds();
  return { outline, length: b.max[0] - b.min[0], height: b.max[1] - b.min[1] };
}

function buildPushStick(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const { outline, length, height } = pushStickProfile(M, p);
  const T = num(p, 'psThick');
  let solid = filletExtrude(M, outline, T, 0, 2);
  const shoe = str(p, 'psStyle') === 'shoe';
  const name = shoe ? 'Duwschoen' : 'Duwstok';
  solid = fit(ctx, solid, name);
  ctx.tips.push(
    shoe
      ? `De zool drukt het werkstuk over de hele lengte omlaag; de hak (${fmt(num(p, 'psHeel'))} mm) duwt de achterkant. Kies de hak iets lager dan je werkstuk dik is.`
      : `De inkeping (${fmt(num(p, 'psHeel'))} mm hoog) haakt achter het werkstuk en drukt het tegelijk omlaag. Kies hem iets lager dan je werkstuk dik is.`,
    `Plat geprint (${T} mm dik): de lagen lopen in de lengte, zo is hij het sterkst. ${strongTip}`,
    'Een duwstok is een slijtdeel: raakt hij het zaagblad, print dan een nieuwe. Houd je handen altijd buiten de lijn van het blad.',
  );
  ctx.info.push({ kind: 'kv', title: 'Maat', rows: [['Lengte', `${Math.round(length)} mm`], ['Hoogte', `${Math.round(height)} mm`], ['Dikte', `${fmt(T)} mm`]] });
  return { parts: [{ name, solid }] };
}

// ---------------------------------------------------------------------------
// 7. Push block: upright block, flat-printed handle, optional replaceable heel and TPU pad

export function pushBlockLayout(p: Params) {
  const L = num(p, 'pbLen');
  const W = num(p, 'pbWidth');
  const hB = num(p, 'pbHeight');
  const Lf = Math.min(L - 16, 150);
  const Lt = Lf - 20;
  const tf = Math.min(26, W - 20);
  const heel = str(p, 'pbHeel') === 'screw';
  const pad = bool(p, 'pbPad');
  return { L, W, hB, Lf, Lt, tf, hh: 60, tenonH: 10, heel, heelH: num(p, 'pbHeelH'), th: 6, pad, padT: 1.5 };
}

const tearAlongY = (M: ManifoldToplevel, r: number, len: number) => teardrop(M, r, 24).extrude(len).rotate([90, 0, 0]);
const tearAlongX = (M: ManifoldToplevel, r: number, len: number) => tearAlongY(M, r, len).rotate([0, 0, 90]);

function buildPushBlock(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const B = pushBlockLayout(p);
  // body
  let body = filletExtrude(M, roundedRect(M, B.L, B.W, 6), B.hB, 0, 2);
  body = body.subtract(M.Manifold.cube([B.Lt + 0.4, B.tf + 0.4, B.tenonH + 0.5]).translate([-(B.Lt + 0.4) / 2, -(B.tf + 0.4) / 2, B.hB - B.tenonH - 0.5]));
  const xs = [-B.Lt / 4, B.Lt / 4];
  for (const x of xs) body = body.subtract(countersunk(M, 4.4, 8.8, B.hB + 1).translate([x, 0, 0]));
  if (B.heel) {
    const depth = 14;
    for (const y of [-B.W / 4, B.W / 4]) body = body.subtract(tearAlongX(M, 1.5, depth + 1).translate([-B.L / 2 - 1, y, B.hB / 2]));
  }
  // handle, printed flat: profile in XY (y up in use), thickness along z
  const outer = M.CrossSection.union([roundedRect(M, B.Lf, B.hh, 14).translate([0, B.hh / 2]), rect(M, -B.Lf / 2, 0, B.Lf / 2, 16)]);
  const gripL = Math.min(100, B.Lf - 28);
  const grip = roundedRect(M, gripL, 28, 10).translate([0, 12 + 14]);
  const tenon = rect(M, -B.Lt / 2, -B.tenonH, B.Lt / 2, 0.01);
  let handle = filletExtrude(M, M.CrossSection.union([outer.subtract(grip), tenon]), B.tf, 0, 2.5);
  for (const x of xs) handle = handle.subtract(tearAlongY(M, 1.5, 11 + 1).translate([x, -B.tenonH + 11, B.tf / 2]));
  const parts: PartOut[] = [
    { name: 'Duwblok', solid: fit(ctx, body, 'Duwblok') },
    { name: 'Handgreep', solid: fit(ctx, handle, 'Handgreep') },
  ];
  const scene: SceneItem[] = [
    { kind: 'part', part: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    { kind: 'part', part: 1, matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, B.tf / 2, B.hB, 1] },
  ];
  if (B.heel) {
    const yLow = -B.heelH - (B.pad ? B.padT : 0);
    let heel = rect(M, -B.W / 2, yLow, B.W / 2, B.hB).extrude(B.th);
    for (const y of [-B.W / 4, B.W / 4]) heel = heel.subtract(countersunk(M, 4.4, 8.8, B.th + 1).mirror([0, 0, 1]).translate([y, B.hB / 2, B.th]));
    parts.push({ name: 'Hak (vervangbaar)', solid: fit(ctx, heel, 'Hak') });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: [0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, -B.L / 2, 0, 0, 1] });
  }
  if (B.pad) {
    parts.push({ name: 'Antislipzool (TPU)', solid: fit(ctx, roundedRect(M, B.L, B.W, 6).extrude(B.padT), 'Antislipzool'), color: '#3a3a3a' });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -B.padT, 1] });
  }
  ctx.tips.push(
    'De handgreep wordt plat geprint (lagen in de belastingsrichting) en in de sleuf van het blok gelijmd en van onderen vastgeschroefd met twee verzonken schroeven 4 × 20 mm.',
    strongTip,
  );
  if (B.heel) ctx.tips.push(`De losse hak steekt ${fmt(B.heelH)} mm onder de zool uit en wordt met twee schroeven 4 × 16 mm vastgezet. Zaag je erin, print dan alleen een nieuwe hak.`);
  else ctx.tips.push('Zonder hak: plak schuurpapier (korrel 120) of antislipmat onder de zool, of zet de TPU-zool aan.');
  if (B.pad) ctx.tips.push('De antislipzool print je in TPU (95A) en plak je met contactlijm onder het blok.');
  ctx.info.push({ kind: 'kv', title: 'Maat', rows: [['Zool', `${B.L} × ${B.W} mm`], ['Hoogte blok', `${B.hB} mm`], ['Met greep', `${B.hB + B.hh} mm`]] });
  return { parts, scene, defaultView: 'assembly' };
}

// ---------------------------------------------------------------------------
// 8. Offset scribe: fence along the edge, pencil-tip holes every step

export function scribeLayout(p: Params) {
  const max = num(p, 'scMax');
  const step = num(p, 'scStep');
  const D = num(p, 'scHole');
  const count = Math.floor(max / step + 1e-9);
  if (count > 300) throw new UserError('Te veel gaatjes: kies een grotere stap of een kleinere maximale afstand.');
  const rows = Math.max(1, Math.ceil((D + 1.2) / step - 1e-9));
  const ry = D + 1.6;
  const y0 = 5 + D / 2;
  const hl = 4;
  const yLab = y0 + (rows - 1) * ry + D / 2 + 3 + hl / 2;
  const Lp = Math.max(40, yLab + hl / 2 + 4);
  const holes: { d: number; x: number; y: number }[] = [];
  for (let k = 1; k <= count; k++) holes.push({ d: k * step, x: k * step, y: y0 + ((k - 1) % rows) * ry });
  const every = step * Math.ceil(10 / step - 1e-9);
  return { holes, rows, D, step, every, fw: 5, t: num(p, 'scThick'), fh: num(p, 'scFence'), Lp, yLab, hl, Wx: max + D / 2 + 5 };
}

function buildScribe(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const S = scribeLayout(p);
  const plate = rect(M, -S.fw, 0, S.Wx, S.Lp).subtract(M.CrossSection.union(S.holes.map((h) => hole(M, S.D / 2, h.x, h.y, 24))));
  const fence = rect(M, -S.fw, 0, 0, S.Lp);
  let solid = M.Manifold.union([plate.extrude(S.t), fence.extrude(S.t + S.fh)]);
  const marks: { cs: CrossSection; at: Vec2 }[] = [];
  for (const h of S.holes) {
    const ratio = h.d / S.every;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-6) continue;
    const cs = label(ctx, fmt(h.d), S.hl, S.every * 0.9);
    if (cs) marks.push({ cs, at: [h.x, S.yLab] });
    marks.push({ cs: rect(M, -0.3, -1.2, 0.3, 1.2), at: [h.x, h.y + S.D / 2 + 1.6] });
  }
  solid = engraveBed(M, solid, marks);
  solid = fit(ctx, solid, 'Kantlijnmal');
  ctx.tips.push(
    'Haak de lip langs de kant van de plank, steek een scherpe potloodpunt of priem in het gaatje met de gewenste afstand en schuif de mal langs de kant.',
    `Gaatjes elke ${fmt(S.step)} mm, gemeten vanaf de binnenkant van de lip tot het midden van het gaatje. De getallen staan op de onderkant (na omdraaien boven).`,
    accuracyTip,
  );
  return { parts: [{ name: 'Kantlijnmal', solid }] };
}

// ---------------------------------------------------------------------------
// 9. Set-up blocks: a staircase of exact heights (blade / bit height gauge)

export function setupLayout(p: Params) {
  const heights = listParam(p, 'suHeights', 'hoogte', 0.5, 100, 24);
  const hl = 4.5;
  const steps: { h: number; x: number; w: number }[] = [];
  let x = 0;
  for (const h of heights) {
    const w = num(p, 'suW');
    steps.push({ h, x, w });
    x += w;
  }
  return { steps, W: x, D: num(p, 'suDepth'), hl };
}

function buildSetup(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const S = setupLayout(p);
  let solid = M.Manifold.union(S.steps.map((s, i) => M.Manifold.cube([s.w + (i < S.steps.length - 1 ? 0.01 : 0), S.D, s.h]).translate([s.x, 0, 0])));
  const skipped: string[] = [];
  for (const s of S.steps) {
    const depth = Math.min(ENGRAVE_TOP, s.h - 0.4);
    if (depth < 0.2) {
      skipped.push(fmt(s.h));
      continue;
    }
    const cs = label(ctx, fmt(s.h), Math.min(S.hl, s.w - 4), S.D - 4);
    if (cs) solid = engraveTop(M, solid, [cs.rotate(90).translate([s.x + s.w / 2, S.D / 2])], s.h, depth);
  }
  solid = fit(ctx, solid, 'Instelblokjes');
  if (S.steps.some((s) => Math.abs(s.h * 5 - Math.round(s.h * 5)) > 1e-6)) {
    ctx.warnings.push('Niet alle hoogtes zijn een veelvoud van 0,2 mm: print met 0,1 mm laaghoogte (of variabele laaghoogte), anders rondt de slicer af.');
  }
  if (skipped.length) ctx.tips.push(`Te laag voor een label: ${skipped.join(', ')} mm.`);
  ctx.tips.push(
    'Zet het blokje naast het zaagblad of de frees en draai hem omhoog tot de hoogste tand de juiste trede net raakt. Ook handig als afstandsblokje voor de aanslag.',
    'Hoogtes komen uit de laaghoogte: print met 0,2 mm (of 0,1 mm) lagen, eerste laag gelijk, en meet de treden na met een schuifmaat. Wijkt het af, pas dan de Z-offset of de flow aan.',
    accuracyTip,
  );
  ctx.info.push({ kind: 'table', title: 'Treden', headers: ['Hoogte', 'Breedte'], rows: S.steps.map((s) => [`${fmt(s.h)} mm`, `${fmt(s.w, 1)} mm`]) });
  return { parts: [{ name: 'Instelblokjes', solid }] };
}

// ---------------------------------------------------------------------------
// 10. Clamping square: two reference edges at an exact angle, clamp windows

export function squareLayout(p: Params) {
  return { theta: num(p, 'sqAngle'), A: num(p, 'sqArm'), w: num(p, 'sqWidth'), T: num(p, 'sqThick'), relief: 3, bw: 8 };
}

function buildSquare(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const S = squareLayout(p);
  const th = deg(S.theta);
  const big = S.A * 4;
  const wedge = poly(M, [[0, 0], [big, 0], [big * Math.cos(th), big * Math.sin(th)]]);
  const arm1 = rect(M, 0, 0, S.A, S.w).intersect(wedge);
  const arm2 = rect(M, 0, -S.w, S.A, 0).rotate(S.theta).intersect(wedge);
  const arms = M.CrossSection.union([arm1, arm2]);
  let outline = M.CrossSection.hull([arms]).intersect(wedge);
  if (bool(p, 'sqWindows')) {
    const win = outline.subtract(arms).offset(-S.bw, 'Round');
    if (!win.isEmpty() && win.area() > 150) outline = outline.subtract(win);
  }
  outline = outline.subtract(M.CrossSection.circle(S.relief, 32));
  const solid = fit(ctx, outline.extrude(S.T), 'Lijmhoek');
  ctx.tips.push(
    `De twee buitenranden staan precies ${fmt(S.theta)}° ten opzichte van elkaar. Zet de lijmhoek in de binnenhoek van je kast of lade en klem hem met lijmtangen door de vensters aan beide planken.`,
    'De uitsparing in de punt houdt lijmresten en een ronde hoek van de plank vrij, zodat de hoek goed aansluit.',
    'Plat geprint staan de referentievlakken loodrecht op het bed: controleer ze na het printen met een goede winkelhaak.',
    strongTip,
  );
  return { parts: [{ name: `Lijmhoek ${fmt(S.theta)}°`, solid, quantity: num(p, 'sqQty') }] };
}

// ---------------------------------------------------------------------------
// 11. Drill guide: straight or angled guide holes in a block

export function drillLayout(p: Params) {
  const sizes = listParam(p, 'dgSizes', 'boormaat', 1, 20, 12);
  const alpha = num(p, 'dgAngle');
  const H = num(p, 'dgHeight');
  const clear = num(p, 'dgClear');
  const ca = Math.cos(deg(alpha));
  const hl = 4.5;
  const holes: { D: number; r: number; x: number; half: number }[] = [];
  for (const D of sizes) {
    const r = (D + clear) / 2;
    const half = Math.max(r, (0.72 * hl * fmt(D).length + 2) / 2);
    const prev = holes[holes.length - 1];
    holes.push({ D, r, half, x: prev ? prev.x + prev.half + 5 + half : 6 + half });
  }
  const rMax = Math.max(...holes.map((h) => h.r));
  const Lx = holes[holes.length - 1].x + holes[holes.length - 1].half + 6;
  const yc = 2 + hl + 3 + rMax / ca + 1;
  const Ly = yc + H * Math.tan(deg(alpha)) + rMax / ca + 6;
  const vee = alpha === 0 && bool(p, 'dgVee');
  const gw = vee ? Math.max(0, Math.min(10, yc - 3, Ly - yc - 3, H - 8)) : 0;
  return { holes, alpha, H, clear, Lx, Ly, yc, hl, gw };
}

function buildDrill(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const G = drillLayout(p);
  const ta = Math.tan(deg(G.alpha));
  const ca = Math.cos(deg(G.alpha));
  let outline = rect(M, 0, 0, G.Lx, G.Ly);
  const grooves: CrossSection[] = [];
  for (const h of G.holes) grooves.push(poly(M, [[h.x - 1, -0.01], [h.x + 1, -0.01], [h.x, 1]]));
  grooves.push(poly(M, [[-0.01, G.yc - 1], [-0.01, G.yc + 1], [1, G.yc]]));
  grooves.push(poly(M, [[G.Lx + 0.01, G.yc - 1], [G.Lx + 0.01, G.yc + 1], [G.Lx - 1, G.yc]]));
  outline = outline.subtract(M.CrossSection.union(grooves));
  let solid = outline.extrude(G.H);
  const cutters: Manifold[] = [];
  for (const h of G.holes) {
    const seg = 48;
    const r = h.r / Math.cos(Math.PI / seg);
    cutters.push(M.Manifold.cylinder((G.H + 4) / ca, r, r, seg).rotate([-G.alpha, 0, 0]).translate([h.x, G.yc - 2 * ta, -2]));
  }
  if (G.gw > 1) {
    const v = poly(M, [[G.yc - G.gw - 0.01, -0.01], [G.yc + G.gw + 0.01, -0.01], [G.yc, G.gw]]);
    // V along x (45° walls): profile in the yz-plane
    cutters.push(v.extrude(G.Lx + 2).rotate([90, 0, 90]).translate([-1, 0, 0]));
  }
  solid = solid.subtract(M.Manifold.union(cutters));
  const marks: CrossSection[] = [];
  for (const h of G.holes) {
    const cs = label(ctx, fmt(h.D), G.hl, 2 * h.r + 6);
    if (cs) marks.push(cs.translate([h.x, 2 + G.hl / 2]));
  }
  solid = engraveTop(M, solid, marks, G.H);
  solid = fit(ctx, solid, 'Boorgeleider');
  ctx.tips.push(
    G.alpha > 0
      ? `De gaten lopen onder ${fmt(G.alpha)}° met de loodlijn. Het boorpunt ligt op de onderkant, recht onder de kerfjes in de voorkant (lengte) en de zijkanten (breedte).`
      : 'Zet de kerfjes in de voor- en zijkanten op je afgetekende kruis: het gat komt precies op het snijpunt.',
    `Gaten ${fmt(G.clear)} mm ruimer dan de boor. Geprinte gaten worden vaak iets kleiner: boor ze na met dezelfde boor als ze klemmen.`,
    'Plastic slijt: voor veel gebruik kun je een stalen boorbus inlijmen, of dit blok als mal gebruiken om een houten geleider te boren.',
  );
  if (G.gw > 1) ctx.tips.push('De V-groef aan de onderkant centreert ronde stokken: het gat gaat dan door het hart.');
  if (G.alpha === 0 && bool(p, 'dgVee') && G.gw <= 1) ctx.warnings.push('Te weinig ruimte voor een V-groef: maak het blok hoger.');
  ctx.info.push({ kind: 'kv', title: 'Maat', rows: [['Blok', `${fmt(G.Lx, 1)} × ${fmt(G.Ly, 1)} × ${fmt(G.H, 1)} mm`], ['Geleidelengte', `${fmt(G.H / ca, 1)} mm`]] });
  return { parts: [{ name: 'Boorgeleider', solid }] };
}

// ---------------------------------------------------------------------------
// 12. Dowel jig: saddle over the board edge, holes on the centre line

export function dowelLayout(p: Params, warnings: string[] = []) {
  const D = Number(str(p, 'dwD')) || 8;
  const B = num(p, 'dwBoard');
  if (D >= B - 2) throw new UserError(`Een deuvel van Ø${D} mm is te dik voor een plank van ${fmt(B)} mm.`);
  if (D > B / 2 + 0.01) warnings.push(`Deuvel Ø${D} mm is dikker dan de helft van de plank (${fmt(B)} mm): de wanden worden dun. Vuistregel: deuvel ≈ ⅓–½ van de plankdikte.`);
  const bush = bool(p, 'dwBush');
  const od = num(p, 'dwBushOD');
  if (bush && od < D + 1.5) throw new UserError(`De boorbus (Ø${fmt(od)} mm) moet minstens 1,5 mm dikker zijn dan de boor (Ø${D} mm).`);
  const r = bush ? (od - 0.1) / 2 : (D + num(p, 'dwClear')) / 2;
  const inner = (B + num(p, 'dwFit')) / 2;
  if (r > inner - 0.5) throw new UserError('De boorbus is te dik voor deze plankdikte.');
  const wc = 6;
  const outer = inner + wc;
  const n = Math.round(num(p, 'dwHoles'));
  const pitch = num(p, 'dwPitch');
  if (n > 1 && pitch < 2 * r + 3) throw new UserError(`De gatafstand (${fmt(pitch)} mm) is te klein voor gaten van Ø${fmt(2 * r)} mm.`);
  let stop = num(p, 'dwStop');
  if (stop > 0 && stop < r + 2) {
    warnings.push(`Aanslag te dicht bij het gat: verschoven naar ${fmt(r + 2)} mm.`);
    stop = r + 2;
  }
  const ws = 5;
  const xs = Array.from({ length: n }, (_, i) => i * pitch);
  const xMin = stop > 0 ? -stop - ws : -(r + 8);
  const hl = 4;
  const xMax = xs[xs.length - 1] + r + 8 + hl + 3;
  return { D, B, r, inner, outer, xs, stop, ws, xMin, xMax, Tg: num(p, 'dwGuide'), He: num(p, 'dwCheek'), bush, od, hl };
}

function buildDowel(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const J = dowelLayout(p, ctx.warnings);
  const plate = rect(M, J.xMin, -J.outer, J.xMax, J.outer).subtract(M.CrossSection.union(J.xs.map((x) => hole(M, J.r, x, 0))));
  const walls = [rect(M, J.xMin, -J.outer, J.xMax, -J.inner), rect(M, J.xMin, J.inner, J.xMax, J.outer)];
  if (J.stop > 0) walls.push(rect(M, J.xMin, -J.outer, -J.stop, J.outer));
  let solid = M.Manifold.union([plate.extrude(J.Tg), M.CrossSection.union(walls).extrude(J.Tg + J.He)]);
  const cs = label(ctx, `Ø${J.D} · ${fmt(J.B)}`, J.hl, 2 * J.outer - 4);
  if (cs) solid = engraveBed(M, solid, [{ cs, at: [J.xMax - 3 - J.hl / 2, 0], rot: 90 }]);
  solid = fit(ctx, solid, 'Deuvelmal');
  ctx.tips.push(
    `Schuif de mal over de kant van de ${fmt(J.B)} mm plank: de wangen centreren hem, de gaten staan precies in het midden.${J.stop > 0 ? ` Met de aanslag tegen de kopse kant ligt het eerste gat op ${fmt(J.stop)} mm.` : ''}`,
    `Boor met een houtboor Ø${J.D} mm en een diepte-stop (diepte in het hout + ${fmt(J.Tg)} mm geleider). Klem de mal vast tijdens het boren.`,
    J.bush
      ? `Druk stalen boorbussen Ø${fmt(J.od)} mm (binnen Ø${J.D}) in de gaten: die slijten niet. Gat ${fmt(J.od - 0.1)} mm = lichte perspassing.`
      : 'Zonder boorbus slijt het plastic: voor veel gaten kun je stalen boorbussen kiezen (optie hierboven).',
    'Gebruik dezelfde kant van de mal (het label) steeds tegen de zichtzijde, dan sluiten de delen ook als de plank niet precies in het midden zit.',
  );
  return { parts: [{ name: `Deuvelmal Ø${J.D}`, solid }] };
}

// ---------------------------------------------------------------------------
// 13. Shelf-pin template (32 mm system)

export function shelfLayout(p: Params) {
  const n = Math.round(num(p, 'spHoles'));
  const pitch = num(p, 'spPitch');
  const off = num(p, 'spOffset');
  const D = num(p, 'spHoleD');
  const bush = bool(p, 'spBush');
  const od = num(p, 'spBushOD');
  if (bush && od < D + 1.5) throw new UserError(`De boorbus (Ø${fmt(od)} mm) moet minstens 1,5 mm dikker zijn dan de boor (Ø${fmt(D)} mm).`);
  const r = bush ? (od - 0.1) / 2 : (D + num(p, 'spClear')) / 2;
  if (pitch < 2 * r + 3) throw new UserError(`De gatafstand (${fmt(pitch)} mm) is te klein voor gaten van Ø${fmt(2 * r)} mm.`);
  if (off < r + 2) throw new UserError('De gaten liggen te dicht bij de rand.');
  const xs = Array.from({ length: n }, (_, i) => i * pitch);
  return { xs, pitch, off, D, r, bush, od, fw: 5, t: num(p, 'spThick'), fh: num(p, 'spFence'), x0: -(r + 8), x1: xs[xs.length - 1] + r + 8, y1: off + r + 8 };
}

function buildShelf(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const S = shelfLayout(p);
  let plate = rect(M, S.x0, -S.fw, S.x1, S.y1).subtract(M.CrossSection.union(S.xs.map((x) => hole(M, S.r, x, S.off))));
  const fence = rect(M, S.x0, -S.fw, S.x1, 0);
  const ticks = M.CrossSection.union(S.xs.map((x) => poly(M, [[x - 1, -S.fw - 0.01], [x + 1, -S.fw - 0.01], [x, -S.fw + 1]])));
  plate = plate.subtract(ticks);
  let solid = M.Manifold.union([plate.extrude(S.t), fence.subtract(ticks).extrude(S.t + S.fh)]);
  const avail = S.pitch - 2 * S.r - 4;
  const lab = avail >= 8 && S.off > 9 ? label(ctx, `${fmt(S.off)} · ${fmt(S.pitch)}`, 4, avail) : null;
  if (lab) solid = engraveBed(M, solid, [{ cs: lab, at: [S.pitch / 2, S.off] }]);
  solid = fit(ctx, solid, 'Gaatjesmal');
  ctx.tips.push(
    `Leg de lip tegen de voorkant van de kastzijde: de gaten liggen op ${fmt(S.off)} mm van de rand, ${fmt(S.pitch)} mm uit elkaar (32 mm-systeem).`,
    `Verlengen: steek een plankdrager of boor Ø${fmt(S.D)} door het laatste gat in het laatst geboorde gat en schuif de mal door.`,
    `Boor met een Ø${fmt(S.D)} mm boor met diepte-stop: ${fmt(S.t)} mm mal + 10–12 mm in het hout. Kerfjes in de lip helpen bij het uitlijnen op een potloodstreep.`,
    S.bush ? `Druk stalen boorbussen Ø${fmt(S.od)} mm in de gaten (gat ${fmt(S.od - 0.1)} mm).` : 'Voor veel gaten: kies de optie stalen boorbussen, dan slijt de mal niet.',
  );
  return { parts: [{ name: 'Gaatjesmal', solid }] };
}

// ---------------------------------------------------------------------------
// 14. Concealed hinge template (cup hole + mounting screws)

const HINGE_PATTERNS: Record<string, { label: string; spacing: number; offset: number }> = {
  '45': { label: '45 / 9,5 mm (o.a. Blum)', spacing: 45, offset: 9.5 },
  '48': { label: '48 / 6 mm (o.a. Hettich)', spacing: 48, offset: 6 },
  '52': { label: '52 / 5,5 mm (o.a. Grass)', spacing: 52, offset: 5.5 },
  none: { label: 'Geen schroefgaten', spacing: 0, offset: 0 },
};

export function hingeLayout(p: Params, warnings: string[] = []) {
  const cup = Number(str(p, 'hgCup')) || 35;
  const R = (cup + 0.4) / 2;
  const cy = num(p, 'hgEdge') + cup / 2;
  const pat = HINGE_PATTERNS[str(p, 'hgPattern')] ?? HINGE_PATTERNS['45'];
  const screws: Vec2[] = pat.spacing > 0 ? [[-pat.spacing / 2, cy + pat.offset], [pat.spacing / 2, cy + pat.offset]] : [];
  const halfX = Math.max(R, pat.spacing / 2 + 2) + 10;
  let top = num(p, 'hgTop');
  if (top > 0 && top < halfX - 4) {
    warnings.push(`Aanslag bovenkant deur verschoven naar ${fmt(halfX - 4)} mm (anders raakt hij het potgat).`);
    top = halfX - 4;
  }
  const ws = 5;
  const fw = 5;
  return { cup, R, cy, screws, pat, x0: top > 0 ? -top - ws : -halfX, x1: halfX, y1: cy + Math.max(R, pat.offset + 2) + 10, top, ws, fw, t: num(p, 'hgThick'), fh: num(p, 'hgFence') };
}

function buildHinge(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const H = hingeLayout(p, ctx.warnings);
  const cuts = [hole(M, H.R, 0, H.cy, 96), ...H.screws.map(([x, y]) => hole(M, 1.25, x, y, 24))];
  const plate = rect(M, H.x0, -H.fw, H.x1, H.y1).subtract(M.CrossSection.union(cuts));
  const walls = [rect(M, H.x0, -H.fw, H.x1, 0)];
  if (H.top > 0) walls.push(rect(M, H.x0, -H.fw, -H.top, H.y1));
  const tick = poly(M, [[-1, -H.fw - 0.01], [1, -H.fw - 0.01], [0, -H.fw + 1]]);
  let solid = M.Manifold.union([plate.subtract(tick).extrude(H.t), M.CrossSection.union(walls).subtract(tick).extrude(H.t + H.fh)]);
  const lab = label(ctx, `Ø${H.cup} · ${fmt(num(p, 'hgEdge'))}`, 4, H.x1 * 2 - 8);
  if (lab) solid = engraveBed(M, solid, [{ cs: lab, at: [0, H.y1 - 5] }]);
  solid = fit(ctx, solid, 'Scharniermal');
  ctx.tips.push(
    `Leg de lip tegen de kant van de deur${H.top > 0 ? ` en de aanslag tegen de bovenkant (midden pot op ${fmt(H.top)} mm)` : ' en zet het kerfje in de lip op je potloodstreep (midden van de pot)'}.`,
    `Boor de pot met een Forstnerboor Ø${H.cup} mm door de geleider, ${fmt(num(p, 'hgEdge'))} mm vanaf de deurrand (boorafstand). Diepte meestal 11,5–13 mm in het hout: gebruik een diepte-stop.`,
    H.screws.length ? `Prik of boor de schroefgaten (${H.pat.label}) voor met een Ø2,5 mm boor of priem. Controleer het gatenpatroon met de handleiding van je scharnier.` : 'Schroefgaten zet je af met het scharnier zelf.',
    'Een Forstnerboor heeft geen centreerpunt dat geleid wordt: begin langzaam en houd de boor recht; de mal voorkomt vooral dat hij wegloopt.',
  );
  return { parts: [{ name: 'Scharniermal', solid }] };
}

// ---------------------------------------------------------------------------
// 15. Featherboard

export function featherLayout(p: Params) {
  const Lb = num(p, 'fbLen');
  const Wb = num(p, 'fbWidth');
  const Lf = num(p, 'fbFinger');
  const phi = num(p, 'fbAngle');
  const fw = num(p, 'fbFingerW');
  const gap = num(p, 'fbGap');
  const c = Math.cos(deg(phi));
  const s = Math.sin(deg(phi));
  const pitch = (fw + gap) / c;
  const gaps: number[] = [];
  for (let x = fw / c + gap / (2 * c); x < Lb - fw / c - gap / (2 * c) + 1e-9; x += pitch) gaps.push(x);
  return { Lb, Wb, Lf, phi, fw, gap, c, s, gaps, T: num(p, 'fbThick') };
}

function buildFeather(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const F = featherLayout(p);
  const base = rect(M, 0, 0, F.Lb, F.Wb + 0.01);
  const tipY = F.Wb + F.Lf * F.c;
  const fingers = poly(M, [[0, F.Wb], [F.Lb, F.Wb], [F.Lb + F.Lf * F.s, tipY], [F.Lf * F.s, tipY]]);
  const far = F.Lf + 10;
  const gapCuts = F.gaps.map((x) => slot(M, F.gap / 2, [x, F.Wb], [x + far * F.s, F.Wb + far * F.c]));
  let outline = M.CrossSection.union([base, fingers]);
  if (gapCuts.length) outline = outline.subtract(M.CrossSection.union(gapCuts));
  if (str(p, 'fbMount') === 'tbolt') {
    const r = num(p, 'fbSlot') / 2;
    const y0 = 8 + r;
    const y1 = F.Wb - 8 - r;
    if (y1 - y0 >= 6) outline = outline.subtract(M.CrossSection.union([slot(M, r, [F.Lb * 0.25, y0], [F.Lb * 0.25, y1]), slot(M, r, [F.Lb * 0.75, y0], [F.Lb * 0.75, y1])]));
    else ctx.warnings.push('Te smal voor stelsleuven: maak het veerbord breder.');
  }
  const solid = fit(ctx, filletExtrude(M, outline, F.T, 0, 1), 'Veerbord');
  ctx.tips.push(
    `De vingers wijzen ${fmt(F.phi)}° met de voedingsrichting mee: het werkstuk schuift erlangs maar kan niet terugslaan. Zet het veerbord zo dat de vingers 2–3 mm ingedrukt worden.`,
    str(p, 'fbMount') === 'tbolt'
      ? 'Bevestig met twee T-bouten M6 (of 1/4") en sterknoppen in een T-rail of in een T-sleuf van de zaagtafel (19 × 9,5 mm). Voor een gewone sleuf zonder T: gebruik een expansiestrip of klem het veerbord vast.'
      : 'Klem het veerbord met twee lijmtangen op de tafel of aan de aanslag.',
    'PETG is taaier dan PLA: de vingers veren dan zonder te breken. Print met 3 wanden zodat elke vinger massief wordt.',
  );
  return { parts: [{ name: 'Veerbord', solid }] };
}

// ---------------------------------------------------------------------------
// 16. Chisel / plane iron bevel angle gauge

export function chiselLayout(p: Params) {
  const angles = listParam(p, 'cgAngles', 'hoek', 10, 60, 10);
  const dn = 14;
  const hl = 4.5;
  const notches: { theta: number; x0: number; open: number }[] = [];
  let x = 6;
  for (const theta of angles) {
    const open = dn * Math.tan(deg(theta));
    const lw = 0.72 * hl * (fmt(theta).length + 1) + 2;
    const x0 = x + Math.max(0, (lw - open) / 2);
    notches.push({ theta, x0, open });
    x = x0 + Math.max(open, lw) + 7;
  }
  return { notches, dn, hl, Hp: dn + hl + 8, W: x, T: num(p, 'cgThick') };
}

function buildChisel(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const C = chiselLayout(p);
  const cuts = C.notches.map((n) => poly(M, [[n.x0, C.Hp + 1], [n.x0, C.Hp - C.dn], [n.x0 + (C.dn + 1) * Math.tan(deg(n.theta)), C.Hp + 1]]));
  const outline = rect(M, 0, 0, C.W, C.Hp).subtract(M.CrossSection.union(cuts));
  let solid = outline.extrude(C.T);
  const marks: CrossSection[] = [];
  for (const n of C.notches) {
    const cs = label(ctx, `${fmt(n.theta)}°`, C.hl, Math.max(n.open, 10) + 4);
    if (cs) marks.push(cs.translate([n.x0 + n.open / 2, C.Hp - C.dn - 2 - C.hl / 2]));
  }
  solid = engraveTop(M, solid, marks, C.T);
  solid = fit(ctx, solid, 'Beitelhoekmeter');
  ctx.tips.push(
    'Zet de rug van de beitel of schaafbeitel tegen de rechte kant van een inkeping: sluit de schuine kant zonder spleet, dan heeft de beitel die slijphoek.',
    'Gebruikelijk: 25° voor beitels om te steken in zacht hout, 30° voor hard hout en hakken; schaafbeitels 25° met een microfaset van 30°.',
    'Stel je slijpgeleider af door de uitsteeklengte te verschuiven tot de facet in de juiste inkeping past.',
  );
  return { parts: [{ name: 'Beitelhoekmeter', solid }] };
}

// ---------------------------------------------------------------------------
// 17. Painter's pyramids / bench cookies

function buildPyramid(ctx: Ctx): BuildOutput {
  const { M, p } = ctx;
  const style = str(p, 'pyStyle');
  const B = num(p, 'pyBase');
  const H = num(p, 'pyHeight');
  let solid: Manifold;
  let name: string;
  if (style === 'cookie') {
    const h = Math.min(H, 30);
    const r = B / 2;
    const c = Math.min(2, h / 4);
    solid = M.Manifold.union([M.Manifold.cylinder(h - c, r, r, 96), M.Manifold.cylinder(c, r, r - c, 96).translate([0, 0, h - c - 0.001])]);
    name = 'Werkstukklos';
    ctx.tips.push('Print werkstukklossen in TPU (95A) voor grip: leg je werkstuk erop om te schuren, frezen of zagen zonder dat het wegglijdt.');
  } else if (style === 'cone') {
    solid = M.Manifold.cylinder(H, B / 2, 0.4, 96);
    name = 'Schilderskegel';
  } else {
    const n = style === 'pyramid4' ? 4 : 3;
    const R = B / 2 / Math.cos(Math.PI / n);
    const pts: [number, number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([R * Math.cos((i * 2 * Math.PI) / n), R * Math.sin((i * 2 * Math.PI) / n), 0]);
    pts.push([0, 0, H]);
    solid = M.Manifold.hull(pts);
    name = 'Schilderspiramide';
  }
  if (style !== 'cookie') ctx.tips.push('Zet geverfde of gelakte delen op de punten: zo raakt alleen een stipje het werkstuk en kun je beide kanten in één keer lakken.');
  solid = fit(ctx, solid, name);
  return { parts: [{ name, solid, quantity: num(p, 'pyQty') }] };
}

// ---------------------------------------------------------------------------

const BUILDERS: Record<string, (ctx: Ctx) => BuildOutput> = {
  bevel: buildBevel,
  dovetail: buildDovetail,
  chamfer: buildChamfer,
  centerRound: buildCenterRound,
  centerEdge: buildCenterEdge,
  pushStick: buildPushStick,
  pushBlock: buildPushBlock,
  scribe: buildScribe,
  setup: buildSetup,
  square: buildSquare,
  drill: buildDrill,
  dowel: buildDowel,
  shelf: buildShelf,
  hinge: buildHinge,
  feather: buildFeather,
  chisel: buildChisel,
  pyramid: buildPyramid,
};

export const WOOD_KINDS: { value: string; label: string }[] = [
  { value: 'bevel', label: 'Hoekmal (zaagblad, verstek)' },
  { value: 'dovetail', label: 'Zwaluwstaartmal' },
  { value: 'chamfer', label: 'Afschuinmal (vellingkant)' },
  { value: 'centerRound', label: 'Middelpuntzoeker rond hout' },
  { value: 'centerEdge', label: 'Middenlijnmal plankkant' },
  { value: 'pushStick', label: 'Duwstok / duwschoen' },
  { value: 'pushBlock', label: 'Duwblok' },
  { value: 'scribe', label: 'Kantlijnmal (evenwijdige lijn)' },
  { value: 'setup', label: 'Instelblokjes (hoogtemal)' },
  { value: 'square', label: 'Lijmhoek / klemhoek' },
  { value: 'drill', label: 'Boorgeleider' },
  { value: 'dowel', label: 'Deuvelmal' },
  { value: 'shelf', label: 'Gaatjesmal 32 mm (plankdragers)' },
  { value: 'hinge', label: 'Scharniermal (potscharnier)' },
  { value: 'feather', label: 'Veerbord' },
  { value: 'chisel', label: 'Beitelhoekmeter' },
  { value: 'pyramid', label: 'Schilderspiramides / werkstukklossen' },
];

/** Kinds that engrave labels (and so need the font). */
const LABELLED = new Set(['bevel', 'dovetail', 'chamfer', 'scribe', 'setup', 'drill', 'dowel', 'shelf', 'hinge', 'chisel']);

function assets(p: Params): AssetRef[] {
  return LABELLED.has(str(p, 'kind')) && bool(p, 'labels') ? [{ kind: 'font', key: FONT }] : [];
}

function build(p: Params, { M, printer, assets: store }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const kind = str(p, 'kind');
  const fn = BUILDERS[kind];
  if (!fn) throw new UserError(`Onbekende soort: ${kind}`);
  const font = LABELLED.has(kind) && bool(p, 'labels') ? store.font(FONT) : null;
  const ctx: Ctx = { M, p, printer, font, tips: [], warnings: [], info: [] };
  const out = fn(ctx);
  return { ...out, tips: [...ctx.tips, ...(out.tips ?? [])], warnings: [...ctx.warnings, ...(out.warnings ?? [])], info: [...ctx.info, ...(out.info ?? [])] };
}

const is = (...kinds: string[]) => (p: Params) => kinds.includes(str(p, 'kind'));

export const woodworkingTool: ToolDef = {
  id: 'houtbewerking',
  name: 'Houtbewerking',
  short: 'Hout',
  icon: 'M3 21l7-7M14 4l6 6-9 9-6-6zM14 4l2-2 6 6-2 2',
  description:
    'Hulpmiddelen voor de werkplaats: hoekmallen voor zaagblad en verstek, zwaluwstaart- en afschuinmallen, middelpuntzoekers, duwstokken en duwblokken, kantlijnmal, instelblokjes, lijmhoeken, boorgeleiders, deuvel-, gaatjes- en scharniermallen, veerbord en beitelhoekmeter.',
  params: [
    { type: 'group', label: 'Soort' },
    { type: 'select', key: 'kind', label: 'Hulpmiddel', default: 'bevel', options: WOOD_KINDS },
    { type: 'bool', key: 'labels', label: 'Maten erin graveren', default: true, show: (p) => LABELLED.has(str(p, 'kind')) },

    { type: 'group', label: 'Hoekmal', show: is('bevel') },
    {
      type: 'select', key: 'bvMode', label: 'Getallen zijn', default: 'tilt', show: is('bevel'),
      options: [
        { value: 'tilt', label: 'Zaagbladstand (0° = haaks)' },
        { value: 'edge', label: 'Hoek tussen de randen' },
      ],
    },
    { type: 'text', key: 'bvAngles', label: 'Hoeken', default: '15; 22,5; 30; 45', maxLength: 80, placeholder: '15; 22,5; 30; 45', help: 'Gescheiden door een puntkomma. Zaagbladstand 0–75°, hoek tussen de randen 15–90°.', show: is('bevel') },
    { type: 'number', key: 'bvEdge', label: 'Hoogte schuine randen', min: 15, max: 60, step: 1, unit: 'mm', default: 25, show: is('bevel'), help: 'Zet het zaagblad niet hoger dan dit.' },
    { type: 'number', key: 'bvThick', label: 'Dikte', min: 3, max: 12, step: 0.5, unit: 'mm', default: 5, show: is('bevel') },

    { type: 'group', label: 'Zwaluwstaartmal', show: is('dovetail') },
    {
      type: 'select', key: 'dtA', label: 'Helling zijde A', default: '6', show: is('dovetail'),
      options: [
        { value: '5', label: '1:5 (≈11,3°)' },
        { value: '6', label: '1:6 (≈9,5°) zacht hout' },
        { value: '7', label: '1:7 (≈8,1°)' },
        { value: '8', label: '1:8 (≈7,1°) hard hout' },
        { value: '10', label: '1:10 (≈5,7°)' },
      ],
    },
    {
      type: 'select', key: 'dtB', label: 'Helling zijde B', default: '8', show: is('dovetail'),
      options: [
        { value: '0', label: 'Geen (enkelzijdig)' },
        { value: '5', label: '1:5 (≈11,3°)' },
        { value: '6', label: '1:6 (≈9,5°) zacht hout' },
        { value: '7', label: '1:7 (≈8,1°)' },
        { value: '8', label: '1:8 (≈7,1°) hard hout' },
        { value: '10', label: '1:10 (≈5,7°)' },
      ],
    },
    { type: 'number', key: 'dtW', label: 'Breedte bij de kop', min: 15, max: 60, step: 1, unit: 'mm', default: 30, show: is('dovetail') },
    { type: 'number', key: 'dtLen', label: 'Lengte schuine kant', min: 20, max: 80, step: 1, unit: 'mm', default: 40, show: is('dovetail') },
    { type: 'number', key: 'dtEnd', label: 'Hoogte lip (kopse kant)', min: 10, max: 60, step: 1, unit: 'mm', default: 25, show: is('dovetail') },
    { type: 'number', key: 'dtThick', label: 'Dikte', min: 3, max: 8, step: 0.5, unit: 'mm', default: 4, show: is('dovetail') },

    { type: 'group', label: 'Afschuinmal', show: is('chamfer') },
    { type: 'text', key: 'chSizes', label: 'Vellingkanten', default: '1; 2; 3; 4; 5; 6', maxLength: 80, help: 'In mm langs elk vlak, gescheiden door een puntkomma (0,5–15).', show: is('chamfer') },
    { type: 'number', key: 'chThick', label: 'Dikte', min: 2, max: 8, step: 0.5, unit: 'mm', default: 4, show: is('chamfer') },

    { type: 'group', label: 'Middelpuntzoeker', show: is('centerRound') },
    { type: 'number', key: 'crMax', label: 'Grootste diameter', min: 20, max: 200, step: 1, unit: 'mm', default: 80, show: is('centerRound') },
    { type: 'number', key: 'crFence', label: 'Hoogte aanslagranden', min: 5, max: 20, step: 1, unit: 'mm', default: 10, show: is('centerRound') },
    { type: 'number', key: 'crThick', label: 'Dikte plaat', min: 3, max: 8, step: 0.5, unit: 'mm', default: 4, show: is('centerRound') },

    { type: 'group', label: 'Middenlijnmal', show: is('centerEdge') },
    { type: 'number', key: 'ceMax', label: 'Dikste plank', min: 10, max: 100, step: 1, unit: 'mm', default: 40, show: is('centerEdge') },
    {
      type: 'select', key: 'cePin', label: 'Pennen', default: 'printed', show: is('centerEdge'),
      options: [
        { value: 'printed', label: 'Meegeprint' },
        { value: 'steel', label: 'Gaten voor stalen pennen / deuvels' },
      ],
    },
    { type: 'number', key: 'cePinD', label: 'Diameter pennen', min: 5, max: 12, step: 0.5, unit: 'mm', default: 8, show: (p) => is('centerEdge')(p) && str(p, 'cePin') !== 'steel' },
    { type: 'number', key: 'ceSteelD', label: 'Diameter stalen pen', min: 3, max: 10, step: 0.5, unit: 'mm', default: 6, show: (p) => is('centerEdge')(p) && str(p, 'cePin') === 'steel' },
    { type: 'number', key: 'cePinH', label: 'Lengte pennen', min: 6, max: 25, step: 1, unit: 'mm', default: 12, show: is('centerEdge') },
    { type: 'number', key: 'cePencil', label: 'Potloodgat', min: 1, max: 10, step: 0.1, unit: 'mm', default: 7.5, show: is('centerEdge'), help: 'Gewoon potlood ≈ 7,5 mm; vulpotlood of priem kleiner.' },

    { type: 'group', label: 'Duwstok', show: is('pushStick') },
    {
      type: 'select', key: 'psStyle', label: 'Model', default: 'classic', show: is('pushStick'),
      options: [
        { value: 'classic', label: 'Klassiek (schuin, met inkeping)' },
        { value: 'shoe', label: 'Duwschoen (lange zool met hak)' },
      ],
    },
    { type: 'number', key: 'psLen', label: 'Lengte', min: 180, max: 420, step: 5, unit: 'mm', default: 300, show: is('pushStick') },
    { type: 'number', key: 'psHeel', label: 'Hoogte hak / inkeping', min: 3, max: 20, step: 0.5, unit: 'mm', default: 8, show: is('pushStick'), help: 'Iets lager dan je werkstuk dik is.' },
    { type: 'number', key: 'psAngle', label: 'Schuinte steel', min: 20, max: 40, step: 1, unit: '°', default: 30, show: (p) => is('pushStick')(p) && str(p, 'psStyle') !== 'shoe' },
    { type: 'number', key: 'psThick', label: 'Dikte', min: 10, max: 25, step: 0.5, unit: 'mm', default: 15, show: is('pushStick'), help: 'Moet tussen zaagblad en aanslag passen.' },

    { type: 'group', label: 'Duwblok', show: is('pushBlock') },
    { type: 'number', key: 'pbLen', label: 'Lengte', min: 100, max: 260, step: 5, unit: 'mm', default: 160, show: is('pushBlock') },
    { type: 'number', key: 'pbWidth', label: 'Breedte', min: 50, max: 140, step: 5, unit: 'mm', default: 80, show: is('pushBlock') },
    { type: 'number', key: 'pbHeight', label: 'Hoogte blok', min: 14, max: 40, step: 1, unit: 'mm', default: 22, show: is('pushBlock') },
    {
      type: 'select', key: 'pbHeel', label: 'Hak', default: 'screw', show: is('pushBlock'),
      options: [
        { value: 'screw', label: 'Losse hak (vervangbaar)' },
        { value: 'none', label: 'Geen hak (vlakke zool)' },
      ],
    },
    { type: 'number', key: 'pbHeelH', label: 'Hak steekt uit', min: 3, max: 12, step: 0.5, unit: 'mm', default: 6, show: (p) => is('pushBlock')(p) && str(p, 'pbHeel') === 'screw' },
    { type: 'bool', key: 'pbPad', label: 'Antislipzool (TPU)', default: false, show: is('pushBlock') },

    { type: 'group', label: 'Kantlijnmal', show: is('scribe') },
    { type: 'number', key: 'scMax', label: 'Grootste afstand', min: 20, max: 150, step: 1, unit: 'mm', default: 50, show: is('scribe') },
    { type: 'number', key: 'scStep', label: 'Stap', min: 0.5, max: 10, step: 0.5, unit: 'mm', default: 1, show: is('scribe') },
    { type: 'number', key: 'scHole', label: 'Gaatje voor potloodpunt', min: 0.8, max: 4, step: 0.1, unit: 'mm', default: 2.4, show: is('scribe') },
    { type: 'number', key: 'scFence', label: 'Hoogte lip', min: 4, max: 20, step: 1, unit: 'mm', default: 8, show: is('scribe') },
    { type: 'number', key: 'scThick', label: 'Dikte plaat', min: 3, max: 8, step: 0.5, unit: 'mm', default: 4, show: is('scribe') },

    { type: 'group', label: 'Instelblokjes', show: is('setup') },
    { type: 'text', key: 'suHeights', label: 'Hoogtes', default: '1; 2; 3; 4; 5; 6; 8; 10; 12; 15; 20; 25', maxLength: 120, help: 'In mm, gescheiden door een puntkomma (0,5–100).', show: is('setup') },
    { type: 'number', key: 'suW', label: 'Breedte per trede', min: 8, max: 30, step: 1, unit: 'mm', default: 13, show: is('setup') },
    { type: 'number', key: 'suDepth', label: 'Diepte', min: 12, max: 50, step: 1, unit: 'mm', default: 25, show: is('setup') },

    { type: 'group', label: 'Lijmhoek', show: is('square') },
    { type: 'number', key: 'sqAngle', label: 'Hoek', min: 30, max: 150, step: 0.5, unit: '°', default: 90, show: is('square') },
    { type: 'number', key: 'sqArm', label: 'Lengte armen', min: 50, max: 200, step: 5, unit: 'mm', default: 100, show: is('square') },
    { type: 'number', key: 'sqWidth', label: 'Breedte armen', min: 12, max: 40, step: 1, unit: 'mm', default: 20, show: is('square') },
    { type: 'number', key: 'sqThick', label: 'Hoogte (dikte)', min: 8, max: 40, step: 1, unit: 'mm', default: 20, show: is('square') },
    { type: 'bool', key: 'sqWindows', label: 'Vensters voor lijmtangen', default: true, show: is('square') },
    { type: 'number', key: 'sqQty', label: 'Aantal', min: 1, max: 8, step: 1, default: 4, show: is('square') },

    { type: 'group', label: 'Boorgeleider', show: is('drill') },
    { type: 'text', key: 'dgSizes', label: 'Boormaten', default: '3; 4; 5; 6; 8; 10', maxLength: 80, help: 'In mm, gescheiden door een puntkomma (1–20).', show: is('drill') },
    { type: 'number', key: 'dgAngle', label: 'Schuin boren', min: 0, max: 45, step: 0.5, unit: '°', default: 0, show: is('drill'), help: '0° = haaks op het hout.' },
    { type: 'number', key: 'dgHeight', label: 'Hoogte blok', min: 15, max: 60, step: 1, unit: 'mm', default: 30, show: is('drill') },
    { type: 'number', key: 'dgClear', label: 'Speling boor', min: 0, max: 1, step: 0.05, unit: 'mm', default: 0.25, show: is('drill') },
    { type: 'bool', key: 'dgVee', label: 'V-groef voor rond hout', default: false, show: (p) => is('drill')(p) && num(p, 'dgAngle') === 0 },

    { type: 'group', label: 'Deuvelmal', show: is('dowel') },
    {
      type: 'select', key: 'dwD', label: 'Deuvel', default: '8', show: is('dowel'),
      options: [
        { value: '6', label: 'Ø6 mm' },
        { value: '8', label: 'Ø8 mm' },
        { value: '10', label: 'Ø10 mm' },
        { value: '12', label: 'Ø12 mm' },
      ],
    },
    { type: 'number', key: 'dwBoard', label: 'Plankdikte', min: 10, max: 40, step: 0.5, unit: 'mm', default: 18, show: is('dowel') },
    { type: 'number', key: 'dwHoles', label: 'Aantal gaten', min: 1, max: 6, step: 1, default: 2, show: is('dowel') },
    { type: 'number', key: 'dwPitch', label: 'Gatafstand', min: 16, max: 64, step: 1, unit: 'mm', default: 32, show: (p) => is('dowel')(p) && num(p, 'dwHoles') > 1 },
    { type: 'number', key: 'dwStop', label: 'Aanslag: eerste gat vanaf kopse kant', min: 0, max: 80, step: 1, unit: 'mm', default: 0, show: is('dowel'), help: '0 = geen aanslag.' },
    { type: 'number', key: 'dwGuide', label: 'Lengte geleiding', min: 14, max: 40, step: 1, unit: 'mm', default: 24, show: is('dowel') },
    { type: 'number', key: 'dwCheek', label: 'Hoogte wangen', min: 10, max: 40, step: 1, unit: 'mm', default: 20, show: is('dowel') },
    { type: 'number', key: 'dwFit', label: 'Speling plank', min: 0, max: 1.5, step: 0.05, unit: 'mm', default: 0.4, show: is('dowel') },
    { type: 'bool', key: 'dwBush', label: 'Stalen boorbussen', default: false, show: is('dowel') },
    { type: 'number', key: 'dwClear', label: 'Speling boor', min: 0, max: 1, step: 0.05, unit: 'mm', default: 0.25, show: (p) => is('dowel')(p) && !bool(p, 'dwBush') },
    { type: 'number', key: 'dwBushOD', label: 'Buitenmaat boorbus', min: 6, max: 20, step: 0.5, unit: 'mm', default: 12, show: (p) => is('dowel')(p) && bool(p, 'dwBush') },

    { type: 'group', label: 'Gaatjesmal', show: is('shelf') },
    { type: 'number', key: 'spHoles', label: 'Aantal gaten', min: 2, max: 12, step: 1, default: 7, show: is('shelf') },
    { type: 'number', key: 'spPitch', label: 'Gatafstand', min: 16, max: 64, step: 1, unit: 'mm', default: 32, show: is('shelf') },
    { type: 'number', key: 'spOffset', label: 'Afstand tot de voorkant', min: 15, max: 100, step: 0.5, unit: 'mm', default: 37, show: is('shelf') },
    { type: 'number', key: 'spHoleD', label: 'Boormaat', min: 3, max: 10, step: 0.5, unit: 'mm', default: 5, show: is('shelf') },
    { type: 'bool', key: 'spBush', label: 'Stalen boorbussen', default: false, show: is('shelf') },
    { type: 'number', key: 'spClear', label: 'Speling boor', min: 0, max: 1, step: 0.05, unit: 'mm', default: 0.2, show: (p) => is('shelf')(p) && !bool(p, 'spBush') },
    { type: 'number', key: 'spBushOD', label: 'Buitenmaat boorbus', min: 5, max: 16, step: 0.5, unit: 'mm', default: 8, show: (p) => is('shelf')(p) && bool(p, 'spBush') },
    { type: 'number', key: 'spThick', label: 'Dikte mal', min: 6, max: 20, step: 1, unit: 'mm', default: 10, show: is('shelf') },
    { type: 'number', key: 'spFence', label: 'Hoogte lip', min: 5, max: 20, step: 1, unit: 'mm', default: 10, show: is('shelf') },

    { type: 'group', label: 'Scharniermal', show: is('hinge') },
    {
      type: 'select', key: 'hgCup', label: 'Pot', default: '35', show: is('hinge'),
      options: [
        { value: '35', label: 'Ø35 mm (standaard)' },
        { value: '26', label: 'Ø26 mm' },
        { value: '40', label: 'Ø40 mm' },
      ],
    },
    { type: 'number', key: 'hgEdge', label: 'Boorafstand (deurrand tot pot)', min: 2, max: 8, step: 0.5, unit: 'mm', default: 4, show: is('hinge') },
    { type: 'select', key: 'hgPattern', label: 'Schroefgaten', default: '45', show: is('hinge'), options: Object.entries(HINGE_PATTERNS).map(([value, v]) => ({ value, label: v.label })) },
    { type: 'number', key: 'hgTop', label: 'Aanslag: midden pot vanaf bovenkant deur', min: 0, max: 200, step: 1, unit: 'mm', default: 0, show: is('hinge'), help: '0 = geen aanslag (kerfje op potloodstreep).' },
    { type: 'number', key: 'hgThick', label: 'Dikte mal', min: 5, max: 15, step: 1, unit: 'mm', default: 8, show: is('hinge') },
    { type: 'number', key: 'hgFence', label: 'Hoogte lip', min: 5, max: 20, step: 1, unit: 'mm', default: 10, show: is('hinge') },

    { type: 'group', label: 'Veerbord', show: is('feather') },
    { type: 'number', key: 'fbLen', label: 'Lengte', min: 100, max: 250, step: 5, unit: 'mm', default: 160, show: is('feather') },
    { type: 'number', key: 'fbWidth', label: 'Breedte voet', min: 30, max: 120, step: 1, unit: 'mm', default: 60, show: is('feather') },
    { type: 'number', key: 'fbFinger', label: 'Lengte vingers', min: 25, max: 80, step: 1, unit: 'mm', default: 45, show: is('feather') },
    { type: 'number', key: 'fbAngle', label: 'Schuinte vingers', min: 15, max: 45, step: 1, unit: '°', default: 30, show: is('feather') },
    { type: 'number', key: 'fbFingerW', label: 'Dikte vinger', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4, show: is('feather') },
    { type: 'number', key: 'fbGap', label: 'Ruimte tussen vingers', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4, show: is('feather') },
    { type: 'number', key: 'fbThick', label: 'Hoogte', min: 8, max: 25, step: 1, unit: 'mm', default: 18, show: is('feather') },
    {
      type: 'select', key: 'fbMount', label: 'Bevestiging', default: 'tbolt', show: is('feather'),
      options: [
        { value: 'tbolt', label: 'Sleuven voor T-bouten (T-rail / T-sleuf)' },
        { value: 'clamp', label: 'Klemmen (dichte voet)' },
      ],
    },
    { type: 'number', key: 'fbSlot', label: 'Breedte sleuf', min: 5, max: 9, step: 0.1, unit: 'mm', default: 6.6, show: (p) => is('feather')(p) && str(p, 'fbMount') === 'tbolt', help: '6,6 mm voor M6 of 1/4".' },

    { type: 'group', label: 'Beitelhoekmeter', show: is('chisel') },
    { type: 'text', key: 'cgAngles', label: 'Hoeken', default: '20; 25; 30; 35', maxLength: 60, help: '10–60°, gescheiden door een puntkomma.', show: is('chisel') },
    { type: 'number', key: 'cgThick', label: 'Dikte', min: 2, max: 6, step: 0.5, unit: 'mm', default: 3, show: is('chisel') },

    { type: 'group', label: 'Piramides', show: is('pyramid') },
    {
      type: 'select', key: 'pyStyle', label: 'Vorm', default: 'pyramid3', show: is('pyramid'),
      options: [
        { value: 'pyramid3', label: 'Driezijdige piramide' },
        { value: 'pyramid4', label: 'Vierzijdige piramide' },
        { value: 'cone', label: 'Kegel' },
        { value: 'cookie', label: 'Werkstukklos (rond, TPU)' },
      ],
    },
    { type: 'number', key: 'pyBase', label: 'Breedte voet', min: 25, max: 90, step: 1, unit: 'mm', default: 50, show: is('pyramid') },
    { type: 'number', key: 'pyHeight', label: 'Hoogte', min: 12, max: 60, step: 1, unit: 'mm', default: 30, show: is('pyramid'), help: 'Werkstukklos: maximaal 30 mm.' },
    { type: 'number', key: 'pyQty', label: 'Aantal', min: 1, max: 16, step: 1, default: 4, show: is('pyramid') },
  ],
  presets: [
    { name: 'Zaagblad 15–45°', values: { kind: 'bevel', bvMode: 'tilt', bvAngles: '15; 22,5; 30; 45' } },
    { name: 'Hoekmal 30/45/60°', values: { kind: 'bevel', bvMode: 'edge', bvAngles: '30; 45; 60', bvEdge: 30 } },
    { name: 'Zwaluwstaart 1:6 / 1:8', values: { kind: 'dovetail', dtA: '6', dtB: '8' } },
    { name: 'Afschuinmal 1–6 mm', values: { kind: 'chamfer', chSizes: '1; 2; 3; 4; 5; 6' } },
    { name: 'Middelpuntzoeker Ø80', values: { kind: 'centerRound', crMax: 80 } },
    { name: 'Middenlijn plankkant', values: { kind: 'centerEdge', ceMax: 40 } },
    { name: 'Duwstok klassiek', values: { kind: 'pushStick', psStyle: 'classic', psLen: 300 } },
    { name: 'Duwschoen', values: { kind: 'pushStick', psStyle: 'shoe', psLen: 280, psThick: 18 } },
    { name: 'Duwblok met losse hak', values: { kind: 'pushBlock', pbHeel: 'screw', pbPad: true } },
    { name: 'Kantlijnmal 1–50 mm', values: { kind: 'scribe', scMax: 50, scStep: 1 } },
    { name: 'Instelblokjes 1–25 mm', values: { kind: 'setup' } },
    { name: 'Lijmhoeken 90° (4×)', values: { kind: 'square', sqAngle: 90, sqQty: 4 } },
    { name: 'Boorgeleider haaks', values: { kind: 'drill', dgAngle: 0, dgSizes: '3; 4; 5; 6; 8; 10' } },
    { name: 'Boorgeleider 15° schuin', values: { kind: 'drill', dgAngle: 15, dgSizes: '4; 6; 8', dgHeight: 35 } },
    { name: 'Deuvelmal Ø8 / 18 mm', values: { kind: 'dowel', dwD: '8', dwBoard: 18, dwHoles: 2, dwPitch: 32 } },
    { name: 'Gaatjesmal 32 mm', values: { kind: 'shelf' } },
    { name: 'Scharniermal Ø35', values: { kind: 'hinge', hgCup: '35', hgPattern: '45' } },
    { name: 'Veerbord', values: { kind: 'feather' } },
    { name: 'Beitelhoekmeter', values: { kind: 'chisel' } },
    { name: 'Schilderspiramides (4×)', values: { kind: 'pyramid', pyStyle: 'pyramid3', pyQty: 4 } },
  ],
  assets,
  build,
};
