import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { ParamDef, Params } from '../core/types';
import { UserError, num, str } from '../core/types';
import { TAU, clamp } from '../geom/helpers';
import {
  axialPlay, externalTapered, heights, helixU, internalTapered, leadOf, mergeHeights, ringsOf, selfLocking, threadSegs, wallSolid,
  type Ring, type ThreadSpec, type Wall,
} from '../geom/thread';

// ---------------------------------------------------------------------------
// The printed screw tube: a hollow tube threaded over its full length (cable
// through the bore). Every part of the lamp slides over it and is clamped by
// threaded discs (nuts); the socket clicks into a cup at the socket end. Long
// tubes are split into pieces that screw together with a coupling stub, and
// the outer thread continues across the joint.

export const TUBE_DIAMETERS = ['20', '24', '28', '32'];
/** Main thread: 4 mm between ridges, 2 starts (8 mm lead): about 25 turns for 20 cm. */
export const MAIN_THREAD: ThreadSpec = { pitch: 4, starts: 2, depth: 1.5 };
/** Coupling between tube pieces: same lead, shallower (fits inside the main thread's root). */
const STUB_THREAD: ThreadSpec = { pitch: 4, starts: 2, depth: 1 };
/** Threaded discs: plate thickness (thicker where posts stand), reveal past the shells, nut length (plate + hub). */
export const DISC = { t: 3.2, tPost: 5.6, edge: 1.2, nut: 9 };
const STUB = { len: 10, extra: 0.8 };
/** Ring spacing on threads (mm). */
const DZ = 0.25;

export const isPrinted = (p: Params) => str(p, 'connection') !== 'm10';

export interface TubeSys {
  D: number;
  /** Major radius of the thread. */
  R: number;
  thread: ThreadSpec;
  /** Radial clearance of nuts on the tube (Draadspeling). */
  c: number;
  /** Cable bore. */
  bore: number;
  /** Plain bore of solid parts and shade ceilings that slide over the tube. */
  slide: number;
  /** Smallest inner radius of a hollow segment around the tube. */
  shellIn: number;
  stub: { thread: ThreadSpec; R: number; len: number; depth: number };
  /** Outer radius of the threaded hub of a disc. */
  hubR: number;
  /** Thread length of a nut (disc plate + hub, top cap, base hub). */
  nut: number;
  /** Axial play of a nut each way. */
  play: number;
  /** Play the coupling takes up when it is tight (a hair less than `play`: flanks touching, not overlapping). */
  take: number;
  segs: number;
}

export function tubeSys(p: Params): TubeSys {
  const raw = str(p, 'tubeD');
  const D = TUBE_DIAMETERS.includes(raw) ? Number(raw) : 24;
  const R = D / 2;
  const c = clamp(Number.isFinite(num(p, 'threadPlay')) ? num(p, 'threadPlay') : 0.3, 0.1, 0.8);
  const t = MAIN_THREAD;
  return {
    D,
    R,
    thread: t,
    c,
    bore: D <= 20 ? 4 : 5,
    slide: R + 0.4,
    shellIn: R + 0.8,
    // the female bore keeps 1.5 mm of wall inside the main thread's root at the largest clearance
    stub: { thread: STUB_THREAD, R: R - t.depth - 2.1, len: STUB.len, depth: STUB.len + STUB.extra },
    hubR: R + c + 2.2,
    nut: DISC.nut,
    play: axialPlay(c),
    take: axialPlay(c) - 0.03,
    segs: threadSegs(t, R),
  };
}

/** Lead angle vs friction: the coarse thread still holds by itself. */
export const tubeLocking = (s: TubeSys) => selfLocking(s.thread, s.R);

// ---------------------------------------------------------------------------
// Parameters

const printed = isPrinted;

