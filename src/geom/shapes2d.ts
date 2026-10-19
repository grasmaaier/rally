import type { CrossSection, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { AssetRef, AssetStore, ParamDef, Params } from '../core/types';
import { num, str } from '../core/types';
import { keep } from '../core/registry';
import { TAU, clamp } from './helpers';

/**
 * Library of 2D outlines shared by all tools (knob heads, vase sections, clock
 * faces, boards, leg sections). Every shape is star-shaped around the origin,
 * so it can be used both as a polygon and as a radial function r(θ) for
 * surfaces. Radii are normalised so the farthest point is at distance 1.
 */

export interface ShapeSpec {
  shape: string;
  /** sides / petals / points / lobes */
  count: number;
  /** 0..1 */
  depth: number;
  /** 0..1 */
  rounding: number;
  seed: number;
  /** superformula */
  m: number;
  n1: number;
  n2: number;
  n3: number;
  /** asset key of an uploaded SVG ('custom') */
  file?: string;
}

export const SHAPE_OPTIONS = [
  { value: 'circle', label: 'Rond' },
  { value: 'polygon', label: 'Veelhoek' },
  { value: 'squircle', label: 'Zachte rechthoek (squircle)' },
  { value: 'star', label: 'Ster' },
  { value: 'flower', label: 'Golvende bloem' },
  { value: 'petals', label: 'Bloemblaadjes' },
  { value: 'scallop', label: 'Schelp' },
  { value: 'gear', label: 'Kantelen / tandwiel' },
  { value: 'cross', label: 'Kruis' },
  { value: 'clover', label: 'Klaver' },
  { value: 'cloud', label: 'Wolk' },
  { value: 'blob', label: 'Blob (organisch)' },
  { value: 'heart', label: 'Hart' },
  { value: 'drop', label: 'Druppel' },
  { value: 'leaf', label: 'Blad' },
  { value: 'superformula', label: 'Superformule (abstract)' },
];

export const CUSTOM_SHAPE_OPTION = { value: 'custom', label: 'Eigen vorm (SVG uploaden)' };

/** Which controls each shape uses (for showing/hiding fields). */
export const SHAPE_USES: Record<string, ('count' | 'depth' | 'rounding' | 'seed' | 'sf' | 'file')[]> = {
  circle: [],
  polygon: ['count', 'rounding'],
  squircle: ['rounding'],
  star: ['count', 'depth', 'rounding'],
  flower: ['count', 'depth'],
  petals: ['count', 'depth', 'rounding'],
  scallop: ['count', 'depth'],
  gear: ['count', 'depth'],
  cross: ['count', 'depth', 'rounding'],
  clover: ['count', 'depth'],
  cloud: ['count', 'depth', 'seed'],
  blob: ['count', 'depth', 'seed'],
  heart: [],
  drop: ['rounding'],
  leaf: ['depth'],
  superformula: ['sf'],
  custom: ['file'],
};

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Inside = (x: number, y: number) => boolean;

/** Outer envelope of an implicit shape along a ray (largest t with inside(t·u)). */
function rayEnvelope(inside: Inside, th: number, rMax = 2.5): number {
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const steps = 96;
  let hi = -1;
  for (let i = steps; i >= 1; i--) {
    const t = (rMax * i) / steps;
    if (inside(t * ux, t * uy)) {
      hi = t;
      break;
    }
  }
  if (hi < 0) return 0;
  let lo = hi;
  let out = Math.min(rMax, hi + rMax / steps);
  for (let k = 0; k < 30; k++) {
    const mid = (lo + out) / 2;
    if (inside(mid * ux, mid * uy)) lo = mid;
    else out = mid;
  }
  return lo;
}

const capsule = (x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number) => {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - dx * h, py - dy * h) <= r;
};

