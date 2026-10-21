import type { ParamDef, Params } from '../core/types';
import { bool, num, str } from '../core/types';
import { TAU, clamp, smoothstep } from '../geom/helpers';
import type { ShadeField } from '../geom/shade';
import { COLOR_OPTIONS } from './lampParts';

// ---------------------------------------------------------------------------
// Layered (nested) lamp shades: two or three thin shades in translucent
// filament, one inside the other with a gap, each with its own pattern. The
// light through both layers makes moiré / interference patterns.

export const MAX_LAYERS = 3;
/** Thickness of the ceiling of an inner layer (takes the centring recess). */
export const LAYER_CEIL = 5;
/** Smallest web between openings, and the slope of the roof of an opening (from horizontal). */
const WEB = 2;
const ROOF = Math.tan((56 * Math.PI) / 180);

export const LAYER_PATTERNS = [
  { value: 'glad', label: 'Glad' },
  { value: 'golfOp', label: 'Golven omhoog (ribben, ook gedraaid)' },
  { value: 'plisse', label: 'Plissé (scherpe vouwen, ook gedraaid)' },
  { value: 'golfRond', label: 'Golven rondom (golvende ringen)' },
  { value: 'strepen', label: 'Strepen (dik/dun, ook schuin)' },
  { value: 'raster', label: 'Raster (vierkant)' },
  { value: 'ruit', label: 'Ruitraster (diagonaal)' },
  { value: 'stippen', label: 'Stippen / rondjes' },
  { value: 'hex', label: 'Honingraat (zeshoeken)' },
];
const SEGMENT = { value: 'segment', label: 'Textuur van het segment' };

/** Patterns where the whole wall undulates (constant thickness: vase mode works). */
export const RELIEF = new Set(['golfOp', 'plisse', 'golfRond']);
/** Patterns made of thicker and thinner wall. */
export const THICK = new Set(['strepen', 'raster', 'ruit', 'stippen', 'hex']);
/** Patterns that can be openings instead of thin spots. */
export const HOLEABLE = new Set(['raster', 'ruit', 'stippen', 'hex']);
const TWISTED = new Set(['golfOp', 'plisse', 'strepen']);

export interface LayerSpec {
  /** 1 = outer layer (the kap segment itself). */
  index: number;
  pat: string;
  n: number;
  up: number;
  depth: number;
  twist: number;
  holes: boolean;
  /** Length of an inner layer relative to the open depth of the outer one. */
  len: number;
  color: string;
}

export interface LayerSetup {
  count: number;
  gap: number;
  specs: LayerSpec[];
}

const LAYER_DEFAULTS = [
  { pat: 'segment', n: 24, up: 6, depth: 1.6, twist: 0, len: 100 },
  { pat: 'golfRond', n: 5, up: 7, depth: 1.6, twist: 0, len: 92 },
  { pat: 'stippen', n: 30, up: 6, depth: 1, twist: 0, len: 84 },
];

const k = (i: number, x: string) => `kl${i}${x}`;