export const tubeParams: ParamDef[] = [
  { type: 'group', label: 'Buis & draad' },
  {
    type: 'select', key: 'connection', label: 'Verbinding', default: 'printed',
    options: [
      { value: 'printed', label: 'Geprinte schroefbuis (alles schroeft vast)' },
      { value: 'm10', label: 'M10 draadbuis (gekocht)' },
    ],
    help: 'Geprinte schroefbuis: een holle buis met draad over de hele lengte; schijven zijn moeren die de holle sierdelen vastklemmen en de fitting klikt onderin. M10: de oude manier met een gekochte draadbuis en moeren.',
  },
  {
    type: 'select', key: 'tubeD', label: 'Buisdiameter', default: '24', show: printed,
    options: [
      { value: '20', label: 'Ø20 (dun, boring Ø8)' },
      { value: '24', label: 'Ø24 (standaard, boring Ø10)' },
      { value: '28', label: 'Ø28' },
      { value: '32', label: 'Ø32 (stevig)' },
    ],
    help: 'Draad met 4 mm tussen de ribben en 2 gangen (8 mm per slag): snel vastdraaien en toch zelfremmend.',
  },
  {
    type: 'number', key: 'threadPlay', label: 'Draadspeling', min: 0.15, max: 0.6, step: 0.05, unit: 'mm', default: 0.3, show: printed,
    help: 'Kleinste ruimte tussen de draad van de buis en de moeren. Te stroef: groter; te los: kleiner. Test met de pasproef.',
  },
  {
    type: 'number', key: 'tubeExtra', label: 'Extra buislengte', min: 0, max: 400, step: 5, unit: 'mm', default: 0, show: printed,
    help: 'Hanglamp: een stijve buis boven de bovenste schijf tot aan het topkapje. Tafellamp: de stapel staat hoger, op een draadstang boven de voet.',
  },
  {
    type: 'bool', key: 'fitTest', label: 'Pasproef (alleen testonderdelen)', default: false, show: printed,
    help: 'Print eerst een kort buiseinde met de klik voor de fitting, een schijfmoer, een koppelstuk en twee naadringen, en controleer de passing voordat je de hele lamp print.',
  },
];

const custom = (p: Params) => printed(p) && str(p, 'fitSize') === 'custom';

export const fitParams: ParamDef[] = [
  { type: 'group', label: 'Fitting (klik)', show: printed },
  {
    type: 'select', key: 'fitSize', label: 'Maten fitting', default: 'std', show: printed,
    options: [
      { value: 'std', label: 'Richtwaarden (E27: ring Ø57 × 12 · E14: ring Ø41 × 10)' },
      { value: 'custom', label: 'Eigen maten (opgemeten)' },
    ],
    help: 'Fitting met buitendraad en losse schroefring. Draai de ring helemaal omhoog tegen de kop; de lipjes in de dop klikken onder de ring. Maten verschillen per merk: meet je fitting na.',
  },
  { type: 'number', key: 'fitRingD', label: 'Ø schroefring', min: 30, max: 80, step: 0.5, unit: 'mm', default: 57, show: custom, help: 'Richtwaarde E27: 55–60 mm (kunststof 57 × 12), E14: 40–43 mm.' },
  { type: 'number', key: 'fitRingH', label: 'Hoogte schroefring', min: 5, max: 25, step: 0.5, unit: 'mm', default: 12, show: custom },
  { type: 'number', key: 'fitBodyD', label: 'Ø fitting (buitendraad)', min: 20, max: 50, step: 0.5, unit: 'mm', default: 40, show: custom, help: 'Richtwaarde E27: 40 mm, E14: 28 mm.' },
  { type: 'number', key: 'fitTopD', label: 'Ø kop boven de ring', min: 15, max: 60, step: 0.5, unit: 'mm', default: 42, show: custom },
  { type: 'number', key: 'fitTopH', label: 'Hoogte kop boven de ring', min: 5, max: 40, step: 0.5, unit: 'mm', default: 22, show: custom, help: 'Van de bovenkant van de ring (helemaal omhoog gedraaid) tot de bovenkant van de fitting met het M10-gat.' },
  { type: 'number', key: 'fitH', label: 'Hoogte fitting', min: 25, max: 90, step: 1, unit: 'mm', default: 58, show: custom, help: 'Totaal, van de bovenkant tot de opening voor de lamp. Richtwaarde E27: 58–60 mm, E14: 45 mm.' },
];

export const SHELL_PRINT = [
  { value: 'vase', label: 'Vase mode (spiraal, één wand: snelst)' },
  { value: 'walls', label: 'Gewone wand (2 wandlijnen)' },
];