/** Raw (un-normalised) radial function for the built-in shapes. */
function rawRadial(spec: ShapeSpec): (th: number) => number {
  const n = Math.max(1, Math.round(spec.count));
  const depth = clamp(spec.depth, 0, 0.95);
  const rounding = clamp(spec.rounding, 0, 1);
  switch (spec.shape) {
    case 'polygon': {
      const p = 2.2 + (1 - rounding) ** 2 * 60;
      const k = Math.max(3, n);
      return (th) => {
        let sum = 0;
        for (let i = 0; i < k; i++) {
          const c = Math.cos(th - (TAU * i) / k);
          if (c > 0) sum += c ** p;
        }
        return 1 / Math.pow(Math.max(sum, 1e-9), 1 / p);
      };
    }
    case 'squircle': {
      const e = 2 + (1 - rounding) * 10;
      return (th) => {
        const c = Math.abs(Math.cos(th));
        const s = Math.abs(Math.sin(th));
        return 1 / Math.pow(c ** e + s ** e, 1 / e);
      };
    }
    case 'star':
      return (th) => {
        const u = ((((n * th) / TAU) % 1) + 1) % 1;
        const tri = 1 - Math.abs(2 * u - 1);
        const soft = (1 - Math.cos(Math.PI * tri)) / 2;
        return 1 - depth * (tri + (soft - tri) * rounding);
      };
    case 'flower':
      return (th) => 1 - (depth * (1 - Math.cos(n * th))) / 2;
    case 'petals': {
      // round-tipped petals with narrow notches between them (like a daisy)
      const ex = 0.5 + 0.9 * (1 - rounding);
      return (th) => {
        const u = ((((n * th) / TAU) % 1) + 1) % 1;
        const arc = Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
        return 1 - depth + depth * Math.pow(arc, ex);
      };
    }
    case 'scallop':
      return (th) => 1 - depth * (1 - Math.abs(Math.cos((n * th) / 2)));
    case 'gear':
      return (th) => {
        const u = ((((n * th) / TAU) % 1) + 1) % 1;
        const s = (a: number, b: number, x: number) => {
          const t = clamp((x - a) / (b - a), 0, 1);
          return t * t * (3 - 2 * t);
        };
        const tooth = s(0.1, 0.25, u) * (1 - s(0.5, 0.65, u));
        return 1 - depth * (1 - tooth);
      };
    case 'cross': {
      // `count` arms; depth = how slender the arms are; rounding = round arm ends
      const arms = Math.max(2, n);
      const w = 0.12 + 0.45 * (1 - depth);
      const round = rounding > 0.5;
      const inside: Inside = (x, y) => {
        for (let i = 0; i < arms; i++) {
          const a = (TAU * i) / arms + Math.PI / 2;
          const ex = Math.cos(a);
          const ey = Math.sin(a);
          if (round) {
            if (capsule(x, y, 0, 0, ex * (1 - w), ey * (1 - w), w)) return true;
          } else {
            const along = x * ex + y * ey;
            const across = Math.abs(-x * ey + y * ex);
            if (along >= -w && along <= 1 && across <= w) return true;
          }
        }
        return false;
      };
      return (th) => rayEnvelope(inside, th, 1.5);
    }
    case 'clover': {
      const leaves = Math.max(2, n);
      const rr = 0.38 + 0.2 * (1 - depth);
      const d = 1 - rr;
      const inside: Inside = (x, y) => {
        if (x * x + y * y <= (d * 0.8) ** 2) return true;
        for (let i = 0; i < leaves; i++) {
          const a = (TAU * i) / leaves + Math.PI / 2;
          if (Math.hypot(x - d * Math.cos(a), y - d * Math.sin(a)) <= rr) return true;
        }
        return false;
      };
      return (th) => rayEnvelope(inside, th, 1.5);
    }
    case 'cloud': {
      const rnd = mulberry32(Math.round(spec.seed) * 7919 + 3);
      const bumps = Math.max(3, n);
      const circles = Array.from({ length: bumps }, (_, i) => {
        const a = (TAU * (i + 0.3 * (rnd() - 0.5))) / bumps;
        const r = (0.28 + 0.2 * rnd()) * (0.6 + 0.8 * depth);
        const d = 1 - r;
        return [d * Math.cos(a), d * Math.sin(a) * 0.8, r] as const;
      });
      const inside: Inside = (x, y) => {
        if ((x / 0.75) ** 2 + (y / 0.6) ** 2 <= 1) return true;
        return circles.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) <= r);
      };
      return (th) => rayEnvelope(inside, th, 2);
    }
    case 'blob': {
      const rnd = mulberry32(Math.round(spec.seed) * 104729 + 11);
      const k = clamp(n, 2, 12);
      const terms = Array.from({ length: k }, (_, i) => ({
        f: i + 2,
        a: (rnd() * 2 - 1) / Math.pow(i + 2, 0.9),
        p: rnd() * TAU,
      }));
      const amp = 0.15 + 0.6 * depth;
      return (th) => {
        let v = 0;
        for (const t of terms) v += t.a * Math.cos(t.f * th + t.p);
        return Math.exp(amp * v);
      };
    }
    case 'heart': {
      const inside: Inside = (x, y) => {
        const X = x * 1.1;
        const Y = y * 1.1 + 0.15;
        return (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 <= 0;
      };
      return (th) => rayEnvelope(inside, th, 2);
    }
    case 'drop': {
      // round bottom with straight flanks tangent to a point on top; rounding makes it plumper
      const r = 0.5 + 0.12 * rounding;
      const cy = -0.5 + r;
      const ay = 1 - 0.25 * rounding;
      const d = ay - cy;
      const ty = cy + (r * r) / d;
      const tx = r * Math.sqrt(Math.max(0, 1 - (r * r) / (d * d)));
      const inside: Inside = (x, y) => {
        if (Math.hypot(x, y - cy) <= r) return true;
        if (y < ty || y > ay) return false;
        return Math.abs(x) <= (tx * (ay - y)) / (ay - ty);
      };
      return (th) => rayEnvelope(inside, th, 2);
    }
    case 'leaf': {
      const r = 0.6 + 1.2 * (1 - depth);
      const off = r - 0.5;
      const inside: Inside = (x, y) => Math.hypot(x - off, y) <= r && Math.hypot(x + off, y) <= r && Math.abs(y) <= 1.2;
      return (th) => rayEnvelope(inside, th, 2.5);
    }
    case 'superformula': {
      const m = spec.m;
      const n1 = Math.max(0.1, spec.n1);
      const n2 = Math.max(0.05, spec.n2);
      const n3 = Math.max(0.05, spec.n3);
      return (th) => {
        const a = Math.abs(Math.cos((m * th) / 4)) ** n2;
        const b = Math.abs(Math.sin((m * th) / 4)) ** n3;
        const r = Math.pow(a + b, -1 / n1);
        return Number.isFinite(r) ? Math.min(r, 1e3) : 1e3;
      };
    }
    default:
      return () => 1;
  }
}