/** Parameters of the layered shade; `kapOn` = there is a kap in the lamp. */
export function layerParams(kapOn: (p: Params) => boolean): ParamDef[] {
  const count = (p: Params) => clamp(Math.round(Number(str(p, 'layers')) || 1), 1, MAX_LAYERS);
  const out: ParamDef[] = [
    { type: 'group', label: 'Kap in lagen', show: kapOn },
    {
      type: 'select', key: 'layers', label: 'Lagen', default: '1', show: kapOn,
      options: [
        { value: '1', label: '1 — gewone kap' },
        { value: '2', label: '2 — kap in kap (moiré)' },
        { value: '3', label: '3 — drie kappen in elkaar' },
      ],
      help: 'Elke laag is een eigen dunne kap in doorschijnend filament; door de lagen heen geeft het licht moiré-patronen. Laag 1 is de kap van het segment.',
    },
    {
      type: 'number', key: 'layerGap', label: 'Tussenruimte', min: 3, max: 15, step: 0.5, unit: 'mm', default: 6, show: (p) => kapOn(p) && count(p) > 1,
      help: 'Ruimte tussen de lagen (haaks op de wand). Meer ruimte = grotere, zachtere moiré.',
    },
  ];
  for (let i = 1; i <= MAX_LAYERS; i++) {
    const d = LAYER_DEFAULTS[i - 1];
    const on = (p: Params) => kapOn(p) && count(p) >= i;
    const pat = (p: Params) => str(p, k(i, 'Pat'));
    const holes = (p: Params) => HOLEABLE.has(pat(p)) && bool(p, k(i, 'Holes'));
    out.push(
      { type: 'group', label: i === 1 ? 'Laag 1 (buiten)' : i === MAX_LAYERS ? `Laag ${i} (binnen)` : `Laag ${i}`, show: on },
      {
        type: 'select', key: k(i, 'Pat'), label: 'Patroon', options: i === 1 ? [SEGMENT, ...LAYER_PATTERNS] : LAYER_PATTERNS, default: d.pat, show: on,
        help: 'Golven en plissé: de hele wand golft (ook in vase mode). Strepen, raster, stippen, honingraat: dikke en dunne wand (meer of minder licht), of echte gaatjes.',
      },
      {
        type: 'number', key: k(i, 'N'), label: 'Aantal rondom', min: 3, max: 120, step: 1, default: d.n,
        show: (p) => on(p) && pat(p) !== 'glad' && pat(p) !== 'segment',
        help: 'Golven/vouwen/strepen rondom; bij golvende ringen: golven per ring; bij raster, stippen en honingraat: cellen rondom.',
      },
      {
        type: 'number', key: k(i, 'Up'), label: 'Ringen in de hoogte', min: 2, max: 40, step: 1, default: d.up,
        show: (p) => on(p) && pat(p) === 'golfRond',
      },
      {
        type: 'number', key: k(i, 'Depth'), label: 'Diepte', min: 0.3, max: 4, step: 0.1, unit: 'mm', default: d.depth,
        show: (p) => on(p) && (RELIEF.has(pat(p)) || (THICK.has(pat(p)) && !holes(p))),
        help: 'Golven: hoe diep de wand golft. Strepen/raster/stippen: hoeveel dikker de dikke delen zijn dan de wand.',
      },
      {
        type: 'number', key: k(i, 'Twist'), label: 'Draaiing', min: -360, max: 360, step: 5, unit: '°', default: d.twist,
        show: (p) => on(p) && TWISTED.has(pat(p)),
        help: 'Hoeveel de golven/strepen over de hoogte meedraaien (spiraal).',
      },
      {
        type: 'bool', key: k(i, 'Holes'), label: 'Doorbroken (gaatjes)', default: false, show: (p) => on(p) && HOLEABLE.has(pat(p)),
        help: 'Echte openingen in plaats van dunne plekken. De bovenkant van elk gaatje loopt spits toe (ruit, druppel), zodat het zonder support print.',
      },
    );
    if (i > 1) {
      out.push(
        {
          type: 'number', key: k(i, 'Len'), label: 'Lengte', min: 40, max: 130, step: 1, unit: '%', default: d.len, show: on,
          help: 'Lengte t.o.v. de buitenste kap: korter blijft binnen, langer steekt eruit.',
        },
        { type: 'select', key: k(i, 'Color'), label: 'Kleur', options: COLOR_OPTIONS, default: '#f2efe8', show: on },
      );
    }
  }
  return out;
}

