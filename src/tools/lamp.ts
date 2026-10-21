import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { BuildOutput, InfoBlock, ParamDef, Params, PartOut, Preset, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { fitsOn, usable } from '../core/printer';
import { TAU, clamp, lerp, mul, rotX, translation, type M4 } from '../geom/helpers';
import { ROUND, latheSolid, latheVolume, mirrorSamples, printable, sampleAt, sampleRange, simplifySamples, type LathePattern, type LatheSample } from '../geom/lathe';
import {
  BORE_R, BULBS, COLOR_OPTIONS, CORE_R, COUNTED, KAP_OPTIONS, POST_HOLE, RECESS, RECESS_HUB, SHAPE_OPTIONS, SOCKETS, SPACERS, SPIGOT, TEXTURE_OPTIONS,
  bulbGlass, bulbOptions, kapRadius, patternFor, ringFactor, shapeRadius, type Bulb, type SegSpec, type Socket,
} from './lampParts';
import { HOLEABLE, LAYER_CEIL, LAYER_PATTERNS, RELIEF as RELIEF_PATS, THICK as THICK_PATS, isShaded, layerBudget, layerField, layerHoles, layerParams, layersOf, patternLabel, type Hole as LayerHole, type LayerSetup, type LayerSpec } from './lampLayers';
import { gridEnvelope, gridSolid, shadeGrid, type ShadeGrid } from '../geom/shade';

export const MAX_SEGMENTS = 8;
/** Smallest wall around the bore of a solid segment (keeps the recess cone intact). */
const SOLID_WALL = 1.2;
const SPIGOT_WALL = 0.5;
const COVER = { wall: 2, floor: 3, gap: 1, open: 6 };
const BASE = { top: 8, rimH: 12, rimW: 7, wall: 3, lidT: 3, slotW: 8, slotH: 9 };
const CAP = { r: 17, h: 34, cavityR: 13, holeR: 4, top: 3 };
const CANOPY = { floor: 3, wall: 2.4, boss: 5, screw: 4.5 };
const DZ = 0.25;
/** Steel M10x1 lamp tube: grams per mm. */
const TUBE_G_PER_MM = 0.22;

type Role = 'seg' | 'kap' | 'laag' | 'lamel' | 'posts' | 'base' | 'cover' | 'cap' | 'canopy';
type FaceKind = 'flat' | 'spigot' | 'recess' | 'posts';

interface Hole {
  /** Stack-local face (0 = bottom, 1 = top). */
  face: 0 | 1;
  x: number;
  y: number;
  r: number;
}

interface Piece {
  role: Role;
  name: string;
  color: string;
  spec?: SegSpec;
  h: number;
  /** World z of the body bottom. */
  z0: number;
  flipped: boolean;
  pattern: LathePattern;
  minInner: number;
  faces: [FaceKind, FaceKind];
  /** Solid material around the tube from each face (for recesses and post holes). */
  hub: [number, number];
  /** Kap: thickness of the ceiling around the tube. */
  ceil: number;
  /** Kap rim / lamel: smallest inner radius where posts are anchored. */
  anchorR: number;
  holes: Hole[];
  /** Stack-local range of the samples (spigots stick out of [0, h]). */
  zmin: number;
  zmax: number;
  final: LatheSample[];
  partIndex: number;
  // posts spacer
  postR?: number;
  postCircle?: number;
  postCount?: number;
  postPhase?: number;
  chain?: boolean;
  /** Largest radius after making it printable / as designed. */
  shrunk?: number;
  // layered shades (the kap = layer 1, nested 'laag' pieces inside)
  layer?: LayerSpec;
  /** Patterned shade mesh (instead of the plain lathe). */
  grid?: ShadeGrid;
  openings?: LayerHole[];
  /** Inner layer: outer radius at a stack height (canonical, rim at z = 0). */
  profile?: (z: number) => number;
  /** Centring cone on the cavity side of the ceiling (for the next layer). */
  spigotIn?: boolean;
  /** Centring recess in the top face of the ceiling (inner layers). */
  recessTop?: boolean;
}

// ---------------------------------------------------------------------------
// Parameters

const DEFAULT_SLOTS: Partial<SegSpec>[] = [
  { shape: 'bloem', D: 130, H: 16, n: 8, v: 0.5, color: '#e7a3b0' },
  { shape: 'bol', D: 74, H: 62, color: '#e8b931' },
  { shape: 'kussen', D: 112, H: 28, color: '#8fae8b' },
  { shape: 'bloem', D: 150, H: 16, n: 6, v: 0.6, color: '#c8693f' },
  { shape: 'cilinder', D: 90, H: 40, color: '#d8c3a0' },
  { shape: 'tol', D: 110, H: 60, color: '#2f7f7a' },
  { shape: 'schijf', D: 160, H: 6, color: '#c8352e' },
  { shape: 'kegel', D: 120, H: 60, color: '#2f5aa8' },
];

const isOn = (p: Params, i: number) => Math.round(num(p, 'count')) >= i;
const shapeOf = (p: Params, i: number) => str(p, `s${i}Shape`);
const pendant = (p: Params) => str(p, 'lampType') === 'pendant';
const anyKap = (p: Params) => Array.from({ length: MAX_SEGMENTS }, (_, i) => i + 1).some((i) => isOn(p, i) && shapeOf(p, i) === 'kap');

function slotParams(i: number): ParamDef[] {
  const k = (x: string) => `s${i}${x}`;
  const d = DEFAULT_SLOTS[i - 1];
  const on = (p: Params) => isOn(p, i);
  const sh = (p: Params) => shapeOf(p, i);
  return [
    { type: 'group', label: `Segment ${i}${i === 1 ? ' (bovenste)' : ''}`, show: on },
    { type: 'select', key: k('Shape'), label: 'Vorm', options: SHAPE_OPTIONS, default: d.shape ?? 'cilinder', show: on },
    { type: 'select', key: k('Kap'), label: 'Kapvorm', options: KAP_OPTIONS, default: 'koepel', show: (p) => on(p) && sh(p) === 'kap' },
    {
      type: 'number', key: k('D'), label: 'Diameter', min: 20, max: 310, step: 1, unit: 'mm', default: d.D ?? 100, show: on,
      help: 'Grootste diameter. Bij stijlen: de cirkel waarop de stijlen staan.',
    },
    {
      type: 'number', key: k('H'), label: 'Hoogte', min: 4, max: 300, step: 1, unit: 'mm', default: d.H ?? 40, show: on,
      help: 'Bij een afstandshouder: de tussenruimte tussen de segmenten.',
    },
    {
      type: 'number', key: k('Var'), label: 'Vormvariant', min: 0, max: 100, step: 1, unit: '%', default: Math.round((d.v ?? 0.3) * 100),
      show: (p) => on(p) && sh(p) !== 'hals',
      help: 'Bol: grootte van de platte kanten · kussen: hoe bol de rand is · cilinder/schijf: afronding · tol/diabolo: diameter van punten/taille · kegel/trap/kap: diameter boven · koepel: platte top · boog: hoogte van de boog · bloem/tandwiel: diepte van blaadjes/tanden · stijlen: dikte · lamel: breedte van de ring.',
    },
    {
      type: 'number', key: k('N'), label: 'Aantal', min: 1, max: 48, step: 1, default: d.n ?? 3,
      show: (p) => on(p) && (COUNTED.has(sh(p)) || (sh(p) === 'kap' && str(p, k('Kap')) === 'trap')),
      help: 'Pieken (tol), taillies (diabolo), treden (trap), blaadjes (bloem), tanden (tandwiel) of stijlen.',
    },
    { type: 'bool', key: k('Flip'), label: 'Ondersteboven', default: false, show: (p) => on(p) && !SPACERS.has(sh(p)) && sh(p) !== 'kap' && sh(p) !== 'lamel' },
    { type: 'select', key: k('Tex'), label: 'Textuur', options: TEXTURE_OPTIONS, default: 'glad', show: (p) => on(p) && sh(p) !== 'stijlen' },
    {
      type: 'number', key: k('TexN'), label: 'Aantal vouwen / ringen', min: 2, max: 180, step: 1, default: 96,
      show: (p) => on(p) && sh(p) !== 'stijlen' && str(p, k('Tex')) !== 'glad',
      help: 'Plissé en ribbels: 8–180 rondom. Ringen: aantal over de hoogte.',
    },
    { type: 'select', key: k('Color'), label: 'Kleur', options: COLOR_OPTIONS, default: d.color ?? '#f2efe8', show: on },
  ];
}

const BASE_SHAPES = [
  { value: 'schijf', label: 'Schijf (afgeronde rand)' },
  { value: 'kegel', label: 'Kegel' },
  { value: 'koepel', label: 'Koepel' },
  { value: 'trap', label: 'Getrapt' },
];

const params: ParamDef[] = [
  { type: 'group', label: 'Lamp' },
  {
    type: 'select', key: 'lampType', label: 'Soort lamp', default: 'table',
    options: [
      { value: 'table', label: 'Tafellamp (lamp boven, verzwaarde voet)' },
      { value: 'pendant', label: 'Hanglamp (lamp onder, aan het snoer)' },
    ],
  },
  {
    type: 'number', key: 'count', label: 'Aantal segmenten', min: 1, max: MAX_SEGMENTS, step: 1, default: 4,
    help: 'Segment 1 is het bovenste. Alle segmenten schuiven over één holle draadbuis M10x1.',
  },
  ...Array.from({ length: MAX_SEGMENTS }, (_, i) => slotParams(i + 1)).flat(),
  ...layerParams(anyKap),
  { type: 'group', label: 'Fitting & lamp' },
  {
    type: 'select', key: 'socket', label: 'Fitting', default: 'e27',
    options: [
      { value: 'e27', label: 'E27 (Ø40 × 58 mm, M10-nippel)' },
      { value: 'e14', label: 'E14 (Ø29 × 45 mm, M10-nippel)' },
      { value: 'g9', label: 'G9 (Ø22 × 26 mm, M10-nippel)' },
    ],
  },
  { type: 'select', key: 'bulb27', label: 'Lamp', options: bulbOptions('e27'), default: 'g95', show: (p) => str(p, 'socket') === 'e27' },
  { type: 'select', key: 'bulb14', label: 'Lamp', options: bulbOptions('e14'), default: 'g45', show: (p) => str(p, 'socket') === 'e14' },
  {
    type: 'number', key: 'clearance', label: 'Afstand lamp – kap', min: 5, max: 50, step: 1, unit: 'mm', default: 15,
    help: 'Minimale ruimte tussen het glas en geprinte delen. Alleen LED-lampen gebruiken.',
  },
  { type: 'bool', key: 'cover', label: 'Fittingkraag', default: true, help: 'Een geprint kokertje rond de fitting (niet nodig in een kap).' },
  { type: 'group', label: 'Afwerking' },
  { type: 'number', key: 'texDepth', label: 'Diepte textuur', min: 0.4, max: 4, step: 0.1, unit: 'mm', default: 1.4 },
  { type: 'number', key: 'shadeWall', label: 'Wand van kappen', min: 0.8, max: 3, step: 0.1, unit: 'mm', default: 1.2, help: '1–2 wandlussen wit PETG/PLA laten het licht mooi door.' },
  { type: 'group', label: 'Hanglamp', show: pendant },
  { type: 'bool', key: 'cableCap', label: 'Kapje over moer en trekontlasting', default: true, show: pendant },
  { type: 'bool', key: 'canopy', label: 'Plafondkap', default: true, show: pendant },
  { type: 'number', key: 'canopyD', label: 'Diameter plafondkap', min: 80, max: 160, step: 1, unit: 'mm', default: 110, show: (p) => pendant(p) && bool(p, 'canopy') },
  { type: 'number', key: 'canopyH', label: 'Hoogte plafondkap', min: 20, max: 50, step: 1, unit: 'mm', default: 28, show: (p) => pendant(p) && bool(p, 'canopy') },
  {
    type: 'number', key: 'canopyScrews', label: 'Schroefafstand', min: 40, max: 130, step: 1, unit: 'mm', default: 70, show: (p) => pendant(p) && bool(p, 'canopy'),
    help: 'Twee schroeven 4 mm door de kap in pluggen naast de plafonddoos (of in de schroefogen van de doos).',
  },
  { type: 'select', key: 'canopyColor', label: 'Kleur plafondkap', options: COLOR_OPTIONS, default: '#f2efe8', show: (p) => pendant(p) && bool(p, 'canopy') },
  { type: 'group', label: 'Voet (tafellamp)', show: (p) => !pendant(p) },
  { type: 'select', key: 'baseShape', label: 'Vorm voet', options: BASE_SHAPES, default: 'schijf', show: (p) => !pendant(p) },
  { type: 'number', key: 'baseD', label: 'Diameter voet', min: 80, max: 310, step: 1, unit: 'mm', default: 150, show: (p) => !pendant(p) },
  { type: 'number', key: 'baseH', label: 'Hoogte voet', min: 30, max: 120, step: 1, unit: 'mm', default: 40, show: (p) => !pendant(p) },
  { type: 'select', key: 'baseColor', label: 'Kleur voet', options: COLOR_OPTIONS, default: '#c8693f', show: (p) => !pendant(p) },
  {
    type: 'select', key: 'ballast', label: 'Verzwaring', default: 'staal', show: (p) => !pendant(p),
    options: [
      { value: 'staal', label: 'Stalen ringen / kogels (~4,5 g/cm³)' },
      { value: 'zand', label: 'Zand in een zakje (~1,5 g/cm³)' },
      { value: 'geen', label: 'Geen' },
    ],
  },
  { type: 'bool', key: 'felt', label: 'Uitsparingen voor viltjes', default: true, show: (p) => !pendant(p) },
];

// ---------------------------------------------------------------------------
// Specs

function specOf(p: Params, i: number): SegSpec {
  const k = (x: string) => `s${i}${x}`;
  return {
    slot: i,
    shape: str(p, k('Shape')),
    kap: str(p, k('Kap')),
    D: clamp(num(p, k('D')), 20, 400),
    H: clamp(num(p, k('H')), 2, 400),
    v: clamp(num(p, k('Var')) / 100, 0, 1),
    n: clamp(Math.round(num(p, k('N'))), 1, 48),
    flip: bool(p, k('Flip')),
    tex: str(p, k('Tex')),
    texN: clamp(Math.round(num(p, k('TexN'))), 2, 180),
    color: str(p, k('Color')),
  };
}

const shapeLabel = (s: SegSpec) =>
  s.shape === 'kap' ? `Kap ${KAP_OPTIONS.find((o) => o.value === s.kap)?.label.toLowerCase() ?? ''}` : (SHAPE_OPTIONS.find((o) => o.value === s.shape)?.label ?? s.shape);

const SHORT: Record<string, string> = {
  bol: 'Bol', kussen: 'Kussen', cilinder: 'Cilinder', tol: 'Tol', diabolo: 'Diabolo', kegel: 'Kegel', koepel: 'Koepel', boog: 'Boog', trap: 'Ziggurat',
  bloem: 'Bloemschijf', tandwiel: 'Tandwiel', schijf: 'Schijf', hals: 'Hals', stijlen: 'Stijlen', kap: 'Kap', lamel: 'Lamel',
};
const shortName = (s: SegSpec) => SHORT[s.shape] ?? s.shape;

export function bulbOf(p: Params): { socket: Socket; bulb: Bulb; key: string } {
  const sk = SOCKETS[str(p, 'socket')] ? str(p, 'socket') : 'e27';
  const key = sk === 'e27' ? str(p, 'bulb27') : sk === 'e14' ? str(p, 'bulb14') : 'g9';
  const bulb = BULBS[key] && BULBS[key].socket === sk ? BULBS[key] : BULBS[sk === 'e27' ? 'a60' : sk === 'e14' ? 'p45' : 'g9'];
  return { socket: SOCKETS[sk], bulb, key };
}

function newPiece(role: Role, name: string, color: string, h: number, spec?: SegSpec): Piece {
  return {
    role, name, color, spec, h, z0: 0, flipped: false, pattern: ROUND, minInner: BORE_R,
    faces: ['flat', 'flat'], hub: [h, h], ceil: 3, anchorR: Infinity, holes: [], zmin: 0, zmax: h, final: [], partIndex: -1,
  };
}

// ---------------------------------------------------------------------------
// Body profiles (stack coordinates, z = 0 at the bottom of the body)

interface Ctx {
  pendant: boolean;
  socket: Socket;
  texDepth: number;
  shadeWall: number;
  baseShape: string;
  layers: LayerSetup;
  /** More than one layer in the kap. */
  layered: boolean;
}

/** Wall budget of a layer for the profile (thickest wall plus the relief). */
const layerWall = (s: LayerSpec, c: Ctx) => {
  const b = layerBudget(s, c.shadeWall);
  return b.thick + b.relief;
};

/** Smallest radius of a kap: room for the socket (and for every layer and gap; walls may lean 45°). */
function kapTopR(pc: Piece, c: Ctx) {
  const topR = c.socket.d / 2 + 2 * c.shadeWall + 3;
  if (!pc.layer) return topR;
  const L = c.layered ? c.layers.specs : [pc.layer];
  const walls = L.reduce((a, q) => a + (isShaded(q) ? layerWall(q, c) : c.shadeWall + c.texDepth), 0);
  return Math.max(topR, c.socket.d / 2 + 4 + 1.42 * (walls + (L.length - 1) * c.layers.gap));
}

/**
 * Samples of a thin shade with a ceiling (canonical: open rim at z = 0, top
 * of the ceiling at z = h). The cavity ends exactly at h - ceil, so a nested
 * layer can touch the ceiling from below without overlapping.
 */
function shellSamples(pc: Piece, c: Ctx, radius: (z: number) => number, tex: number): LatheSample[] {
  const h = pc.h;
  const open = h - pc.ceil;
  const shaded = !!pc.layer && isShaded(pc.layer);
  const wall = pc.layer && shaded ? layerWall(pc.layer, c) : c.shadeWall;
  const anchored = Number.isFinite(pc.anchorR);
  const flange = anchored ? POST_HOLE + 4 : -1;
  const lower = sampleRange(0, open, DZ, (z) => {
    const fl = z <= flange;
    // shaded: the pattern fades out toward the ceiling and the flange of the posts
    const t = !shaded ? tex : fl ? 0 : clamp((open - z) / 3, 0, 1) * (anchored ? clamp((z - flange) / 4, 0, 1) : 1);
    return { o: radius(z), i: fl ? pc.anchorR : Infinity, tex: t, wall: fl ? c.shadeWall : wall, follow: !fl };
  });
  const top = sampleRange(Math.min(h, open + 0.01), h, DZ, (z) => {
    const i = pc.recessTop && z > h - RECESS.depth ? Math.max(BORE_R, RECESS.r0 - (h - z)) : BORE_R;
    return { o: radius(z), i, tex: shaded ? 0 : tex, wall: SOLID_WALL };
  });
  const out = [...lower, ...top];
  return c.pendant ? out : mirrorSamples(out);
}


function bodySamples(pc: Piece, c: Ctx): LatheSample[] {
  const h = pc.h;
  const s = pc.spec;
  switch (pc.role) {
    case 'seg': {
      const spec = s!;
      const R = spec.D / 2;
      const raw = shapeRadius(spec);
      const ring = ringFactor(spec, c.texDepth, R);
      const minO = CORE_R / pc.pattern.min;
      const tex = pc.pattern.min < 1 ? 1 : 0;
      return sampleRange(0, h, DZ, (z) => {
        const zz = spec.flip ? h - z : z;
        return { o: Math.max(minO, raw(zz) * ring(z)), i: BORE_R, tex, wall: SOLID_WALL };
      });
    }
    case 'kap': {
      const spec = s!;
      const topR = kapTopR(pc, c);
      const raw = kapRadius(spec, topR);
      const ring = pc.layer && isShaded(pc.layer) ? () => 1 : ringFactor(spec, c.texDepth, spec.D / 2);
      const tex = pc.pattern.min < 1 ? 1 : 0;
      if (pc.layer) return shellSamples(pc, c, (z) => raw(z) * ring(z), tex);
      const flange = POST_HOLE + 4;
      // pendant: rim at the bottom; table lamp: the bowl opens upward
      const out = sampleRange(0, h, DZ, (z) => {
        const ceiling = z >= h - pc.ceil;
        const i = ceiling ? BORE_R : z <= flange ? pc.anchorR : Infinity;
        return { o: raw(z) * ring(z), i, tex, wall: ceiling ? SOLID_WALL : c.shadeWall };
      });
      return c.pendant ? out : mirrorSamples(out);
    }
    case 'laag':
      return shellSamples(pc, c, pc.profile!, 0);
    case 'lamel': {
      const spec = s!;
      const R = spec.D / 2;
      const w = Math.max(lerp(8, 0.45 * R, spec.v), 6);
      const inner = Math.max(4, Math.min(R - w, pc.anchorR));
      const ring = ringFactor(spec, c.texDepth, R);
      const rf = Math.min(h / 2, 1.5);
      const tex = pc.pattern.min < 1 ? 1 : 0;
      return sampleRange(0, h, Math.min(DZ, h / 8), (z) => {
        const d = Math.min(z, h - z);
        const o = d >= rf ? R : R - rf + Math.sqrt(Math.max(0, rf * rf - (rf - d) ** 2));
        return { o: o * ring(z), i: inner, tex, wall: 1.5 };
      });
    }
    case 'base': {
      const R = pc.spec!.D / 2;
      // printed upside down: the wall may widen at most 45° toward the table (steps get 45° chamfers)
      const top = Math.max(CORE_R + 4, R - (c.baseShape === 'trap' ? 0.45 : 0.95) * h);
      const radius = (z: number) => {
        const t = z / h;
        switch (c.baseShape) {
          case 'kegel':
            return lerp(R, top, t);
          case 'koepel':
            return Math.max(top, R * Math.sqrt(Math.max(0, 1 - t * t)));
          case 'trap': {
            const N = 3;
            return R - ((R - top) * Math.min(N - 1, Math.floor(t * N))) / (N - 1);
          }
          default: {
            const rf = Math.min(h / 2, (R - CORE_R) * 0.8, 14);
            const d = h - z;
            return d >= rf ? R : R - rf + Math.sqrt(Math.max(0, rf * rf - (rf - d) ** 2));
          }
        }
      };
      return sampleRange(0, h, DZ, (z) => {
        const chamfer = Math.max(0, 0.8 - z);
        if (z >= h - BASE.top) return { o: radius(z), i: BORE_R, tex: 0, wall: SOLID_WALL };
        return { o: radius(z) - chamfer, i: Infinity, tex: 0, wall: z < BASE.rimH ? BASE.rimW : BASE.wall };
      });
    }
    case 'cover': {
      const R = c.socket.d / 2 + COVER.gap + COVER.wall;
      const out = sampleRange(0, h, DZ, (z) => ({
        o: R - Math.max(0, 0.6 - (h - z)),
        i: z < COVER.floor ? BORE_R : c.socket.d / 2 + COVER.gap,
        tex: 0,
        wall: z < COVER.floor ? SOLID_WALL : COVER.wall,
      }));
      // the floor rests on the stack: at the bottom of a table lamp, on top for a pendant
      return c.pendant ? mirrorSamples(out) : out;
    }
    case 'cap': {
      const rf = 8;
      return sampleRange(0, h, DZ, (z) => {
        const d = h - z;
        const o = d >= rf ? CAP.r : CAP.r - rf + Math.sqrt(Math.max(0, rf * rf - (rf - d) ** 2));
        return { o, i: z >= h - CAP.top ? CAP.holeR : CAP.cavityR, tex: 0, wall: 2 };
      });
    }
    case 'canopy': {
      const R = pc.spec!.D / 2;
      const rf = Math.min(h / 2, 10);
      return sampleRange(0, h, DZ, (z) => {
        const o = z >= rf ? R : R - rf + Math.sqrt(Math.max(0, rf * rf - (rf - z) ** 2));
        return { o, i: z < CANOPY.floor ? BORE_R : Infinity, tex: 0, wall: z < CANOPY.floor ? SOLID_WALL : CANOPY.wall };
      });
    }
    default:
      return [];
  }
}

/** Body plus the centring cones, in stack coordinates. */
function stackSamples(pc: Piece, c: Ctx): LatheSample[] {
  const body = bodySamples(pc, c);
  const h = pc.h;
  // a spigot rises from the face: pull the body's edge sample just inside, so nothing pokes past the face
  if (pc.faces[0] === 'spigot') body[0].z = 0.02;
  if (pc.faces[1] === 'spigot') body[body.length - 1].z = h - 0.02;
  for (const q of body) {
    if (pc.faces[0] === 'recess' && q.z < RECESS.depth) q.i = Math.max(q.i, RECESS.r0 - q.z);
    if (pc.faces[1] === 'recess' && q.z > h - RECESS.depth) q.i = Math.max(q.i, RECESS.r0 - (h - q.z));
  }
  const spig = (z0: number, z1: number, r: (z: number) => number) => sampleRange(z0, z1, 0.2, (z) => ({ o: r(z), i: BORE_R, tex: 0, wall: SPIGOT_WALL }));
  const k = (SPIGOT.r0 - SPIGOT.r1) / SPIGOT.h;
  const below = pc.faces[0] === 'spigot' ? spig(-SPIGOT.h, 0, (z) => SPIGOT.r0 + k * z) : [];
  const above = pc.faces[1] === 'spigot' ? spig(h, h + SPIGOT.h, (z) => SPIGOT.r0 - k * (z - h)) : [];
  const all = [...below, ...body, ...above];
  pc.zmin = all[0].z;
  pc.zmax = all[all.length - 1].z;
  return all;
}

const toPrint = (s: LatheSample[], flipped: boolean, zmin: number) =>
  flipped ? mirrorSamples(s).map((q) => ({ ...q, z: q.z - zmin })) : s.map((q) => ({ ...q, z: q.z - zmin }));

/** Final samples back in stack coordinates (ascending). */
function stackFinal(pc: Piece): LatheSample[] {
  return pc.flipped ? mirrorSamples(pc.final).map((q) => ({ ...q, z: q.z + pc.zmin })) : pc.final.map((q) => ({ ...q, z: q.z + pc.zmin }));
}

function finish(pc: Piece, c: Ctx) {
  const s = stackSamples(pc, c);
  pc.final = printable(toPrint(s, pc.flipped, pc.zmin), pc.pattern, pc.minInner);
  const raw = Math.max(...s.map((q) => q.o));
  pc.shrunk = Math.max(...pc.final.map((q) => q.o)) / raw;
}

/** How much material printing in an orientation would add or remove (mm³). */
function orientationCost(pc: Piece, c: Ctx, flipped: boolean) {
  const s = bodySamples(pc, c);
  const p = toPrint(s, flipped, 0);
  const q = printable(p, pc.pattern, pc.minInner);
  let cost = 0;
  for (let k = 0; k < p.length - 1; k++) {
    const dz = p[k + 1].z - p[k].z;
    cost += Math.abs(p[k].o ** 2 - q[k].o ** 2) * dz;
    const pi = Number.isFinite(p[k].i) ? p[k].i : q[k].i;
    cost += Math.abs(pi ** 2 - q[k].i ** 2) * dz;
  }
  return cost;
}

/** Print matrix: print coordinates → world. */
const placeMatrix = (pc: Piece): M4 => (pc.flipped ? mul(translation(0, 0, pc.z0 + pc.zmax), rotX(180)) : translation(0, 0, pc.z0 + pc.zmin));

/**
 * Radii [lo, hi] where a face holds a post hole of radius r: solid material
 * from the face to the hole depth (plus a floor), clear of the tube.
 */
function postWindow(pc: Piece, face: 0 | 1, r: number): [number, number] {
  const s = stackFinal(pc);
  const depth = POST_HOLE + r + 1;
  const za = face === 0 ? 0 : pc.h - depth;
  const zb = face === 0 ? depth : pc.h;
  if (zb - za > pc.h + 1e-6 || depth > pc.hub[face] + 1e-6) return [Infinity, -Infinity];
  let lo = BORE_R + 4 + r;
  let hi = Infinity;
  const fmin = pc.pattern.min;
  for (let z = za; z <= zb + 1e-9; z += 0.25) {
    const o = sampleAt(s, z, 'o');
    const i = sampleAt(s, z, 'i');
    hi = Math.min(hi, o * (pc.role === 'seg' || pc.role === 'lamel' || pc.role === 'kap' ? fmin : 1) - r - 1.2);
    lo = Math.max(lo, i + r + 1.2);
  }
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Layered shades

/** Patterned mesh of a shade layer; replaces the round envelope in `final`. */
function shadeUp(pc: Piece, c: Ctx, notes: string[]) {
  const spec = pc.layer!;
  const s = pc.final;
  const H = s[s.length - 1].z;
  // ceiling on the bed: the open wall starts at the ceiling thickness
  const geo = { R: Math.max(...s.map((q) => q.o)), z0: pc.ceil, H, wall: c.shadeWall };
  const f = layerField(spec, geo, pc.name);
  notes.push(...f.notes);
  pc.grid = shadeGrid(s, f.field, pc.minInner);
  const env = gridEnvelope(pc.grid);
  pc.final = env;
  const plain = (za: number, zb: number) => {
    if (za < pc.ceil + 2 || zb > H - 2.5) return false;
    for (const q of env) if (q.z >= za && q.z <= zb && !q.follow) return false;
    return true;
  };
  const h = layerHoles(spec, geo, pc.name, (z) => sampleAt(env, z, 'o'), plain);
  notes.push(...h.notes);
  pc.openings = h.holes;
}

/** Stack range of the cavity of a shade (below / above its ceiling). */
const cavity = (pc: Piece, c: Ctx): [number, number] => (c.pendant ? [0, pc.h - pc.ceil] : [pc.ceil, pc.h]);

/** Outer radius of a nested layer: the inner wall of the layer around it, minus the gap (square to the wall). */
function innerProfile(prev: Piece, pc: Piece, c: Ctx): (z: number) => number {
  const ps = stackFinal(prev);
  const [lo, hi] = cavity(prev, c);
  // stay off the ceiling face, where the inner radius jumps to the tube
  const a = lo + (c.pendant ? 0.3 : 2);
  const b = hi - (c.pendant ? 2 : 0.3);
  const iAt = (zs: number) => sampleAt(ps, clamp(zs, a, b), 'i');
  return (zc) => {
    const zs = (c.pendant ? pc.z0 + zc : pc.z0 + pc.h - zc) - prev.z0;
    let m = Infinity;
    for (let d = -1.5; d <= 1.5; d += 0.5) m = Math.min(m, iAt(zs + d));
    const slope = (iAt(zs + 1.5) - iAt(zs - 1.5)) / 3;
    return m - c.layers.gap * clamp(Math.sqrt(1 + slope * slope), 1, 2);
  };
}

/** The nested layer must keep the gap to the layer around it everywhere. */
function checkGap(prev: Piece, pc: Piece, c: Ctx) {
  const ps = stackFinal(prev);
  const cs = stackFinal(pc);
  const [lo, hi] = cavity(prev, c);
  const shift = pc.z0 - prev.z0;
  const want = c.layers.gap * 0.9 - 0.05;
  let worst = Infinity;
  for (const q of cs) {
    const zs = q.z + shift;
    if (zs > lo + 0.05 && zs < hi - 0.05) worst = Math.min(worst, sampleAt(ps, zs, 'i') - q.o);
  }
  for (const q of ps) {
    const zl = q.z - shift;
    if (q.z > lo + 0.05 && q.z < hi - 0.05 && zl >= cs[0].z && zl <= cs[cs.length - 1].z) worst = Math.min(worst, q.i - sampleAt(cs, zl, 'o'));
  }
  if (worst < want) {
    throw new UserError(`Te weinig ruimte tussen ${prev.name.replace(/^\d+\. /, '')} en ${pc.name.replace(/^\d+\. /, '')} (${Math.max(0, worst).toFixed(1)} mm i.p.v. ${c.layers.gap} mm). Maak de kap breder, de tussenruimte kleiner of neem minder lagen.`);
  }
}

function buildLayers(kap: Piece, c: Ctx, hasChain: boolean, notes: string[]): Piece[] {
  if (kap.layer && isShaded(kap.layer)) shadeUp(kap, c, notes);
  if (!c.layered) return [];
  const out: Piece[] = [];
  const openDepth = kap.h - kap.ceil;
  const slot = kap.spec!.slot;
  const n = c.layers.count;
  let prev = kap;
  // from the top of the kap (pendant) or its floor (table): the ceilings stack on the tube
  let used = kap.ceil;
  for (const spec of c.layers.specs.slice(1)) {
    let len = spec.len;
    if (hasChain && len > 1) {
      len = 1;
      notes.push(`Laag ${spec.index}: niet langer dan de buitenste kap, want de lamellen hangen aan de rand.`);
    }
    const h = kap.ceil + len * openDepth - used;
    if (h < LAYER_CEIL + 15) throw new UserError(`Laag ${spec.index} van de kap wordt te kort (${Math.max(0, h - LAYER_CEIL).toFixed(0)} mm open wand). Maak hem langer of de kap hoger.`);
    const pc = newPiece('laag', `${slot}. Kap laag ${spec.index}${spec.index === n ? ' (binnen)' : ''}`, spec.color, h);
    pc.layer = spec;
    pc.ceil = LAYER_CEIL;
    pc.recessTop = true;
    pc.spigotIn = spec.index < n;
    pc.flipped = c.pendant;
    pc.z0 = c.pendant ? kap.z0 + kap.h - used - h : kap.z0 + used;
    pc.profile = innerProfile(prev, pc, c);
    finish(pc, c);
    shadeUp(pc, c, notes);
    checkGap(prev, pc, c);
    out.push(pc);
    prev = pc;
    used += LAYER_CEIL;
  }
  return out;
}

/** Solid of a turned part: patterned shade or lathe, plus the centring cone and the openings of a layer. */
function shellSolid(M: ManifoldToplevel, pc: Piece): Manifold {
  let solid = pc.grid ? gridSolid(M, pc.grid) : latheSolid(M, pc.final, pc.pattern);
  if (pc.spigotIn) {
    // on the cavity side of the ceiling (print coordinates: ceiling on the bed)
    const k = (SPIGOT.r0 - SPIGOT.r1) / SPIGOT.h;
    const cone = M.Manifold.cylinder(SPIGOT.h + 0.05, SPIGOT.r0 + 0.05 * k, SPIGOT.r1, 64).translate([0, 0, pc.ceil - 0.05]);
    const bore = M.Manifold.cylinder(SPIGOT.h + 2, BORE_R, BORE_R, 48).translate([0, 0, pc.ceil - 1]);
    solid = M.Manifold.union([solid, cone.subtract(bore)]);
  }
  if (pc.openings?.length) {
    const env = pc.final;
    const cutters = pc.openings.map((hole) => {
      const vs = hole.poly.map((q) => q[1]);
      const za = hole.z + Math.min(...vs);
      const zb = hole.z + Math.max(...vs);
      let lo = Infinity;
      let hi = 0;
      for (let z = za; z <= zb + 0.25; z += 0.5) {
        lo = Math.min(lo, sampleAt(env, Math.min(z, zb), 'i'));
        hi = Math.max(hi, sampleAt(env, Math.min(z, zb), 'o'));
      }
      const rc = sampleAt(env, hole.z, 'o');
      const pts: [number, number, number][] = [];
      for (const [sx, v] of hole.poly) {
        const a = hole.th + sx / rc;
        for (const r of [lo - 0.8, hi + 0.8]) pts.push([r * Math.cos(a), r * Math.sin(a), hole.z + v]);
      }
      return M.Manifold.hull(pts);
    });
    solid = solid.subtract(M.Manifold.compose(cutters));
  }
  return solid;
}

// ---------------------------------------------------------------------------
// Clearance between the bulb and the printed parts (everything is coaxial,
// so this is a 2D problem in the r–z half-plane)

interface Outline {
  name: string;
  pts: [number, number][];
  s: LatheSample[];
  z0: number;
}

function outlineOf(pc: Piece): Outline {
  const s = simplifySamples(stackFinal(pc), 0.1).map((q) => ({ ...q, z: q.z + pc.z0 }));
  const pts: [number, number][] = [];
  const add = (a: [number, number], b: [number, number]) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 0; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  };
  for (let k = 0; k < s.length - 1; k++) {
    add([s[k].o, s[k].z], [s[k + 1].o, s[k + 1].z]);
    add([s[k].i, s[k].z], [s[k + 1].i, s[k + 1].z]);
  }
  add([s[0].i, s[0].z], [s[0].o, s[0].z]);
  const e = s[s.length - 1];
  add([e.i, e.z], [e.o, e.z]);
  return { name: pc.name, pts, s, z0: pc.z0 };
}

function clearanceTo(o: Outline, glass: { r: (t: number) => number; length: number }, mouth: number, dir: 1 | -1): number {
  const zLo = o.s[0].z;
  const zHi = o.s[o.s.length - 1].z;
  const bulb: [number, number][] = [];
  for (let t = 0; t <= glass.length; t += 1) bulb.push([glass.r(t), mouth + dir * t]);
  bulb.push([0, mouth + dir * glass.length]);
  // overlap: the glass inside the part's material, or the part inside the glass
  for (const [r, z] of bulb) {
    if (z < zLo || z > zHi) continue;
    if (r >= sampleAt(o.s, z, 'i') - 1e-6 && r <= sampleAt(o.s, z, 'o') + 1e-6) return -1;
  }
  for (const [r, z] of o.pts) {
    const t = (z - mouth) * dir;
    if (t >= 0 && t <= glass.length && r < glass.r(t)) return -1;
  }
  let best = Infinity;
  for (const [br, bz] of bulb)
    for (const [r, z] of o.pts) {
      const d = (br - r) ** 2 + (bz - z) ** 2;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Extra solids

function postHoleCutter(M: ManifoldToplevel, r: number): Manifold {
  return M.Manifold.union([
    // overlapping pieces: touching ones leave a zero-thickness skin inside the hole
    M.Manifold.cylinder(POST_HOLE + 0.05, r, r, 24).translate([0, 0, -0.02]),
    M.Manifold.cylinder(r, r, 0.05, 24).translate([0, 0, POST_HOLE]),
  ]);
}

function pinSolid(M: ManifoldToplevel, r: number, L: number): Manifold {
  const c = Math.min(0.5, r / 3);
  return M.Manifold.union([
    M.Manifold.cylinder(c, r - c, r, 24),
    M.Manifold.cylinder(L - 2 * c, r, r, 24).translate([0, 0, c - 0.001]),
    M.Manifold.cylinder(c, r, r - c, 24).translate([0, 0, L - c - 0.002]),
  ]);
}

function lidSolid(M: ManifoldToplevel, r: number, screwR: number, angles: number[], felt: boolean): Manifold {
  const t = BASE.lidT;
  const segs = Math.round(clamp((TAU * r) / 1.5, 96, 360));
  let lid = M.Manifold.union([M.Manifold.cylinder(0.6, r - 0.6, r, segs), M.Manifold.cylinder(t - 0.6, r, r, segs).translate([0, 0, 0.599])]);
  const cut: Manifold[] = [];
  // printed underside up: z = 0 is the top of the lid (against the base), z = t the underside with the countersinks
  for (const a of angles) {
    // the lid is printed upside down (y mirrored), like the base
    const x = screwR * Math.cos(a);
    const y = -screwR * Math.sin(a);
    cut.push(M.Manifold.cylinder(t + 0.2, 1.7, 1.7, 20).translate([x, y, -0.1]));
    cut.push(M.Manifold.cylinder(1.6 + 0.01, 1.7, 3.3, 20).translate([x, y, t - 1.6]));
  }
  if (felt) {
    const fr = Math.max(12, Math.min(0.72 * r, r - 13));
    for (let k = 0; k < 4; k++) {
      const a = TAU / 8 + (k * TAU) / 4;
      cut.push(M.Manifold.cylinder(1.21, 10.25, 10.25, 40).translate([fr * Math.cos(a), fr * Math.sin(a), t - 1.2]));
    }
  }
  if (cut.length) lid = lid.subtract(M.Manifold.union(cut));
  return lid;
}

// ---------------------------------------------------------------------------
// Build

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const isPendant = pendant(p);
  const { socket, bulb, key: bulbKey } = bulbOf(p);
  const count = clamp(Math.round(num(p, 'count')), 1, MAX_SEGMENTS);
  const specs = Array.from({ length: count }, (_, i) => specOf(p, i + 1));
  const kapSpec = specs.find((s) => s.shape === 'kap');
  const layers = layersOf(p, kapSpec?.color ?? '#f2efe8');
  const c: Ctx = {
    pendant: isPendant, socket, texDepth: num(p, 'texDepth'), shadeWall: clamp(num(p, 'shadeWall'), 0.8, 3), baseShape: str(p, 'baseShape'),
    layers, layered: !!kapSpec && layers.count > 1,
  };
  const warnings: string[] = [];
  const tips: string[] = [];
  const notes: string[] = [];

  // world order bottom → top (segment 1 is the top one)
  const order = [...specs].reverse();
  const kaps = order.filter((s) => s.shape === 'kap');
  if (kaps.length > 1) throw new UserError('Er kan maar één kap in de lamp: de lamp zit in de kap, bij de fitting.');
  const kapIdx = order.findIndex((s) => s.shape === 'kap');
  // the chain of lamellas hangs (pendant) or stands (table) beyond the kap rim
  let chain: SegSpec[] = [];
  let tube: SegSpec[] = order;
  if (kapIdx >= 0) {
    if (isPendant) {
      chain = order.slice(0, kapIdx);
      tube = order.slice(kapIdx);
    } else {
      chain = order.slice(kapIdx + 1);
      tube = order.slice(0, kapIdx + 1);
    }
    const end = isPendant ? 0 : tube.length - 1;
    if (tube[end].shape !== 'kap') throw new UserError('De kap moet aan de lampkant zitten: onderaan bij een hanglamp, bovenaan bij een tafellamp.');
  }
  if (tube.some((s) => s.shape === 'lamel')) {
    throw new UserError('Een lamel (open ring) hangt aan de rand van een kap: zet eerst een kap en daarna afwisselend stijlen en lamellen.');
  }
  // chain from the kap outward: posts, lamel, posts, lamel …
  const outward = isPendant ? [...chain].reverse() : chain;
  outward.forEach((s, i) => {
    const want = i % 2 === 0 ? 'stijlen' : 'lamel';
    if (s.shape !== want) throw new UserError(`Na de kap komen afwisselend stijlen en lamellen (segment ${s.slot} moet ${want === 'stijlen' ? 'een afstandshouder met stijlen' : 'een lamel'} zijn).`);
  });
  if (outward.length % 2 === 1) throw new UserError('Stijlen aan de rand van de kap hebben een lamel nodig om te dragen.');
  if (tube.every((s) => s.shape === 'stijlen')) throw new UserError('Een lamp heeft minstens één echt segment nodig (geen alleen afstandshouders).');

  // pieces along the tube, world bottom → top
  const pieces: Piece[] = [];
  const hasKap = kapIdx >= 0;
  const useCover = bool(p, 'cover') && !hasKap;
  const coverH = socket.h - COVER.open + COVER.floor;
  if (!isPendant) {
    const D = clamp(num(p, 'baseD'), 60, 400);
    const H = clamp(num(p, 'baseH'), BASE.top + BASE.rimH + 6, 200);
    const base = newPiece('base', 'Voet', str(p, 'baseColor'), H, { slot: 0, shape: 'base', kap: '', D, H, v: 0, n: 0, flip: false, tex: 'glad', texN: 0, color: str(p, 'baseColor') });
    base.flipped = true;
    base.hub = [0, BASE.top];
    pieces.push(base);
  }
  if (useCover && isPendant) pieces.push(newPiece('cover', 'Fittingkraag', specs[count - 1].color, coverH));
  for (const s of tube) {
    const role: Role = s.shape === 'kap' ? 'kap' : s.shape === 'stijlen' ? 'posts' : 'seg';
    pieces.push(newPiece(role, `${s.slot}. ${shortName(s)}`, s.color, Math.max(s.H, role === 'posts' ? 2 : 4), s));
  }
  if (useCover && !isPendant) pieces.push(newPiece('cover', 'Fittingkraag', specs[0].color, coverH));
  // the chain continues the list outward (pendant: downward, so prepend)
  // lamellas take post holes from both faces: at least the hole depth plus its tip
  const chainPieces = outward.map((s) => newPiece(s.shape === 'lamel' ? 'lamel' : 'posts', `${s.slot}. ${shortName(s)}`, s.color, Math.max(s.H, s.shape === 'lamel' ? POST_HOLE + 4 : 2), s));
  for (const cp of chainPieces) cp.chain = true;
  const all: Piece[] = isPendant ? [...[...chainPieces].reverse(), ...pieces] : [...pieces, ...chainPieces];

  // tube posts at an open end of the stack have nothing to stand on: make them a neck
  const toNeck = (pc: Piece, why: string) => {
    pc.role = 'seg';
    pc.spec = { ...pc.spec!, shape: 'hals', D: 26, v: 0.2, tex: 'glad' };
    pc.name = `${pc.spec.slot}. Hals`;
    notes.push(`Segment ${pc.spec.slot}: ${why} — er is een hals (Ø26) van gemaakt.`);
  };
  all.forEach((pc, i) => {
    if (pc.role !== 'posts' || pc.chain) return;
    const lo = all[i - 1];
    const up = all[i + 1];
    if (!lo || !up || lo.role === 'posts' || up.role === 'posts' || lo.role === 'cover' || up.role === 'cover') toNeck(pc, 'stijlen hebben aan beide kanten een segment nodig');
  });

  // patterns and print orientation
  for (const pc of all) {
    if (pc.role === 'seg' || pc.role === 'kap' || pc.role === 'lamel') {
      const s = pc.spec!;
      pc.pattern = SPACERS.has(s.shape) && s.shape !== 'hals' ? ROUND : patternFor(s, c.texDepth);
    }
    if (pc.role === 'cap') pc.minInner = CAP.holeR;
  }
  const kapPiece = all.find((pc) => pc.role === 'kap');
  if (kapPiece) {
    // ceiling on the bed (pendant) or floor on the bed (table): the shade opens upward while printing
    kapPiece.flipped = isPendant;
    const l1 = layers.specs[0];
    if (c.layered || isShaded(l1)) {
      kapPiece.layer = l1;
      if (isShaded(l1)) kapPiece.pattern = ROUND;
      if (c.layered) {
        kapPiece.spigotIn = true;
        kapPiece.name = `${kapPiece.spec!.slot}. Kap laag 1 (buiten)`;
      }
    }
  }
  for (const pc of all) if (pc.role === 'cover') pc.flipped = isPendant;

  // posts: radius, thickness and the faces they occupy
  all.forEach((pc, i) => {
    if (pc.role !== 'posts') return;
    const s = pc.spec!;
    pc.postR = lerp(4, 10, s.v) / 2;
    pc.postCount = clamp(s.n, 3, 8);
    pc.postCircle = s.D / 2;
    const lo = all[i - 1];
    const up = all[i + 1];
    lo.faces[1] = 'posts';
    up.faces[0] = 'posts';
    if (lo.role === 'kap' && !pc.chain) lo.ceil = POST_HOLE + 1.5 + pc.postR;
    if (up.role === 'kap' && !pc.chain) up.ceil = POST_HOLE + 1.5 + pc.postR;
  });
  for (const pc of all) {
    if (pc.role === 'kap') pc.hub = isPendant ? [0, pc.ceil] : [pc.ceil, 0];
    if (pc.role === 'cover') pc.hub = isPendant ? [0, COVER.floor] : [COVER.floor, 0];
  }
  for (const pc of all) {
    if (pc.role !== 'seg' || !pc.spec) continue;
    // the same shape either way up: keep it as designed
    const up = orientationCost(pc, c, false);
    const down = orientationCost(pc, c, true);
    pc.flipped = down < up * 0.8 - 1;
  }

  // centring cones between solid neighbours along the tube
  const recessFits = (pc: Piece, face: 0 | 1) => {
    if (pc.role === 'lamel' || pc.role === 'posts' || pc.faces[face] !== 'flat') return false;
    const other = pc.faces[1 - face] === 'recess' ? RECESS.depth : pc.faces[1 - face] === 'posts' ? POST_HOLE + 2 : 0;
    const hub = pc.role === 'seg' ? pc.h - other : pc.hub[face];
    return hub >= RECESS_HUB;
  };
  for (let i = 0; i < all.length - 1; i++) {
    const lo = all[i];
    const up = all[i + 1];
    if (lo.faces[1] !== 'flat' || up.faces[0] !== 'flat' || lo.chain || up.chain) continue;
    if (lo.role === 'kap' || up.role === 'kap') continue;
    if (!lo.flipped && recessFits(up, 0)) {
      lo.faces[1] = 'spigot';
      up.faces[0] = 'recess';
    } else if (up.flipped && recessFits(lo, 1)) {
      up.faces[0] = 'spigot';
      lo.faces[1] = 'recess';
    }
  }

  // printer fit of the raw sizes first: a clear message before heavy work
  const U = usable(printer);
  const checkFit = (name: string, d: number, h: number) => {
    if (!fitsOn(printer, [d, d, h])) {
      throw new UserError(`${name} (Ø${d.toFixed(0)} × ${h.toFixed(0)} mm) past niet op de ${printer.name} (max ${U.x} × ${U.y} × ${U.z} mm). Maak dit onderdeel kleiner.`);
    }
  };
  for (const pc of all) if (pc.spec && pc.role !== 'posts') checkFit(pc.name, pc.spec.D, pc.h);
  for (const pc of all)
    if (pc.role === 'kap' && pc.h < pc.ceil + 15) throw new UserError(`${pc.name}: een kap moet minstens ${Math.ceil(pc.ceil + 15)} mm hoog zijn.`);
  if (kapPiece?.layer && 2 * kapTopR(kapPiece, c) > kapPiece.spec!.D + 0.5) {
    notes.push(`${kapPiece.name}: breder gemaakt (Ø${(2 * kapTopR(kapPiece, c)).toFixed(0)} mm) zodat ${c.layered ? 'alle lagen, de tussenruimtes en ' : ''}de fitting erin passen.`);
  }
  if (kapPiece && c.layered) {
    const need = kapPiece.ceil + (layers.count - 1) * LAYER_CEIL + 15;
    if (kapPiece.h < need) throw new UserError(`${kapPiece.name}: een kap met ${layers.count} lagen moet minstens ${Math.ceil(need)} mm hoog zijn.`);
  }

  for (const pc of all) if (pc.role !== 'posts') finish(pc, c);

  // posts along the tube: a radius both neighbours can hold
  let changed = false;
  all.forEach((pc, i) => {
    if (pc.role !== 'posts' || pc.chain) return;
    const lo = all[i - 1];
    const up = all[i + 1];
    const r = pc.postR! + 0.15;
    const a = postWindow(lo, 1, r);
    const b = postWindow(up, 0, r);
    const minR = Math.max(a[0], b[0]);
    const maxR = Math.min(a[1], b[1]);
    if (minR > maxR) {
      lo.faces[1] = 'flat';
      up.faces[0] = 'flat';
      toNeck(pc, 'de stijlen passen niet in de buursegmenten');
      changed = true;
      return;
    }
    const want = clamp(pc.postCircle!, minR, maxR);
    if (Math.abs(want - pc.postCircle!) > 0.5) notes.push(`Segment ${pc.spec!.slot}: stijlen op Ø${(2 * want).toFixed(0)} mm gezet zodat ze in de buursegmenten passen.`);
    pc.postCircle = want;
  });
  if (changed) {
    // posts turned into a neck: plain and upright, then rebuild everything with the flat faces
    for (const pc of all) {
      if (pc.role === 'seg' && pc.spec?.shape === 'hals' && !pc.final.length) {
        pc.pattern = ROUND;
        pc.flipped = false;
      }
    }
    for (const pc of all) if (pc.role !== 'posts') finish(pc, c);
  }

  // posts in the lamella chain: the kap rim and the lamellas reach in to the post circle
  all.forEach((pc, i) => {
    if (pc.role !== 'posts' || !pc.chain) return;
    const lo = all[i - 1];
    const up = all[i + 1];
    const r = pc.postR! + 0.1;
    const outer = (q: Piece, face: 0 | 1) => {
      const s = stackFinal(q);
      const d = POST_HOLE + r + 1;
      let m = Infinity;
      for (let z = face === 0 ? 0 : q.h - d; z <= (face === 0 ? d : q.h) + 1e-9; z += 0.25) m = Math.min(m, sampleAt(s, z, 'o') * q.pattern.min);
      return m;
    };
    const maxR = Math.min(outer(lo, 1), outer(up, 0)) - r - 1.2;
    const want = Math.min(pc.postCircle!, maxR);
    if (want < r + 2) throw new UserError(`Segment ${pc.spec!.slot}: de stijlen passen niet op de rand — maak de kap of lamel groter of de stijlen dunner.`);
    if (want < pc.postCircle! - 0.5) notes.push(`Segment ${pc.spec!.slot}: stijlen op Ø${(2 * want).toFixed(0)} mm gezet zodat ze op de rand passen.`);
    pc.postCircle = want;
    for (const q of [lo, up]) q.anchorR = Math.min(q.anchorR, want - r - 1.2);
  });
  for (const pc of all) if ((pc.role === 'kap' || pc.role === 'lamel') && Number.isFinite(pc.anchorR)) finish(pc, c);

  // world positions
  let z = !isPendant ? BASE.lidT : 0;
  for (const pc of all) {
    pc.z0 = z;
    z += pc.h;
  }
  const stackTop = z;

  // nested layers inside the kap (each on the tube, under the ceiling of the one around it)
  const layerPieces = kapPiece?.layer ? buildLayers(kapPiece, c, chainPieces.length > 0, notes) : [];

  // socket and bulb
  const tubePieces = all.filter((pc) => !pc.chain);
  const end = isPendant ? tubePieces[0] : tubePieces[tubePieces.length - 1];
  // the socket sits under the innermost layer
  const sock = end.role === 'kap' && layerPieces.length ? layerPieces[layerPieces.length - 1] : end;
  let socketFace: number;
  if (end.role === 'kap') socketFace = isPendant ? sock.z0 + sock.h - sock.ceil : sock.z0 + sock.ceil;
  else if (end.role === 'cover') socketFace = isPendant ? end.z0 + end.h - COVER.floor : end.z0 + COVER.floor;
  else socketFace = isPendant ? end.z0 : end.z0 + end.h;
  const dir: 1 | -1 = isPendant ? -1 : 1;
  const mouth = socketFace + dir * socket.h;
  const glass = bulbGlass(bulb, socket);
  const tip = mouth + dir * glass.length;

  // the socket must fit inside the kap
  if (end.role === 'kap') {
    const s = stackFinal(sock);
    for (let t = 1; t <= socket.h; t += 2) {
      const zl = socketFace + dir * t - sock.z0;
      if (zl < 0 || zl > sock.h) continue;
      if (sampleAt(s, zl, 'i') < socket.d / 2 + 0.4) {
        throw new UserError(`De ${socket.label}-fitting past niet in de ${layerPieces.length ? 'binnenste laag' : 'kap'}. Maak de kap breder${layerPieces.length ? ', de tussenruimte kleiner of neem minder lagen' : ''}.`);
      }
    }
  }

  // clearance
  const clearance = num(p, 'clearance');
  let nearest = Infinity;
  let nearestName = '';
  for (const pc of [...all, ...layerPieces]) {
    if (pc.role === 'posts' || pc.role === 'cover') continue;
    const d = clearanceTo(outlineOf(pc), glass, mouth, dir);
    if (d < 0) throw new UserError(`De lamp (${bulb.label.split(' —')[0]}) raakt ${pc.name}. Kies een kleinere lamp of maak de kap/lamel ruimer.`);
    if (d < nearest) {
      nearest = d;
      nearestName = pc.name;
    }
  }
  if (nearest < clearance) {
    warnings.push(`Maar ${nearest.toFixed(0)} mm tussen de lamp en ${nearestName} (gewenst ${clearance} mm). Gebruik een kleinere lamp of maak de kap ruimer — en alleen LED.`);
  }

  // kap opening: can the bulb be changed?
  if (end.role === 'kap') {
    const s = stackFinal(end);
    const rimZ = isPendant ? 0 : end.h;
    const layerRims = layerPieces.map((q) => sampleAt(stackFinal(q), isPendant ? 0 : q.h, 'i'));
    const rimR = Math.min(sampleAt(s, rimZ, 'i'), ...layerRims, ...all.filter((q) => q.role === 'lamel').map((q) => q.final[0].i));
    if (rimR * 2 < bulb.d + 4) warnings.push(`De opening (Ø${(rimR * 2).toFixed(0)} mm) is kleiner dan de lamp (Ø${bulb.d} mm): om de lamp te wisselen moet je de kap losnemen.`);
  }

  // ---- solids
  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  const masses: { m: number; z: number }[] = [];
  const grams = (m: Manifold) => {
    const v = m.volume();
    const shell = Math.min(v, m.surfaceArea() * 0.84);
    return ((shell + (v - shell) * 0.15) * 1.24) / 1000;
  };
  const rows: (string | number)[][] = [];

  // post holes in the neighbours of every posts spacer
  let parity = 0;
  all.forEach((pc, i) => {
    if (pc.role !== 'posts') return;
    const n = pc.postCount!;
    pc.postPhase = (parity++ % 2) * (Math.PI / n) + Math.PI / 2;
    const r = pc.postR! + (pc.chain ? 0.1 : 0.15);
    for (let k = 0; k < n; k++) {
      const a = pc.postPhase + (k * TAU) / n;
      const x = pc.postCircle! * Math.cos(a);
      const y = pc.postCircle! * Math.sin(a);
      all[i - 1].holes.push({ face: 1, x, y, r });
      all[i + 1].holes.push({ face: 0, x, y, r });
    }
  });
  // holes from both faces of a thin part must not meet
  for (const pc of all) {
    const top = pc.holes.filter((q) => q.face === 1);
    const bottom = pc.holes.filter((q) => q.face === 0);
    if (!top.length || !bottom.length || pc.h >= 2 * (POST_HOLE + 6) + 1) continue;
    for (const a of top)
      for (const b of bottom)
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + 1.5) throw new UserError(`${pc.name}: de gaten voor de stijlen boven en onder raken elkaar. Maak het segment dikker of kies een ander aantal stijlen.`);
  }

  const addLayerPart = (pc: Piece) => {
    const printH = pc.final[pc.final.length - 1].z;
    const maxO = Math.max(...pc.final.map((q) => q.o));
    checkFit(pc.name, 2 * maxO, printH);
    const solid = shellSolid(M, pc);
    const idx = parts.length;
    parts.push({ name: pc.name, solid, color: pc.color });
    scene.push({ kind: 'part', part: idx, matrix: placeMatrix(pc) });
    pc.partIndex = idx;
    masses.push({ m: grams(solid), z: pc.z0 + pc.h / 2 });
    rows.push([kapPiece!.spec!.slot, `${pc.name.replace(/^\d+\. /, '')} · ${patternLabel(pc.layer!)}`, `Ø${(2 * maxO).toFixed(0)} × ${pc.h.toFixed(0)} mm`, colorName(pc.color), pc.flipped ? 'ondersteboven' : 'rechtop']);
  };
  for (const pc of all) {
    if (pc.role === 'posts') {
      const n = pc.postCount!;
      const L = pc.h + 2 * POST_HOLE;
      const idx = parts.length;
      parts.push({ name: `${pc.name} (Ø${(2 * pc.postR!).toFixed(0)} × ${L.toFixed(0)} mm)`, solid: pinSolid(M, pc.postR!, L), quantity: n, color: pc.color });
      for (let k = 0; k < n; k++) {
        const a = pc.postPhase! + (k * TAU) / n;
        scene.push({ kind: 'part', part: idx, matrix: translation(pc.postCircle! * Math.cos(a), pc.postCircle! * Math.sin(a), pc.z0 - POST_HOLE) });
      }
      masses.push({ m: grams(parts[idx].solid) * n, z: pc.z0 + pc.h / 2 });
      rows.push([pc.spec!.slot, `${n}× stijl`, `Ø${(2 * pc.postR!).toFixed(0)} × ${L.toFixed(0)} mm op Ø${(2 * pc.postCircle!).toFixed(0)}`, colorName(pc.color), 'rechtop']);
      continue;
    }
    const printH = pc.final[pc.final.length - 1].z;
    const maxO = Math.max(...pc.final.map((q) => q.o));
    checkFit(pc.name, 2 * maxO, printH);
    if ((pc.shrunk ?? 1) < 0.97 && pc.spec && pc.role !== 'base') {
      notes.push(`${pc.name}: zonder support kan de wand niet vlakker dan 45° oplopen, dus is hij Ø${(2 * maxO).toFixed(0)} mm geworden (i.p.v. Ø${pc.spec.D.toFixed(0)}). Maak hem hoger voor de volle maat.`);
    }
    let solid = shellSolid(M, pc);
    const cut: Manifold[] = [];
    for (const hole of pc.holes) {
      const cutter = postHoleCutter(M, hole.r);
      const faceZ = hole.face === 0 ? 0 : pc.h;
      const zp = pc.flipped ? pc.zmax - faceZ : faceZ - pc.zmin;
      const inward = (hole.face === 0 ? 1 : -1) * (pc.flipped ? -1 : 1);
      const y = pc.flipped ? -hole.y : hole.y;
      cut.push(inward > 0 ? cutter.translate([hole.x, y, zp]) : cutter.mirror([0, 0, 1]).translate([hole.x, y, zp]));
    }
    if (pc.role === 'base') {
      // cable slot at the bottom edge and three pilot holes for the lid screws (printed upside down)
      const s = stackFinal(pc);
      const R = s[0].o;
      const screwR = R - BASE.rimW / 2 - 0.4;
      cut.push(M.Manifold.cube([R + 10, BASE.slotW, BASE.slotH + 1]).translate([0, -BASE.slotW / 2, printH - BASE.slotH]));
      for (const a of LID_SCREWS) cut.push(M.Manifold.cylinder(11, 1.25, 1.25, 16).translate([screwR * Math.cos(a), -screwR * Math.sin(a), printH - 10]));
    }
    if (cut.length) solid = solid.subtract(M.Manifold.union(cut));
    const idx = parts.length;
    parts.push({ name: pc.name, solid, color: pc.color, ...(pc.role === 'kap' || pc.role === 'lamel' ? { material: 'petg-translucent', purpose: 'lamp' as const } : {}) });
    scene.push({ kind: 'part', part: idx, matrix: placeMatrix(pc) });
    pc.partIndex = idx;
    masses.push({ m: grams(solid), z: pc.z0 + pc.h / 2 });
    const s = pc.spec;
    rows.push([
      s?.slot || '–',
      pc.role === 'seg' || pc.role === 'kap' || pc.role === 'lamel' ? shapeLabel(s!) + (pc.layer ? `${c.layered ? ' — laag 1' : ''}${isShaded(pc.layer) ? ` · ${patternLabel(pc.layer)}` : ''}` : '') : pc.name,
      `Ø${(2 * maxO).toFixed(0)} × ${pc.h.toFixed(0)} mm`,
      colorName(pc.color),
      pc.flipped ? 'ondersteboven' : 'rechtop',
    ]);
    if (pc.role === 'kap') layerPieces.forEach(addLayerPart);
  }

  // lid of the base
  const base = all.find((pc) => pc.role === 'base');
  let ballastG = 0;
  if (base) {
    const s = stackFinal(base);
    const R = s[0].o;
    const lidR = R - 0.3;
    const lid = lidSolid(M, lidR, R - BASE.rimW / 2 - 0.4, LID_SCREWS, bool(p, 'felt'));
    const idx = parts.length;
    parts.push({ name: 'Bodemplaat', solid: lid, color: base.color });
    // printed underside up: z = 0 of the lid faces the base
    scene.push({ kind: 'part', part: idx, matrix: mul(translation(0, 0, BASE.lidT), rotX(180)) });
    masses.push({ m: grams(lid), z: BASE.lidT / 2 });
    rows.push(['–', 'Bodemplaat', `Ø${(2 * lidR).toFixed(0)} × ${BASE.lidT} mm`, colorName(base.color), 'onderkant boven']);
    const cavity = latheVolume(s, 0, base.h - BASE.top, 'inner') - Math.PI * 25 * (base.h - BASE.top);
    const density = str(p, 'ballast') === 'staal' ? 4.5 : str(p, 'ballast') === 'zand' ? 1.5 : 0;
    ballastG = (Math.max(0, cavity) / 1000) * density * 0.85;
    masses.push({ m: ballastG, z: base.z0 + (base.h - BASE.top) / 2 });
  }

  // pendant extras: cap over the nut and the ceiling canopy
  const extras: Piece[] = [];
  if (isPendant && bool(p, 'cableCap')) {
    const cap = newPiece('cap', 'Kapje trekontlasting', specs[0].color, CAP.h);
    cap.minInner = CAP.holeR;
    cap.z0 = stackTop;
    extras.push(cap);
  }
  let canopyTop = stackTop + 60;
  if (isPendant && bool(p, 'canopy')) {
    const D = clamp(num(p, 'canopyD'), 60, 200);
    const H = clamp(num(p, 'canopyH'), 15, 60);
    const can = newPiece('canopy', 'Plafondkap', str(p, 'canopyColor'), H, { slot: 0, shape: 'canopy', kap: '', D, H, v: 0, n: 0, flip: false, tex: 'glad', texN: 0, color: str(p, 'canopyColor') });
    can.z0 = stackTop + (bool(p, 'cableCap') ? CAP.h : 0) + 250;
    canopyTop = can.z0 + H;
    extras.push(can);
  }
  for (const pc of extras) {
    // the canopy prints floor down; the cap whichever way needs least change
    pc.flipped = pc.role === 'cap' && orientationCost(pc, c, true) < orientationCost(pc, c, false) * 0.8;
    finish(pc, c);
    const printH = pc.final[pc.final.length - 1].z;
    let solid = latheSolid(M, pc.final, pc.pattern);
    if (pc.role === 'canopy') {
      const R = pc.spec!.D / 2;
      let spacing = clamp(num(p, 'canopyScrews'), 30, 200) / 2;
      // bosses stand on the flat part of the floor, inside the rounded bottom edge
      const maxS = R - Math.max(CANOPY.wall, Math.min(pc.h / 2, 10)) - CANOPY.boss - 1;
      if (spacing > maxS) {
        notes.push(`Schroefafstand plafondkap verkleind tot ${(2 * maxS).toFixed(0)} mm (past anders niet in de kap).`);
        spacing = maxS;
      }
      if (spacing < CANOPY.boss + BORE_R + 4) throw new UserError('De plafondkap is te klein voor de schroeven. Maak hem groter.');
      const bosses: Manifold[] = [];
      const holes: Manifold[] = [];
      for (const x of [-spacing, spacing]) {
        bosses.push(M.Manifold.cylinder(printH - CANOPY.floor, CANOPY.boss, CANOPY.boss, 32).translate([x, 0, CANOPY.floor - 0.5]));
        holes.push(M.Manifold.cylinder(printH + 1, CANOPY.screw / 2, CANOPY.screw / 2, 24).translate([x, 0, -0.5]));
        // countersunk head (90°) at the visible underside
        holes.push(M.Manifold.cylinder(2.3 + 0.01, 4.5, 2.25, 24).translate([x, 0, -0.01]));
      }
      solid = M.Manifold.union([solid, ...bosses]).subtract(M.Manifold.union(holes));
    }
    const idx = parts.length;
    parts.push({ name: pc.name, solid, color: pc.color });
    scene.push({ kind: 'part', part: idx, matrix: placeMatrix(pc) });
    const maxO = Math.max(...pc.final.map((q) => q.o));
    rows.push(['–', pc.name, `Ø${(2 * maxO).toFixed(0)} × ${pc.h.toFixed(0)} mm`, colorName(pc.color), pc.flipped ? 'ondersteboven' : 'rechtop']);
  }

  // display only: tube, socket, bulb, cable
  const tubeBottom = isPendant ? socketFace - 10 : base ? base.z0 + base.h - BASE.top - 10 : 0;
  const tubeTop = isPendant ? stackTop + 18 : socketFace + 10;
  const tubeL = Math.ceil((tubeTop - tubeBottom) / 5) * 5;
  scene.push({ kind: 'box', size: [10, 10, tubeTop - tubeBottom], position: [-5, -5, tubeBottom], color: '#8a8f98', material: 'ghost', label: 'Draadbuis M10x1' });
  scene.push({ kind: 'box', size: [socket.d, socket.d, socket.h], position: [-socket.d / 2, -socket.d / 2, Math.min(socketFace, mouth)], color: '#6b6f76', material: 'ghost', label: `Fitting ${socket.label}` });
  scene.push({ kind: 'box', size: [bulb.d, bulb.d, glass.length], position: [-bulb.d / 2, -bulb.d / 2, Math.min(mouth, tip)], color: '#f3d36b', material: 'ghost', label: bulb.label });
  if (isPendant) scene.push({ kind: 'box', size: [6, 6, Math.max(1, canopyTop - stackTop)], position: [-3, -3, stackTop], color: '#3a3d42', material: 'ghost', label: 'Snoer' });

  // ---- stability and weight
  const lampMass = bulb.mass + socket.mass + tubeL * TUBE_G_PER_MM;
  masses.push({ m: lampMass, z: (socketFace + tip) / 2 });
  const total = masses.reduce((s, q) => s + q.m, 0);
  const zcm = masses.reduce((s, q) => s + q.m * q.z, 0) / Math.max(1, total);
  const height = Math.max(stackTop, tip) - Math.min(0, tip);
  const info: InfoBlock[] = [];
  const kv: [string, string][] = [
    ['Hoogte', `${height.toFixed(0)} mm${isPendant ? ' (zonder snoer)' : ''}`],
    ['Grootste diameter', `${Math.max(...all.filter((q) => q.final.length).map((q) => 2 * Math.max(...q.final.map((s) => s.o))), 0).toFixed(0)} mm`],
    ['Lamp', `${bulb.label} · LED`],
    ['Draadbuis', `M10x1, ${tubeL} mm`],
    ['Gewicht ≈', `${(total / 1000).toFixed(2)} kg${ballastG > 0 ? ` (waarvan ${(ballastG / 1000).toFixed(2)} kg verzwaring)` : ''}`],
  ];
  if (base) {
    const contact = stackFinal(base)[0].o * (bool(p, 'felt') ? 0.72 : 0.95);
    const tipAngle = (Math.atan2(contact, Math.max(1, zcm)) * 180) / Math.PI;
    kv.push(['Kantelhoek', `${tipAngle.toFixed(0)}° (zwaartepunt op ${zcm.toFixed(0)} mm)`]);
    if (tipAngle < 15) warnings.push(`De lamp is topzwaar: hij kantelt al bij ${tipAngle.toFixed(0)}°. Maak de voet breder of zwaarder, of de stapel lager/lichter.`);
    else if (tipAngle < 22) tips.push(`Kantelhoek ${tipAngle.toFixed(0)}°: stabiel genoeg op een vlakke tafel, maar een bredere of zwaardere voet maakt hem steviger.`);
    if (height > 4.5 * base.spec!.D) warnings.push(`De lamp is ${(height / base.spec!.D).toFixed(1)}× zo hoog als de voet breed is — dat oogt wankel. Een bredere voet helpt.`);
  } else if (total > 2000) {
    warnings.push(`De hanglamp weegt ≈ ${(total / 1000).toFixed(1)} kg: hang hem aan een plafondhaak met staalkabel, niet alleen aan het snoer.`);
  }
  info.push({ kind: 'kv', title: 'Lamp', rows: kv });
  info.push({ kind: 'table', title: 'Printdelen (stapel van boven naar beneden)', headers: ['Seg.', 'Vorm', 'Maat', 'Kleur', 'Printstand'], rows: rows.reverse() });
  info.push({ kind: 'table', title: 'Benodigdheden', headers: ['#', 'Onderdeel'], rows: hardware(isPendant, socket, bulb, bulbKey, tubeL, !!base, bool(p, 'felt'), str(p, 'ballast'), bool(p, 'canopy'), ballastG) });
  info.push({ kind: 'text', title: 'Montage', text: assembly(socket, !!base, useCover, hasKap, chainPieces.length > 0, all.some((q) => q.role === 'posts' && !q.chain), layerPieces.length + 1) });

  warnings.push(...notes);
  tips.push(
    'Alleen LED-lampen: PLA wordt zacht vanaf ~55 °C. Print kappen en delen dicht bij de lamp in PETG.',
    'Elk segment is een eigen printdeel: print ze in hun eigen kleur. De centreerkegels tussen de segmenten houden de stapel recht; de draadbuis klemt alles vast.',
    'Kappen en lamellen in wit PETG/PLA met 1–2 wandlussen en 0% infill laten het licht mooi door. Massieve segmenten: 2–3 wanden en 10–15% infill is genoeg.',
    'Bollen en koepels hebben aan de onderkant een kegel van 45°: zo printen ze zonder support.',
  );
  if (kapPiece?.layer) {
    const used = [kapPiece, ...layerPieces].map((q) => q.layer!).filter(isShaded);
    tips.push(
      layerPieces.length
        ? `Kap in ${layerPieces.length + 1} lagen: print elke laag apart in doorschijnend PLA of PETG ("translucent"/"clear"). Een wand van 0,8–1,6 mm laat het meeste licht door; de tussenruimte van ${layers.gap} mm geeft de moiré.`
        : 'Patroonkap: print in doorschijnend PLA of PETG; een wand van 0,8–1,6 mm laat het meeste licht door.',
    );
    if (used.some((q) => RELIEF_PATS.has(q.pat))) tips.push(`Golven en plissé hebben overal dezelfde wanddikte: 1–2 wandlussen en 0% infill${layerPieces.length ? '' : ', of vase mode (spiraalvaas) met de plafondschijf als bodemlagen'}.`);
    const open = (q: LayerSpec) => HOLEABLE.has(q.pat) && q.holes;
    if (used.some((q) => THICK_PATS.has(q.pat) && !open(q))) tips.push('Strepen, raster, stippen en honingraat zijn dikke en dunne wand: zet 2–3 wandlussen en 100% infill (of "gap fill" aan), dan worden de dikke delen massief en zie je het patroon als licht en donker. Niet in vase mode.');
    if (used.some(open)) tips.push('Doorbroken lagen: elk gaatje loopt aan de bovenkant (zoals geprint) spits toe onder 56°, dus het print zonder support.');
  }
  if (specs.some((s) => s.tex === 'plisse' || s.tex === 'ribbels')) tips.push('Fijne plissé: print met 0,12–0,16 mm laaghoogte en zet "naad" op "achter" of "uitgelijnd" zodat de naad in een vouw valt.');
  return { parts, scene, info, tips, warnings, defaultView: 'assembly' };
}

const LID_SCREWS = [Math.PI / 2, Math.PI / 2 + TAU / 3, Math.PI / 2 + (2 * TAU) / 3];

const colorName = (hex: string) => COLOR_OPTIONS.find((o) => o.value === hex)?.label.split(' (')[0] ?? hex;

function hardware(isPendant: boolean, socket: Socket, bulb: Bulb, bulbKey: string, tubeL: number, base: boolean, felt: boolean, ballast: string, canopy: boolean, ballastG: number): (string | number)[][] {
  const rows: (string | number)[][] = [
    [1, `Holle draadbuis M10x1 (Ø10 mm), ${tubeL} mm — op maat zagen en ontbramen`],
    [isPendant ? 1 : 2, 'Moer M10x1 (+ sluitring Ø20 mm)'],
    [1, `Fitting ${socket.label} met M10x1-binnendraad (nippelmontage)`],
    [1, `LED-lamp ${bulb.label.split(' —')[0]} ${socket.label} (${bulbKey === 'g9' ? 'G9 LED' : 'max. ~8 W LED'})`],
    [1, isPendant ? 'Snoer 2 × 0,75 mm² (dubbel geïsoleerd), lengte naar wens' : 'Snoer 2 × 0,75 mm² met stekker en snoerschakelaar, ~2 m'],
  ];
  if (isPendant) {
    rows.push([1, 'Trekontlasting / kabelwartel M10x1 op de buis (boven)']);
    if (canopy) rows.push([1, 'Trekontlasting M10x1 + kort draadeind en moer in de plafondkap'], [2, 'Schroef 4 × 40 mm platkop + plug'], [1, 'Lasklem (Wago) voor de aansluiting in de plafonddoos']);
  }
  if (base) {
    rows.push([3, 'Spaanplaatschroef 3 × 12 mm platkop (bodemplaat)']);
    if (felt) rows.push([4, 'Viltjes Ø20 mm']);
    if (ballast !== 'geen') rows.push(['≈', `${(ballastG / 1000).toFixed(2)} kg ${ballast === 'staal' ? 'stalen ringen / loodvrije kogels' : 'zand (in een zakje)'} als verzwaring`]);
  }
  return rows;
}

function assembly(socket: Socket, base: boolean, cover: boolean, kap: boolean, chain: boolean, posts: boolean, layers: number): string {
  const steps: string[] = [];
  if (base) {
    steps.push('1. Steek de draadbuis van onderen door de voet en zet hem in de holte vast met sluitring + moer.');
    steps.push('2. Schuif de segmenten van onder naar boven over de buis (segment met het hoogste nummer eerst). De kegelvormige nokjes vallen in elkaars uitsparing.');
    steps.push(`3. ${cover ? 'Schuif de fittingkraag erop en d' : 'D'}raai de ${socket.label}-fitting op de buis: die klemt de stapel vast. Contramoer eronder als je wilt.`);
    steps.push('4. Trek het snoer door de buis, sluit de fitting aan (trekontlasting in de fitting!) en leid het snoer in de voet door de sleuf naar buiten.');
    steps.push('5. Vul de holte met verzwaring en schroef de bodemplaat met 3 schroeven vast. Plak de viltjes in de uitsparingen.');
  } else {
    steps.push('1. Schuif de segmenten van boven naar beneden over de draadbuis (segment 1 bovenaan) en zet ze boven vast met sluitring + moer.');
    steps.push(`2. ${kap ? 'Onder de kap' : cover ? 'Onder de fittingkraag' : 'Onderaan'} draai je de ${socket.label}-fitting op de buis: die klemt de stapel vast.`);
    steps.push('3. Trek het snoer van boven door de buis en sluit de fitting aan. Zet boven een trekontlasting (kabelwartel M10x1) op de buis — de lamp hangt aan die trekontlasting, nooit aan de aansluitdraden.');
    steps.push('4. De plafondkap hangt aan een tweede trekontlasting; schroef hem met twee schroeven tegen het plafond en sluit aan met lasklemmen.');
  }
  if (layers > 1) steps.push(`Kap in lagen: schuif eerst de buitenste kap op de buis, dan laag 2${layers > 2 ? ' en laag 3' : ''}. Het kegeltje onder elke plafondschijf valt in de uitsparing van de volgende laag, zo blijven de lagen in het midden; de fitting klemt ze tegen elkaar. Draai een laag een stukje rond voor een ander moiré-beeld.`);
  if (posts) steps.push('Stijlen: steek ze in de gaatjes van de segmenten erboven en eronder; de buis houdt alles op zijn plek.');
  if (chain) steps.push('Lamellen: lijm de stijlen in de rand van de kap en in de lamellen (secondelijm of 2K-lijm), afwisselend een lamel en een set stijlen.');
  steps.push('Laat de aansluiting op het lichtnet door een vakkundig iemand controleren. Alleen LED-lampen.');
  return steps.join('\n');
}

// ---------------------------------------------------------------------------
// Presets and randomize

const slot = (i: number, s: Partial<{ shape: string; kap: string; D: number; H: number; v: number; n: number; flip: boolean; tex: string; texN: number; color: string }>): Partial<Params> => {
  const out: Partial<Params> = {};
  if (s.shape !== undefined) out[`s${i}Shape`] = s.shape;
  if (s.kap !== undefined) out[`s${i}Kap`] = s.kap;
  if (s.D !== undefined) out[`s${i}D`] = s.D;
  if (s.H !== undefined) out[`s${i}H`] = s.H;
  if (s.v !== undefined) out[`s${i}Var`] = s.v;
  if (s.n !== undefined) out[`s${i}N`] = s.n;
  if (s.flip !== undefined) out[`s${i}Flip`] = s.flip;
  out[`s${i}Tex`] = s.tex ?? 'glad';
  if (s.texN !== undefined) out[`s${i}TexN`] = s.texN;
  if (s.color !== undefined) out[`s${i}Color`] = s.color;
  return out;
};
const stack = (...slots: Parameters<typeof slot>[1][]): Partial<Params> => Object.assign({ count: slots.length }, ...slots.map((s, i) => slot(i + 1, s)));

const W = '#f2efe8';
const TERRA = '#c8693f';
const TEAL = '#2f7f7a';
const SAND = '#d8c3a0';
const YELLOW = '#e8b931';
const RED = '#c8352e';
const BLUE = '#2f5aa8';
const BLACK = '#2b2b2e';
const PINK = '#e7a3b0';
const SAGE = '#8fae8b';

const presets: Preset[] = [
  {
    name: 'Bloemetjeslamp (tafel)',
    values: {
      lampType: 'table', socket: 'e27', bulb27: 'g95', baseShape: 'koepel', baseD: 150, baseH: 44, baseColor: SAGE,
      ...stack(
        { shape: 'bloem', D: 130, H: 16, n: 8, v: 50, color: PINK },
        { shape: 'bol', D: 74, H: 62, v: 20, color: YELLOW },
        { shape: 'kussen', D: 112, H: 28, v: 60, color: SAGE },
        { shape: 'bloem', D: 150, H: 16, n: 6, v: 60, color: TERRA },
      ),
    },
  },
  {
    name: 'Totem plissé (tafel)',
    values: {
      lampType: 'table', socket: 'e27', bulb27: 'g125', baseShape: 'kegel', baseD: 170, baseH: 45, baseColor: TERRA, texDepth: 1.2,
      ...stack(
        { shape: 'tol', D: 130, H: 100, n: 1, v: 10, tex: 'plisse', texN: 120, color: TERRA },
        { shape: 'bol', D: 110, H: 92, v: 25, tex: 'plisse', texN: 140, color: W },
        { shape: 'cilinder', D: 96, H: 60, v: 20, tex: 'ringen', texN: 7, color: TEAL },
        { shape: 'boog', D: 120, H: 80, v: 60, flip: true, tex: 'plisse', texN: 110, color: SAND },
      ),
    },
  },
  {
    name: 'Totem hanglamp',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'a60', texDepth: 1.2,
      ...stack(
        { shape: 'bol', D: 90, H: 72, v: 25, tex: 'plisse', texN: 100, color: TEAL },
        { shape: 'diabolo', D: 120, H: 70, n: 1, v: 35, tex: 'plisse', texN: 120, color: TERRA },
        { shape: 'cilinder', D: 104, H: 36, v: 30, tex: 'ringen', texN: 4, color: SAND },
        { shape: 'kap', kap: 'koepel', D: 230, H: 125, tex: 'plisse', texN: 160, color: W },
      ),
    },
  },
  {
    name: 'Memphis (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'g95', canopyColor: YELLOW,
      ...stack(
        { shape: 'koepel', D: 170, H: 62, v: 0, color: YELLOW },
        { shape: 'stijlen', D: 80, H: 34, n: 3, v: 20, color: BLACK },
        { shape: 'schijf', D: 240, H: 8, v: 30, color: RED },
        { shape: 'stijlen', D: 80, H: 34, n: 3, v: 20, color: BLACK },
        { shape: 'schijf', D: 200, H: 8, v: 30, color: BLUE },
        { shape: 'hals', D: 26, H: 30, color: BLACK },
        { shape: 'kap', kap: 'cilinder', D: 140, H: 70, color: RED },
      ),
    },
  },
  {
    name: 'Lagenkoepel (louvre)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'g95', shadeWall: 1.4,
      ...stack(
        { shape: 'cilinder', D: 40, H: 30, v: 40, color: W },
        { shape: 'kap', kap: 'koepel', D: 260, H: 110, color: W },
        { shape: 'stijlen', D: 220, H: 22, n: 4, v: 10, color: W },
        { shape: 'lamel', D: 230, H: 8, v: 15, color: W },
        { shape: 'stijlen', D: 190, H: 22, n: 4, v: 10, color: W },
        { shape: 'lamel', D: 200, H: 8, v: 15, color: W },
        { shape: 'stijlen', D: 160, H: 22, n: 4, v: 10, color: W },
        { shape: 'lamel', D: 170, H: 8, v: 15, color: W },
      ),
    },
  },
  {
    name: 'Ziggurat (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'a60', canopyColor: TERRA,
      ...stack(
        { shape: 'bol', D: 54, H: 44, v: 30, color: BLACK },
        { shape: 'hals', D: 24, H: 30, color: BLACK },
        { shape: 'kap', kap: 'trap', D: 250, H: 150, n: 5, v: 25, color: TERRA },
      ),
    },
  },
  {
    name: 'Geribbelde klok (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'st64', texDepth: 1.6,
      ...stack(
        { shape: 'cilinder', D: 44, H: 34, v: 30, color: BLACK },
        { shape: 'kap', kap: 'klok', D: 240, H: 170, v: 20, tex: 'ribbels', texN: 48, color: W },
      ),
    },
  },
  {
    name: 'Schijven en halve bol (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'p45e27',
      ...stack(
        { shape: 'bol', D: 60, H: 50, v: 30, color: BLACK },
        { shape: 'hals', D: 24, H: 26, color: BLACK },
        { shape: 'schijf', D: 190, H: 8, v: 40, color: SAGE },
        { shape: 'stijlen', D: 60, H: 26, n: 3, v: 20, color: BLACK },
        { shape: 'schijf', D: 160, H: 8, v: 40, color: YELLOW },
        { shape: 'kap', kap: 'koepel', D: 170, H: 85, color: W },
      ),
    },
  },
  {
    name: 'Tandwiel & kussen (tafel)',
    values: {
      lampType: 'table', socket: 'e27', bulb27: 'g80', baseShape: 'trap', baseD: 150, baseH: 40, baseColor: BLUE,
      ...stack(
        { shape: 'tandwiel', D: 120, H: 14, n: 18, v: 50, color: YELLOW },
        { shape: 'kussen', D: 100, H: 34, v: 80, color: BLUE },
        { shape: 'tandwiel', D: 140, H: 14, n: 22, v: 50, color: RED },
        { shape: 'bol', D: 80, H: 70, v: 25, color: YELLOW },
      ),
    },
  },
  {
    name: 'Uplight met plissé kap (tafel)',
    values: {
      lampType: 'table', socket: 'e14', bulb14: 'g45', baseShape: 'schijf', baseD: 130, baseH: 36, baseColor: BLACK,
      ...stack(
        { shape: 'kap', kap: 'kegel', D: 200, H: 110, v: 10, tex: 'plisse', texN: 90, color: W },
        { shape: 'hals', D: 24, H: 120, color: BLACK },
        { shape: 'tol', D: 76, H: 90, n: 2, v: 30, color: BLACK },
      ),
    },
  },
  {
    name: 'Moiré golven (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'a60', shadeWall: 1, layers: '2', layerGap: 6,
      kl1Pat: 'golfOp', kl1N: 28, kl1Depth: 2, kl1Twist: 40,
      kl2Pat: 'golfRond', kl2N: 5, kl2Up: 8, kl2Depth: 1.6, kl2Len: 94, kl2Color: W,
      ...stack(
        { shape: 'cilinder', D: 44, H: 30, v: 30, color: BLACK },
        { shape: 'kap', kap: 'klok', D: 230, H: 170, v: 30, color: W },
      ),
    },
  },
  {
    name: 'Raster in golf (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'a60', shadeWall: 1, layers: '2', layerGap: 5,
      kl1Pat: 'golfRond', kl1N: 4, kl1Up: 6, kl1Depth: 2,
      kl2Pat: 'raster', kl2N: 40, kl2Depth: 1.2, kl2Holes: false, kl2Len: 100, kl2Color: W,
      ...stack(
        { shape: 'bol', D: 56, H: 46, v: 30, color: TEAL },
        { shape: 'kap', kap: 'cilinder', D: 200, H: 160, v: 30, color: W },
      ),
    },
  },
  {
    name: 'Stippen in een gladde kap (hanglamp)',
    values: {
      lampType: 'pendant', socket: 'e27', bulb27: 'a60', shadeWall: 1.2, layers: '2', layerGap: 8,
      kl1Pat: 'glad',
      kl2Pat: 'stippen', kl2N: 32, kl2Holes: true, kl2Len: 88, kl2Color: YELLOW,
      ...stack(
        { shape: 'cilinder', D: 40, H: 26, v: 40, color: W },
        { shape: 'kap', kap: 'koepel', D: 240, H: 130, color: W },
      ),
    },
  },
  {
    name: 'Drie lagen honingraat (tafel)',
    values: {
      lampType: 'table', socket: 'e14', bulb14: 'g45', baseShape: 'schijf', baseD: 150, baseH: 40, baseColor: BLACK, shadeWall: 1, layers: '3', layerGap: 5,
      kl1Pat: 'strepen', kl1N: 36, kl1Depth: 1, kl1Twist: 90,
      kl2Pat: 'hex', kl2N: 30, kl2Depth: 1.2, kl2Len: 92, kl2Color: W,
      kl3Pat: 'golfOp', kl3N: 20, kl3Depth: 1.6, kl3Twist: -60, kl3Len: 82, kl3Color: PINK,
      ...stack(
        { shape: 'kap', kap: 'cilinder', D: 190, H: 150, color: W },
        { shape: 'hals', D: 24, H: 60, color: BLACK },
        { shape: 'tol', D: 76, H: 70, n: 2, v: 30, color: BLACK },
      ),
    },
  },
];