/** Radial function of a set of polygons: outer envelope seen from the origin. */
export function radialFromPolygons(polys: [number, number][][]): (th: number) => number {
  return (th) => {
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let best = 0;
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        // ray t·u hits segment a + s(b - a)
        const ex = bx - ax;
        const ey = by - ay;
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (ax * ey - ay * ex) / den;
        const s = (ax * uy - ay * ux) / den;
        if (t > best && s >= 0 && s <= 1) best = t;
      }
    return best;
  };
}

const MIN_RADIUS = 0.1;

/**
 * Normalised radial function: max radius 1, never below MIN_RADIUS (so walls
 * and inset surfaces stay valid). Values are memoised per angle.
 */
export function radialShape(spec: ShapeSpec, assets?: AssetStore): (th: number) => number {
  let raw: (th: number) => number;
  if (spec.shape === 'custom') {
    if (!spec.file || !assets) return () => 1;
    raw = radialFromPolygons(assets.shape(spec.file).polygons);
  } else raw = rawRadial(spec);
  let max = 0;
  for (let i = 0; i < 1440; i++) max = Math.max(max, raw((TAU * i) / 1440));
  const k = max > 0 ? max : 1;
  const memo = new Map<number, number>();
  return (th) => {
    let v = memo.get(th);
    if (v === undefined) {
      if (memo.size > 200000) memo.clear();
      v = Math.max(MIN_RADIUS, raw(th) / k);
      memo.set(th, v);
    }
    return v;
  };
}

/** Closed CCW outline (unit size: max radius 1) sampled from the radial function. */
export function shapeOutline(spec: ShapeSpec, segs = 360, assets?: AssetStore): Vec2[] {
  const r = radialShape(spec, assets);
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const th = (TAU * i) / segs;
    const rr = r(th);
    pts.push([rr * Math.cos(th), rr * Math.sin(th)]);
  }
  return pts;
}

/**
 * 2D cross-section of a shape scaled to `size` (the diameter of its bounding
 * circle). Uploaded SVGs keep their own outline, holes included.
 */
export function shapeCross(M: ManifoldToplevel, spec: ShapeSpec, size: number, assets?: AssetStore, segs = 360): CrossSection {
  if (spec.shape === 'custom' && spec.file && assets) {
    const polys = assets.shape(spec.file).polygons;
    // fit the drawing's farthest point to the bounding circle
    let rmax = 0;
    for (const poly of polys) for (const [x, y] of poly) rmax = Math.max(rmax, Math.hypot(x, y));
    const s = size / 2 / (rmax || 1);
    return keep(new M.CrossSection(polys.map((poly) => poly.map(([x, y]) => [x * s, y * s] as Vec2)), 'NonZero'));
  }
  const pts = shapeOutline(spec, segs, assets).map(([x, y]) => [(x * size) / 2, (y * size) / 2] as Vec2);
  return keep(new M.CrossSection([pts], 'Positive'));
}