/** The layer setup of the parameters (count 1 with a plain outer layer = no layers at all). */
export function layersOf(p: Params, kapColor: string): LayerSetup {
  const count = clamp(Math.round(Number(str(p, 'layers')) || 1), 1, MAX_LAYERS);
  const specs: LayerSpec[] = [];
  for (let i = 1; i <= count; i++) {
    const d = LAYER_DEFAULTS[i - 1];
    const raw = typeof p[k(i, 'Pat')] === 'string' ? str(p, k(i, 'Pat')) : d.pat;
    const valid = (i === 1 && raw === 'segment') || LAYER_PATTERNS.some((o) => o.value === raw);
    const v = (x: string, def: number) => (typeof p[k(i, x)] === 'number' ? num(p, k(i, x)) : def);
    specs.push({
      index: i,
      pat: valid ? raw : i === 1 ? 'segment' : 'glad',
      n: clamp(Math.round(v('N', d.n)), 3, 120),
      up: clamp(Math.round(v('Up', d.up)), 1, 40),
      depth: clamp(v('Depth', d.depth), 0.2, 4),
      twist: clamp(v('Twist', d.twist), -720, 720),
      holes: typeof p[k(i, 'Holes')] === 'boolean' ? bool(p, k(i, 'Holes')) : false,
      len: clamp(v('Len', d.len), 30, 150) / 100,
      color: i === 1 ? kapColor : typeof p[k(i, 'Color')] === 'string' ? str(p, k(i, 'Color')) : '#f2efe8',
    });
  }
  return { count, gap: clamp(typeof p.layerGap === 'number' ? num(p, 'layerGap') : 6, 2, 20), specs };
}

/** Does a layer use the patterned shade mesher (anything but the segment's own texture)? */
export const isShaded = (s: LayerSpec) => s.pat !== 'segment';
const holesOn = (s: LayerSpec) => HOLEABLE.has(s.pat) && s.holes;

/** Upper bounds before the geometry is known: inward relief and largest wall thickness. */
export function layerBudget(s: LayerSpec, wall: number) {
  const relief = RELIEF.has(s.pat) ? Math.min(s.depth, 6) : 0;
  const thick = THICK.has(s.pat) && !holesOn(s) ? wall + s.depth : wall;
  return { relief, thick };
}

export const patternLabel = (s: LayerSpec) => (s.pat === 'segment' ? '' : (LAYER_PATTERNS.find((o) => o.value === s.pat)?.label.split(' (')[0] ?? s.pat).toLowerCase() + (holesOn(s) ? ', doorbroken' : ''));

// ---------------------------------------------------------------------------
// Pattern fields (print coordinates: z up from the bed, `z0` = start of the
// open wall above the ceiling, `R` = largest radius, `H` = top of the part)

export interface LayerGeo {
  R: number;
  z0: number;
  H: number;
  wall: number;
}

const frac = (x: number) => x - Math.floor(x);
/** 1 on a line at every integer, `w` wide (cell units) with soft edges `e`. */
const band = (x: number, w: number, e: number) => {
  const d = Math.abs(x - Math.round(x));
  return 1 - smoothstep(w / 2, w / 2 + e, d);
};
const SQ3 = Math.sqrt(3);

/** Distance to the nearest hexagon centre (pointy top, circumradius s), 1 at the edge. */
function hexMetric(x: number, y: number, s: number) {
  const q = ((SQ3 / 3) * x - y / 3) / s;
  const r = ((2 / 3) * y) / s;
  let rx = Math.round(q);
  let rz = Math.round(r);
  const ry = Math.round(-q - r);
  const dx = Math.abs(rx - q);
  const dy = Math.abs(ry + q + r);
  const dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (!(dy > dz)) rz = -rx - ry;
  const cx = s * SQ3 * (rx + rz / 2);
  const cy = s * 1.5 * rz;
  const ax = Math.abs(x - cx);
  const ay = Math.abs(y - cy);
  return Math.max(ax, ax / 2 + (ay * SQ3) / 2) / ((s * SQ3) / 2);
}

export interface FieldOut {
  field: ShadeField;
  notes: string[];
}