export const shellParams: ParamDef[] = [
  { type: 'select', key: 'shellPrint', label: 'Holle sierdelen', options: SHELL_PRINT, default: 'vase', show: printed, help: 'Bol, kussen, cilinder, tol, kegel… worden dunne open schalen zonder vulling, dichtgemaakt door de schijven. Vase mode: zet "spiraalvaas" aan met 0 bodemlagen.' },
  {
    type: 'number', key: 'shellWall', label: 'Wand sierdelen', min: 0.8, max: 3, step: 0.1, unit: 'mm', default: 0.8, show: printed,
    help: 'Vase mode: zet de lijnbreedte van de buitenwand op deze maat (hoogstens ~2× de nozzle, dus max. 1 mm). Gewone wand: 2–3 wandlijnen.',
  },
];

// ---------------------------------------------------------------------------
// Socket click (E27/E14 socket with outer thread and a loose shade ring)

export interface FitDims {
  bodyD: number;
  ringD: number;
  ringH: number;
  topD: number;
  topH: number;
  H: number;
}

/** Guide values of common thermoplastic sockets with outer thread and shade ring (Kopp, Bailey, Arditi, Vossloh Schwabe). */
export const FIT_GUIDE: Record<string, FitDims> = {
  e27: { bodyD: 40, ringD: 57, ringH: 12, topD: 42, topH: 22, H: 58 },
  e14: { bodyD: 28, ringD: 41, ringH: 10, topD: 30, topH: 17, H: 45 },
};

export function fitDims(p: Params, socket: string, notes: string[]): FitDims {
  const g = FIT_GUIDE[socket] ?? FIT_GUIDE.e27;
  if (str(p, 'fitSize') !== 'custom') return { ...g };
  const v = (k: string, def: number, lo: number, hi: number) => clamp(Number.isFinite(num(p, k)) ? num(p, k) : def, lo, hi);
  const d: FitDims = {
    bodyD: v('fitBodyD', g.bodyD, 15, 60),
    ringD: v('fitRingD', g.ringD, 25, 90),
    ringH: v('fitRingH', g.ringH, 4, 30),
    topD: v('fitTopD', g.topD, 12, 70),
    topH: v('fitTopH', g.topH, 4, 50),
    H: v('fitH', g.H, 20, 100),
  };
  if (d.ringD < d.bodyD + 6) {
    d.ringD = d.bodyD + 6;
    notes.push(`Fitting: de schroefring moet breder zijn dan de fitting om onder te klikken — Ø${d.ringD} mm aangenomen.`);
  }
  if (d.topD > d.ringD - 4) {
    d.topD = d.ringD - 4;
    notes.push(`Fitting: de kop boven de ring mag niet breder zijn dan de ring — Ø${d.topD} mm aangenomen.`);
  }
  if (d.H < d.ringH + d.topH + 8) {
    d.H = d.ringH + d.topH + 8;
    notes.push(`Fitting: hoogte ${d.H} mm aangenomen (ring en kop passen anders niet).`);
  }
  return d;
}

/** The cup at the socket end of the tube (local z from the cup rim, opening down while printing). */
export interface Click {
  dims: FitDims;
  /** Outer radius and height of the cup (the flat shoulder on top carries the shade). */
  Rc: number;
  H: number;
  /** Wall inside the fingers, around the ring. */
  zoneR: number;
  /** Hooks reach in to here; the ring rests on their catch faces at `hookTop`. */
  hookR: number;
  lead: number;
  hookTop: number;
  ringTop: number;
  topR: number;
  capTop: number;
  fingers: number;
  slotW: number;
  slotTop: number;
  /** Anti-rotation ribs on the fingers (press on the ring). */
  ribR: number;
  ribW: number;
  /** Socket position: mouth (opening for the bulb) and top (with the M10 hole), from the cup rim. */
  mouth: number;
  top: number;
  bodyR: number;
  /** Bending strain of a finger when the ring passes (fraction). */
  strain: number;
}