// ---------------------------------------------------------------------------
// Form helpers: a group of controls that edits one ShapeSpec

export interface ShapeParamOptions {
  label?: string;
  /** offer "Eigen vorm (SVG uploaden)" */
  custom?: boolean;
  /** extra visibility condition for the whole group */
  show?: (p: Params) => boolean;
  /** restrict the menu to these shape ids */
  only?: string[];
}

export function shapeParams(prefix: string, def: Partial<{ shape: string; count: number; depth: number; rounding: number; seed: number }>, opts: ShapeParamOptions = {}): ParamDef[] {
  const k = (s: string) => `${prefix}${s}`;
  const base = opts.show ?? (() => true);
  const uses = (p: Params, what: 'count' | 'depth' | 'rounding' | 'seed' | 'sf' | 'file') => base(p) && (SHAPE_USES[str(p, k('Shape'))] ?? []).includes(what);
  const options = [...SHAPE_OPTIONS.filter((o) => !opts.only || opts.only.includes(o.value)), ...(opts.custom ? [CUSTOM_SHAPE_OPTION] : [])];
  return [
    { type: 'select', key: k('Shape'), label: opts.label ?? 'Vorm', options, default: def.shape ?? 'circle', show: base },
    { type: 'number', key: k('Count'), label: 'Aantal (hoeken / blaadjes / armen)', min: 2, max: 40, step: 1, default: def.count ?? 5, show: (p) => uses(p, 'count') },
    { type: 'number', key: k('Depth'), label: 'Diepte / slankheid', min: 0, max: 90, step: 1, unit: '%', default: def.depth ?? 35, show: (p) => uses(p, 'depth') },
    { type: 'number', key: k('Rounding'), label: 'Afronding', min: 0, max: 100, step: 1, unit: '%', default: def.rounding ?? 40, show: (p) => uses(p, 'rounding') },
    { type: 'number', key: k('Seed'), label: 'Variant (willekeurig getal)', min: 1, max: 999, step: 1, default: def.seed ?? 7, show: (p) => uses(p, 'seed') },
    { type: 'number', key: k('M'), label: 'Superformule m (symmetrie)', min: 0, max: 24, step: 1, default: 6, show: (p) => uses(p, 'sf') },
    { type: 'number', key: k('N1'), label: 'Superformule n1', min: 0.2, max: 20, step: 0.1, default: 1, show: (p) => uses(p, 'sf') },
    { type: 'number', key: k('N2'), label: 'Superformule n2', min: 0.2, max: 20, step: 0.1, default: 1.7, show: (p) => uses(p, 'sf') },
    { type: 'number', key: k('N3'), label: 'Superformule n3', min: 0.2, max: 20, step: 0.1, default: 1.7, show: (p) => uses(p, 'sf') },
    ...(opts.custom
      ? [{ type: 'file', key: k('File'), label: 'SVG-bestand', asset: 'shape', accept: '.svg,image/svg+xml', default: '', help: 'Gevulde vormen; de vorm wordt passend geschaald.', show: (p: Params) => uses(p, 'file') } as ParamDef]
      : []),
  ];
}

export function shapeSpecFrom(p: Params, prefix: string): ShapeSpec {
  const k = (s: string) => `${prefix}${s}`;
  const get = (s: string, d: number) => (p[k(s)] === undefined ? d : num(p, k(s)));
  return {
    shape: p[k('Shape')] === undefined ? 'circle' : str(p, k('Shape')),
    count: get('Count', 5),
    depth: get('Depth', 35) / 100,
    rounding: get('Rounding', 40) / 100,
    seed: get('Seed', 7),
    m: get('M', 6),
    n1: get('N1', 1),
    n2: get('N2', 1.7),
    n3: get('N3', 1.7),
    file: p[k('File')] ? str(p, k('File')) : undefined,
  };
}

/** Assets a shape group needs (an uploaded SVG when 'custom' is chosen). */
export function shapeAssets(p: Params, prefix: string): AssetRef[] {
  const spec = shapeSpecFrom(p, prefix);
  return spec.shape === 'custom' && spec.file ? [{ kind: 'shape', key: spec.file }] : [];
}

/** A custom shape without an uploaded file falls back to a circle. */
export function effectiveSpec(spec: ShapeSpec): ShapeSpec {
  return spec.shape === 'custom' && !spec.file ? { ...spec, shape: 'circle' } : spec;
}