const rnd = (a: number, b: number, step = 1) => Math.round((a + Math.random() * (b - a)) / step) * step;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const SOLID_SHAPES = ['bol', 'kussen', 'cilinder', 'tol', 'diabolo', 'kegel', 'koepel', 'boog', 'trap', 'bloem', 'tandwiel', 'schijf', 'hals'];

function randomize(): Partial<Params> {
  const isPendant = Math.random() < 0.5;
  const palette = [...COLOR_OPTIONS.map((o) => o.value)].sort(() => Math.random() - 0.5).slice(0, 3);
  const n = rnd(2, isPendant ? 5 : 6);
  const slots: Parameters<typeof slot>[1][] = [];
  for (let i = 0; i < n; i++) {
    const shape = pick(SOLID_SHAPES);
    const flat = ['bloem', 'tandwiel', 'schijf', 'kussen'].includes(shape);
    slots.push({
      shape,
      D: shape === 'hals' ? rnd(22, 40) : rnd(60, 170),
      H: flat ? rnd(8, 30) : rnd(30, 90),
      v: rnd(0, 80),
      n: shape === 'bloem' ? rnd(5, 10) : shape === 'tandwiel' ? rnd(12, 28) : rnd(1, 4),
      flip: Math.random() < 0.2,
      tex: Math.random() < 0.5 ? 'glad' : pick(['plisse', 'ribbels', 'ringen']),
      texN: rnd(40, 140),
      color: pick(palette),
    });
  }
  const hasKap = isPendant && Math.random() < 0.7;
  if (hasKap) slots.push({ shape: 'kap', kap: pick(KAP_OPTIONS.map((o) => o.value)), D: rnd(160, 260), H: rnd(90, 170), v: rnd(0, 40), n: rnd(3, 6), tex: Math.random() < 0.5 ? 'glad' : 'plisse', texN: rnd(60, 160), color: W });
  // sometimes a layered (moiré) shade
  const layered: Partial<Params> = { layers: '1', kl1Pat: 'segment' };
  if (hasKap && Math.random() < 0.4) {
    const pats = LAYER_PATTERNS.map((o) => o.value).filter((v) => v !== 'glad');
    const count = Math.random() < 0.75 ? 2 : 3;
    Object.assign(layered, { layers: String(count), layerGap: rnd(4, 10), shadeWall: 1 });
    for (let i = 1; i <= count; i++) {
      const pat = pick(pats);
      Object.assign(layered, {
        [`kl${i}Pat`]: pat, [`kl${i}N`]: pat === 'golfRond' ? rnd(3, 8) : rnd(16, 48), [`kl${i}Up`]: rnd(4, 10), [`kl${i}Depth`]: rnd(8, 20) / 10,
        [`kl${i}Twist`]: pick([0, 0, 45, -60, 90]), [`kl${i}Holes`]: HOLEABLE.has(pat) && Math.random() < 0.4, [`kl${i}Len`]: rnd(80, 100), [`kl${i}Color`]: W,
      });
    }
  }
  return {
    ...layered,
    lampType: isPendant ? 'pendant' : 'table',
    socket: 'e27',
    bulb27: isPendant ? pick(['a60', 'g95', 'st64']) : pick(['g95', 'g125', 'g80']),
    baseShape: pick(BASE_SHAPES.map((o) => o.value)),
    baseD: rnd(140, 200),
    baseH: rnd(35, 60),
    baseColor: pick(palette),
    ...stack(...slots),
  };
}

export const lampTool: ToolDef = {
  id: 'lamp',
  name: 'Lampen',
  short: 'Lampen',
  icon: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3',
  description:
    'Stapelbare hang- en tafellampen: kies tot acht segmenten (bol, tol, kussen, bloem, tandwiel, ziggurat, kap, lamellen…) met plissé, ribbels of ringen, elk in een eigen kleur. Alles schuift over een standaard draadbuis M10x1 met E27/E14/G9-fitting.',
  params,
  presets,
  randomize,
  build,
};