export function clickOf(d: FitDims, s: TubeSys): Click {
  const ringR = d.ringD / 2;
  const zoneR = ringR + 0.3;
  // hooks reach 1.2–1.8 mm under the ring's lower face
  const catchW = clamp(0.16 * (ringR - d.bodyD / 2), 1.2, 1.8);
  const hookR = ringR - catchW;
  const lead = zoneR - hookR;
  const hookTop = lead + 1.4;
  const ringTop = hookTop + d.ringH + 0.3;
  const topR = Math.min(d.topD / 2 + 0.6, zoneR - 0.5);
  const capTop = ringTop + d.topH + 0.4;
  const fingerT = 2.2;
  const Rc = zoneR + fingerT;
  // the roof cone over the socket stays inside: shoulder high enough for 2 mm of wall under the thread
  const Rmin = s.R - s.thread.depth;
  const H = Math.max(capTop, capTop + topR - (Rmin - 2), ringTop + zoneR - (Rmin - 2));
  const fingers = Math.round(clamp((TAU * Rc) / 24, 6, 12));
  const slotTop = ringTop + 5;
  const L = slotTop - 0.8;
  return {
    dims: d,
    Rc,
    H,
    zoneR,
    hookR,
    lead,
    hookTop,
    ringTop,
    topR,
    capTop,
    fingers,
    slotW: 2.4,
    slotTop,
    ribR: ringR - 0.25,
    ribW: 0.8 / zoneR,
    mouth: hookTop - (d.H - d.topH - d.ringH),
    top: hookTop + d.ringH + d.topH,
    bodyR: d.bodyD / 2,
    strain: (1.5 * fingerT * (zoneR - hookR)) / (L * L),
  };
}

/** Cup cavity radius (round part) above the ring: 45° cones over the ring seat and the socket top. */
function cupRoof(k: Click, s: TubeSys, z: number) {
  return Math.max(s.bore, k.zoneR - Math.max(0, z - k.ringTop), z <= k.capTop ? k.topR : k.topR - (z - k.capTop));
}

// ---------------------------------------------------------------------------
// Tube pieces

export interface TubePiece {
  index: number;
  /** Bottom face to the top shoulder (the stub stands on the shoulder). */
  len: number;
  cup: Click | null;
  female: boolean;
  stub: boolean;
}

/** Valid piece length of k pitches: the main thread continues across a tight joint when len ≡ −take (mod pitch). */
export const validLen = (s: TubeSys, k: number) => k * s.thread.pitch - s.take;

/**
 * Split a tube of at least `need` mm (cup rim to top shoulder) into pieces
 * that fit a printer `maxZ` high (stub included). Returns the piece lengths.
 */
export function splitTube(s: TubeSys, need: number, maxZ: number, cupH: number): number[] {
  const P = s.thread.pitch;
  const kmax = Math.floor((maxZ - 1 - s.stub.len + s.take) / P);
  const k1min = Math.ceil((cupH + 8 + s.take) / P);
  const kmin = Math.ceil((s.stub.depth + 14 + s.take) / P);
  if (kmax < Math.max(k1min, kmin)) throw new UserError(`De buis past niet op deze printer: zelfs het eerste stuk met de dop (${(cupH + 8 + s.stub.len).toFixed(0)} mm) is te hoog.`);
  for (let m = 1; m <= 40; m++) {
    const K = Math.max(Math.ceil((need + m * s.take) / P), k1min + (m - 1) * kmin);
    if (K > m * kmax) continue;
    // as even as possible, the first piece (with the cup) a little longer
    const ks = Array.from({ length: m }, () => Math.floor(K / m));
    const rest = K - ks[0] * m;
    for (let i = 0; i < rest; i++) ks[i]++;
    if (ks[0] < k1min) {
      const d = k1min - ks[0];
      ks[0] = k1min;
      for (let i = m - 1, left = d; left > 0 && i > 0; i--) {
        const take = Math.min(left, ks[i] - kmin);
        ks[i] -= take;
        left -= take;
      }
    }
    if (ks.some((k, i) => k > kmax || k < (i === 0 ? k1min : kmin))) continue;
    return ks.map((k) => validLen(s, k));
  }
  throw new UserError('De buis wordt te lang (meer dan 40 stukken). Maak de lamp korter.');
}

/** Rotation of piece i+1 against piece i when the joint is tight (the coupling's play taken up). */
export const jointTurn = (s: TubeSys) => (-TAU * s.take) / leadOf(s.thread);