/** Resolution and the relief / thickness functions of one layer. */
export function layerField(s: LayerSpec, g: LayerGeo, name: string): FieldOut {
  const notes: string[] = [];
  const C = TAU * g.R;
  const Hc = Math.max(10, g.H - g.z0);
  const base = Math.round(clamp(C / 1.4, 96, 360));
  const wall = g.wall;
  let n = s.n;
  const zero = () => 0;
  const flat = () => wall;
  let relief: (z: number, th: number) => number = zero;
  let thick: (z: number, th: number) => number = flat;
  let segs = base;
  let dz = 2;
  const W = () => C / n;
  // cells/waves never smaller than ~4 mm (at the widest)
  const maxN = Math.max(3, Math.floor(C / (THICK.has(s.pat) ? 6 : 4)));
  if (n > maxN && s.pat !== 'glad') {
    notes.push(`${name}: ${n} rondom is te fijn voor Ø${(2 * g.R).toFixed(0)} mm — ${maxN} gebruikt.`);
    n = maxN;
  }
  const A = Math.min(s.depth, 6, 0.12 * g.R);
  switch (s.pat) {
    case 'golfOp':
    case 'plisse': {
      // twist (degrees over the height) as a phase shift per mm
      let twist = s.twist;
      // keep the twisted ribs from leaning more than ~30° extra
      const maxTwist = (0.6 * Hc * 360) / Math.max(1e-6, A * Math.PI * n);
      if (Math.abs(twist) > maxTwist) {
        twist = Math.sign(twist) * Math.floor(maxTwist);
        notes.push(`${name}: draaiing beperkt tot ${twist}° zodat de golven zonder support printen.`);
      }
      const per = s.pat === 'plisse' ? 4 : 12;
      segs = Math.max(base, Math.min(1440, n * per));
      segs = Math.round(segs / n) * n;
      const k = (twist / 360) * n;
      dz = twist ? clamp(Hc / Math.max(1, Math.abs(k)) / 24, 0.4, 2) : 2;
      relief =
        s.pat === 'golfOp'
          ? (z, th) => (A * (1 - Math.cos(TAU * ((th * n) / TAU + (k * (z - g.z0)) / Hc)))) / 2
          : (z, th) => A * Math.abs(2 * frac((th * n) / TAU + (k * (z - g.z0)) / Hc) - 1);
      break;
    }
    case 'golfRond': {
      const P = Hc / s.up;
      const amp = Math.min(A, (0.6 * P) / Math.PI);
      if (amp < A - 0.05) notes.push(`${name}: golfdiepte ${amp.toFixed(1)} mm (bij ${s.up} ringen kan dieper niet zonder support).`);
      const sway = 0.45;
      segs = Math.max(base, Math.min(1080, n * 24));
      dz = clamp(P / 14, 0.3, 1.5);
      relief = (z, th) => (amp * (1 - Math.cos(TAU * ((z - g.z0) / P + sway * Math.sin(n * th))))) / 2;
      break;
    }
    case 'strepen': {
      const D = s.depth;
      const k = (s.twist / 360) * n;
      const e = clamp((1.6 * D) / W(), 0.05, 0.2);
      segs = Math.max(base, Math.min(1440, n * 16));
      dz = s.twist ? clamp(Hc / Math.max(1, Math.abs(k)) / 24, 0.4, 2) : 2;
      thick = (z, th) => wall + D * band((th * n) / TAU + (k * (z - g.z0)) / Hc + 0.5, 0.5, e);
      break;
    }
    case 'raster':
    case 'ruit':
    case 'stippen':
    case 'hex': {
      if (holesOn(s)) {
        // openings are cut afterwards; the wall stays plain
        segs = Math.max(base, Math.min(1440, n * 6));
        dz = 1.5;
        break;
      }
      const D = s.depth;
      const w = W();
      const e = clamp((1.6 * D) / w, 0.05, 0.25);
      segs = Math.max(base, Math.min(1440, n * 12));
      if (s.pat === 'raster') {
        dz = clamp(w / 12, 0.3, 1.2);
        thick = (z, th) => wall + D * Math.max(band((th * n) / TAU, 0.22, e), band((z - g.z0) / w, 0.22, e));
      } else if (s.pat === 'ruit') {
        const P = 1.5 * w;
        dz = clamp(P / 16, 0.3, 1.2);
        thick = (z, th) => {
          const a = (th * n) / TAU;
          const b = (z - g.z0) / P;
          return wall + D * Math.max(band(a + b, 0.2, e), band(a - b, 0.2, e));
        };
      } else if (s.pat === 'stippen') {
        const P = (w * SQ3) / 2;
        const rho = 0.32 * w;
        const soft = Math.max(0.6, 1.6 * D);
        dz = clamp(w / 14, 0.3, 1.2);
        thick = (z, th) => {
          const zz = (z - g.z0) / P;
          const u = (th * n) / TAU;
          let best = Infinity;
          const j0 = Math.round(zz);
          for (let j = j0 - 1; j <= j0 + 1; j++) {
            const off = j & 1 ? 0.5 : 0;
            const du = u - off - Math.round(u - off);
            best = Math.min(best, Math.hypot(du * w, (zz - j) * P));
          }
          // thin (bright) dots in a thicker wall
          return wall + D * smoothstep(rho - soft / 2, rho + soft / 2, best);
        };
      } else {
        const sHex = w / SQ3;
        dz = clamp(w / 14, 0.3, 1.2);
        const lo = clamp(1 - (1.6 * D) / (0.866 * w) - 0.12, 0.55, 0.85);
        thick = (z, th) => wall + D * smoothstep(lo, lo + 0.12, hexMetric(((th * n) / TAU) * w, z - g.z0, sHex));
      }
      break;
    }
    default:
      break;
  }
  return { field: { relief, thick, segs, dz }, notes };
}

