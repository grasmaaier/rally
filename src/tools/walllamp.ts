import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { BuildOutput, InfoBlock, MeshData, ParamDef, Params, PartOut, Preset, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { keep } from '../core/registry';
import { fitsOn, usable } from '../core/printer';
import { asMat4, clamp, mul, rotX, rotY, rotZ, smoothstep, translation, type M4 } from '../geom/helpers';
import { loftLoop, loopsOf, resample, unitNormals, type Loop } from '../geom/soft';
import { COLOR_OPTIONS } from './lampParts';
import {
  BRACKET_SCREW, FLUSH_BOX, G9_GUIDE, G9_LED, LOCK, PLUG, SHAPES, WAGO, frontYOver, holeLattice, holePoly, latticeWeb, offsetLoop, outlineOf, reliefLoop, sideXOver,
  type Outline,
} from './wallLampParts';

/*
 * Wall sconce over a Dutch flush box. Frame used everywhere below: x along the
 * wall, y = distance from the wall (the wall is y = 0), z = height measured
 * from the mount end of the housing (the end with the lock screws). For an
 * up/down or up light the mount end is the bottom; for a down light (closed
 * top) it is the top, and the housing is shown turned over.
 *
 * - Muurplaat: a shallow tray screwed to the box, open towards the wall (the
 *   box and the tray hold the Wago connectors).
 * - Kap: an extruded outline. Two channels (rib + lip) hook behind the front
 *   flange of the plate, so it cannot come off the wall; the housing slides
 *   over the plate from the open far end until two pillars rest against the
 *   plate, and two countersunk screws through the pillars lock it.
 * - G9-houder: holds the socket so the bulb sits in the middle of the light.
 */

// ---------------------------------------------------------------------------
// Dimensions

/**
 * Channel around the plate edges. The plate has a rabbet on both sides: its
 * front flange is full width, the part behind it is `rabbet` narrower on each
 * side. The housing's lips sit in the rabbets, between the wall and the
 * flange, so the housing cannot be pulled off the wall; the ribs beside the
 * flange keep it from moving sideways. Pillars at the mount end carry the
 * plate and take the lock screws.
 */
const CH = { c: 0.4, rib: 3, rabbet: 6, flange: 5, pillarH: 8 };
/** Wall plate: front skin, rim, corner blocks for the lock screws, boss radii. */
const PLATE = { front: 3, rim: 3, r: 1.5, cornerW: 10, cornerH: 13, bossBox: 4.5, bossBr: 4, bossPlug: 5, lead: 4.5 };
const FLANGE_T = 1.8;
const FLOOR_T = 2.2;
const REFL = { gap: 0.4, t: 1.2, lip: 1.2 };
/** Socket bracket: pad and base thickness, base length (sideways). */
const BR = { t: 5, base: 5, len: 32 };
/** Smallest distance from the bulb glass to any printed part. */
const CLEAR = 10;
const WHITE = '#f2efe8';
/** The back of the plate (6 mm narrower each side) must cover the Ø68 hole with its rim. */
const PLATE_MIN_W = 92;

type Dir = 'both' | 'up' | 'down';

// ---------------------------------------------------------------------------
// Parameters

const isShape = (...s: string[]) => (p: Params) => s.includes(str(p, 'shape'));
const isPat = (...s: string[]) => (p: Params) => s.includes(str(p, 'pattern'));
const dirOf = (p: Params): Dir => (['both', 'up', 'down'].includes(str(p, 'dir')) ? (str(p, 'dir') as Dir) : 'both');

const params: ParamDef[] = [
  { type: 'group', label: 'Vorm' },
  { type: 'select', key: 'shape', label: 'Vorm (bovenaanzicht)', options: SHAPES, default: 'pil' },
  { type: 'number', key: 'W', label: 'Breedte', min: 90, max: 260, step: 1, unit: 'mm', default: 150, help: 'Langs de muur.' },
  { type: 'number', key: 'D', label: 'Diepte', min: 55, max: 150, step: 1, unit: 'mm', default: 80, help: 'Hoe ver de lamp uit de muur steekt.' },
  { type: 'number', key: 'H', label: 'Hoogte', min: 90, max: 250, step: 1, unit: 'mm', default: 100 },
  { type: 'number', key: 'corner', label: 'Hoekradius voorkant', min: 2, max: 60, step: 1, unit: 'mm', default: 16, show: isShape('rechthoek') },
  { type: 'number', key: 'waves', label: 'Aantal golven', min: 2, max: 9, step: 1, default: 5, show: isShape('golf') },
  { type: 'number', key: 'waveDepth', label: 'Golfdiepte', min: 2, max: 20, step: 1, unit: '%', default: 10, show: isShape('golf') },

  { type: 'group', label: 'Licht' },
  {
    type: 'select', key: 'dir', label: 'Lichtrichting', default: 'both',
    options: [
      { value: 'both', label: 'Omhoog en omlaag' },
      { value: 'up', label: 'Alleen omhoog (dichte onderkant)' },
      { value: 'down', label: 'Alleen omlaag (dichte bovenkant)' },
    ],
  },
  {
    type: 'number', key: 'rimTop', label: 'Rand bovenaan', min: 0, max: 40, step: 1, unit: 'mm', default: 0, show: (p) => dirOf(p) !== 'down',
    help: 'Een rand naar binnen (45° van onderen) maakt de lichtbundel smaller. 0 = helemaal open.',
  },
  { type: 'number', key: 'rimBottom', label: 'Rand onderaan', min: 0, max: 40, step: 1, unit: 'mm', default: 0, show: (p) => dirOf(p) !== 'up', help: '0 = helemaal open.' },
  { type: 'number', key: 'endWindow', label: 'Venster in de dichte kant', min: 0, max: 60, step: 1, unit: 'mm', default: 0, show: (p) => dirOf(p) !== 'both', help: 'Rond venstertje recht boven/onder de lamp voor een beetje strijklicht. 0 = dicht.' },
  {
    type: 'select', key: 'bulbPos', label: 'Stand van de lamp', default: 'auto',
    options: [
      { value: 'auto', label: 'Automatisch' },
      { value: 'staand', label: 'Staand (naar de open kant)' },
      { value: 'liggend', label: 'Liggend (langs de muur)' },
    ],
    help: 'Automatisch: liggend bij omhoog en omlaag, anders staand als de kap hoog genoeg is.',
  },

  { type: 'group', label: 'Wand & patroon' },
  {
    type: 'select', key: 'pattern', label: 'Patroon', default: 'glad',
    options: [
      { value: 'glad', label: 'Glad' },
      { value: 'plisse', label: 'Plissé (scherpe vouwen)' },
      { value: 'ribbels', label: 'Ribbels (afgerond)' },
      { value: 'gaatjes', label: 'Gaatjes (doorbroken)' },
    ],
  },
  { type: 'bool', key: 'translucent', label: 'Doorschijnende wand', default: false, help: 'Dunne wand (0,8–1,6 mm) in doorschijnend PETG of PLA: de hele kap gloeit.' },
  { type: 'number', key: 'wall', label: 'Wanddikte', min: 0.8, max: 4, step: 0.1, unit: 'mm', default: 2.4 },
  { type: 'number', key: 'pitch', label: 'Afstand vouwen', min: 4, max: 20, step: 0.5, unit: 'mm', default: 8, show: isPat('plisse', 'ribbels') },
  { type: 'number', key: 'depth', label: 'Diepte vouwen', min: 0.8, max: 5, step: 0.1, unit: 'mm', default: 2, show: isPat('plisse', 'ribbels') },
  {
    type: 'select', key: 'holeShape', label: 'Vorm gaatjes', default: 'ruit', show: isPat('gaatjes'),
    options: [
      { value: 'ruit', label: 'Ruit (45°)' },
      { value: 'druppel', label: 'Druppel (rond met punt)' },
    ],
  },
  { type: 'number', key: 'holeSize', label: 'Grootte gaatjes', min: 4, max: 20, step: 0.5, unit: 'mm', default: 9, show: isPat('gaatjes') },
  { type: 'number', key: 'holeWeb', label: 'Minimale brug', min: 1.2, max: 8, step: 0.1, unit: 'mm', default: 3, show: isPat('gaatjes'), help: 'Kleinste breedte van het materiaal tussen twee gaatjes.' },

  { type: 'group', label: 'Kleuren & reflector' },
  { type: 'select', key: 'color', label: 'Kleur kap', options: COLOR_OPTIONS, default: '#d8c3a0' },
  { type: 'bool', key: 'reflector', label: 'Witte reflector (los binnenwerk)', default: false, show: (p) => dirOf(p) !== 'down', help: 'Dunne binnenschaal die met een randje op de bovenkant van de kap hangt. Neemt ook de rand bovenaan over.' },
  { type: 'select', key: 'reflColor', label: 'Kleur reflector', options: COLOR_OPTIONS, default: WHITE, show: (p) => dirOf(p) !== 'down' && bool(p, 'reflector') },
  { type: 'select', key: 'plateColor', label: 'Kleur muurplaat en houder', options: COLOR_OPTIONS, default: WHITE },

  { type: 'group', label: 'Muurplaat & inbouwdoos' },
  {
    type: 'select', key: 'boxScrews', label: 'Schroefpotjes inbouwdoos', default: 'h',
    options: [
      { value: 'h', label: 'Links en rechts (60 mm)' },
      { value: 'v', label: 'Boven en onder (60 mm)' },
      { value: 'beide', label: 'Allebei (4 gaten, gebruik er 2)' },
    ],
  },
  {
    type: 'select', key: 'plugs', label: 'Extra pluggen', default: 'geen',
    options: [
      { value: 'geen', label: 'Geen (alleen de doos)' },
      { value: 'schroeven', label: '2 verzonken schroeven' },
      { value: 'sleutelgaten', label: '2 sleutelgaten (ophangen)' },
    ],
  },
  { type: 'number', key: 'plateW', label: 'Breedte muurplaat', min: 92, max: 160, step: 1, unit: 'mm', default: 96, help: 'De achterkant is aan elke kant 6 mm smaller (daar haakt de kap achter) en dekt het gat van Ø68 af.' },
  { type: 'number', key: 'plateH', label: 'Hoogte muurplaat', min: 80, max: 200, step: 1, unit: 'mm', default: 88 },
  { type: 'number', key: 'plateT', label: 'Dikte muurplaat', min: 14, max: 26, step: 1, unit: 'mm', default: 16, help: 'De holte erachter (dikte − 3 mm) heeft ruimte voor de Wago-klemmen.' },

  { type: 'group', label: 'G9-fitting en lamp (richtmaten)' },
  {
    type: 'select', key: 'sockMount', label: 'Bevestiging fitting', default: 'm10',
    options: [
      { value: 'm10', label: 'M10-nippel met moer' },
      { value: 'schroeven', label: '2 schroeven M3' },
    ],
  },
  { type: 'number', key: 'sockD', label: 'Diameter fitting', min: 14, max: 32, step: 0.1, unit: 'mm', default: G9_GUIDE.m10.d, help: 'Keramische G9-fitting: Ø20,2 × 25 mm (M10) is gangbaar. Meet je eigen fitting na.' },
  { type: 'number', key: 'sockH', label: 'Hoogte fitting', min: 14, max: 40, step: 0.5, unit: 'mm', default: G9_GUIDE.m10.h, help: 'Van de bevestiging tot de opening waar de lamp in gaat.' },
  { type: 'number', key: 'sockSpacing', label: 'Gatafstand fitting', min: 10, max: 40, step: 0.5, unit: 'mm', default: G9_GUIDE.screws.spacing, show: (p) => str(p, 'sockMount') === 'schroeven' },
  { type: 'number', key: 'bulbD', label: 'Diameter G9 LED', min: 12, max: 22, step: 0.5, unit: 'mm', default: G9_LED.d },
  { type: 'number', key: 'bulbL', label: 'Lengte G9 LED (met pinnen)', min: 40, max: 70, step: 1, unit: 'mm', default: G9_LED.l },
];

// ---------------------------------------------------------------------------
// 2D / 3D helpers

const cs = (M: ManifoldToplevel, loops: Vec2[][]) => keep(new M.CrossSection(loops, 'Positive'));
function rect(M: ManifoldToplevel, x0: number, x1: number, y0: number, y1: number): CrossSection {
  const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [c, d] = y0 < y1 ? [y0, y1] : [y1, y0];
  return cs(M, [
    [
      [a, c],
      [b, c],
      [b, d],
      [a, d],
    ],
  ]);
}
const box = (M: ManifoldToplevel, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  M.Manifold.cube([Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)]).translate([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)]);