/** Outer wall of a piece: cup, main thread with lead-ins, coupling stub. */
function pieceOuter(s: TubeSys, pc: TubePiece, segs: number): Wall {
  const t = s.thread;
  const rings: Ring[] = [];
  const z0 = pc.cup ? pc.cup.H : 0;
  if (pc.cup) {
    const Rc = pc.cup.Rc;
    rings.push({ z: 0, r: () => Rc - 0.6 }, { z: 0.6, r: () => Rc }, { z: z0, r: () => Rc });
  }
  rings.push(...ringsOf(heights(z0, pc.len, DZ), (z, th) => externalTapered(t, s.R, helixU(t, z, th), z - z0, pc.len - z)));
  if (pc.stub) {
    const st = s.stub;
    const top = pc.len + st.len;
    rings.push(...ringsOf(heights(pc.len, top, DZ), (z, th) => externalTapered(st.thread, st.R, helixU(st.thread, z - pc.len, th), Infinity, top - z)));
  }
  return { segs, rings };
}

/** Inner wall: cup cavity (hooks, ribs, ring seat, socket top, roof) or the coupling's female thread, then the bore. */
function pieceInner(s: TubeSys, pc: TubePiece, top: number): Wall {
  const rings: Ring[] = [];
  if (pc.cup) {
    const k = pc.cup;
    const ribH = k.zoneR - k.ribR;
    const r0 = k.hookTop + 0.2;
    const fing = TAU / k.fingers;
    // anti-rotation ribs in the middle of each finger, rising at 45° from the hooks
    const rib = (z: number, th: number) => {
      const w = ((th % fing) + fing) % fing;
      if (Math.min(w, fing - w) > k.ribW) return k.zoneR;
      return k.zoneR - clamp(z - r0, 0, ribH);
    };
    rings.push(
      { z: 0, r: () => k.zoneR },
      { z: k.lead, r: () => k.hookR },
      { z: k.hookTop, r: () => k.hookR },
      ...ringsOf([k.hookTop, r0, r0 + ribH, k.ringTop], rib),
    );
    // kinks of the max of the 45° cones (seat, socket top, roof) and the bore
    const kinks = [k.ringTop + (k.zoneR - k.topR), k.capTop, k.capTop + (k.topR - s.bore), k.ringTop + (k.zoneR - s.bore)].filter((z) => z > k.ringTop + 1e-3 && z < top);
    const zs = mergeHeights([k.ringTop + 1e-3], kinks, [top]);
    rings.push(...ringsOf(zs, (z) => cupRoof(k, s, z)));
    return { segs: Math.min(720, Math.ceil((TAU * k.zoneR) / 0.5 / 8) * 8), rings };
  }
  if (pc.female) {
    const st = s.stub;
    const f = st.depth;
    rings.push(...ringsOf(heights(0, f, DZ), (z, th) => internalTapered(st.thread, st.R, s.c, helixU(st.thread, z, th), z, Infinity)));
    const wide = st.R + s.c;
    rings.push({ z: f, r: () => wide }, { z: f + (wide - s.bore), r: () => s.bore }, { z: top, r: () => s.bore });
    return { segs: threadSegs(st.thread, st.R), rings };
  }
  rings.push({ z: 0, r: () => s.bore }, { z: top, r: () => s.bore });
  return { segs: 48, rings };
}

/** Solid of a tube piece in print orientation (standing, bottom face on the bed). */
export function tubePieceSolid(M: ManifoldToplevel, s: TubeSys, pc: TubePiece): Manifold {
  const top = pc.len + (pc.stub ? s.stub.len : 0);
  const segs = pc.cup ? Math.max(s.segs, Math.ceil((TAU * pc.cup.Rc) / 2 / 8) * 8) : s.segs;
  let solid = wallSolid(M, pieceOuter(s, pc, segs), pieceInner(s, pc, top));
  if (pc.cup) {
    // slots between the fingers, pointed at the top (45°) so they print without support
    const k = pc.cup;
    const w = k.slotW / 2;
    const rIn = k.topR - 1;
    const rOut = k.Rc + 1;
    const cutters: Manifold[] = [];
    for (let i = 0; i < k.fingers; i++) {
      const a = ((i + 0.5) * TAU) / k.fingers;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const pts: [number, number, number][] = [];
      for (const r of [rIn, rOut])
        for (const [x, z] of [[-w, -1], [w, -1], [w, k.slotTop], [0, k.slotTop + w], [-w, k.slotTop]] as const) pts.push([r * c - x * sn, r * sn + x * c, z]);
      cutters.push(M.Manifold.hull(pts));
    }
    solid = solid.subtract(M.Manifold.union(cutters));
  }
  return solid;
}