// ---------------------------------------------------------------------------
// Openings

type Poly = [number, number][];

/** Opening outlines in (tangential mm, z mm) around the centre; the roof is steep (≥ 56°). */
function holeShape(pat: string, a: number): Poly {
  switch (pat) {
    case 'ruit':
      return [[0, -1.5 * a], [a, 0], [0, 1.5 * a], [-a, 0]];
    case 'raster': {
      const c = 0.74 * a;
      return [[-a, -a - c], [a, -a - c], [a, a - c], [0, a - c + a * ROOF], [-a, a - c]];
    }
    case 'stippen': {
      // teardrop: circle with tangents at 56° to a point on top
      const beta = Math.atan(ROOF);
      const pts: Poly = [];
      const a0 = Math.PI / 2 - beta;
      const a1 = a0 - (TAU - 2 * beta);
      const steps = 14;
      const shift = 0.35 * a;
      pts.push([0, a / Math.cos(beta) - shift]);
      for (let i = 0; i <= steps; i++) {
        const t = a0 + ((a1 - a0) * i) / steps;
        pts.push([a * Math.cos(t), a * Math.sin(t) - shift]);
      }
      return pts;
    }
    default: {
      // elongated hexagon: vertical sides, steep roof, flatter floor
      const h1 = 0.5 * a;
      return [[0, -h1 - 0.58 * a], [a, -h1], [a, h1], [0, h1 + a * ROOF], [-a, h1], [-a, -h1]];
    }
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / Math.max(1e-12, vx * vx + vy * vy), 0, 1);
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

function inside(p: [number, number], poly: Poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Smallest distance between two polygons (0 when they overlap). */
function polyDist(A: Poly, B: Poly) {
  if (A.some((p) => inside(p, B)) || B.some((p) => inside(p, A))) return 0;
  let d = Infinity;
  for (const [X, Y] of [[A, B], [B, A]] as const)
    for (const p of X)
      for (let i = 0; i < Y.length; i++) {
        const a = Y[i];
        const b = Y[(i + 1) % Y.length];
        d = Math.min(d, segDist(p[0], p[1], a[0], a[1], b[0], b[1]));
      }
  return d;
}

/** Largest opening of a pattern in a cell (w wide, P high) that leaves `web` between neighbours. */
function fitHole(pat: string, w: number, P: number, web: number): Poly | null {
  const nb: [number, number][] =
    pat === 'raster' ? [[w, 0], [0, P], [w, P], [-w, P]]
    : pat === 'ruit' ? [[w / 2, P / 2], [-w / 2, P / 2], [w, 0], [0, P]]
    : pat === 'stippen' ? [[w, 0], [w / 2, P], [-w / 2, P], [0, 2 * P]]
    : [[w, 0], [w / 2, P], [-w / 2, P]];
  const ok = (a: number) => {
    const s = holeShape(pat, a);
    return nb.every(([dx, dy]) => polyDist(s, s.map(([x, y]) => [x + dx, y + dy])) >= web);
  };
  let lo = 0;
  let hi = w / 2;
  for (let it = 0; it < 16; it++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  return lo >= 1.2 ? holeShape(pat, lo) : null;
}

export interface Hole {
  th: number;
  z: number;
  poly: Poly;
}

/**
 * Openings of a perforated layer in print coordinates. `env(z)` gives the
 * outer radius, `ok(z0, z1)` says whether the wall between those heights may
 * get an opening (plain wall, not too steep).
 */
export function layerHoles(s: LayerSpec, g: LayerGeo, name: string, env: (z: number) => number, ok: (z0: number, z1: number) => boolean): { holes: Hole[]; notes: string[] } {
  const notes: string[] = [];
  if (!holesOn(s)) return { holes: [], notes };
  const C = TAU * g.R;
  // openings between ~6 and ~36 mm wide (at the widest), never more than a third of the height
  const n = clamp(s.n, Math.ceil(C / Math.min(36, (g.H - g.z0) / 3)), Math.max(3, Math.floor(C / 6)));
  if (n !== s.n) notes.push(`${name}: ${n} gaatjes rondom (i.p.v. ${s.n}) zodat ze passen.`);
  const wRef = C / n;
  // webs between the openings keep the shell stiff
  const web = Math.max(WEB, 2 * g.wall, 0.14 * wRef);
  // rows: pitch and the column offset of each row (in cells); raster cells are taller for the pointed roof
  const P = s.pat === 'raster' ? 1.45 * wRef : s.pat === 'ruit' ? 0.75 * wRef : (wRef * SQ3) / 2;
  const stagger = s.pat !== 'raster';
  const holes: Hole[] = [];
  const cache = new Map<number, Poly | null>();
  const pitchP = s.pat === 'ruit' ? 1.5 * wRef : P;
  for (let j = 0; ; j++) {
    const z = g.z0 + (j + 0.5) * P;
    if (z > g.H) break;
    const r = env(z);
    if (!(r > 5)) continue;
    const wLoc = (TAU * r) / n;
    const key = Math.round(wLoc * 4);
    if (!cache.has(key)) cache.set(key, fitHole(s.pat, wLoc, pitchP, web));
    const poly = cache.get(key)!;
    if (!poly) continue;
    const vs = poly.map((q) => q[1]);
    if (!ok(z + Math.min(...vs) - 1.5, z + Math.max(...vs) + 1.5)) continue;
    const off = stagger && j & 1 ? 0.5 : 0;
    for (let i = 0; i < n; i++) holes.push({ th: (TAU * (i + 0.5 + off)) / n, z, poly });
    if (holes.length > 2400) break;
  }
  if (!holes.length) notes.push(`${name}: geen ruimte voor gaatjes in deze laag (te klein of te schuin) — de wand blijft dicht.`);
  return { holes, notes };
}
