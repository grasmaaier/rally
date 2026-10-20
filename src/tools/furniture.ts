import type { ManifoldToplevel, Vec3 } from 'manifold-3d';
import type { AssetRef, AssetStore, BuildOutput, Params, PartOut, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { usable } from '../core/printer';
import { type M4, TAU, asMat4, clamp, filletExtrude, mul, rotX, rotY, rotZ, rotateOnto, roundedRectPoints, translation } from '../geom/helpers';
import { SHAPE_OPTIONS, effectiveSpec, radialFromPolygons, shapeAssets, shapeOutline, shapeParams, shapeSpecFrom } from '../geom/shapes2d';
import { buildLeg, buildRing, legAssets, legDescription, legHardware, legMatrix, legParams, legSpecFrom, legTips, plateExtent, plateScrewLength } from '../geom/legs';
import { cabinetCorner, cornerCore, cornerForPrint, hubGeometry, plankGeometry, plankJoint, stickHub } from './joints';

const WOOD = ['#c9a57a', '#c29d70', '#cfae86', '#bf9a6c'];
const wood = (i: number) => WOOD[i % WOOD.length];

interface Board {
  name: string;
  l: number;
  w: number;
  t: number;
}

/** Group identical boards into a cut list. */
function cutList(boards: Board[]) {
  const map = new Map<string, { b: Board; n: number }>();
  for (const b of boards) {
    const key = `${b.name}|${b.l.toFixed(0)}|${b.w.toFixed(0)}|${b.t}`;
    const e = map.get(key);
    if (e) e.n++;
    else map.set(key, { b, n: 1 });
  }
  return [...map.values()];
}

/** Cut list as an info table (compact) with a full CSV for the timber yard. */
function cutTable(title: string, boards: Board[]) {
  const list = cutList(boards);
  const csv = [['Aantal', 'Onderdeel', 'Lengte (mm)', 'Breedte (mm)', 'Dikte (mm)'], ...list.map(({ b, n }) => [n, b.name, Math.round(b.l), Math.round(b.w), b.t])]
    .map((r) => r.join(';'))
    .join('\n');
  return {
    kind: 'table' as const,
    title,
    headers: ['#', 'Onderdeel', 'L × B × D (mm)'],
    rows: list.map(({ b, n }) => [n, b.name, `${Math.round(b.l)} × ${Math.round(b.w)} × ${b.t}`]),
    csv,
  };
}

function boardSummary(boards: Board[]) {
  const area = boards.reduce((s, b) => s + (b.l * b.w) / 1e6, 0);
  return `${boards.length} stuks · ${area.toFixed(2)} m²`;
}

// ---------------------------------------------------------------------------
// Open cabinet / bookcase from planks and 2D joints (L/T/X), front and back.

function shelving(M: ManifoldToplevel, p: Params, printer: PrinterProfile, assets: AssetStore): BuildOutput {
  const W = num(p, 'width');
  const H = num(p, 'height');
  const D = num(p, 'depth');
  const t = num(p, 'plankT');
  const rows = Math.round(num(p, 'rows'));
  const cols = Math.round(num(p, 'cols'));
  const l = num(p, 'connLen');
  const per = Number(str(p, 'perNode'));
  const jointBase = { t, clearance: num(p, 'clearance'), wall: num(p, 'wall'), depth: num(p, 'insert'), length: l, screws: Number(str(p, 'screws')), screwD: 4, rounding: 2 };
  const { half } = plankGeometry({ ...jointBase, angles: [0, 90] });
  const s = 2 * half;
  const sx = (W - s) / cols;
  const sz = (H - s) / rows;
  const lh = sx - s;
  const lv = sz - s;
  const minLen = 2 * jointBase.depth + 10;
  if (lh < minLen || lv < minLen) throw new UserError(`Vakken te klein: planken moeten minstens ${minLen} mm lang zijn. Maak de kast groter of gebruik minder vakken.`);
  if (D < per * l + 10) throw new UserError('De kast is niet diep genoeg voor zoveel verbinders per knoop.');

  const boards: Board[] = [];
  const scene: SceneItem[] = [];
  const xs = Array.from({ length: cols + 1 }, (_, i) => -W / 2 + s / 2 + i * sx);
  const zs = Array.from({ length: rows + 1 }, (_, j) => s / 2 + j * sz);
  let k = 0;
  for (const z of zs)
    for (let i = 0; i < cols; i++) {
      boards.push({ name: 'Legplank (horizontaal)', l: lh, w: D, t });
      scene.push({ kind: 'box', size: [lh, D, t], position: [xs[i] + s / 2, 0, z - t / 2], color: wood(k++), material: 'wood' });
    }
  for (const x of xs)
    for (let j = 0; j < rows; j++) {
      boards.push({ name: 'Staander (verticaal)', l: lv, w: D, t });
      scene.push({ kind: 'box', size: [t, D, lv], position: [x - t / 2, 0, zs[j] + s / 2], color: wood(k++), material: 'wood' });
    }

  // joints: L = {0, 90}, T = {0, 90, 180}, X = all; rotate to match each node
  const shapes: Record<string, number[]> = { L: [0, 90], T: [0, 90, 180], X: [0, 90, 180, 270] };
  const partIndex: Record<string, number> = {};
  const parts: PartOut[] = [];
  const yOffsets = per === 3 ? [l, (D + l) / 2, D] : [l, D];
  for (let i = 0; i <= cols; i++)
    for (let j = 0; j <= rows; j++) {
      const need = new Set<number>();
      if (i < cols) need.add(0);
      if (j < rows) need.add(90);
      if (i > 0) need.add(180);
      if (j > 0) need.add(270);
      const type = need.size === 4 ? 'X' : need.size === 3 ? 'T' : 'L';
      let rot = 0;
      for (const r of [0, 90, 180, 270]) {
        if (shapes[type].every((a) => need.has((a + r) % 360))) {
          rot = r;
          break;
        }
      }
      if (partIndex[type] === undefined) {
        partIndex[type] = parts.length;
        const names: Record<string, string> = { L: 'Hoekverbinder L', T: 'T-verbinder', X: 'Kruisverbinder X' };
        parts.push({ name: names[type], solid: plankJoint(M, { ...jointBase, angles: shapes[type] }), quantity: 0 });
      }
      const pi = partIndex[type];
      for (const y of yOffsets) {
        parts[pi].quantity = (parts[pi].quantity ?? 0) + 1;
        scene.push({ kind: 'part', part: pi, matrix: mul(translation(xs[i], y, zs[j]), mul(rotX(90), rotZ(rot))) });
      }
    }
  const cut = cutTable('Zaaglijst', boards);
  const out: BuildOutput = {
    parts,
    scene,
    defaultView: 'assembly',
    info: [
      cut,
      {
        kind: 'kv',
        title: 'Kast',
        rows: [
          ['Buitenmaat', `${W} × ${D} × ${H} mm`],
          ['Vakken', `${cols} × ${rows} (binnenmaat ${Math.round(lh)} × ${Math.round(lv)} mm)`],
          ['Hout', boardSummary(boards)],
          ['Printdelen', parts.map((q) => `${q.quantity}× ${q.name}`).join(', ')],
        ],
      },
    ],
    tips: [
      `Plankdikte ${t} mm: laat de bouwmarkt alles op maat zagen met de zaaglijst (CSV).`,
      'Bouw eerst het frame op de grond (voorkant naar beneden), schuif dan de achterste verbinders erop.',
      'Een dunne achterwand (3–6 mm hardboard/multiplex) erop schroeven maakt de kast flink stijver.',
    ],
  };
  const legs = str(p, 'cabLegs');
  if (legs !== 'none') {
    // under the bottom boards, between the front and back connectors
    const xr = Array.from({ length: cols }, (_, i) => [xs[i] + s / 2 + 1, xs[i + 1] - s / 2 - 1]);
    const yr = per === 3 ? [[l + 1, (D - l) / 2 - 1], [(D + l) / 2 + 1, D - l - 1]] : [[l + 1, D - l - 1]];
    const regions = xr.flatMap(([x0, x1]) => yr.map(([y0, y1]) => ({ x0, x1, y0, y1 })));
    const targets: [number, number][] = [[-W / 2, 0], [W / 2, 0], [-W / 2, D], [W / 2, D]];
    if (legs === '6') targets.push([0, 0], [0, D]);
    addCabinetLegs(M, p, printer, assets, out, { zUnder: s / 2 - t / 2, regions, targets, centre: [0, D / 2], boardT: t });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small cabinet from six panels, eight 3D corners and edge profiles.

function signMatrix(sx: number, sy: number, sz: number): M4 {
  const neg = [sx, sy, sz].filter((v) => v < 0).length;
  const diag = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
  // odd number of flips = mirror; the corner is symmetric in x↔y so swap first
  return neg % 2 === 0 ? diag : mul(diag, [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

const quadrant = (a: number, b: number) => (a > 0 && b > 0 ? 0 : a < 0 && b > 0 ? 90 : a < 0 && b < 0 ? 180 : 270);

function cabinetBox(M: ManifoldToplevel, p: Params, printer: PrinterProfile, assets: AssetStore): BuildOutput {
  const W = num(p, 'width');
  const H = num(p, 'height');
  const D = num(p, 'depth');
  const t = num(p, 'plankT');
  const co = { t, clearance: num(p, 'clearance'), wall: num(p, 'wall'), depth: num(p, 'insert'), arm: num(p, 'arm'), rounding: 2 };
  const s = cornerCore(co);
  const reach = s + co.arm;
  const lens = { x: W - 2 * reach, y: D - 2 * reach, z: H - 2 * reach };
  if (Math.min(lens.x, lens.y, lens.z) < 0) throw new UserError(`Te klein: elke maat moet minstens ${Math.ceil(2 * reach)} mm zijn (of maak de armen korter).`);
  const corner = cabinetCorner(M, co);
  const parts: PartOut[] = [{ name: 'Kasthoek 3D', solid: cornerForPrint(M, corner), quantity: 8 }];
  const scene: SceneItem[] = [];
  // the printed corner is rotated onto its tip; undo that rotation to place it
  const k = 1 / Math.sqrt(3);
  const fromPrint = rotateOnto([0, 0, 1], [k, k, k]);
  const bx = (sign: number, size: number) => (sign > 0 ? 0 : size);
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      for (const sz of [1, -1]) {
        const at = translation(bx(sx, W) - W / 2, bx(sy, D), bx(sz, H));
        scene.push({ kind: 'part', part: 0, matrix: mul(at, mul(signMatrix(sx, sy, sz), fromPrint)) });
      }

  // edge profiles: same L-section as the corner arms, laid diagonally for printing
  const tc = t + co.clearance;
  const w = co.wall;
  const section = M.CrossSection.union([M.CrossSection.square([s, s + co.depth]), M.CrossSection.square([s + co.depth, s])])
    .offset(-2, 'Round')
    .offset(2, 'Round')
    .subtract(M.CrossSection.union([M.CrossSection.square([tc, co.depth + 1]).translate([w, s]), M.CrossSection.square([co.depth + 1, tc]).translate([s, w])]));
  const maxLen = usable(printer).x - 4;
  const edges = str(p, 'edges');
  const clipLen = 30;
  // each entry: part index and the start positions (along the edge) of its copies
  const stripParts: Record<'x' | 'y' | 'z', { idx: number; starts: number[]; len: number } | null> = { x: null, y: null, z: null };
  // print orientation: extrusion along X, the L-section's diagonal pointing up
  const sectionToPrint = mul(rotX(135), rotY(90));
  const makeStrip = (len: number) => {
    const printed = filletExtrude(M, section, len, 0.6, 0.6).transform(asMat4(sectionToPrint));
    return printed.trimByPlane([0, 0, 1], printed.boundingBox().min[2] + 3);
  };
  let clipIdx = -1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const total = lens[axis];
    if (total < 1 || edges === 'none') continue;
    if (edges === 'clips') {
      if (total < clipLen + 10) continue;
      if (clipIdx < 0) {
        clipIdx = parts.length;
        parts.push({ name: `Randclip (${clipLen} mm)`, solid: makeStrip(clipLen), quantity: 0 });
      }
      const n = Math.max(1, Math.round(total / 180));
      const starts = Array.from({ length: n }, (_, i) => reach + ((i + 0.5) * total) / n - clipLen / 2);
      parts[clipIdx].quantity = (parts[clipIdx].quantity ?? 0) + 4 * n;
      stripParts[axis] = { idx: clipIdx, starts, len: clipLen };
    } else {
      const n = Math.ceil(total / maxLen);
      const len = total / n;
      stripParts[axis] = { idx: parts.length, starts: Array.from({ length: n }, (_, i) => reach + i * len), len };
      parts.push({ name: `Randprofiel ${axis.toUpperCase()} (${Math.round(len)} mm)`, solid: makeStrip(len), quantity: 4 * n });
    }
  }
  const toX: M4 = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const toY: M4 = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const unprint = mul(rotY(-90), rotX(-135));
  for (const axis of ['x', 'y', 'z'] as const) {
    const sp = stripParts[axis];
    if (!sp) continue;
    for (const a of [1, -1])
      for (const b of [1, -1])
        for (const start of sp.starts) {
          let m: M4;
          if (axis === 'z') m = mul(translation(bx(a, W) - W / 2, bx(b, D), start), rotZ(quadrant(a, b)));
          else if (axis === 'x') m = mul(translation(start - W / 2, bx(a, D), bx(b, H)), mul(rotX(quadrant(a, b)), toX));
          else m = mul(translation(bx(b, W) - W / 2, start, bx(a, H)), mul(rotY(quadrant(a, b)), toY));
          scene.push({ kind: 'part', part: sp.idx, matrix: mul(m, unprint) });
        }
  }
  // panels sit in the slots, `wall` in from each outer face
  const boards: Board[] = [];
  const open = bool(p, 'openFront');
  const pw = W - 2 * s;
  const pd = D - 2 * s;
  const ph = H - 2 * s;
  const panel = (name: string, l: number, wd: number, size: Vec3, pos: Vec3, i: number) => {
    boards.push({ name, l, w: wd, t });
    scene.push({ kind: 'box', size, position: pos, color: wood(i), material: 'wood' });
  };
  const x0 = -W / 2;
  panel('Zijpaneel', ph, pd, [t, pd, ph], [x0 + w, s, s], 0);
  panel('Zijpaneel', ph, pd, [t, pd, ph], [x0 + W - w - t, s, s], 1);
  panel('Boven/onder', pw, pd, [pw, pd, t], [x0 + s, s, w], 2);
  panel('Boven/onder', pw, pd, [pw, pd, t], [x0 + s, s, H - w - t], 3);
  panel('Achterwand', pw, ph, [pw, t, ph], [x0 + s, D - w - t, s], 0);
  if (!open) panel('Voorpaneel', pw, ph, [pw, t, ph], [x0 + s, w, s], 1);
  const cut = cutTable('Zaaglijst', boards);
  const out: BuildOutput = {
    parts,
    scene,
    defaultView: 'assembly',
    info: [
      cut,
      {
        kind: 'kv',
        title: 'Kastje',
        rows: [
          ['Buitenmaat', `${W} × ${D} × ${H} mm`],
          ['Panelen', boardSummary(boards)],
          ['Printdelen', parts.map((q) => `${q.quantity}× ${q.name}`).join(', ')],
        ],
      },
    ],
    tips: [
      edges === 'none' ? 'Alleen hoeken: lijm de panelen in de sleuven voor een stevig kastje.' : 'Schuif eerst de randclips/-profielen op de panelen, klik daarna de hoeken erop.',
      'De hoeken staan op hun punt geprint (geen support): gebruik een brim. Randprofielen liggen diagonaal.',
      open ? 'Open voorkant: ideaal als nachtkastje of opbergvak. Een deurtje kun je met kleine scharnieren aan een zijpaneel zetten.' : 'Gesloten doos: handig als opbergkist. Maak de voorkant open voor een kastje.',
    ],
  };
  const legs = str(p, 'cabLegs');
  if (legs !== 'none') {
    // the bottom panel lies `wall` above the underside; keep clear of the corners and edge profiles
    const k = s + co.depth + 1;
    const regions = [{ x0: -W / 2 + k, x1: W / 2 - k, y0: k, y1: D - k }];
    const targets: [number, number][] = [[-W / 2, 0], [W / 2, 0], [-W / 2, D], [W / 2, D]];
    if (legs === '6') targets.push([0, 0], [0, D]);
    addCabinetLegs(M, p, printer, assets, out, { zUnder: w, regions, targets, centre: [0, D / 2], boardT: t });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table / bench / stool: square timber legs and rails, printed corner hubs.

function table(M: ManifoldToplevel, p: Params): BuildOutput {
  const L = num(p, 'width');
  const B = num(p, 'depth');
  const H = num(p, 'height');
  const a = num(p, 'stick');
  const topT = num(p, 'topT');
  const pw = num(p, 'plankW');
  const gap = num(p, 'gap');
  const over = num(p, 'overhang');
  const shelf = bool(p, 'shelf');
  const hubBase = { profile: 'square' as const, size: a, clearance: num(p, 'clearance'), wall: num(p, 'wall'), depth: num(p, 'insert'), screwD: 3.5, teardrop: false };
  const topDirs: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, -1]];
  const lowDirs: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
  const g = hubGeometry({ ...hubBase, dirs: topDirs });
  const ro = g.ro;
  const r0 = g.r0;
  const xl = L / 2 - over - ro;
  const yl = B / 2 - over - ro;
  const zc = H - topT - a / 2;
  const zl = num(p, 'shelfH');
  if (xl < ro + r0 + 20 || yl < ro + r0 + 20) throw new UserError('Te smal voor deze latdikte en overstek.');
  const legTop = zc - r0;
  if (legTop < 50) throw new UserError('Te laag voor deze latdikte.');
  if (shelf && (zl < r0 + a + 10 || zl > zc - 2 * r0 - 40)) throw new UserError('Onderplank zit te hoog of te laag.');

  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  parts.push({ name: 'Hoekstuk boven', solid: stickHub(M, { ...hubBase, dirs: topDirs, trimTop: a / 2 }), quantity: 4 });
  if (shelf) parts.push({ name: 'Hoekstuk onderplank', solid: stickHub(M, { ...hubBase, dirs: lowDirs, gussets: true }), quantity: 4 });
  const boards: Board[] = [];
  const corners: [number, number, number][] = [[-1, -1, 0], [1, -1, 90], [1, 1, 180], [-1, 1, 270]];
  let k = 0;
  const lat = (name: string, l: number, size: Vec3, pos: Vec3) => {
    boards.push({ name, l, w: a, t: a });
    scene.push({ kind: 'box', size, position: pos, color: wood(k++), material: 'wood' });
  };
  for (const [sx, sy, rot] of corners) {
    const x = sx * xl;
    const y = sy * yl;
    scene.push({ kind: 'part', part: 0, matrix: mul(translation(x, y, zc), rotZ(rot)) });
    if (shelf) {
      scene.push({ kind: 'part', part: 1, matrix: mul(translation(x, y, zl), rotZ(rot)) });
      lat('Poot onder', zl - r0, [a, a, zl - r0], [x - a / 2, y - a / 2, 0]);
      lat('Poot boven', legTop - zl - r0, [a, a, legTop - zl - r0], [x - a / 2, y - a / 2, zl + r0]);
    } else {
      lat('Poot', legTop, [a, a, legTop], [x - a / 2, y - a / 2, 0]);
    }
  }
  const levels = shelf ? [zc, zl] : [zc];
  for (const z of levels) {
    const tag = z === zc ? '' : ' onder';
    for (const sy of [-1, 1]) lat(`Regel lang${tag}`, 2 * xl - 2 * r0, [2 * xl - 2 * r0, a, a], [-xl + r0, sy * yl - a / 2, z - a / 2]);
    for (const sx of [-1, 1]) lat(`Regel kort${tag}`, 2 * yl - 2 * r0, [a, 2 * yl - 2 * r0, a], [sx * xl - a / 2, -yl + r0, z - a / 2]);
  }
  // top planks along the length
  const n = Math.max(1, Math.round((B + gap) / (pw + gap)));
  const w = (B - (n - 1) * gap) / n;
  const planks: Board[] = [];
  for (let i = 0; i < n; i++) {
    planks.push({ name: 'Bladplank', l: L, w, t: topT });
    scene.push({ kind: 'box', size: [L, w, topT], position: [-L / 2, -B / 2 + i * (w + gap), H - topT], color: wood(i + 1), material: 'wood' });
  }
  if (shelf) {
    // shelf planks run front-to-back on the long rails, between the hub sleeves
    const span = 2 * (xl - r0 - hubBase.depth - 2);
    const m = Math.max(1, Math.floor((span + gap) / (pw + gap)));
    const sw = Math.min(pw, (span - (m - 1) * gap) / m);
    const sl = 2 * yl + a;
    const startX = -((m * sw + (m - 1) * gap) / 2);
    for (let i = 0; i < m; i++) {
      planks.push({ name: 'Onderplank', l: sl, w: sw, t: topT });
      scene.push({ kind: 'box', size: [sw, sl, topT], position: [startX + i * (sw + gap), -sl / 2, zl + a / 2], color: wood(i + 2), material: 'wood' });
    }
  }
  const cut = cutTable('Zaaglijst', [...boards, ...planks]);
  const latTotal = boards.reduce((s, b) => s + b.l, 0) / 1000;
  return {
    parts,
    scene,
    defaultView: 'assembly',
    info: [
      cut,
      {
        kind: 'kv',
        title: 'Meubel',
        rows: [
          ['Buitenmaat', `${L} × ${B} × ${H} mm`],
          ['Latten', `${a} × ${a} mm, totaal ${latTotal.toFixed(2)} m`],
          ['Blad', `${n} planken van ${w.toFixed(0)} mm breed${Math.abs(w - pw) > 0.5 ? ` (op breedte zagen vanuit ${pw} mm)` : ''}`],
          ['Printdelen', parts.map((q) => `${q.quantity}× ${q.name}`).join(', ')],
        ],
      },
    ],
    tips: [
      'De bovenste hoekstukken zijn vlak aan de bovenkant: de regels vallen er van bovenaf in en het blad ligt overal op.',
      'Zet poten en regels vast met een schroef (Ø3.5) door het borggat; schroef het blad van bovenaf op de regels.',
      shelf ? 'De onderste hoekstukken hebben schuine steunen zodat ze zonder support printen.' : 'Voeg een onderplank toe voor extra stevigheid en opbergruimte.',
      'Gebruik PETG of PLA+ met 4 wanden en 30–40% infill voor dragende hoekstukken.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Printed legs: shared helpers for risers, loose legs and cabinets on legs.

type Pt = [number, number];

function segDist2(px: number, py: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const h = l2 > 0 ? Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - a[0] - dx * h, py - a[1] - dy * h);
}

function insidePoly(poly: Pt[], x: number, y: number) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Signed distance to the outline (positive inside). */
function edgeDist(poly: Pt[], x: number, y: number) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist2(x, y, poly[i], poly[(i + 1) % poly.length]));
  return insidePoly(poly, x, y) ? d : -d;
}

/** Sorted x intervals where a horizontal line at y crosses into the outline. */
function scan(poly: Pt[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 0.5) out.push([xs[i], xs[i + 1]]);
  return out;
}

/**
 * A shaped board for the assembled view. Scene boxes cannot be round, so the
 * outline is built from thin strips (finer where the edge turns quickly).
 */
function shapedBoard(poly: Pt[], t: number, z: number, color: string, label: string, cx = 0, cy = 0): SceneItem[] {
  const ys = poly.map((q) => q[1]);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const items: SceneItem[] = [];
  const close = (a: [number, number][], b: [number, number][]) => a.length === b.length && a.every((v, i) => Math.abs(v[0] - b[i][0]) < 2.5 && Math.abs(v[1] - b[i][1]) < 2.5);
  const band = (a: number, b: number, depth: number) => {
    const lo = scan(poly, a + 0.01);
    const hi = scan(poly, b - 0.01);
    if (depth < 6 && b - a > 1.2 && !close(lo, hi)) {
      const m = (a + b) / 2;
      band(a, m, depth + 1);
      band(m, b, depth + 1);
      return;
    }
    for (const [xa, xb] of scan(poly, (a + b) / 2)) items.push({ kind: 'box', size: [xb - xa, b - a, t], position: [cx + xa, cy + a, z], color, material: 'wood', label });
  };
  const n = Math.max(1, Math.ceil((y1 - y0) / 8));
  for (let i = 0; i < n; i++) band(y0 + ((y1 - y0) * i) / n, y0 + ((y1 - y0) * (i + 1)) / n, 0);
  return items;
}

interface BoardShape {
  poly: Pt[];
  /** rect or rounded rect (legs go in the corners) */
  boxy: boolean;
  round: boolean;
  /** e.g. "Rond plankje Ø300" */
  name: string;
  size: string;
  how: string;
  w: number;
  d: number;
}

const BOARD_FORMS = [
  { value: 'rect', label: 'Rechthoek' },
  { value: 'rounded', label: 'Afgeronde rechthoek' },
  { value: 'circle', label: 'Rond' },
  { value: 'oval', label: 'Ovaal' },
  { value: 'shape', label: 'Ontwerpvorm (wolk, bloem, blob …)' },
];
const BOARD_DESIGNS = ['squircle', 'cloud', 'petals', 'flower', 'blob', 'scallop', 'clover', 'gear', 'star', 'polygon', 'heart', 'leaf', 'drop', 'superformula'];

function boardShape(p: Params, form: string, W: number, D: number, dia: number, assets: AssetStore): BoardShape {
  const ring = (rx: number, ry: number, n = 180): Pt[] => Array.from({ length: n }, (_, i) => [rx * Math.cos((TAU * i) / n), ry * Math.sin((TAU * i) / n)] as Pt);
  if (form === 'circle')
    return { poly: ring(dia / 2, dia / 2), boxy: false, round: true, name: 'Rond plankje', size: `Ø${Math.round(dia)}`, how: 'Laten zagen, of een ronde snijplank / tafelblad gebruiken', w: dia, d: dia };
  if (form === 'oval')
    return { poly: ring(W / 2, D / 2), boxy: false, round: false, name: 'Ovaal plankje', size: `${Math.round(W)} × ${Math.round(D)}`, how: 'Met een decoupeerzaag uitzagen (teken de ovaal met een touwtje en twee spijkers)', w: W, d: D };
  if (form === 'rounded') {
    const r = Math.min(num(p, 'boardRadius'), Math.min(W, D) / 2 - 1);
    return { poly: roundedRectPoints(W, D, r, 12) as Pt[], boxy: true, round: false, name: 'Plank met ronde hoeken', size: `${Math.round(W)} × ${Math.round(D)}`, how: `Op maat laten zagen, hoeken afronden met R${Math.round(r)} (decoupeerzaag + schuurpapier)`, w: W, d: D };
  }
  if (form === 'shape') {
    const spec = effectiveSpec(shapeSpecFrom(p, 'board'));
    const pts = shapeOutline(spec, 240, assets);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const bx = [Math.min(...xs), Math.max(...xs)];
    const by = [Math.min(...ys), Math.max(...ys)];
    const sx = W / (bx[1] - bx[0]);
    const sy = D / (by[1] - by[0]);
    const ox = (bx[0] + bx[1]) / 2;
    const oy = (by[0] + by[1]) / 2;
    const label = (SHAPE_OPTIONS.find((o) => o.value === spec.shape)?.label ?? 'eigen vorm').replace(/\s*\(.*\)/, '').toLowerCase();
    return {
      poly: pts.map(([x, y]) => [(x - ox) * sx, (y - oy) * sy] as Pt),
      boxy: false,
      round: false,
      name: `Plankje in vorm (${spec.shape === 'custom' ? 'eigen vorm' : label})`,
      size: `${Math.round(W)} × ${Math.round(D)}`,
      how: 'Contour overtekenen (bijv. van een print op ware grootte) en uitzagen met een decoupeerzaag',
      w: W,
      d: D,
    };
  }
  return { poly: roundedRectPoints(W, D, 0) as Pt[], boxy: true, round: false, name: 'Plank', size: `${Math.round(W)} × ${Math.round(D)}`, how: 'Op maat laten zagen in de bouwmarkt', w: W, d: D };
}

/** Scale a board shape around its centre. */
function scaledShape(b: BoardShape, k: number): BoardShape {
  const fmt = b.round ? `Ø${Math.round(b.w * k)}` : `${Math.round(b.w * k)} × ${Math.round(b.d * k)}`;
  return { ...b, poly: b.poly.map(([x, y]) => [x * k, y * k] as Pt), w: b.w * k, d: b.d * k, size: fmt };
}

/**
 * Leg positions on a board: `dist` is the clearance from the leg axis to the
 * edge. Boxy boards get legs in the corners (plus extras along the sides),
 * other shapes evenly around, pulled inward until they are clear of the edge.
 */
function legLayout(b: BoardShape, n: number, dist: number, minSpacing: number, turn = 0): Pt[] {
  let pts: Pt[];
  if (b.boxy) {
    const X = b.w / 2 - dist;
    const Y = b.d / 2 - dist;
    if (X < 0 || Y < 0) throw new UserError('Het plankje is te klein voor deze poten: maak het groter, de poten dunner of de afstand tot de rand kleiner.');
    const corners: Pt[] = [[-X, -Y], [X, -Y], [X, Y], [-X, Y]];
    const along = b.w >= b.d;
    const side = (f: number, s: number): Pt => (along ? [f * X, s * Y] : [s * X, f * Y]);
    if (n === 3) pts = along ? [[-X, -Y], [X, -Y], [0, Y]] : [[-X, -Y], [-X, Y], [X, 0]];
    else if (n === 4) pts = corners;
    else if (n === 5) pts = [...corners, [0, 0]];
    else if (n === 6) pts = [...corners, side(0, -1), side(0, 1)];
    else if (n === 7) pts = [...corners, side(0, -1), side(0, 1), [0, 0]];
    else pts = [...corners, side(-1 / 3, -1), side(1 / 3, -1), side(-1 / 3, 1), side(1 / 3, 1)];
  } else {
    const rad = radialFromPolygons([b.poly]);
    // symmetric default; turn the pattern when that puts the legs much further out (lobes of a flower, a star)
    const reach = (s: number) => Math.min(...Array.from({ length: n }, (_, k) => rad(s + (TAU * k) / n)));
    const start0 = (n % 2 === 1 ? Math.PI / 2 : Math.PI / n) + turn;
    let start = start0;
    const def = reach(start0);
    let best = def;
    for (let i = 1; i < 48; i++) {
      const s = start0 + (TAU * i) / n / 48;
      const r = reach(s);
      if (r > best + 0.5 && r > def * 1.06) {
        best = r;
        start = s;
      }
    }
    pts = Array.from({ length: n }, (_, k) => {
      const th = start + (TAU * k) / n;
      const r = rad(th) - dist;
      return [r * Math.cos(th), r * Math.sin(th)] as Pt;
    });
  }
  // pull each leg toward the centre until it is clear of the edge everywhere
  pts = pts.map(([x, y]) => {
    const r = Math.hypot(x, y);
    if (r < 1e-6) return [x, y] as Pt;
    for (let f = 1; f > 0; f -= 0.01) if (edgeDist(b.poly, x * f, y * f) >= dist) return [x * f, y * f] as Pt;
    throw new UserError('Het plankje is te klein of te grillig voor deze poten: maak het groter of de poten dunner.');
  });
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < minSpacing)
        throw new UserError('De poten komen te dicht bij elkaar: kies minder poten, een groter plankje of dunnere poten.');
  return pts;
}

const ANGLE = (x: number, y: number) => (Math.hypot(x, y) < 1e-6 ? 0 : (Math.atan2(y, x) * 180) / Math.PI);

function checkHeight(h: number, printer: PrinterProfile, what: string) {
  const z = usable(printer).z;
  if (h > z) throw new UserError(`${what} van ${Math.round(h)} mm is te hoog voor de printer (max. ${z} mm).`);
}

function screwLen(max: number, lens = [10, 12, 16, 20, 25, 30, 35, 40, 45, 50]) {
  return lens.filter((l) => l <= max).pop() ?? lens[0];
}

function hardwareTable(rows: [number, string, string][]) {
  return { kind: 'table' as const, title: 'Schroeven en extra’s', headers: ['#', 'Wat', 'Waarvoor'], rows: rows.map((r) => [r[0], r[1], r[2]]) };
}

// ---------------------------------------------------------------------------
// Riser / plank stand: a board on printed legs (or a ring), optionally tiered.

function riser(M: ManifoldToplevel, p: Params, printer: PrinterProfile, assets: AssetStore): BuildOutput {
  const form = str(p, 'boardForm');
  const t = num(p, 'plankT');
  const top = num(p, 'riserH');
  const legH = top - t;
  const tiers = Math.round(num(p, 'tiers'));
  const k = num(p, 'tierScale') / 100;
  const gap = num(p, 'tierGap');
  const inset = num(p, 'legInset');
  const warnings: string[] = [];
  let support = str(p, 'riserSupport');
  if (support === 'ring' && form !== 'circle') {
    support = 'legs';
    warnings.push('Een ring kan alleen onder een rond plankje: er worden poten gebruikt.');
  }
  const base = boardShape(p, form, num(p, 'width'), num(p, 'depth'), num(p, 'boardDia'), assets);
  const boards = Array.from({ length: tiers }, (_, i) => (i === 0 ? base : scaledShape(base, Math.pow(k, i))));
  if (legH < 10) throw new UserError('De verhoging is lager dan de plank dik is: maak hem hoger.');

  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  const hardware: [number, string, string][] = [];
  const tips: string[] = [];
  const printed: [number, string][] = [];
  // board heights (underside)
  const zb = boards.map((_, i) => legH + i * (t + gap));
  // what is screwed under the bottom board (column screws from below must stay clear of it)
  let blocked: (x: number, y: number) => boolean = () => false;

  if (support === 'ring') {
    checkHeight(legH, printer, 'Een ring');
    const R = base.w / 2 - inset;
    const ring = buildRing(M, { radius: R, height: legH, wall: clamp(2.4 + legH / 40, 3.2, 6), pattern: str(p, 'ringPattern'), bed: usable(printer) });
    warnings.push(...ring.warnings);
    const idx = parts.length;
    const name = ring.segments === 1 ? 'Ring' : `Ringsegment (${Math.round(ring.angle)}°)`;
    parts.push({ name, solid: ring.solid, quantity: ring.segments });
    for (let i = 0; i < ring.segments; i++) scene.push({ kind: 'part', part: idx, matrix: mul(translation(0, 0, legH), mul(rotZ(90 + i * ring.angle), rotX(180))) });
    printed.push([ring.segments, name]);
    blocked = (x, y) => Math.abs(Math.hypot(x, y) - ring.holeRadius) < 12;
    hardware.push([ring.segments * ring.holesPerSegment, `Verzonken houtschroef 4 × ${screwLen(4 + t - 3)} mm`, 'ring onder de plank']);
    tips.push(
      ring.segments > 1
        ? `De ring bestaat uit ${ring.segments} segmenten met zwaluwstaarten: schuif ze van bovenaf in elkaar. Leg de plank omgekeerd neer, zet de ring erop en schroef hem door de flens vast.`
        : 'Leg de plank omgekeerd neer, zet de ring erop en schroef hem door de flens vast.',
      'Print de ring met de flens op het bed: zo is er nergens support nodig.',
    );
  } else {
    checkHeight(legH, printer, 'Een poot');
    const leg = buildLeg(M, legSpecFrom(p, legH), assets);
    warnings.push(...leg.warnings);
    const choice = str(p, 'legCount');
    const n = choice === 'auto' ? (base.boxy ? 4 : 3) : Number(choice);
    const pts = legLayout(base, n, inset + leg.plateR, 2 * leg.plateR + 4);
    const idx = parts.length;
    parts.push({ name: 'Poot', solid: leg.solid, quantity: n });
    const radial = !base.boxy || leg.spec.splay > 0;
    for (const [x, y] of pts) scene.push({ kind: 'part', part: idx, matrix: legMatrix(leg, x, y, legH, radial ? ANGLE(x, y) : 0) });
    printed.push([n, `Poot (${legDescription(leg)})`]);
    hardware.push(...legHardware(leg, n, t));
    blocked = (x, y) => pts.some(([lx, ly]) => Math.hypot(x - lx, y - ly) < leg.plateR + 6);
    tips.push('Leg de plank omgekeerd op een handdoek, zet de poten erop en schroef ze vast.', ...legTips(leg));
  }

  // columns between the tiers, screwed under the upper board and from below into the lower one
  if (tiers > 1) {
    checkHeight(gap, printer, 'Een zuil');
    const col = buildLeg(M, legSpecFrom(p, gap, { bottom: 'screw', splay: 0 }), assets);
    warnings.push(...col.warnings.filter((w) => !warnings.includes(w)));
    const nc = base.boxy ? 4 : 3;
    const idx = parts.length;
    parts.push({ name: 'Zuil etagère', solid: col.solid, quantity: nc * (tiers - 1) });
    for (let i = 1; i < tiers; i++) {
      // turned half a step against the legs below; moved inward when they would still land on the legs or ring
      const dist = Math.max(inset, 10) + col.plateR;
      const turn = base.boxy ? 0 : Math.PI / nc;
      let pts = legLayout(boards[i], nc, dist, 2 * col.plateR + 4, turn);
      for (let extra = 5; i === 1 && pts.some(([x, y]) => blocked(x, y)) && extra <= 300; extra += 5) {
        try {
          pts = legLayout(boards[i], nc, dist + extra, 2 * col.plateR + 4, turn);
        } catch {
          break;
        }
      }
      for (const [x, y] of pts) {
        // the foot must stand on the board below
        if (edgeDist(boards[i - 1].poly, x, y) < col.footR + 2) throw new UserError('De bovenste laag is te groot voor de laag eronder: maak "Grootte volgende laag" kleiner.');
        if (i === 1 && blocked(x, y)) throw new UserError('De zuilen komen precies boven het onderstel: daar kun je ze van onderen niet vastschroeven. Maak "Grootte volgende laag" kleiner of groter.');
        scene.push({ kind: 'part', part: idx, matrix: legMatrix(col, x, y, zb[i], base.boxy ? 0 : ANGLE(x, y)) });
      }
    }
    printed.push([nc * (tiers - 1), `Zuil (${legDescription(col)})`]);
    hardware.push([nc * (tiers - 1) * col.holes.length, `Verzonken houtschroef 4 × ${plateScrewLength(col, t)} mm`, 'zuil onder de bovenste plank']);
    hardware.push([nc * (tiers - 1), `Verzonken houtschroef 3,5 × ${screwLen(t + 24, [25, 30, 35, 40, 45, 50])} mm`, 'van onderen door de plank in de voet van de zuil']);
    if (col.core) hardware.push([nc * (tiers - 1), `${col.core.label} ${col.core.rod} mm`, 'in de kern van de zuil']);
    tips.push('Etagère: schroef eerst de zuilen onder de bovenste plank, zet het geheel op de onderste plank en schroef van onderen door de plank in de voet van elke zuil (voorboren Ø3).');
  }

  // boards and a ghost table top under it all
  const cut: (string | number)[][] = [];
  boards.forEach((b, i) => {
    const name = tiers > 1 ? `${b.name} (laag ${i + 1})` : b.name;
    if (b.boxy && str(p, 'boardForm') === 'rect') scene.push({ kind: 'box', size: [b.w, b.d, t], position: [-b.w / 2, -b.d / 2, zb[i]], color: wood(i), material: 'wood', label: name });
    else scene.push(...shapedBoard(b.poly, t, zb[i], wood(i), name));
    cut.push([1, name, `${b.size} × ${t}`, b.how]);
  });
  const span = Math.max(base.w, base.d) + 240;
  scene.push({ kind: 'box', size: [span, span * 0.7, 20], position: [-span / 2, -span * 0.35, -20], color: '#8a8f98', material: 'ghost', label: 'tafel' });

  const csv = [['Aantal', 'Onderdeel', 'Maat (mm)', 'Hoe'], ...cut].map((r) => r.join(';')).join('\n');
  const totalH = zb[tiers - 1] + t;
  tips.push(
    `Plankdikte ${t} mm: massief hout, multiplex of een stevige snijplank werkt prima. Olie of lak het hout als er brood of fruit op komt.`,
    'Zet de verhoging op viltjes of anti-slipdopjes, dan krast hij niet op de tafel.',
  );
  return {
    parts,
    scene,
    defaultView: 'assembly',
    warnings,
    info: [
      { kind: 'table', title: 'Zaaglijst', headers: ['#', 'Plank', 'Maat (mm)', 'Hoe'], rows: cut, csv },
      { kind: 'table', title: 'Printdelen', headers: ['#', 'Onderdeel'], rows: printed },
      hardwareTable(hardware),
      {
        kind: 'kv',
        title: 'Verhoging',
        rows: [
          ['Hoogte bovenkant', tiers > 1 ? `${Math.round(top)} mm (bovenste laag ${Math.round(totalH)} mm)` : `${Math.round(top)} mm`],
          ['Onderstel', support === 'ring' ? 'Geprinte ring' : `${printed[0][0]} poten`],
          ['Lagen', String(tiers)],
        ],
      },
    ],
    tips,
  };
}

// ---------------------------------------------------------------------------
// Loose furniture legs

function looseLegs(M: ManifoldToplevel, p: Params, printer: PrinterProfile, assets: AssetStore): BuildOutput {
  const h = num(p, 'legH');
  checkHeight(h, printer, 'Een poot');
  const n = Math.round(num(p, 'legQty'));
  const leg = buildLeg(M, legSpecFrom(p, h), assets);
  const parts: PartOut[] = [{ name: 'Poot', solid: leg.solid, quantity: n }];
  // assembled view: the legs under an example board, in a grid of two rows
  const pitch = 2 * leg.plateR + 40;
  const cols = n <= 2 ? n : Math.ceil(n / 2);
  const rows = n <= 2 ? 1 : 2;
  const scene: SceneItem[] = [];
  const W = cols * pitch;
  const D = rows * pitch;
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = -W / 2 + pitch / 2 + c * pitch;
    const y = -D / 2 + pitch / 2 + r * pitch;
    scene.push({ kind: 'part', part: 0, matrix: legMatrix(leg, x, y, h, leg.spec.splay > 0 ? ANGLE(x, y) : 0) });
  }
  scene.push({ kind: 'box', size: [W, D, 18], position: [-W / 2, -D / 2, h], color: wood(0), material: 'wood', label: 'je meubel (voorbeeld)' });
  return {
    parts,
    scene,
    defaultView: 'assembly',
    warnings: leg.warnings,
    info: [
      {
        kind: 'kv',
        title: 'Poten',
        rows: [
          ['Poot', legDescription(leg)],
          ['Montageplaat', `${leg.plateLabel}, ${leg.spec.plateT} mm dik, ${leg.holes.length} verzonken gaten`],
          ['Onderkant', leg.feltD > 0 ? `uitsparing voor viltje Ø${leg.feltD} mm` : leg.spec.bottom === 'level' ? 'M8-moer voor een stelvoet' : 'vlak'],
          ['Versterking', leg.core ? `${leg.core.label} ${leg.core.rod} mm` : 'geen'],
        ],
      },
      hardwareTable(legHardware(leg, n, 18)),
    ],
    tips: [...legTips(leg), 'De schroeflengte in de lijst geldt voor 18 mm hout: kies kortere schroeven voor dunner materiaal.'],
  };
}

// ---------------------------------------------------------------------------
// Legs under a cabinet or bookcase

interface Region {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Put printed legs under a cabinet. `zUnder` is the height of the underside
 * of the bottom board in the cabinet frame, `regions` the areas of that
 * underside that are free (no corners, clips or connectors), `targets`
 * where the legs would ideally go. Raises the whole scene by the leg height.
 */
function addCabinetLegs(M: ManifoldToplevel, p: Params, printer: PrinterProfile, assets: AssetStore, out: BuildOutput, o: { zUnder: number; regions: Region[]; targets: Pt[]; centre: Pt; boardT: number }) {
  const h = num(p, 'legH');
  const leg = buildLeg(M, legSpecFrom(p, h + o.zUnder), assets);
  checkHeight(leg.spec.height, printer, 'Een poot');
  const idx = out.parts.length;
  out.parts.push({ name: 'Meubelpoot', solid: leg.solid, quantity: o.targets.length });
  const placed: SceneItem[] = [];
  for (const [tx, ty] of o.targets) {
    const alpha = leg.spec.splay > 0 ? ANGLE(tx - o.centre[0], ty - o.centre[1]) : 0;
    const e = plateExtent(leg, alpha);
    let best: { x: number; y: number; d: number } | null = null;
    for (const r of o.regions) {
      const lx = r.x0 - e.minX;
      const hx = r.x1 - e.maxX;
      const ly = r.y0 - e.minY;
      const hy = r.y1 - e.maxY;
      if (lx > hx || ly > hy) continue;
      const x = clamp(tx, lx, hx);
      const y = clamp(ty, ly, hy);
      const d = Math.hypot(x - tx, y - ty);
      if (!best || d < best.d) best = { x, y, d };
    }
    if (!best) throw new UserError('Er is onder de kast geen plek voor deze poten: kies een kleinere montageplaat of dunnere poten.');
    placed.push({ kind: 'part', part: idx, matrix: legMatrix(leg, best.x, best.y, o.zUnder, alpha) });
  }
  out.scene = [...(out.scene ?? []), ...placed].map((s) =>
    s.kind === 'part' ? { ...s, matrix: mul(translation(0, 0, h), s.matrix) } : s.kind === 'mesh' ? s : { ...s, position: [s.position[0], s.position[1], s.position[2] + h] as [number, number, number] },
  );
  out.warnings = [...(out.warnings ?? []), ...leg.warnings];
  const kv = out.info?.find((b) => b.kind === 'kv');
  if (kv && kv.kind === 'kv') kv.rows.push(['Poten', `${o.targets.length}× ${legDescription(leg)} (kast staat ${h} mm boven de vloer)`]);
  out.info = [...(out.info ?? []), hardwareTable(legHardware(leg, o.targets.length, o.boardT))];
  out.tips = [...(out.tips ?? []), 'Schroef de poten pas vast als de kast in elkaar zit: leg hem op zijn kop op een deken.', ...legTips(leg)];
}

function build(p: Params, { M, printer, assets }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const kind = str(p, 'kind');
  if (kind === 'table') return table(M, p);
  if (kind === 'riser') return riser(M, p, printer, assets);
  if (kind === 'legs') return looseLegs(M, p, printer, assets);
  if (kind === 'box') return cabinetBox(M, p, printer, assets);
  return shelving(M, p, printer, assets);
}

const is = (...k: string[]) => (p: Params) => k.includes(str(p, 'kind'));
const cabinetLegs = (p: Params) => is('shelf', 'box')(p) && str(p, 'cabLegs') !== 'none';
const riserLegs = (p: Params) => is('riser')(p) && (str(p, 'riserSupport') !== 'ring' || str(p, 'boardForm') !== 'circle');
const legsUsed = (p: Params) => is('legs')(p) || cabinetLegs(p) || riserLegs(p) || (is('riser')(p) && num(p, 'tiers') > 1);
const round = (p: Params) => str(p, 'boardForm') === 'circle';

function assetsFor(p: Params): AssetRef[] {
  const out: AssetRef[] = legsUsed(p) ? legAssets(p) : [];
  if (is('riser')(p) && str(p, 'boardForm') === 'shape') out.push(...shapeAssets(p, 'board'));
  return out;
}

export const furnitureTool: ToolDef = {
  id: 'meubels',
  name: 'Meubels met hout',
  short: 'Meubels',
  icon: 'M4 4h16v16H4zM4 10h16M4 15h16M12 4v16',
  description: 'Ontwerp kasten, kastjes, tafels en plankverhogingen uit standaard planken en latten. Je krijgt de zaaglijst én alle printbare verbinders en poten.',
  params: [
    { type: 'group', label: 'Meubel' },
    {
      type: 'select', key: 'kind', label: 'Soort', default: 'shelf',
      options: [
        { value: 'shelf', label: 'Open kast / boekenkast' },
        { value: 'box', label: 'Kastje (panelen + 3D-hoeken)' },
        { value: 'table', label: 'Tafel / bank / kruk (latten)' },
        { value: 'riser', label: 'Verhoging / plankstandaard' },
        { value: 'legs', label: 'Losse meubelpoten' },
      ],
    },
    {
      type: 'select', key: 'boardForm', label: 'Vorm van de plank', default: 'rounded', show: is('riser'),
      options: BOARD_FORMS,
    },
    ...shapeParams('board', { shape: 'cloud', count: 6, depth: 40, rounding: 50, seed: 7 }, { label: 'Ontwerpvorm', custom: true, show: (p) => is('riser')(p) && str(p, 'boardForm') === 'shape', only: BOARD_DESIGNS }),
    { type: 'number', key: 'boardDia', label: 'Diameter', min: 120, max: 1200, step: 5, unit: 'mm', default: 300, show: (p) => is('riser')(p) && round(p) },
    { type: 'number', key: 'width', label: 'Breedte', min: 150, max: 2400, step: 10, unit: 'mm', default: 800, show: (p) => !is('legs')(p) && !(is('riser')(p) && round(p)) },
    { type: 'number', key: 'depth', label: 'Diepte', min: 100, max: 1200, step: 5, unit: 'mm', default: 300, show: (p) => !is('legs')(p) && !(is('riser')(p) && round(p)) },
    { type: 'number', key: 'height', label: 'Hoogte', min: 150, max: 2400, step: 10, unit: 'mm', default: 1000, show: is('shelf', 'box', 'table') },
    { type: 'number', key: 'boardRadius', label: 'Afronding hoeken', min: 5, max: 200, step: 1, unit: 'mm', default: 30, show: (p) => is('riser')(p) && str(p, 'boardForm') === 'rounded' },
    { type: 'number', key: 'riserH', label: 'Hoogte bovenkant plank', min: 30, max: 400, step: 5, unit: 'mm', default: 100, show: is('riser'), help: 'Gemeten vanaf de tafel.' },
    { type: 'group', label: 'Indeling', show: is('shelf') },
    { type: 'number', key: 'cols', label: 'Kolommen', min: 1, max: 8, step: 1, default: 2, show: is('shelf') },
    { type: 'number', key: 'rows', label: 'Planken boven elkaar (vakken)', min: 1, max: 10, step: 1, default: 3, show: is('shelf') },
    { type: 'bool', key: 'openFront', label: 'Open voorkant', default: true, show: is('box') },
    { type: 'group', label: 'Onderstel', show: is('riser') },
    {
      type: 'select', key: 'riserSupport', label: 'Onderstel', default: 'legs', show: (p) => is('riser')(p) && round(p),
      options: [
        { value: 'legs', label: 'Pootjes' },
        { value: 'ring', label: 'Geprinte ring' },
      ],
    },
    {
      type: 'select', key: 'ringPattern', label: 'Patroon in de ring', default: 'diamonds', show: (p) => is('riser')(p) && round(p) && str(p, 'riserSupport') === 'ring',
      options: [
        { value: 'none', label: 'Dicht' },
        { value: 'diamonds', label: 'Ruitjes' },
        { value: 'slots', label: 'Smalle sleuven' },
      ],
    },
    {
      type: 'select', key: 'legCount', label: 'Aantal poten', default: 'auto', show: riserLegs,
      options: [
        { value: 'auto', label: 'Automatisch (3 bij rond, 4 bij rechthoek)' },
        ...[3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) })),
      ],
    },
    { type: 'number', key: 'legInset', label: 'Afstand tot de rand', min: 0, max: 150, step: 1, unit: 'mm', default: 25, show: is('riser'), help: 'Van de rand van de plank tot de montageplaat (of de ring).' },
    { type: 'number', key: 'tiers', label: 'Lagen (etagère)', min: 1, max: 3, step: 1, default: 1, show: is('riser') },
    { type: 'number', key: 'tierScale', label: 'Grootte volgende laag', min: 40, max: 95, step: 1, unit: '%', default: 70, show: (p) => is('riser')(p) && num(p, 'tiers') > 1 },
    { type: 'number', key: 'tierGap', label: 'Ruimte tussen de lagen', min: 60, max: 300, step: 5, unit: 'mm', default: 140, show: (p) => is('riser')(p) && num(p, 'tiers') > 1, help: 'Hoogte van de zuilen tussen de lagen.' },
    {
      type: 'select', key: 'cabLegs', label: 'Poten', default: 'none', show: is('shelf', 'box'),
      options: [
        { value: 'none', label: 'Geen' },
        { value: '4', label: '4 poten' },
        { value: '6', label: '6 poten' },
      ],
    },
    { type: 'number', key: 'legQty', label: 'Aantal poten', min: 1, max: 16, step: 1, default: 4, show: is('legs') },
    { type: 'number', key: 'legH', label: 'Poothoogte', min: 20, max: 320, step: 5, unit: 'mm', default: 120, show: (p) => is('legs')(p) || cabinetLegs(p), help: 'Van de vloer tot de onderkant van het meubel.' },
    ...legParams(legsUsed),
    { type: 'group', label: 'Hout', show: is('shelf', 'box', 'table', 'riser') },
    { type: 'number', key: 'plankT', label: 'Plankdikte', min: 6, max: 30, step: 0.5, unit: 'mm', default: 18, show: is('shelf', 'box', 'riser') },
    { type: 'number', key: 'stick', label: 'Lat (vierkant)', min: 18, max: 70, step: 1, unit: 'mm', default: 44, show: is('table') },
    { type: 'number', key: 'topT', label: 'Dikte bladplanken', min: 10, max: 45, step: 1, unit: 'mm', default: 18, show: is('table') },
    { type: 'number', key: 'plankW', label: 'Breedte bladplanken', min: 40, max: 400, step: 1, unit: 'mm', default: 140, show: is('table') },
    { type: 'number', key: 'gap', label: 'Naad tussen planken', min: 0, max: 15, step: 1, unit: 'mm', default: 4, show: is('table') },
    { type: 'number', key: 'overhang', label: 'Overstek blad', min: 0, max: 150, step: 5, unit: 'mm', default: 30, show: is('table') },
    { type: 'bool', key: 'shelf', label: 'Onderplank', default: false, show: is('table') },
    { type: 'number', key: 'shelfH', label: 'Hoogte onderplank', min: 60, max: 800, step: 5, unit: 'mm', default: 120, show: (p) => is('table')(p) && bool(p, 'shelf') },
    { type: 'group', label: 'Verbinders', show: is('shelf', 'box', 'table') },
    { type: 'number', key: 'insert', label: 'Insteekdiepte', min: 10, max: 60, step: 1, unit: 'mm', default: 25, show: is('shelf', 'box', 'table') },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 2, max: 8, step: 0.2, unit: 'mm', default: 3.2, show: is('shelf', 'box', 'table') },
    { type: 'number', key: 'clearance', label: 'Speling', min: 0, max: 1.5, step: 0.05, unit: 'mm', default: 0.4, show: is('shelf', 'box', 'table') },
    { type: 'number', key: 'connLen', label: 'Lengte verbinder', min: 20, max: 120, step: 1, unit: 'mm', default: 40, show: is('shelf') },
    {
      type: 'select', key: 'perNode', label: 'Verbinders per knoop', default: '2', show: is('shelf'),
      options: [
        { value: '2', label: '2 (voor + achter)' },
        { value: '3', label: '3 (ook midden)' },
      ],
    },
    {
      type: 'select', key: 'screws', label: 'Schroefgaten', default: '1', show: is('shelf'),
      options: [
        { value: '0', label: 'Geen' },
        { value: '1', label: '1 per arm' },
        { value: '2', label: '2 per arm' },
      ],
    },
    { type: 'number', key: 'arm', label: 'Armlengte hoeken', min: 10, max: 80, step: 1, unit: 'mm', default: 30, show: is('box') },
    {
      type: 'select', key: 'edges', label: 'Randen tussen de hoeken', default: 'clips', show: is('box'),
      options: [
        { value: 'clips', label: 'Clips (licht, elke ~18 cm)' },
        { value: 'full', label: 'Doorlopend profiel (stevig, veel filament)' },
        { value: 'none', label: 'Geen (alleen hoeken)' },
      ],
    },
  ],
  presets: [
    { name: 'Boekenkast 80×100', values: { kind: 'shelf', width: 800, depth: 300, height: 1000, cols: 2, rows: 3, plankT: 18 } },
    { name: 'Lage tv-kast', values: { kind: 'shelf', width: 1400, depth: 400, height: 450, cols: 3, rows: 1, plankT: 18, perNode: '3' } },
    { name: 'Vakkenkast 4×4', values: { kind: 'shelf', width: 1450, depth: 390, height: 1450, cols: 4, rows: 4, plankT: 18 } },
    { name: 'Nachtkastje', values: { kind: 'box', width: 400, depth: 300, height: 400, plankT: 12, openFront: true, arm: 30, insert: 18, wall: 2.6 } },
    { name: 'Opbergkist', values: { kind: 'box', width: 600, depth: 350, height: 350, plankT: 12, openFront: false, arm: 35, insert: 18, wall: 2.6 } },
    { name: 'Salontafel', values: { kind: 'table', width: 1100, depth: 600, height: 450, stick: 44, topT: 18, plankW: 140, overhang: 30, shelf: true, shelfH: 120 } },
    { name: 'Bankje', values: { kind: 'table', width: 1000, depth: 320, height: 450, stick: 44, topT: 27, plankW: 95, overhang: 20, shelf: false } },
    { name: 'Kruk', values: { kind: 'table', width: 350, depth: 350, height: 460, stick: 34, topT: 18, plankW: 90, overhang: 15, shelf: true, shelfH: 150 } },
    { name: 'Broodplank verhoging', values: { kind: 'riser', boardForm: 'rounded', width: 450, depth: 300, boardRadius: 40, plankT: 18, riserH: 90, legCount: '4', legInset: 20, legProfile: 'taper', legD: 34, legFoot: 70, legSecShape: 'squircle', legSecRounding: 60, legPlate: 'round', legBottom: 'felt' } },
    { name: 'Fruit etagère rond (2 lagen)', values: { kind: 'riser', boardForm: 'circle', boardDia: 320, plankT: 18, riserH: 70, riserSupport: 'ring', ringPattern: 'diamonds', legInset: 12, tiers: 2, tierScale: 65, tierGap: 150, legProfile: 'hourglass', legD: 30, legFoot: 80, legWaist: 55, legSecShape: 'petals', legSecCount: 6, legSecDepth: 25, legSecRounding: 60, legTwist: 60, legPlate: 'round', legCore: 'none' } },
    { name: 'Monitorstandaard', values: { kind: 'riser', boardForm: 'rect', width: 560, depth: 240, plankT: 18, riserH: 110, legCount: '4', legInset: 15, legProfile: 'straight', legD: 44, legSecShape: 'squircle', legSecRounding: 40, legPlate: 'square', legBottom: 'felt' } },
    { name: 'Kastje op pootjes', values: { kind: 'box', width: 400, depth: 300, height: 400, plankT: 12, openFront: true, arm: 30, insert: 18, wall: 2.6, cabLegs: '4', legH: 140, legProfile: 'scandi', legD: 34, legFoot: 55, legSplay: 8, legPlate: 'round', legBottom: 'felt' } },
    { name: 'Boekenkast met poten', values: { kind: 'shelf', width: 800, depth: 300, height: 1000, cols: 2, rows: 3, plankT: 18, cabLegs: '6', legH: 80, legProfile: 'stepped', legD: 44, legFoot: 70, legSecShape: 'polygon', legSecCount: 8, legSecRounding: 60, legPlate: 'square', legBottom: 'level' } },
    { name: 'Losse Scandinavische poten', values: { kind: 'legs', legQty: 4, legH: 220, legProfile: 'scandi', legD: 40, legFoot: 50, legSplay: 10, legPlate: 'round', legCore: 'm8', legBottom: 'felt' } },
    { name: 'Ronde bolpootjes', values: { kind: 'legs', legQty: 4, legH: 70, legProfile: 'bun', legD: 40, legBall: 140, legPlate: 'round', legBottom: 'felt' } },
  ],
  assets: assetsFor,
  build,
};