/** Print height of a piece. */
export const pieceHeight = (s: TubeSys, pc: TubePiece) => pc.len + (pc.stub ? s.stub.len : 0);

// ---------------------------------------------------------------------------
// Discs, top cap and the hub in the base: nuts on the tube

export interface Groove {
  /** 0 = bottom face, 1 = top face of the plate (print orientation). */
  face: 0 | 1;
  r: number;
  hw: number;
}

export interface DiscSpec {
  R: number;
  t: number;
  /** Hub on the top face (print orientation), 0 = none. */
  hub: number;
  grooves: Groove[];
}

/** V-groove (45°) that centres the rim of a shell: half width at the face for a wall. */
export const grooveHW = (wall: number) => wall / 2 + 0.6;

function grooveCutters(M: ManifoldToplevel, grooves: Groove[], faceZ: (face: 0 | 1) => number, segs: number): Manifold[] {
  return grooves.map((g) => {
    const z = faceZ(g.face);
    const dir = g.face === 0 ? 1 : -1;
    const pts: [number, number][] = [
      [Math.max(0.01, g.r - g.hw - 0.05), z - dir * 0.05],
      [g.r + g.hw + 0.05, z - dir * 0.05],
      [g.r, z + dir * g.hw],
    ];
    // counter-clockwise for the cross-section
    if (dir < 0) pts.reverse();
    return M.CrossSection.ofPolygons([pts]).revolve(segs);
  });
}

/** Disc (nut) in print orientation: plate on the bed, hub up. */
export function discSolid(M: ManifoldToplevel, s: TubeSys, d: DiscSpec): Manifold {
  const t = s.thread;
  const top = d.t + d.hub;
  const ch = Math.min(0.5, d.t / 4);
  const outerSegs = Math.round(clamp((TAU * d.R) / 1.5, 96, 512) / 8) * 8;
  const segs = Math.max(outerSegs, s.segs);
  const rings: Ring[] = [
    { z: 0, r: () => d.R - ch },
    { z: ch, r: () => d.R },
    { z: d.t - ch, r: () => d.R },
    { z: d.t, r: () => d.R - ch },
  ];
  if (d.hub > 0) {
    const hc = Math.min(0.5, d.hub / 3);
    rings.push({ z: d.t, r: () => s.hubR }, { z: top - hc, r: () => s.hubR }, { z: top, r: () => s.hubR - hc });
  }
  const inner: Wall = { segs: s.segs, rings: ringsOf(heights(0, top, DZ), (z, th) => internalTapered(t, s.R, s.c, helixU(t, z, th), z, top - z)) };
  let solid = wallSolid(M, { segs, rings }, inner);
  if (d.grooves.length) solid = solid.subtract(M.Manifold.union(grooveCutters(M, d.grooves, (f) => (f === 0 ? 0 : d.t), outerSegs)));
  return solid;
}

/** Plate thickness for grooves on both faces at the same radius (keeps material between them). */
export const discThickness = (base: number, grooves: Groove[]) => Math.max(base, ...grooves.map((g) => (grooves.some((h) => h.face !== g.face && Math.abs(h.r - g.r) < g.hw + h.hw) ? 2 * g.hw + 1 : 0)));

export interface TopCapSpec {
  R: number;
  grooves: Groove[];
}

/**
 * Inside the top cap: the thread (the tube may end up to one pitch past the
 * nut length: piece lengths come in whole pitches), a 45° cone, the cavity for
 * the coupling stub and a knot in the cord, a cone up to the cable hole.
 */
export function topCapLayout(s: TubeSys) {
  const cav = Math.max(s.stub.R + 1.2, 8.5);
  const thread = s.nut + s.thread.pitch;
  const wide = s.R + s.c + 0.6;
  const zCav = thread + Math.max(0, wide - cav) + s.stub.len + 10;
  const hole = 3.5;
  const zRoof = zCav + (cav - hole);
  return { cav, thread, wide, zCav, hole, H: zRoof + 2.2, minR: Math.max(s.R + s.c + 4, cav + 3) };
}

