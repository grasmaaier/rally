import type { ManifoldToplevel, Vec3 } from 'manifold-3d';
import type { BuildOutput, Params, PartOut, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { usable } from '../core/printer';
import { type M4, asMat4, filletExtrude, mul, rotX, rotY, rotZ, rotateOnto, translation } from '../geom/helpers';
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

function shelving(M: ManifoldToplevel, p: Params): BuildOutput {
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
  return {
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

function cabinetBox(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
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
  return {
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

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const kind = str(p, 'kind');
  if (kind === 'table') return table(M, p);
  if (kind === 'box') return cabinetBox(M, p, printer);
  return shelving(M, p);
}

const is = (...k: string[]) => (p: Params) => k.includes(str(p, 'kind'));

export const furnitureTool: ToolDef = {
  id: 'meubels',
  name: 'Meubels met hout',
  short: 'Meubels',
  icon: 'M4 4h16v16H4zM4 10h16M4 15h16M12 4v16',
  description: 'Ontwerp kasten, kastjes en tafels uit standaard planken en latten. Je krijgt de zaaglijst én alle printbare verbinders.',
  params: [
    { type: 'group', label: 'Meubel' },
    {
      type: 'select', key: 'kind', label: 'Soort', default: 'shelf',
      options: [
        { value: 'shelf', label: 'Open kast / boekenkast' },
        { value: 'box', label: 'Kastje (panelen + 3D-hoeken)' },
        { value: 'table', label: 'Tafel / bank / kruk (latten)' },
      ],
    },
    { type: 'number', key: 'width', label: 'Breedte', min: 150, max: 2400, step: 10, unit: 'mm', default: 800 },
    { type: 'number', key: 'depth', label: 'Diepte', min: 100, max: 1200, step: 5, unit: 'mm', default: 300 },
    { type: 'number', key: 'height', label: 'Hoogte', min: 150, max: 2400, step: 10, unit: 'mm', default: 1000 },
    { type: 'group', label: 'Indeling', show: is('shelf') },
    { type: 'number', key: 'cols', label: 'Kolommen', min: 1, max: 8, step: 1, default: 2, show: is('shelf') },
    { type: 'number', key: 'rows', label: 'Planken boven elkaar (vakken)', min: 1, max: 10, step: 1, default: 3, show: is('shelf') },
    { type: 'bool', key: 'openFront', label: 'Open voorkant', default: true, show: is('box') },
    { type: 'group', label: 'Hout' },
    { type: 'number', key: 'plankT', label: 'Plankdikte', min: 6, max: 30, step: 0.5, unit: 'mm', default: 18, show: is('shelf', 'box') },
    { type: 'number', key: 'stick', label: 'Lat (vierkant)', min: 18, max: 70, step: 1, unit: 'mm', default: 44, show: is('table') },
    { type: 'number', key: 'topT', label: 'Dikte bladplanken', min: 10, max: 45, step: 1, unit: 'mm', default: 18, show: is('table') },
    { type: 'number', key: 'plankW', label: 'Breedte bladplanken', min: 40, max: 400, step: 1, unit: 'mm', default: 140, show: is('table') },
    { type: 'number', key: 'gap', label: 'Naad tussen planken', min: 0, max: 15, step: 1, unit: 'mm', default: 4, show: is('table') },
    { type: 'number', key: 'overhang', label: 'Overstek blad', min: 0, max: 150, step: 5, unit: 'mm', default: 30, show: is('table') },
    { type: 'bool', key: 'shelf', label: 'Onderplank', default: false, show: is('table') },
    { type: 'number', key: 'shelfH', label: 'Hoogte onderplank', min: 60, max: 800, step: 5, unit: 'mm', default: 120, show: (p) => is('table')(p) && bool(p, 'shelf') },
    { type: 'group', label: 'Verbinders' },
    { type: 'number', key: 'insert', label: 'Insteekdiepte', min: 10, max: 60, step: 1, unit: 'mm', default: 25 },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 2, max: 8, step: 0.2, unit: 'mm', default: 3.2 },
    { type: 'number', key: 'clearance', label: 'Speling', min: 0, max: 1.5, step: 0.05, unit: 'mm', default: 0.4 },
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
  ],
  build,
};