/** Matrix with the given columns (local x, y, z axes) and origin. */
function basis(ex: Vec3, ey: Vec3, ez: Vec3, o: Vec3): M4 {
  return [ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, o[0], o[1], o[2], 1];
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Horizontal-in-print hole: a teardrop (45° point towards `up`) of radius r
 * along `axis`, centred on `centre`, `len` long. Vertical holes can use it too.
 */
function tearHole(M: ManifoldToplevel, r: number, len: number, centre: Vec3, axis: Vec3, up: Vec3): Manifold {
  const pts: Vec2[] = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 0.75 + (Math.PI * 1.5 * i) / (n - 1);
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  pts.push([0, r * Math.SQRT2]);
  const ex = cross(up, axis);
  return cs(M, [pts]).extrude(len).translate([0, 0, -len / 2]).transform(asMat4(basis(ex, up, axis, centre)));
}

function cylAlong(M: ManifoldToplevel, r: number, len: number, centre: Vec3, axis: Vec3, segs = 32): Manifold {
  const up: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ey = cross(axis, up);
  const ex = cross(ey, axis);
  return M.Manifold.cylinder(len, r, r, segs).translate([0, 0, -len / 2]).transform(asMat4(basis(ex, ey, axis, centre)));
}

function meshOf(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const n = mesh.numProp;
  const vp = mesh.vertProperties;
  const count = vp.length / n;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = vp[i * n];
    positions[i * 3 + 1] = vp[i * n + 1];
    positions[i * 3 + 2] = vp[i * n + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

const colorName = (hex: string) => COLOR_OPTIONS.find((o) => o.value === hex)?.label.replace(/ \(.*\)$/, '') ?? hex;
const mm = (v: number, d = 0) => v.toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------------------
// Layout: every size and position, all fit checks (throws UserError)

interface Hole2 {
  x: number;
  z: number;
  r: number;
}

/** Keeps holes on the plate apart and away from the rim, corners and lips. */
class Planner {
  taken: Hole2[] = [];
  /** Solid blocks (x0, x1, z0, z1) a hole may not reach into. */
  blocks: [number, number, number, number][] = [];
  constructor(private xMax: number, private z0: number, private z1: number) {}
  ok(x: number, z: number, r: number, margin = 1): boolean {
    if (Math.abs(x) > this.xMax - r || z < this.z0 + r || z > this.z1 - r) return false;
    for (const [a, b, c, d] of this.blocks) if (Math.hypot(Math.max(a - x, 0, x - b), Math.max(c - z, 0, z - d)) < r + margin) return false;
    return this.taken.every((h) => Math.hypot(h.x - x, h.z - z) >= h.r + r + margin);
  }
  add(x: number, z: number, r: number) {
    this.taken.push({ x, z, r });
  }
  find(cands: [number, number][], r: number, margin = 1): [number, number] | null {
    for (const [x, z] of cands) if (this.ok(x, z, r, margin)) return [x, z];
    return null;
  }
  clone(): Planner {
    const q = new Planner(this.xMax, this.z0, this.z1);
    q.taken = [...this.taken];
    q.blocks = this.blocks;
    return q;
  }
}

interface BulbLayout {
  orient: 'vertical' | 'sideways';
  axis: Vec3;
  /** Centre of the socket's mounting face (on the pad). */
  base: Vec3;
  mouth: Vec3;
  tip: Vec3;
  r: number;
  sd: number;
  sh: number;
  // bracket
  x0: number; // vertical: centre x; sideways: pad x (outer face)
  yc: number;
  zc: number;
  pad0: number; // vertical: pad bottom z
  yPadF: number;
  bw: number; // vertical: width in x; sideways: height in z
  zs0: number; // vertical: base strip z range
  zs1: number;
  baseLen: number; // sideways base length
  gusset: number;
  screws: [number, number][];
  lead: [number, number];
  tie: [number, number] | null;
  /** Plan footprint (rectangles) of bracket, socket, nut and glass. */
  foot: [number, number, number, number][];
  glassFoot: [number, number, number, number];
  zMin: number;
  zMax: number;
}

export interface WallLayout {
  shape: string;
  W: number;
  D: number;
  H: number;
  t: number;
  translucent: boolean;
  dir: Dir;
  outline: Outline;
  outerLoop: Loop;
  relief: number;
  nearClosed: boolean;
  floorT: number;
  nearFw: number;
  farFw: number;
  window: number;
  reflector: boolean;
  plate: { W: number; H: number; T: number; z0: number; zb: number };
  yb: number;
  /** x of the lock screws (±), y of the lock screws. */
  lockX: number;
  lockY: number;
  boxHoles: [number, number][];
  plugHoles: [number, number][];
  keyholes: boolean;
  bulb: BulbLayout;
  holes: { shape: string; size: number; web: number; ps: number; pz: number } | null;
  notes: string[];
  ctx: Ctx;
}

interface Ctx {
  M: ManifoldToplevel;
  baseInner: CrossSection;
  freeLoop: Loop;
  yb: number;
}

export function wallLayout(p: Params, M: ManifoldToplevel, printer: PrinterProfile): WallLayout {
  const notes: string[] = [];
  const dir = dirOf(p);
  const shape = SHAPES.some((s) => s.value === str(p, 'shape')) ? str(p, 'shape') : 'pil';
  const W = clamp(num(p, 'W') || 150, 60, 400);
  const H = clamp(num(p, 'H') || 100, 60, 400);
  const translucent = bool(p, 'translucent');
  let t = clamp(num(p, 'wall') || 2.4, 0.8, 4);
  if (translucent && t > 1.6) {
    notes.push(`Doorschijnend: wand ${mm(t, 1)} mm is te dik om mooi door te schijnen; gebruikt 1,6 mm.`);
    t = 1.6;
  }
  const outline = outlineOf({ shape, W, D: clamp(num(p, 'D') || 80, 30, 400), corner: num(p, 'corner'), waves: num(p, 'waves'), waveDepth: num(p, 'waveDepth') });
  notes.push(...outline.notes);
  const D = outline.D;

  // printer
  const u = usable(printer);
  if (!fitsOn(printer, [W, D, H + REFL.lip])) {
    throw new UserError(`De kap (${mm(W)} × ${mm(D)} × ${mm(H)} mm) past niet op de printplaat van de ${printer.name} (${u.x} × ${u.y} × ${u.z} mm). Maak de lamp kleiner.`);
  }

  // plate
  const Tp = clamp(num(p, 'plateT') || 16, 14, 26);
  let Wp = clamp(num(p, 'plateW') || 96, PLATE_MIN_W, 200);
  let Hp = clamp(num(p, 'plateH') || 88, 80, 260);
  const z0 = CH.pillarH;
  if (Hp > H - z0 - 1) {
    const fit = Math.floor(H - z0 - 1);
    if (fit < 80) throw new UserError(`De kap is te laag voor de muurplaat: maak hem minstens ${Math.ceil(80 + z0 + 1)} mm hoog (de plaat moet het gat van de inbouwdoos, Ø68, afdekken).`);
    notes.push(`Muurplaat verkleind tot ${fit} mm hoog (past anders niet in de kap).`);
    Hp = fit;
  }
  const zb = z0 + Hp / 2;
  /** Front of the ribs: everything behind this belongs to the attachment. */
  const yb = Tp + CH.c + 1;

  // walls: smooth base, relief on the outside, uniform wall
  const pattern = str(p, 'pattern');
  const reliefDepth = pattern === 'plisse' || pattern === 'ribbels' ? clamp(num(p, 'depth') || 2, 0.5, 6) : 0;
  const outerLoop = reliefDepth > 0 ? reliefLoop(outline.loop, { kind: pattern, pitch: clamp(num(p, 'pitch') || 8, 3, 30), depth: reliefDepth, yMin: yb + 4 }) : outline.loop;
  const baseCS = cs(M, [outline.loop]);
  const baseInner = baseCS.offset(-t, 'Miter', 2);
  if (loopsOf(baseInner).outers.length !== 1) throw new UserError('De wand is te dik voor deze vorm. Maak de wand dunner of de lamp groter.');

  // plate must sit inside the housing, the channels inside the outline
  // (the plate replaces the back wall, so only in front of the back wall must it clear the inside)
  const fits = (w: number) =>
    rect(M, -w / 2 - CH.c, w / 2 + CH.c, t + 0.01, Tp + CH.c).subtract(baseInner).area() < 0.5 &&
    rect(M, -w / 2 - CH.c - CH.rib, w / 2 + CH.c + CH.rib, 0, yb).subtract(baseCS).area() < 0.5;
  if (!fits(Wp)) {
    let w = Wp;
    while (w > PLATE_MIN_W && !fits(w)) w = Math.max(PLATE_MIN_W, w - 2);
    if (!fits(w)) {
      throw new UserError(`De muurplaat (minstens ${PLATE_MIN_W} mm breed, ${mm(Tp)} mm dik) past niet in deze kap: de achterkant van de kap is maar ${mm(2 * outline.xb)} mm breed. Maak de lamp breder of dieper, of de plaat dunner.`);
    }
    notes.push(`Muurplaat smaller gemaakt: ${mm(w)} mm (past anders niet in de kap).`);
    Wp = w;
  }

  // reflector
  const reflector = dir !== 'down' && bool(p, 'reflector');
  const liner = reflector ? REFL.gap + REFL.t : 0;
  const freeCS = liner > 0 ? baseInner.offset(-liner, 'Miter', 2) : baseInner;
  const freeLoops = loopsOf(freeCS).outers;
  if (freeLoops.length !== 1) throw new UserError('De lamp is te klein voor een reflector. Maak hem groter of zet de reflector uit.');
  const freeLoop = resample(freeLoops[0], 1);

  // ends
  const nearClosed = dir !== 'both';
  const floorT = nearClosed ? FLOOR_T : 0;

  // plate holes: box screws and plugs
  // holes with bosses go in the cavity, behind the full-depth part of the plate
  const cavityX = Wp / 2 - CH.rabbet - PLATE.rim;
  const planner = new Planner(cavityX - 0.5, z0 + PLATE.rim + 0.5, z0 + Hp - PLATE.rim - 0.5);
  const cx0 = Wp / 2 - CH.rabbet - PLATE.cornerW;
  for (const [a, b] of [
    [z0, z0 + PLATE.cornerH],
    [z0 + Hp - PLATE.cornerH, z0 + Hp],
  ])
    planner.blocks.push([-1e3, -cx0, a, b], [cx0, 1e3, a, b]);
  const bs = str(p, 'boxScrews');
  const half = FLUSH_BOX.spacing / 2;
  const boxHoles: [number, number][] = [];
  if (bs !== 'v') boxHoles.push([-half, zb], [half, zb]);
  if (bs === 'v' || bs === 'beide') boxHoles.push([0, zb - half], [0, zb + half]);
  for (const [x, z] of boxHoles) planner.add(x, z, PLATE.bossBox);
  const plugs = str(p, 'plugs');
  const plugHoles: [number, number][] = [];
  const keyholes = plugs === 'sleutelgaten';
  if (plugs === 'schroeven' || keyholes) {
    // inside the corner blocks of the lock screws, well outside the Ø68 hole
    const px = Wp / 2 - CH.rabbet - PLATE.cornerW - 5.5;
    const pz = Hp / 2 - 9;
    if (keyholes) plugHoles.push([-px, zb + pz], [px, zb + pz]);
    else plugHoles.push([-px, zb + pz], [px, zb - pz]);
    for (const [x, z] of plugHoles) {
      planner.add(x, z, PLATE.bossPlug + 1);
      if (keyholes) planner.add(x, z - 9, PLATE.bossPlug + 1);
    }
  }

  const ctx: Ctx = { M, baseInner, freeLoop, yb };
  const rimFar = dir === 'down' ? num(p, 'rimBottom') : num(p, 'rimTop');
  const rimNear = dir === 'both' ? num(p, 'rimBottom') : 0;
  const rimWant = clamp(Math.max(rimFar || 0, rimNear || 0), 0, 60);
  const bulb = bulbLayout(p, ctx, { H, Wp, Hp, Tp, z0, face: Wp / 2 - 1, floorT, dir, planner, rim: rimWant }, notes);

  // the assembly must stay inside the free space of the housing
  const footCS = M.CrossSection.union(bulb.foot.map(([a, b, c, d]) => rect(M, a, b, c, d)));
  const frontPart = footCS.intersect(rect(M, -1e3, 1e3, yb + 0.5, 1e3));
  if (frontPart.subtract(freeCS.offset(-0.5, 'Miter', 2)).area() > 0.5) {
    throw new UserError('De G9-fitting en lamp passen niet in deze kap. Maak de lamp groter of kies een andere stand van de lamp.');
  }

  // flanges: never in the way of the bulb (10 mm) or of the assembly while the housing slides on
  const flangeBase = reflector ? freeCS : baseInner;
  const wallT = reflector ? REFL.t : t;
  const farFw = clampFlange(M, clamp(rimFar || 0, 0, 60), flangeBase, wallT, yb, 'far', H, bulb, footCS);
  const nearFw = clampFlange(M, clamp(rimNear || 0, 0, 60), baseInner, t, yb, 'near', H, bulb, footCS);
  const farName = dir === 'down' ? 'onderaan' : 'bovenaan';
  if (farFw < (rimFar || 0) - 0.01) notes.push(`Rand ${farName} verkleind tot ${mm(farFw)} mm: anders komt hij te dicht bij de lamp (min. ${CLEAR} mm) of kan de kap niet over de lamp schuiven.`);
  if (nearFw < (rimNear || 0) - 0.01) notes.push(`Rand onderaan verkleind tot ${mm(nearFw)} mm: anders komt hij te dicht bij de lamp of de houder.`);

  // window in the closed end, right under/over the bulb
  let window = nearClosed ? clamp(num(p, 'endWindow') || 0, 0, 80) : 0;
  if (window > 0) {
    const [gx0, gx1, gy0, gy1] = bulb.glassFoot;
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    const room = baseInner.offset(-3, 'Miter', 2).subtract(rect(M, -1e3, 1e3, -10, yb + 2));
    let r = window / 2;
    for (let i = 0; i < 30 && r > 2; i++) {
      if (M.CrossSection.circle(r, 48).translate([cx, cy]).subtract(room).area() < 0.05) break;
      r -= 1;
    }
    if (r <= 2) {
      notes.push('Geen ruimte voor een venster in de dichte kant.');
      window = 0;
    } else if (2 * r < window - 0.01) {
      notes.push(`Venster verkleind tot Ø${mm(2 * r)} mm (past anders niet).`);
      window = 2 * r;
    }
  }

  let holes: WallLayout['holes'] = null;
  if (pattern === 'gaatjes') {
    const size = clamp(num(p, 'holeSize') || 9, 3, 30);
    const web = clamp(num(p, 'holeWeb') || 3, 1, 10);
    const hs = str(p, 'holeShape') === 'druppel' ? 'druppel' : 'ruit';
    const lat = holeLattice(hs, size, web + 0.3);
    holes = { shape: hs, size, web, ps: lat.ps, pz: lat.pz };
  }

  return {
    shape, W, D, H, t, translucent, dir, outline, outerLoop, relief: reliefDepth, nearClosed, floorT, nearFw, farFw, window, reflector,
    plate: { W: Wp, H: Hp, T: Tp, z0, zb }, yb, lockX: Wp / 2 - CH.rabbet - PLATE.cornerW / 2, lockY: Tp / 2, boxHoles, plugHoles, keyholes, bulb, holes, notes, ctx,
  };
}

interface PlateFrame {
  H: number;
  Wp: number;
  Hp: number;
  Tp: number;
  z0: number;
  /** Half width of the front face available for the bracket. */
  face: number;
  /** Rim (flange) width asked for: the layout tries to leave room for it. */
  rim: number;
  floorT: number;
  dir: Dir;
  planner: Planner;
}

/** Where the bulb, socket and bracket go; tries a few positions until the bracket screws and the lead hole fit. */
function bulbLayout(p: Params, ctx: Ctx, f: PlateFrame, notes: string[]): BulbLayout {
  const { freeLoop, yb } = ctx;
  const sd = clamp(num(p, 'sockD') || 20, 10, 40);
  const sh = clamp(num(p, 'sockH') || 25, 10, 50);
  const r = clamp(num(p, 'bulbD') || 16, 8, 30) / 2;
  const Lg = Math.max(2 * r + 2, clamp(num(p, 'bulbL') || 50, 30, 90) - G9_LED.insert);
  const m10 = str(p, 'sockMount') !== 'schroeven';
  const spacing = clamp(num(p, 'sockSpacing') || 24, 8, 50);
  // behind the bulb: the lips of the housing and the base of the bracket
  const yLow = Math.max(yb, f.Tp + BR.base);
  const want = str(p, 'bulbPos');
  const auto = want !== 'staand' && want !== 'liggend';
  const tryVertical = want === 'staand' || (auto && f.dir !== 'both');
  let reason = '';
  // first with room for the rim that was asked for, then without (the rim is made smaller later)
  let rim = f.rim;
  const attempt = (fn: () => BulbLayout | string): BulbLayout | string => {
    rim = f.rim;
    const a = fn();
    if (typeof a !== 'string' || rim <= 0) return a;
    rim = 0;
    return fn();
  };
  if (tryVertical) {
    const v = attempt(vertical);
    if (typeof v !== 'string') return v;
    reason = v;
    if (!auto) throw new UserError(v);
  }
  const s = attempt(sideways);
  if (typeof s !== 'string') {
    if (reason) notes.push(`Lamp liggend geplaatst: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
    return s;
  }
  throw new UserError(s);

  function yLayout(x0: number, x1: number, padHalf: number): { yc: number; yPadF: number } | string {
    const yFront = frontYOver(freeLoop, x0, x1);
    const need = 2 * r + 2 * CLEAR;
    if (!(yFront - yLow >= need)) return `De lamp is te ondiep voor een G9-lamp met ${CLEAR} mm afstand rondom: maak hem ${mm(Math.ceil(need - (yFront - yLow)))} mm dieper (of de muurplaat dunner).`;
    // in the middle, or further back so a rim at the front still keeps its distance
    const yMinC = yLow + r + CLEAR;
    const yWant = yFront - rim - Math.max(r + CLEAR, padHalf + 4);
    const yc = clamp((yLow + yFront) / 2, yMinC, Math.max(yMinC, Math.min(yFront - r - CLEAR, yWant)));
    const yPadF = yc + Math.max(padHalf, r) + 3;
    if (yPadF > frontYOver(freeLoop, x0, x1) - 1) return 'De G9-fitting is te dik voor deze diepte. Maak de lamp dieper.';
    return { yc, yPadF };
  }

  function vertical(): BulbLayout | string {
    const bw = Math.max(sd + 12, m10 ? 0 : spacing + 9, 28);
    const padT = BR.t;
    const leadMin = f.z0 + PLATE.rim + PLATE.lead + 1;
    const pad0Min = Math.max(leadMin + 5, f.floorT + G9_GUIDE.nut.h + G9_GUIDE.nipple.len + 2);
    const stack = padT + sh + Lg;
    const pad0Max = Math.min(f.H - 4 - stack, f.z0 + f.Hp - PLATE.rim - 1 - padT - 24);
    if (pad0Min > pad0Max) return `De kap is te laag voor een staande G9-lamp: maak hem minstens ${mm(Math.ceil(f.H + pad0Min - pad0Max))} mm hoog of leg de lamp liggend.`;
    const pad0 = clamp(f.H / 2 - Lg / 2 - sh - padT, pad0Min, pad0Max);
    const pad1 = pad0 + padT;
    // the gusset stays 10 mm below the mouth of the socket (away from the glass)
    const g = Math.max(0, Math.min(10, sh - CLEAR));
    const lastErr = 'De G9-houder past niet op de muurplaat (botst met de schroefgaten). Kies de andere schroefpotjes van de inbouwdoos of een grotere plaat.';
    for (const xc of [0, 14, -14, 22, -22]) {
      if (Math.abs(xc) + bw / 2 > f.face) continue;
      const yl = yLayout(xc - bw / 2, xc + bw / 2, Math.max(sd / 2, m10 ? G9_GUIDE.nut.d / 2 : spacing / 2 + 3));
      if (typeof yl === 'string') return yl;
      const { yc, yPadF } = yl;
      const gg = Math.max(0, Math.min(g, yc - sd / 2 - f.Tp - BR.base - 1));
      const [sx0, sx1] = sideXOver(freeLoop, f.Tp, yPadF);
      if (xc - bw / 2 < sx0 + 1 + rim || xc + bw / 2 > sx1 - 1 - rim) continue;
      const pl = f.planner.clone();
      const zs0 = Math.max(f.z0 + PLATE.rim + 0.5, pad0 - 20);
      const zs1 = Math.min(f.z0 + f.Hp - PLATE.rim - 0.5, pad1 + 26);
      // lead hole just below the pad (the wires come out of the nipple there)
      const leadC: [number, number][] = [];
      for (let z = pad0 - PLATE.lead - 0.5; z >= zs0 + PLATE.lead + 0.5; z -= 1) for (const dx of [0, 2, -2, 4, -4]) leadC.push([xc + dx, z]);
      const lead = pl.find(leadC, PLATE.lead, 1.5);
      if (!lead) continue;
      pl.add(lead[0], lead[1], PLATE.lead);
      // bracket screws side by side, above the gusset or below the pad
      const sx = bw / 2 - 3.5;
      const zc: number[] = [];
      for (let z = zs1 - 4.5; z >= pad1 + gg + 4.5; z -= 1) zc.push(z);
      for (let z = pad0 - 4.5; z >= zs0 + 4.5; z -= 1) zc.push(z);
      const zScrew = zc.find((z) => pl.ok(xc - sx, z, PLATE.bossBr) && pl.ok(xc + sx, z, PLATE.bossBr) && Math.hypot(lead[0] - (xc - sx), lead[1] - z) > PLATE.lead + 3.5 && Math.hypot(lead[0] - (xc + sx), lead[1] - z) > PLATE.lead + 3.5);
      if (zScrew === undefined) continue;
      pl.add(xc - sx, zScrew, PLATE.bossBr);
      pl.add(xc + sx, zScrew, PLATE.bossBr);
      const tie = pl.find(tieCands(lead, zScrew > lead[1] ? -1 : 1), 7, 1);
      f.planner.taken = pl.taken;
      if (tie) f.planner.add(tie[0], tie[1], 7);
      const mouthZ = pad1 + sh;
      const nutR = m10 ? G9_GUIDE.nut.d / 2 : 0;
      return {
        orient: 'vertical', axis: [0, 0, 1], base: [xc, yc, pad1], mouth: [xc, yc, mouthZ], tip: [xc, yc, mouthZ + Lg], r, sd, sh,
        x0: xc, yc, zc: mouthZ + Lg / 2, pad0, yPadF, bw, zs0: Math.min(zs0, lead[1] - PLATE.lead - 1, zScrew - 4), zs1: Math.max(zs1, zScrew + 4), baseLen: 0, gusset: gg,
        screws: [[xc - sx, zScrew], [xc + sx, zScrew]], lead, tie,
        foot: [
          [xc - bw / 2, xc + bw / 2, f.Tp, yPadF],
          [xc - Math.max(sd / 2, nutR, r), xc + Math.max(sd / 2, nutR, r), yc - Math.max(sd / 2, nutR, r), yc + Math.max(sd / 2, nutR, r)],
        ],
        glassFoot: [xc - r, xc + r, yc - r, yc + r],
        zMin: Math.min(Math.min(zs0, lead[1] - PLATE.lead - 1), pad0 - (m10 ? G9_GUIDE.nipple.len : 0)),
        zMax: mouthZ + Lg,
      };
    }
    return lastErr;
  }

  function sideways(): BulbLayout | string {
    const bh = Math.max(sd + 8, m10 ? 0 : spacing + 8, 26);
    const padT = BR.t;
    const zcMin = Math.max(f.z0 + PLATE.rim + 0.5 + bh / 2, f.floorT + r + CLEAR);
    const zcMax = f.z0 + f.Hp - PLATE.rim - 0.5 - bh / 2;
    if (zcMin > zcMax) return 'De muurplaat is te laag voor de G9-houder. Maak de plaat hoger.';
    const zc = clamp(f.H / 2, zcMin, zcMax);
    const start = Math.max(-f.face, -(padT + sh + Lg / 2));
    let err = '';
    for (let shiftX = 0; shiftX <= 30; shiftX += 3) {
      const xp = start + shiftX;
      const xm = xp + padT + sh;
      const nipX = xp - (m10 ? G9_GUIDE.nipple.len : 4);
      const yl = yLayout(xm, xm + Lg, Math.max(sd / 2, m10 ? G9_GUIDE.nut.d / 2 : 0));
      if (typeof yl === 'string') return yl;
      const { yc, yPadF } = yl;
      const half = Math.max(sd / 2, m10 ? G9_GUIDE.nut.d / 2 : 0);
      const [sx0, sx1] = sideXOver(freeLoop, yc - Math.max(half, r), yc + Math.max(half, r));
      if (xm + Lg > sx1 - Math.max(CLEAR, rim + 1)) {
        err = `De lamp is te smal voor een liggende G9-lamp met ${CLEAR} mm afstand: maak hem breder of zet de lamp staand.`;
        break;
      }
      if (nipX < sx0 + 1 + rim) {
        err = 'De lamp is te smal voor de G9-fitting. Maak hem breder.';
        continue;
      }
      const baseLen = Math.min(BR.len, f.face - xp);
      if (baseLen < 18) {
        err = 'De muurplaat is te smal voor de G9-houder. Maak de plaat breder.';
        break;
      }
      const g = Math.max(0, Math.min(10, sh - CLEAR, yc - sd / 2 - f.Tp - BR.base - 1, baseLen - padT - 9));
      const pl = f.planner.clone();
      // lead hole left of the pad, where the wires leave the nipple, or just under/over the bracket
      const leadC: [number, number][] = [];
      for (const dz of [0, 4, -4, 8, -8, 12, -12, 16, -16, 20, -20]) for (const dx of [0, -2, -4, 2]) leadC.push([xp - PLATE.lead - 1.5 + dx, zc + dz]);
      for (const dx of [4, 10, 16]) for (const sz of [-1, 1]) leadC.push([xp + dx, zc + sz * (bh / 2 + PLATE.lead + 1.5)]);
      const lead = pl.find(leadC, PLATE.lead, 1.5);
      if (!lead) {
        err = 'De G9-houder past niet op de muurplaat (botst met de schroefgaten). Kies de andere schroefpotjes van de inbouwdoos of een grotere plaat.';
        continue;
      }
      pl.add(lead[0], lead[1], PLATE.lead);
      const dz = Math.min(9, bh / 2 - 4.5);
      const xs: number[] = [];
      for (let x = xp + padT + g + 4.5; x <= xp + baseLen - 4.5; x += 1) xs.push(x);
      const xScrew = xs.find((x) => pl.ok(x, zc - dz, PLATE.bossBr) && pl.ok(x, zc + dz, PLATE.bossBr));
      if (xScrew === undefined) {
        err = 'De G9-houder past niet op de muurplaat (botst met de schroefgaten). Kies de andere schroefpotjes van de inbouwdoos of een grotere plaat.';
        continue;
      }
      pl.add(xScrew, zc - dz, PLATE.bossBr);
      pl.add(xScrew, zc + dz, PLATE.bossBr);
      const tie = pl.find(tieCands(lead, 1), 7, 1);
      f.planner.taken = pl.taken;
      if (tie) f.planner.add(tie[0], tie[1], 7);
      return {
        orient: 'sideways', axis: [1, 0, 0], base: [xp + padT, yc, zc], mouth: [xm, yc, zc], tip: [xm + Lg, yc, zc], r, sd, sh,
        x0: xp, yc, zc, pad0: 0, yPadF, bw: bh, zs0: zc - bh / 2, zs1: zc + bh / 2, baseLen, gusset: g,
        screws: [[xScrew, zc - dz], [xScrew, zc + dz]], lead, tie,
        foot: [
          [xp, xp + baseLen, f.Tp, f.Tp + BR.base],
          [xp, xp + padT, f.Tp, yPadF],
          [nipX, xm, yc - half, yc + half],
          [xm, xm + Lg, yc - r, yc + r],
        ],
        glassFoot: [xm, xm + Lg, yc - r, yc + r],
        zMin: zc - Math.max(bh / 2, half),
        zMax: zc + Math.max(bh / 2, half),
      };
    }
    return err || 'De G9-houder past niet in deze lamp. Maak de lamp groter.';
  }

  function tieCands(lead: [number, number], side: number): [number, number][] {
    const out: [number, number][] = [];
    for (const d of [13, 16, 20]) out.push([lead[0], lead[1] + side * d], [lead[0] + 13, lead[1]], [lead[0] - 13, lead[1]], [lead[0], lead[1] - side * d]);
    return out;
  }
}

/** Ring of a flange of width fw on the given inner region (front and sides only). */
function flangeRing(M: ManifoldToplevel, base: CrossSection, fw: number, yb: number): CrossSection {
  return base.subtract(base.offset(-fw, 'Miter', 2)).subtract(rect(M, -1e3, 1e3, -10, yb + 5));
}

const riseOf = (fw: number, wall: number) => (fw + 0.7 * wall + 0.3) * 1.03;

/** Largest flange width ≤ want that keeps 10 mm from the glass and clears the assembly. */
function clampFlange(M: ManifoldToplevel, want: number, base: CrossSection, wall: number, yb: number, end: 'near' | 'far', H: number, b: BulbLayout, foot: CrossSection): number {
  if (want <= 0) return 0;
  const glass = rect(M, ...b.glassFoot);
  const gz0 = Math.min(b.mouth[2], b.tip[2]) - b.r;
  const gz1 = Math.max(b.mouth[2], b.tip[2]) + b.r;
  const ok = (fw: number) => {
    const span = FLANGE_T + riseOf(fw, wall);
    const [z0, z1] = end === 'far' ? [H - span, H] : [0, span];
    const ring = flangeRing(M, base, fw, yb);
    // far end: the housing slides over the bulb, so the whole assembly must pass through
    const sweep = end === 'far' || b.zMin < z1 + 1;
    if (sweep && ring.intersect(foot.offset(1, 'Miter', 2)).area() > 0.01) return false;
    const near = gz1 > z0 - CLEAR && gz0 < z1 + CLEAR;
    if (near && ring.intersect(glass.offset(CLEAR, 'Round', 2, 48)).area() > 0.01) return false;
    return true;
  };
  if (ok(want)) return want;
  let lo = 0;
  let hi = want;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  return Math.floor(lo * 2) / 2;
}

// ---------------------------------------------------------------------------
// Parts (frame coordinates unless noted)

/** Flange at the near (z = 0) or far (z = H) end: flat ring with a 45° underside. */
function flangeSolid(M: ManifoldToplevel, base: CrossSection, fw: number, wall: number, yb: number, end: 'near' | 'far', H: number): Manifold | null {
  const loops = loopsOf(base).outers;
  if (loops.length !== 1 || fw <= 0) return null;
  const loop = resample(loops[0], 1);
  const din = 0.7 * wall;
  const dOut = din + 0.3;
  const rise = riseOf(fw, wall);
  const slab2D = base.offset(din, 'Miter', 2).subtract(rect(M, -1e3, 1e3, -10, yb + 5));
  if (slab2D.isEmpty()) return null;
  // the back (towards the wall) stays open: the plate and the assembly slide through there
  const weights = loop.map(([, y]) => smoothstep(yb, yb + 5, y));
  try {
    if (end === 'far') {
      const zIn = H - FLANGE_T;
      const zWall = zIn - rise;
      const slab = slab2D.extrude(H - zWall).translate([0, 0, zWall]);
      const open = loftLoop(M, loop, [{ t: zWall - 1, d: -dOut }, { t: zWall, d: -dOut }, { t: zIn, d: fw }, { t: H + 1, d: fw }], weights);
      return slab.subtract(open);
    }
    const zIn = FLANGE_T;
    const zWall = zIn + rise;
    const slab = slab2D.extrude(zWall);
    const open = loftLoop(M, loop, [{ t: -1, d: fw }, { t: zIn, d: fw }, { t: zWall, d: -dOut }, { t: zWall + 1, d: -dOut }], weights);
    return slab.subtract(open);
  } catch {
    return null;
  }
}

interface HoleSet {
  cutters: Manifold | null;
  count: number;
}

/**
 * Perforation cutters: convex prisms square to the wall, spaced along the
 * inner face (where the webs are narrowest) on a staggered lattice, only on
 * the front and sides and clear of the ends.
 */
function holeCutters(M: ManifoldToplevel, L: WallLayout, zLo: number, zHi: number, inExtra: number, both: boolean, notes: string[] | null): HoleSet {
  const h = L.holes!;
  const poly = holePoly(h.shape, h.size, both);
  let vMin = Infinity;
  let vMax = -Infinity;
  let uMax = 0;
  for (const [u, v] of holePoly(h.shape, h.size, true)) {
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
    uMax = Math.max(uMax, Math.abs(u));
  }
  const base = L.outline.loop;
  const nrm = unitNormals(base);
  const inner = offsetLoop(base, -L.t);
  const n = base.length;
  const yMin = L.yb + 6 + uMax;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(inner[(i + 1) % n][0] - inner[i][0], inner[(i + 1) % n][1] - inner[i][1]));
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++)
    if (base[i][1] >= yMin) {
      if (first < 0) first = i;
      last = i;
    }
  const z0 = zLo - vMin;
  const z1 = zHi - vMax;
  if (first < 0 || z1 < z0) {
    notes?.push('Te weinig ruimte voor gaatjes in deze kap.');
    return { cutters: null, count: 0 };
  }
  const s0 = cum[first] + uMax;
  const s1 = cum[last] - uMax;
  let ps = h.ps;
  let pz = h.pz;
  const est = ((s1 - s0) / ps + 1) * ((z1 - z0) / pz + 1);
  const MAX = 1400;
  if (est > MAX) {
    const k = Math.sqrt(est / MAX);
    ps *= k;
    pz *= k;
    notes?.push('Veel gaatjes: de onderlinge afstand is wat groter gemaakt zodat het model snel blijft.');
  }
  if (s1 < s0) return { cutters: null, count: 0 };
  const ncol = Math.max(1, Math.floor((s1 - s0) / ps) + 1);
  const psA = ncol > 1 ? (s1 - s0) / (ncol - 1) : 0;
  const nrow = Math.max(1, Math.floor((z1 - z0) / pz) + 1);
  const pzA = nrow > 1 ? (z1 - z0) / (nrow - 1) : 0;
  const wIn = -(L.t / 2 + inExtra);
  const wOut = L.t / 2 + L.relief + 1.5;
  const parts: Manifold[] = [];
  let j = first;
  const at = (s: number) => {
    while (j < last && cum[j + 1] < s) j++;
    while (j > first && cum[j] > s) j--;
    const f = clamp((s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]), 0, 1);
    const k = (j + 1) % n;
    const px = base[j][0] + (base[k][0] - base[j][0]) * f;
    const py = base[j][1] + (base[k][1] - base[j][1]) * f;
    let nx = nrm[j][0] + (nrm[k][0] - nrm[j][0]) * f;
    let ny = nrm[j][1] + (nrm[k][1] - nrm[j][1]) * f;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    return { px, py, nx, ny };
  };
  for (let row = 0; row < nrow; row++) {
    const zc = nrow > 1 ? z0 + row * pzA : (z0 + z1) / 2;
    const odd = row % 2 === 1 && ncol > 1;
    const count = odd ? ncol - 1 : ncol;
    for (let i = 0; i < count; i++) {
      const s = ncol > 1 ? s0 + (i + (odd ? 0.5 : 0)) * psA : (s0 + s1) / 2;
      const q = at(s);
      if (q.py < yMin) continue;
      const tx = -q.ny;
      const ty = q.nx;
      // centre of the hole in the middle of the wall
      const cx = q.px - q.nx * (L.t / 2);
      const cy = q.py - q.ny * (L.t / 2);
      const pts: Vec3[] = [];
      for (const w of [wIn, wOut]) for (const [uu, vv] of poly) pts.push([cx + tx * uu + q.nx * w, cy + ty * uu + q.ny * w, zc + vv]);
      parts.push(M.Manifold.hull(pts));
    }
  }
  if (!parts.length) return { cutters: null, count: 0 };
  return { cutters: M.Manifold.compose(parts), count: parts.length };
}

/** Near and far z limits for perforations (clear of flanges, floor and rims). */
function holeZone(L: WallLayout): [number, number] {
  const near = (L.nearClosed ? L.floorT : 0) + (L.nearFw > 0 ? FLANGE_T + riseOf(L.nearFw, L.t) : 0) + 4;
  const farWall = L.reflector ? REFL.t : L.t;
  const far = L.H - (L.farFw > 0 ? FLANGE_T + riseOf(L.farFw, farWall) : 0) - 4;
  return [near, far];
}

function housingSolid(M: ManifoldToplevel, L: WallLayout, notes: string[]): { solid: Manifold; holes: number } {
  const { H, t, yb } = L;
  const { W: Wp, T: Tp } = L.plate;
  const outerCS = cs(M, [L.outerLoop]);
  const innerCS = outerCS.offset(-t, 'Miter', 2);
  const pieces: Manifold[] = [outerCS.subtract(innerCS).extrude(H)];
  if (L.nearClosed) pieces.push(outerCS.extrude(L.floorT));
  const fl = (fw: number, end: 'near' | 'far') => {
    const s = flangeSolid(M, L.ctx.baseInner, fw, t, yb, end, H);
    if (s) pieces.push(s);
    else notes.push('De rand kon niet gemaakt worden in deze vorm en is weggelaten.');
  };
  if (L.nearFw > 0) fl(L.nearFw, 'near');
  if (L.farFw > 0 && !L.reflector) fl(L.farFw, 'far');
  // channels around the plate edges (rib + lip) and the pillars the plate rests on
  const lipY = Tp - CH.flange - CH.c;
  const back = Wp / 2 - CH.rabbet + CH.c;
  for (const s of [-1, 1]) {
    const a = Wp / 2 + CH.c;
    // rib beside the flange, lip in the rabbet behind it
    const ribLip = M.CrossSection.union([rect(M, s * a, s * (a + CH.rib), 0, yb), rect(M, s * back, s * a, 0, lipY)]);
    pieces.push(ribLip.extrude(H));
    pieces.push(rect(M, s * (Wp / 2 - CH.rabbet - PLATE.cornerW), s * (a + CH.rib), 0, yb).extrude(CH.pillarH));
  }
  let solid = M.Manifold.union(pieces);
  // room for the plate from the pillars to the far end (it slides in from there)
  const cut: Manifold[] = [box(M, -Wp / 2 - CH.c, Wp / 2 + CH.c, lipY, Tp + CH.c, CH.pillarH, H + 1), box(M, -back, back, -1, lipY + 0.01, CH.pillarH, H + 1)];
  for (const s of [-1, 1]) {
    const x = s * L.lockX;
    cut.push(M.Manifold.cylinder(CH.pillarH + 2, LOCK.clear / 2, LOCK.clear / 2, 24).translate([x, L.lockY, -1]));
    const sink = (LOCK.headD - LOCK.clear) / 2;
    cut.push(M.Manifold.cylinder(sink + 0.01, LOCK.headD / 2, LOCK.clear / 2, 32).translate([x, L.lockY, -0.01]));
    cut.push(M.Manifold.cylinder(1.01, LOCK.headD / 2, LOCK.headD / 2, 32).translate([x, L.lockY, -1]));
  }
  if (L.window > 0) {
    const [gx0, gx1, gy0, gy1] = L.bulb.glassFoot;
    cut.push(M.Manifold.cylinder(L.floorT + 2, L.window / 2, L.window / 2, 64).translate([(gx0 + gx1) / 2, (gy0 + gy1) / 2, -1]));
  }
  let count = 0;
  if (L.holes) {
    const [zLo, zHi] = holeZone(L);
    const hs = holeCutters(M, L, zLo, zHi, 1, false, notes);
    if (hs.cutters) cut.push(hs.cutters);
    count = hs.count;
  }
  solid = solid.subtract(M.Manifold.union(cut));
  return { solid, holes: count };
}

function reflectorSolid(M: ManifoldToplevel, L: WallLayout): Manifold {
  const { H, yb } = L;
  const base = L.ctx.baseInner;
  const outer = base.offset(-REFL.gap, 'Miter', 2);
  const inner = base.offset(-REFL.gap - REFL.t, 'Miter', 2);
  const back = rect(M, -1e3, 1e3, -10, yb + 0.5);
  const zLow = (L.nearClosed ? L.floorT : 0) + (L.nearFw > 0 ? FLANGE_T + riseOf(L.nearFw, L.t) : 0) + 0.5;
  const pieces: Manifold[] = [outer.subtract(inner).subtract(back).extrude(H - zLow).translate([0, 0, zLow])];
  pieces.push(cs(M, [L.outerLoop]).subtract(inner).subtract(back).extrude(REFL.lip).translate([0, 0, H]));
  if (L.farFw > 0) {
    // the flange top is level with the lip, so it lies on the bed when printed upside down
    const f = flangeSolid(M, inner, L.farFw, REFL.t, yb, 'far', H + REFL.lip);
    if (f) pieces.push(f);
  }
  let solid = M.Manifold.union(pieces);
  if (L.holes) {
    const [zLo, zHi] = holeZone(L);
    const hs = holeCutters(M, L, zLo, zHi, REFL.gap + REFL.t + 1.5, true, null);
    if (hs.cutters) solid = solid.subtract(hs.cutters);
  }
  return solid;
}

/**
 * Wall plate in print coordinates: front face on the bed (Z = 0), wall side
 * up (Z = T), X along the wall, Y up the wall from the box centre.
 */
function plateSolid(M: ManifoldToplevel, L: WallLayout): Manifold {
  const { W: Wp, H: Hp, T: Tp, zb } = L.plate;
  const fT = PLATE.front;
  const Y = (z: number) => z - zb;
  const add: Manifold[] = [];
  const cut: Manifold[] = [];
  // full-width front flange, narrower behind it (the rabbets take the lips of the housing)
  const backW = Wp - 2 * CH.rabbet;
  const slab = M.Manifold.union([cs(M, [roundRect(Wp, Hp, PLATE.r)]).extrude(CH.flange), cs(M, [roundRect(backW, Hp, PLATE.r)]).extrude(Tp)]);
  const cavity = cs(M, [roundRect(backW - 2 * PLATE.rim, Hp - 2 * PLATE.rim, 1)]).extrude(Tp).translate([0, 0, fT]);
  const boss = (x: number, z: number, r: number) => add.push(M.Manifold.cylinder(Tp - fT + 0.01, r, r, 32).translate([x, Y(z), fT - 0.01]));
  // corner blocks take the lock screws (in from the bottom and the top edge)
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x0 = sx * (backW / 2 - PLATE.cornerW);
      const y0 = sy * (Hp / 2 - PLATE.cornerH);
      add.push(box(M, x0, sx * (backW / 2 - 0.5), y0, sy * (Hp / 2 - 0.5), fT - 0.01, Tp));
      cut.push(tearHole(M, LOCK.pilot / 2, 2 * 12, [sx * L.lockX, sy * Hp / 2, Tp - L.lockY], [0, 1, 0], [0, 0, 1]));
    }
  const sink = (d: number, clear: number, x: number, z: number) => {
    cut.push(M.Manifold.cylinder(Tp + 2, clear / 2, clear / 2, 32).translate([x, Y(z), -1]));
    cut.push(M.Manifold.cylinder((d - clear) / 2 + 0.01, d / 2, clear / 2, 32).translate([x, Y(z), -0.01]));
    cut.push(M.Manifold.cylinder(1.01, d / 2, d / 2, 32).translate([x, Y(z), -1]));
  };
  for (const [x, z] of L.boxHoles) {
    boss(x, z, PLATE.bossBox);
    sink(FLUSH_BOX.headD, FLUSH_BOX.clear, x, z);
  }
  if (L.keyholes) {
    for (const [x, z] of L.plugHoles) {
      // the screw head goes in through the round hole, the plate drops onto the shank (slot above)
      const head = PLUG.headD / 2 + 0.5;
      add.push(cs(M, [roundRect(2 * head + 6, 9 + 2 * head + 6, 3)]).translate([x, Y(z) - 4.5]).extrude(Tp - fT + 0.01).translate([0, 0, fT - 0.01]));
      const slot = M.CrossSection.hull([M.CrossSection.circle(PLUG.clear / 2, 32).translate([x, Y(z)]), M.CrossSection.circle(PLUG.clear / 2, 32).translate([x, Y(z) - 9])]);
      const shape = slot.add(M.CrossSection.circle(head, 48).translate([x, Y(z) - 9]));
      cut.push(shape.extrude(fT + 2).translate([0, 0, -1]));
      const channel = M.CrossSection.hull([M.CrossSection.circle(head, 48).translate([x, Y(z)]), M.CrossSection.circle(head, 48).translate([x, Y(z) - 9])]);
      cut.push(channel.extrude(Tp).translate([0, 0, fT]));
    }
  } else
    for (const [x, z] of L.plugHoles) {
      boss(x, z, PLATE.bossPlug);
      sink(PLUG.headD, PLUG.clear, x, z);
    }
  const b = L.bulb;
  for (const [x, z] of b.screws) {
    boss(x, z, PLATE.bossBr);
    cut.push(M.Manifold.cylinder(Tp + 2, BRACKET_SCREW.pilot / 2, BRACKET_SCREW.pilot / 2, 24).translate([x, Y(z), -1]));
  }
  // lead hole with rounded-off (chamfered) edges for the wires
  const [lx, lz] = b.lead;
  cut.push(M.Manifold.cylinder(fT + 2, PLATE.lead, PLATE.lead, 40).translate([lx, Y(lz), -1]));
  cut.push(M.Manifold.cylinder(1.01, PLATE.lead + 1, PLATE.lead, 40).translate([lx, Y(lz), -0.01]));
  // cable-tie block: the tie goes through a tunnel with a pointed roof
  if (b.tie) {
    const [tx, tz] = b.tie;
    add.push(box(M, tx - 6, tx + 6, Y(tz) - 4, Y(tz) + 4, fT - 0.01, fT + 7.5));
    const tunnel = cs(M, [
      [
        [Y(tz) - 2.5, fT + 1.2],
        [Y(tz) + 2.5, fT + 1.2],
        [Y(tz) + 2.5, fT + 3],
        [Y(tz), fT + 5.5],
        [Y(tz) - 2.5, fT + 3],
      ],
    ])
      .extrude(16)
      .transform(asMat4(basis([0, 1, 0], [0, 0, 1], [1, 0, 0], [tx - 8, 0, 0])));
    cut.push(tunnel);
  }
  return slab.subtract(cavity).add(M.Manifold.union(add)).subtract(M.Manifold.union(cut));
}

function roundRect(w: number, h: number, r: number): Vec2[] {
  const pts: Vec2[] = [];
  const cx = w / 2 - r;
  const cy = h / 2 - r;
  const corners: [number, number, number][] = [
    [cx, cy, 0],
    [-cx, cy, 90],
    [-cx, -cy, 180],
    [cx, -cy, 270],
  ];
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= 6; i++) {
      const a = ((a0 + (90 * i) / 6) * Math.PI) / 180;
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  return pts;
}

/** Socket bracket in frame coordinates. */
function bracketSolid(M: ManifoldToplevel, L: WallLayout, m10: boolean, spacing: number): Manifold {
  const b = L.bulb;
  const Tp = L.plate.T;
  const cut: Manifold[] = [];
  let solid: Manifold;
  if (b.orient === 'vertical') {
    // side profile (y, z), extruded along x; prints lying on its side (x up)
    const pad1 = b.pad0 + BR.t;
    const prof: Vec2[][] = [
      [
        [Tp, b.zs0],
        [Tp + BR.base, b.zs0],
        [Tp + BR.base, b.pad0],
        [b.yPadF, b.pad0],
        [b.yPadF, pad1],
        [Tp + BR.base + b.gusset, pad1],
        [Tp + BR.base, pad1 + b.gusset],
        [Tp + BR.base, b.zs1],
        [Tp, b.zs1],
      ],
    ];
    solid = cs(M, prof)
      .extrude(b.bw)
      .transform(asMat4(basis([0, 1, 0], [0, 0, 1], [1, 0, 0], [b.x0 - b.bw / 2, 0, 0])));
    const up: Vec3 = [1, 0, 0];
    const padMid: Vec3 = [b.x0, b.yc, b.pad0 + BR.t / 2];
    if (m10) cut.push(tearHole(M, G9_GUIDE.nipple.hole / 2, BR.t + 2, padMid, [0, 0, 1], up));
    else {
      cut.push(tearHole(M, 3.5, BR.t + 2, padMid, [0, 0, 1], up));
      for (const s of [-1, 1]) cut.push(tearHole(M, BRACKET_SCREW.pilot / 2, BR.t + 2, [b.x0 + (s * spacing) / 2, b.yc, padMid[2]], [0, 0, 1], up));
    }
    for (const [x, z] of b.screws) cut.push(tearHole(M, BRACKET_SCREW.clear / 2, BR.base + 2, [x, Tp + BR.base / 2, z], [0, 1, 0], up));
    cut.push(tearHole(M, PLATE.lead, BR.base + 2, [b.lead[0], Tp + BR.base / 2, b.lead[1]], [0, 1, 0], up));
  } else {
    // plan profile (x, y), extruded along z; prints standing as used
    const xp = b.x0;
    const prof: Vec2[][] = [
      [
        [xp, Tp],
        [xp + b.baseLen, Tp],
        [xp + b.baseLen, Tp + BR.base],
        [xp + BR.t + b.gusset, Tp + BR.base],
        [xp + BR.t, Tp + BR.base + b.gusset],
        [xp + BR.t, b.yPadF],
        [xp, b.yPadF],
      ],
    ];
    solid = cs(M, prof).extrude(b.bw).translate([0, 0, b.zc - b.bw / 2]);
    const up: Vec3 = [0, 0, 1];
    const padMid: Vec3 = [xp + BR.t / 2, b.yc, b.zc];
    if (m10) cut.push(tearHole(M, G9_GUIDE.nipple.hole / 2, BR.t + 2, padMid, [1, 0, 0], up));
    else {
      cut.push(tearHole(M, 3.5, BR.t + 2, padMid, [1, 0, 0], up));
      for (const s of [-1, 1]) cut.push(tearHole(M, BRACKET_SCREW.pilot / 2, BR.t + 2, [padMid[0], b.yc, b.zc + (s * spacing) / 2], [1, 0, 0], up));
    }
    for (const [x, z] of b.screws) cut.push(tearHole(M, BRACKET_SCREW.clear / 2, BR.base + 2, [x, Tp + BR.base / 2, z], [0, 1, 0], up));
  }
  return solid.subtract(M.Manifold.union(cut));
}

/** Glass of the bulb (capsule), socket body and nut in frame coordinates. */
function bulbSolids(M: ManifoldToplevel, L: WallLayout, m10: boolean) {
  const b = L.bulb;
  const a = b.axis;
  const at = (p: Vec3, d: number): Vec3 => [p[0] + a[0] * d, p[1] + a[1] * d, p[2] + a[2] * d];
  const len = Math.hypot(b.tip[0] - b.mouth[0], b.tip[1] - b.mouth[1], b.tip[2] - b.mouth[2]);
  const glass = M.Manifold.hull([M.Manifold.sphere(b.r, 32).translate(at(b.mouth, b.r)), M.Manifold.sphere(b.r, 32).translate(at(b.mouth, len - b.r))]);
  const socket = cylAlong(M, b.sd / 2, b.sh, at(b.base, b.sh / 2), a, 40);
  const nut = m10
    ? M.Manifold.union([
        cylAlong(M, G9_GUIDE.nut.d / 2, G9_GUIDE.nut.h, at(b.base, -BR.t - G9_GUIDE.nut.h / 2), a, 6),
        cylAlong(M, G9_GUIDE.nipple.d / 2, G9_GUIDE.nipple.len, at(b.base, -G9_GUIDE.nipple.len / 2), a, 24),
      ])
    : null;
  return { glass, socket, nut };
}

// ---------------------------------------------------------------------------
// Build

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const L = wallLayout(p, M, printer);
  const notes = [...L.notes];
  const tips: string[] = [];
  const { W, D, H, dir } = L;
  const { W: Wp, H: Hp, T: Tp, zb } = L.plate;
  const m10 = str(p, 'sockMount') !== 'schroeven';
  const spacing = clamp(num(p, 'sockSpacing') || 24, 8, 50);
  const color = String(p.color || '#d8c3a0');
  const plateColor = String(p.plateColor || WHITE);
  const reflColor = String(p.reflColor || WHITE);

  // frame → world: the wall is the plane y = 0, the lamp stands in front of it (−y)
  const F2W: M4 = dir === 'down' ? mul(translation(0, 0, H), rotX(180)) : rotZ(180);
  const P2F: M4 = mul(translation(0, Tp, zb), rotX(90));
  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];

  const housing = housingSolid(M, L, notes);
  const housingMat = L.translucent ? 'petg-translucent' : 'petg-hf';
  parts.push({ name: 'Kap', solid: housing.solid, color, material: housingMat, purpose: 'lamp' });
  scene.push({ kind: 'part', part: 0, matrix: F2W });

  const platePrint = plateSolid(M, L);
  parts.push({ name: 'Muurplaat', solid: platePrint, color: plateColor, material: 'petg-hf' });
  scene.push({ kind: 'part', part: 1, matrix: mul(F2W, P2F) });

  const bracketFrame = bracketSolid(M, L, m10, spacing);
  const B2P: M4 = L.bulb.orient === 'vertical' ? rotY(-90) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const B2F: M4 = L.bulb.orient === 'vertical' ? rotY(90) : B2P;
  parts.push({ name: 'G9-houder', solid: bracketFrame.transform(asMat4(B2P)), color: plateColor, material: printer.enclosed ? 'asa' : 'petg-hf', purpose: 'lamp' });
  scene.push({ kind: 'part', part: 2, matrix: mul(F2W, B2F) });

  let reflFrame: Manifold | null = null;
  if (L.reflector) {
    reflFrame = reflectorSolid(M, L);
    parts.push({ name: 'Reflector', solid: reflFrame.transform(asMat4(rotX(180))), color: reflColor, material: 'petg-hf', purpose: 'lamp' });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: mul(F2W, rotX(180)) });
  }

  // printer check for every part in its print orientation
  const u = usable(printer);
  for (const part of parts) {
    const bb = part.solid.boundingBox();
    const size: [number, number, number] = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
    if (!fitsOn(printer, size)) throw new UserError(`${part.name} (${size.map((v) => mm(v)).join(' × ')} mm) past niet op de printplaat van de ${printer.name} (${u.x} × ${u.y} × ${u.z} mm). Maak de lamp kleiner.`);
  }

  // bulb clearance to every printed part (10 mm)
  const bs = bulbSolids(M, L, m10);
  const frames: [string, Manifold][] = [
    ['de kap', housing.solid],
    ['de muurplaat', platePrint.transform(asMat4(P2F))],
    ['de houder', bracketFrame],
  ];
  if (reflFrame) frames.push(['de reflector', reflFrame]);
  let gap = Infinity;
  let gapTo = '';
  for (const [name, s] of frames) {
    const g = s.minGap(bs.glass, CLEAR + 5);
    if (g < gap) {
      gap = g;
      gapTo = name;
    }
  }
  if (gap < CLEAR - 0.05) throw new UserError(`De lamp zit maar ${mm(gap, 1)} mm van ${gapTo}; minstens ${CLEAR} mm is nodig. Maak de lamp groter of de rand kleiner.`);

  // ghosts: wall, flush box, Wago connectors, socket, bulb
  const toWorld = (m: Manifold) => m.transform(asMat4(F2W));
  const zWorld = (z: number) => (dir === 'down' ? H - z : z);
  scene.push({ kind: 'box', size: [W + 60, 6, H + 60], position: [-W / 2 - 30, 0, -30], color: '#d8d2c8', material: 'ghost', label: 'Muur' });
  const boxCyl = M.Manifold.cylinder(FLUSH_BOX.depth, FLUSH_BOX.holeD / 2, FLUSH_BOX.holeD / 2, 64).transform(asMat4(rotX(-90))).translate([0, 0.5, zWorld(zb)]);
  scene.push({ kind: 'mesh', mesh: meshOf(boxCyl), color: '#8a8f98', material: 'ghost', label: 'Inbouwdoos Ø68' });
  for (const dx of [-21, 0, 21]) {
    const wago = box(M, dx - WAGO.w / 2, dx + WAGO.w / 2, 1, 1 + WAGO.h, zb + 5, zb + 5 + WAGO.d);
    scene.push({ kind: 'mesh', mesh: meshOf(toWorld(wago)), color: '#e07b39', material: 'ghost', label: 'Wago 221' });
  }
  scene.push({ kind: 'mesh', mesh: meshOf(toWorld(bs.socket)), color: '#6b6f76', material: 'ghost', label: 'G9-fitting (keramisch)' });
  if (bs.nut) scene.push({ kind: 'mesh', mesh: meshOf(toWorld(bs.nut)), color: '#6b6f76', material: 'ghost', label: 'M10-nippel en moer' });
  scene.push({ kind: 'mesh', mesh: meshOf(toWorld(bs.glass)), color: '#f3d36b', material: 'ghost', label: 'G9 LED' });

  // ---- info
  const dirLabel = dir === 'both' ? 'omhoog en omlaag' : dir === 'up' ? 'omhoog (onderkant dicht)' : 'omlaag (bovenkant dicht)';
  const boxFromBottom = dir === 'down' ? H - zb : zb;
  const opening = farOpening(L);
  const kv: [string, string][] = [
    ['Maat', `${mm(W)} × ${mm(D)} × ${mm(H)} mm (b × d × h)`],
    ['Vorm', SHAPES.find((s) => s.value === L.shape)?.label ?? L.shape],
    ['Licht', dirLabel + (L.farFw > 0 || L.nearFw > 0 ? `, rand ${[L.farFw > 0 ? `${mm(L.farFw)} mm ${dir === 'down' ? 'onder' : 'boven'}` : '', L.nearFw > 0 ? `${mm(L.nearFw)} mm onder` : ''].filter(Boolean).join(' en ')}` : '')],
    ['Lamp', `G9 LED Ø${mm(2 * L.bulb.r)} mm, ${L.bulb.orient === 'vertical' ? `staand, naar ${dir === 'down' ? 'beneden' : 'boven'}` : 'liggend langs de muur'}`],
    ['Afstand lamp – kunststof', `${mm(Math.min(gap, CLEAR + 5), 1)} mm${gap >= CLEAR + 5 ? ' of meer' : ''} (tot ${gapTo}; minimaal ${CLEAR} mm)`],
    ['Wand', `${mm(L.t, 1)} mm${L.translucent ? ' doorschijnend' : ''}${L.relief > 0 ? `, ${str(p, 'pattern') === 'plisse' ? 'plissé' : 'ribbels'} ${mm(L.relief, 1)} mm diep` : ''}${L.holes ? `, ${housing.holes} gaatjes (brug ≥ ${mm(L.holes.web, 1)} mm)` : ''}`],
    ['Inbouwdoos', `hart ${mm(boxFromBottom)} mm boven de onderkant van de kap, midden van de breedte`],
    ['Muurplaat', `${mm(Wp)} × ${mm(Hp)} × ${mm(Tp)} mm, holte ${mm(Wp - 2 * CH.rabbet - 2 * PLATE.rim)} × ${mm(Hp - 2 * PLATE.rim)} × ${mm(Tp - PLATE.front)} mm`],
    ['Lamp wisselen', opening >= 40 ? `via de ${dir === 'down' ? 'onderkant' : 'bovenkant'} (opening ≈ ${mm(opening)} mm rond de lamp)` : 'borgschroeven los en de kap eraf schuiven'],
  ];
  const info: InfoBlock[] = [{ kind: 'kv', title: 'Wandlamp', rows: kv }];
  const print = (name: string): string =>
    name === 'Kap'
      ? dir === 'down'
        ? 'ondersteboven (dichte kant op het bed)'
        : 'rechtop zoals hij hangt'
      : name === 'Muurplaat'
        ? 'voorkant op het bed'
        : name === 'Reflector'
          ? 'ondersteboven (randje op het bed)'
          : L.bulb.orient === 'vertical'
            ? 'op de zijkant'
            : 'rechtop zoals hij hangt';
  info.push({
    kind: 'table',
    title: 'Printdelen',
    headers: ['Onderdeel', 'Kleur', 'Filament', 'Printstand'],
    rows: parts.map((q) => [q.name, colorName(q.color ?? WHITE), q.material === 'petg-translucent' ? 'PETG Translucent (of PLA Translucent)' : q.material === 'asa' ? 'ASA (of PETG)' : 'PETG', print(q.name)]),
  });
  info.push({ kind: 'table', title: 'Benodigdheden', headers: ['#', 'Onderdeel'], rows: hardware(L, m10, spacing) });
  info.push({ kind: 'text', title: 'Montage', text: assembly(L, m10, opening >= 40) });
  info.push({
    kind: 'text',
    title: 'Veiligheid',
    text: [
      'Alleen een G9 LED-lamp (max. ~4 W). Een G9-halogeenlamp (25–40 W) wordt veel te heet en laat de kunststof smelten.',
      'De lamp is volledig van kunststof (klasse II, dubbel geïsoleerd): er hoort geen aarde aan. Zit er een aardedraad in de doos, zet die apart in een eigen Wago-klem en laat hem in de doos.',
      'Alle aansluitingen zitten in de Wago-klemmen in de inbouwdoos of de holte van de muurplaat; nergens blanke draad buiten de klemmen. De draden van de fitting lopen door het gat in de plaat en zitten vast met een kabelbinder.',
      'Zet de groep uit in de meterkast voordat je begint, en laat vaste bedrading aansluiten of controleren door een vakkundig iemand.',
    ].join('\n'),
  });
  if (L.holes) {
    const web = latticeWeb(holePoly(L.holes.shape, L.holes.size), L.holes.ps, L.holes.pz);
    info.push({ kind: 'kv', title: 'Gaatjes', rows: [['Aantal', String(housing.holes)], ['Vorm', L.holes.shape === 'ruit' ? `ruit ${mm(L.holes.size, 1)} mm (45°)` : `druppel ${mm(L.holes.size, 1)} mm`], ['Kleinste brug', `${mm(web, 1)} mm (gevraagd ${mm(L.holes.web, 1)})`]] });
  }

  tips.push(
    dir === 'down'
      ? 'Kap: print ondersteboven met de dichte kant op het bed. De wanden staan recht en de randen hebben een schuine kant van 45°, dus support is niet nodig.'
      : 'Kap: print rechtop zoals hij hangt. De wanden staan recht en de randen hebben een schuine kant van 45°, dus support is niet nodig. Een brim van 5 mm helpt bij een dunne wand.',
    'Muurplaat: voorkant op het bed, 3 wanden en 20% vulling. De gaten voor de borgschroeven in de zijkant zijn druppelvormig en printen zonder support.',
    `G9-houder: ${L.bulb.orient === 'vertical' ? 'op de zijkant, zoals hij in de printplaat ligt' : 'rechtop'}, 4 wanden en 40% vulling, in PETG of — op een gesloten printer — ASA: hij zit het dichtst bij de lamp.`,
    'Gebruik PETG (of ASA) voor alles wat bij de lamp zit: PLA wordt al bij ~55 °C zacht.',
  );
  if (L.translucent) tips.push(`Doorschijnend: 2 wandlijnen (${mm(L.t, 1)} mm wand), 0% vulling, iets minder koeling en een iets hogere temperatuur maken het helderder.`);
  if (L.relief > 0) tips.push('Plissé en ribbels: zet de naad op "achter" of "uitgelijnd" zodat hij tegen de muur valt.');
  if (L.holes) tips.push(`Gaatjes: elk gaatje loopt aan de bovenkant spits toe onder 45°, dus de kap print zonder support. De brug tussen de gaatjes is minstens ${mm(L.holes.web, 1)} mm.`);
  if (L.reflector) tips.push('Reflector: print ondersteboven met het randje op het bed, in wit PETG. Hij hangt met het randje op de bovenrand van de kap en kaatst het licht naar buiten.');
  if (L.reflector && L.translucent) notes.push('Met een reflector schijnt de doorschijnende wand nauwelijks meer door.');
  if (dir === 'down') tips.push('Alleen omlaag: de borgschroeven zitten bovenop de kap, tegen de muur. Bij een lamp boven ooghoogte zie je ze niet.');
  tips.push('Meet je fitting en lamp na: de maten zijn richtwaarden. Past de nippel niet, boor het gat dan iets ruimer.');

  return { parts, scene, info, tips, warnings: notes, defaultView: 'assembly' };
}

/** Smallest distance from the bulb axis to the edge of the far opening (to reach the bulb by hand). */
function farOpening(L: WallLayout): number {
  const b = L.bulb;
  const [x0, x1, y0, y1] = b.glassFoot;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const free = L.farFw + (L.reflector ? REFL.gap + REFL.t : 0);
  const loop = L.ctx.freeLoop;
  let m = Infinity;
  for (const [x, y] of loop) if (y > L.yb + 1) m = Math.min(m, Math.hypot(x - cx, y - cy));
  m = Math.min(m - free, cy - L.yb);
  return Math.max(0, 2 * m);
}

function hardware(L: WallLayout, m10: boolean, spacing: number): (string | number)[][] {
  const rows: (string | number)[][] = [
    [1, m10 ? `Keramische G9-fitting met M10×1-nippel en moer (richtmaat Ø${mm(L.bulb.sd, 1)} × ${mm(L.bulb.sh, 1)} mm) met hittebestendige aansluitdraden (siliconen/teflon, 0,5–0,75 mm²)` : `Keramische G9-fitting met 2 bevestigingsgaten M3, gatafstand ${mm(spacing, 1)} mm (richtmaat Ø${mm(L.bulb.sd, 1)} × ${mm(L.bulb.sh, 1)} mm), met hittebestendige aansluitdraden`],
    [1, `G9 LED-lamp, max. ~4 W, Ø${mm(2 * L.bulb.r)} mm (geen halogeen)`],
    [3, 'Wago 221-412 of 221-413 (fase, nul, en eventueel de aarde apart)'],
    [2, 'Dozenschroef M3,5 × 25 verzonken (vaak bij de inbouwdoos)'],
    [2, `Borgschroef M3 × ${LOCK.len} verzonken (kap aan de muurplaat)`],
    [2, 'Schroef M3 × 10 bolkop of plaatschroef 2,9 × 9,5 (houder aan de muurplaat)'],
    [1, 'Kabelbinder 2,5 mm (trekontlasting van de fittingdraden)'],
  ];
  if (!m10) rows.push([2, 'Schroef M3 × 8 (fitting aan de houder)']);
  if (L.plugHoles.length) rows.push([2, `Plug 6 mm met schroef 4 × 40 ${L.keyholes ? 'bolkop (sleutelgaten)' : 'verzonken'}`]);
  return rows;
}

function assembly(L: WallLayout, m10: boolean, reachable: boolean): string {
  const steps: string[] = [];
  const n = () => `${steps.length + 1}. `;
  const far = L.dir === 'down' ? 'onderkant' : 'bovenkant';
  steps.push(`${n()}Zet de groep uit in de meterkast en controleer met een spanningzoeker dat de draden spanningsloos zijn.`);
  steps.push(`${n()}${m10 ? 'Steek de M10-nippel van de fitting door het gat van de houder en draai de moer vast' : 'Schroef de fitting met 2 schroeven M3 op de houder'}. Haal de draden van de fitting door het ronde gat in de muurplaat en zet ze in de holte vast met een kabelbinder door het tunneltje.`);
  steps.push(`${n()}Verbind de draden met de Wago-klemmen: bruin (fase, via de schakelaar) en blauw (nul). Een aardedraad gaat apart in een eigen klem (klasse II, niet aansluiten). Duw de klemmen in de doos of de holte.`);
  steps.push(`${n()}${L.keyholes ? 'Hang de plaat met de sleutelgaten op de schroeven in de pluggen en schroef' : 'Schroef'} de muurplaat met 2 dozenschroeven M3,5 vast op de schroefpotjes van de inbouwdoos${L.plugHoles.length && !L.keyholes ? ' en zet hem extra vast met de pluggen' : ''}. "Onder" is de kant met de ${L.dir === 'down' ? 'smalle' : ''}borgschroefgaten in de zijkant — de plaat werkt beide kanten op.`);
  steps.push(`${n()}Schroef de houder met 2 schroeven op de muurplaat en draai de G9 LED-lamp in de fitting.`);
  steps.push(`${n()}Schuif de kap van ${L.dir === 'down' ? 'boven' : 'onder'} over de muurplaat: de lippen aan de binnenkant haken achter de zijkanten van de plaat. Schuif door tot de kap tegen de plaat stopt.`);
  steps.push(`${n()}Draai de 2 borgschroeven M3 ${L.dir === 'down' ? 'van boven' : 'van onder'} door de kap in de muurplaat. ${L.reflector ? `Hang de reflector met zijn randje in de ${far} van de kap.` : ''}`.trim());
  steps.push(`${n()}Groep weer aan en testen. Lamp wisselen: ${reachable ? `via de ${far}` : 'borgschroeven los en de kap eraf schuiven'}.`);
  return steps.join('\n');
}

// ---------------------------------------------------------------------------
// Presets and randomizer

const presets: Preset[] = [
  { name: 'Pil op & neer', values: { shape: 'pil', W: 150, D: 80, H: 100, dir: 'both', pattern: 'glad', color: '#f2efe8', bulbPos: 'auto', rimTop: 0, rimBottom: 0 } },
  { name: 'Halve maan omhoog', values: { shape: 'halfrond', W: 180, D: 85, H: 110, dir: 'up', pattern: 'glad', color: '#2f7f7a', endWindow: 18, rimTop: 0, bulbPos: 'auto', reflector: true } },
  { name: 'Rond met plissé', values: { shape: 'rond', W: 140, D: 100, H: 120, dir: 'both', pattern: 'plisse', pitch: 7, depth: 2, wall: 1.8, color: '#c8693f', rimTop: 8, rimBottom: 8 } },
  { name: 'Doorschijnende golf', values: { shape: 'golf', W: 170, D: 85, H: 130, waves: 5, waveDepth: 12, dir: 'both', pattern: 'ribbels', pitch: 10, depth: 1.5, translucent: true, wall: 1.2, color: '#f2efe8' } },
  { name: 'Vierkant met gaatjes', values: { shape: 'rechthoek', W: 130, D: 90, H: 130, corner: 14, dir: 'both', pattern: 'gaatjes', holeShape: 'ruit', holeSize: 8, holeWeb: 3, color: '#2b2b2e', reflector: true, reflColor: '#f2efe8' } },
];

const rnd = (a: number, b: number, step = 1) => Math.round((a + Math.random() * (b - a)) / step) * step;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function randomize(): Partial<Params> {
  const shape = pick(SHAPES.map((s) => s.value));
  const W = rnd(120, 200);
  const dir = pick<Dir>(['both', 'both', 'up', 'down']);
  const pattern = pick(['glad', 'plisse', 'ribbels', 'gaatjes']);
  const translucent = pattern !== 'gaatjes' && Math.random() < 0.3;
  return {
    shape, W,
    D: shape === 'rond' ? rnd(W * 0.6, W * 0.8) : rnd(70, 100),
    H: rnd(100, 150),
    corner: rnd(6, 30),
    waves: rnd(3, 7),
    waveDepth: rnd(6, 14),
    dir,
    rimTop: Math.random() < 0.4 ? rnd(4, 14) : 0,
    rimBottom: Math.random() < 0.4 ? rnd(4, 14) : 0,
    endWindow: Math.random() < 0.5 ? rnd(12, 30) : 0,
    bulbPos: 'auto',
    pattern,
    translucent,
    wall: translucent ? rnd(1, 1.4, 0.1) : rnd(1.8, 2.6, 0.1),
    pitch: rnd(6, 12, 0.5),
    depth: rnd(1.2, 2.8, 0.1),
    holeShape: pick(['ruit', 'druppel']),
    holeSize: rnd(6, 12, 0.5),
    holeWeb: rnd(2.5, 4, 0.1),
    color: pick(COLOR_OPTIONS.map((o) => o.value)),
    reflector: dir !== 'down' && !translucent && Math.random() < 0.4,
  };
}

export const wallLampTool: ToolDef = {
  id: 'wandlamp',
  name: 'Wandlampen',
  short: 'Wandlamp',
  icon: 'M4 4v16M4 8h3l2-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-2-3H4M12 3v-1M12 22v-1',
  description:
    'Wandlampen met licht omhoog, omlaag of allebei, vast op de muur over een inbouwdoos. Kies een pil, rond, halve maan, rechthoek of organische golf, met plissé, ribbels, gaatjes of een doorschijnende wand, en een losse witte reflector. Met muurplaat (ruimte voor Wago-klemmen), houder voor een keramische G9-fitting en een kap die over de plaat schuift en met verborgen schroeven vastzit.',
  params,
  presets,
  randomize,
  build,
};