/** Top cap of a pendant: nut on the tube, cavity for the coupling stub and the cord knot, cable hole on top. */
export function topCapSolid(M: ManifoldToplevel, s: TubeSys, d: TopCapSpec): Manifold {
  const t = s.thread;
  const L = topCapLayout(s);
  const R = Math.max(d.R, L.minR);
  const rf = Math.min(8, R - L.cav - 1.5, L.H / 3);
  const segs = Math.max(s.segs, Math.round(clamp((TAU * R) / 1.5, 96, 512) / 8) * 8);
  const outerZ = mergeHeights([0, 0.5], heights(L.H - rf, L.H, 0.5));
  const outer: Wall = {
    segs,
    rings: ringsOf(outerZ, (z) => {
      if (z < 0.5) return R - 0.5 + z;
      const dd = L.H - z;
      return dd >= rf ? R : R - rf + Math.sqrt(Math.max(0, rf * rf - (rf - dd) ** 2));
    }),
  };
  const { wide, thread } = L;
  const inner: Wall = {
    segs: s.segs,
    rings: [
      ...ringsOf(heights(0, thread, DZ), (z, th) => internalTapered(t, s.R, s.c, helixU(t, z, th), z, Infinity)),
      // above the thread: a 45° cone in to the cavity, the cavity, a cone up to the cable hole
      { z: thread, r: () => wide },
      ...ringsOf([thread + Math.max(0, wide - L.cav), L.zCav, L.zCav + (L.cav - L.hole), L.H], (z) =>
        Math.max(L.hole, wide - (z - thread), z <= L.zCav ? L.cav : L.cav - (z - L.zCav)),
      ),
    ],
  };
  let solid = wallSolid(M, outer, inner);
  if (d.grooves.length) solid = solid.subtract(M.Manifold.union(grooveCutters(M, d.grooves, () => 0, segs)));
  return solid;
}

/** Threaded hub that joins the top plate of a table lamp's base (print orientation: base top face at z = 0). */
export function hubSolid(M: ManifoldToplevel, s: TubeSys, outerR: number): Manifold {
  const t = s.thread;
  const top = s.nut;
  const outer: Wall = { segs: s.segs, rings: [{ z: 0, r: () => outerR }, { z: top - 0.8, r: () => outerR }, { z: top, r: () => outerR - 0.8 }] };
  const inner: Wall = { segs: s.segs, rings: ringsOf(heights(0, top, DZ), (z, th) => internalTapered(t, s.R, s.c, helixU(t, z, th), z, top - z)) };
  return wallSolid(M, outer, inner);
}

// ---------------------------------------------------------------------------
// Placement: threaded parts must be turned so their threads mesh

/**
 * World rotation (about Z) of part b so that its thread meshes with part a.
 * A part's thread is u = z_l − lead·θ_l/2π − phase in its own coordinates; it
 * is placed as world = T(z) · Rz(rot) · [Rx(180) if flipped] · local.
 */
export function meshTurn(t: ThreadSpec, a: { z: number; rot: number; flip: boolean; phase?: number }, b: { z: number; flip: boolean; phase?: number }): number {
  const L = leadOf(t);
  const fa = a.flip ? -1 : 1;
  const fb = b.flip ? -1 : 1;
  return a.rot + (TAU / L) * (b.z - a.z - fa * (a.phase ?? 0) + fb * (b.phase ?? 0));
}

/** Check that a whole part list stays printable as asked (used by the fit test and notes). */
export const fingerNote = (k: Click) =>
  k.strain > 0.025 ? `Klik: de lipjes buigen ${(k.strain * 100).toFixed(1)}% door — print de dop in PETG (PLA kan breken).` : '';

/** Numbers for the info panel. */
export function threadInfo(s: TubeSys): string {
  const l = tubeLocking(s);
  return `Ø${s.D} mm, 2 gangen × 4 mm (8 mm per slag), diepte ${s.thread.depth} mm, 45°-flanken · speling ${s.c.toFixed(2)} mm · spoedhoek ${l.lead.toFixed(1)}° < wrijvingshoek ~${l.friction.toFixed(0)}°: zelfremmend`;
}
