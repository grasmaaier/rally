import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { AssetRef, AssetStore, BuildOutput, Params, ToolDef } from '../core/types';
import { num, str } from '../core/types';
import { keep } from '../core/registry';
import { SCREWS, clamp, countersunk, filletExtrude, fixingHole, lerp, roundedRect, smoothstep } from '../geom/helpers';
import { sectionFn } from '../geom/surface';
import { effectiveSpec, shapeCross, type ShapeSpec } from '../geom/shapes2d';
import { cushion, edgeRings, focusRings, gridSolid, polarGrid, radiiOf, rise, type PolarGrid } from '../geom/pillow';

const SPACINGS = [64, 96, 128, 160, 192, 224, 256, 320];

function spacing(p: Params) {
  const v = str(p, 'spacing');
  return v === 'custom' ? num(p, 'spacingCustom') : Number(v);
}

/** Smooth 2D Catmull-Rom curve through points, sampled `per` times per segment. */
function smoothPath(points: Vec2[], per = 16): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function gripFactor(pattern: string, n: number, depth: number, th: number, z: number) {
  switch (pattern) {
    case 'ribs':
      return 1 - depth * (0.5 - 0.5 * Math.cos(n * th));
    case 'facets':
      return sectionFn('polygon', n, 0, 0.15)(th);
    case 'knurl': {
      const k = 0.35;
      return 1 - (depth * (2 - Math.cos(n * th + z * k) - Math.cos(n * th - z * k))) / 4;
    }
    default:
      return 1;
  }
}

function knob(M: ManifoldToplevel, p: Params) {
  const D = num(p, 'knobD');
  const H = num(p, 'knobH');
  const Db = Math.min(num(p, 'baseD'), D);
  const Dn = Math.min(num(p, 'neckD'), Db, D);
  const style = str(p, 'style');
  const dome = Math.min((num(p, 'dome') / 100) * D * 0.18, H * 0.3);
  const edge = Math.min(num(p, 'edge'), D / 4, H / 4);
  const topEdgeZ = H - dome;
  const st = topEdgeZ - edge;
  const R = D / 2;
  const sides: Record<string, Vec2[]> = {
    mushroom: [[Db / 2, 0], [Dn / 2, 0.55 * st], [R * 0.93, 0.88 * st], [R, st]],
    cylinder: [[Db / 2, 0], [Dn / 2, 0.3 * st], [R, 0.45 * st], [R, st]],
    cone: [[Db / 2, 0], [(Db / 2 + R) / 2 - 1, 0.5 * st], [R, st]],
    ball: [[Db / 2, 0], [Dn / 2, 0.4 * st], [R * 0.9, 0.75 * st], [R, st]],
  };
  const side = sides[style] ?? sides.mushroom;
  const sideTop = st;
  const pts: Vec2[] = [[0, 0], ...smoothPath(side, 20)];
  // rounded edge into the (domed) top
  for (let i = 1; i <= 10; i++) {
    const a = (Math.PI / 2) * (i / 10);
    pts.push([R - edge + edge * Math.cos(a), sideTop + edge * Math.sin(a)]);
  }
  const rTop = R - edge;
  for (let i = 1; i <= 16; i++) {
    const r = rTop * (1 - i / 16);
    pts.push([r, topEdgeZ + dome * (1 - (r / Math.max(rTop, 1e-3)) ** 2)]);
  }
  // remove near-duplicate points
  const clean: Vec2[] = [];
  for (const q of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) clean.push([Math.max(0, q[0]), q[1]]);
  }
  const pattern = str(p, 'pattern');
  const n = Math.round(num(p, 'patternCount'));
  const segs = pattern === 'smooth' ? 96 : clamp(n * 10, 96, 360);
  let solid = keep(new M.CrossSection([clean])).revolve(segs);
  if (pattern !== 'smooth') {
    const depth = num(p, 'patternDepth') / 100;
    const zNeck = side.length > 1 ? side[1][1] : 0;
    solid = solid.warp((v: Vec3) => {
      const r = Math.hypot(v[0], v[1]);
      if (r < 1e-6) return;
      const th = Math.atan2(v[1], v[0]);
      const w = smoothstep(zNeck, zNeck + 3, v[2]);
      const f = 1 - w * (1 - gripFactor(pattern, n, depth, th, v[2]));
      v[0] *= f;
      v[1] *= f;
    });
  }
  const depth = Math.min(H * 0.7, 16);
  solid = solid.subtract(fixingHole(M, str(p, 'screw'), str(p, 'mount'), depth));
  const orient = str(p, 'orient');
  const flip = orient === 'top' || (orient === 'auto' && dome < 0.5);
  const tips: string[] = [];
  if (flip) {
    solid = solid.rotate([180, 0, 0]);
    tips.push('Geprint met de bovenkant op het bed: een strak topvlak en geen support nodig.');
  } else {
    tips.push('Geprint op de voet. Bij een brede kap kan "tree support" onder de rand nodig zijn.');
  }
  return { solid, tips };
}

// ---------------------------------------------------------------------------
// Designy knobs: soft heads shaped from the 2D shape library

const CLASSIC_STYLES = ['mushroom', 'cylinder', 'cone', 'ball'];

export const DESIGN_STYLES = [
  { value: 'cross', label: 'Kruis' },
  { value: 'bloom', label: 'Echte bloem' },
  { value: 'blob', label: 'Blob' },
  { value: 'pebble', label: 'Kiezel' },
  { value: 'star', label: 'Ster' },
  { value: 'heart', label: 'Hart' },
  { value: 'cloud', label: 'Wolk' },
  { value: 'clover', label: 'Klaver' },
  { value: 'drop', label: 'Druppel' },
  { value: 'leaf', label: 'Blad' },
  { value: 'ring', label: 'Ring / donut' },
  { value: 'gear', label: 'Tandwiel' },
  { value: 'superformula', label: 'Superformule' },
  { value: 'custom', label: 'Eigen vorm (SVG uploaden)' },
];

type HeadUse = 'count' | 'depth' | 'rounding' | 'seed' | 'sf' | 'file' | 'hole';
const HEAD_USES: Record<string, HeadUse[]> = {
  cross: ['count', 'depth', 'rounding'],
  bloom: ['count', 'depth', 'rounding'],
  blob: ['count', 'depth', 'seed'],
  pebble: ['depth', 'seed'],
  star: ['count', 'depth', 'rounding'],
  heart: [],
  cloud: ['count', 'depth', 'seed'],
  clover: ['count', 'depth'],
  drop: ['rounding'],
  leaf: ['depth'],
  ring: ['hole'],
  gear: ['count', 'depth'],
  superformula: ['sf'],
  custom: ['file'],
};

const isDesign = (p: Params) => str(p, 'type') === 'knob' && !CLASSIC_STYLES.includes(str(p, 'style'));
const headUses = (what: HeadUse) => (p: Params) => isDesign(p) && (HEAD_USES[str(p, 'style')] ?? []).includes(what);

/** Domed by nature: these never get a flat top to print on. */
const DOMED = ['pebble', 'ring', 'bloom'];

/** Narrowest feature (mm) a knob head may have, so arms and points do not snap off. */
const MIN_FEATURE = 4;

function headSpec(p: Params, style: string, D: number): ShapeSpec {
  const spec: ShapeSpec = {
    shape: style === 'bloom' ? 'petals' : style === 'pebble' ? 'blob' : style,
    count: Math.round(num(p, 'headCount')),
    depth: num(p, 'headDepth') / 100,
    rounding: num(p, 'headRounding') / 100,
    seed: num(p, 'headSeed'),
    m: num(p, 'headM'),
    n1: num(p, 'headN1'),
    n2: num(p, 'headN2'),
    n3: num(p, 'headN3'),
    file: p.headFile ? str(p, 'headFile') : undefined,
  };
  if (style === 'cross') {
    // arm half-width is (0.12 + 0.45·(1 − depth)) × radius: keep arms at least MIN_FEATURE + 0.5 mm wide
    const w = (MIN_FEATURE + 0.5) / D;
    spec.depth = Math.min(spec.depth, 1 - (w - 0.12) / 0.45);
    spec.count = clamp(spec.count, 2, 8);
  }
  if (style === 'pebble') {
    // a few soft, low harmonics: a stone polished smooth by water
    spec.count = 3;
    spec.depth = 0.05 + 0.4 * spec.depth;
  }
  if (style === 'bloom') {
    spec.count = clamp(spec.count, 3, 12);
    spec.depth = clamp(spec.depth, 0.2, 0.75);
  }
  return effectiveSpec(spec);
}

/** Recent head outlines: sliders that do not change the outline (height, puff, fixing) reuse them. */
const outlineCache = new Map<string, { R: number[]; notes: string[] }>();

/**
 * Outline of a head as radii on N rays. Features narrower than MIN_FEATURE are
 * opened away and inner corners get a small fillet; what is left is the main
 * piece seen from the axis.
 */
function headOutline(M: ManifoldToplevel, spec: ShapeSpec, D: number, angle: number, assets: AssetStore | undefined, N: number, squash = 1) {
  const key = JSON.stringify([spec, D, angle, N, squash]);
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const notes: string[] = [];
  let cs: CrossSection = shapeCross(M, spec, D, assets, 360);
  if (squash !== 1) cs = cs.scale([1, squash]);
  if (angle) cs = cs.rotate(angle);
  const area0 = cs.area();
  const open = MIN_FEATURE / 2;
  const eroded = cs.offset(-open, 'Round', 2, 32);
  // grow back a bit further, then shrink: opens thin parts and rounds inner corners in three offsets
  const soft = eroded.offset(open + 1.2, 'Round', 2, 32).offset(-1.2, 'Round', 2, 32);
  let best: CrossSection | null = null;
  let bestArea = 0;
  for (const piece of soft.decompose()) {
    const a = piece.area();
    if (a > bestArea) {
      bestArea = a;
      best = piece;
    }
  }
  if (!best || bestArea < 0.15 * Math.PI * (D / 2) ** 2 * 0.25) {
    notes.push('Deze vorm is te fijn voor een knop van deze maat: de kop is rond gemaakt. Maak de knop groter of de punten minder diep.');
    best = M.CrossSection.circle(D * 0.3, 96);
  } else if (eroded.offset(open, 'Round', 2, 32).area() < area0 * 0.96) {
    notes.push(`Dunne punten en armen zijn afgerond tot minstens ${MIN_FEATURE} mm breed, zodat ze niet afbreken.`);
  }
  const out = { R: radiiOf(best, N), notes };
  if (outlineCache.size > 24) outlineCache.delete(outlineCache.keys().next().value as string);
  outlineCache.set(key, out);
  return out;
}

/** Radius of the hole a fixing needs (nut: corner of the hex). */
function holeRadius(screw: string, mount: string) {
  const s = SCREWS[screw] ?? SCREWS.M4;
  return mount === 'nut' ? (s.nutAF + 0.3) / Math.sqrt(3) : mount === 'insert' ? s.insertD / 2 : s.pilot / 2;
}

/**
 * Revolved stem from a radius profile r(z) on [0, z1] (use coordinates, z = 0
 * at the door). `grow` is the print direction: the radius may widen at most
 * 45° going up ('up' = printed on the foot, 'down' = printed hanging from the head).
 */
function stemOf(M: ManifoldToplevel, r: (z: number) => number, z1: number, grow: 'up' | 'down', n = 40) {
  const zs = Array.from({ length: n + 1 }, (_, i) => 0.4 + ((z1 - 0.4) * i) / n);
  const rs = zs.map((z) => Math.max(0.8, r(z)));
  if (grow === 'up') for (let i = 1; i <= n; i++) rs[i] = Math.min(rs[i], rs[i - 1] + (zs[i] - zs[i - 1]));
  else for (let i = n - 1; i >= 0; i--) rs[i] = Math.min(rs[i], rs[i + 1] + (zs[i + 1] - zs[i]));
  // a small 45° chamfer at the door face against elephant's foot
  const pts: Vec2[] = [[0, 0], [Math.max(0.4, rs[0] - 0.4), 0]];
  for (let i = 0; i <= n; i++) pts.push([rs[i], zs[i]]);
  pts.push([0, z1]);
  return keep(new M.CrossSection([pts])).revolve(96);
}

interface HeadLayer {
  g: PolarGrid;
  /** Height above the head bottom of each grid point. */
  top: (k: number) => number;
  /** Bottom plane of the layer (use coordinates). */
  z0: number;
}

/** Sunflower seeds: tiny bumps in a Vogel spiral, for the heart of the bloom. */
function seedBumps(r: number) {
  const c = Math.max(0.9, r / 6);
  const seeds: [number, number][] = [];
  for (let i = 1; c * Math.sqrt(i) < r - c * 0.6; i++) {
    const a = i * 2.39996;
    seeds.push([c * Math.sqrt(i) * Math.cos(a), c * Math.sqrt(i) * Math.sin(a)]);
  }
  seeds.push([0, 0]);
  const rb = c * 0.48;
  return (x: number, y: number) => {
    let best = Infinity;
    for (const [sx, sy] of seeds) best = Math.min(best, (x - sx) ** 2 + (y - sy) ** 2);
    const t = Math.sqrt(best) / rb;
    return t < 1 ? 0.35 * c * (1 - t * t) : 0;
  };
}

function designKnob(M: ManifoldToplevel, p: Params, assets?: AssetStore) {
  const style = str(p, 'style');
  const D = num(p, 'knobD');
  const H = num(p, 'knobH');
  const screw = str(p, 'screw');
  const mount = str(p, 'mount');
  const s = SCREWS[screw] ?? SCREWS.M4;
  const tips: string[] = [];
  const warnings: string[] = [];
  const holeR = holeRadius(screw, mount);
  const minDepth = mount === 'nut' ? s.nutH + 4 : mount === 'insert' ? s.insertL + 1 : 8;
  const th = clamp(num(p, 'headH'), 3, H - 4);
  const zHB = H - th;
  const puff = num(p, 'puff') / 100;
  const edge = num(p, 'edge');
  const angle = num(p, 'headAngle');
  const N = 320;

  // ---- outline(s)
  const spec = headSpec(p, style, D);
  if (str(p, 'style') === 'custom' && !p.headFile) tips.push('Kies een SVG-bestand voor je eigen vorm; tot die tijd is de kop rond.');
  let R: number[];
  if (style === 'ring') R = new Array(N).fill(D / 2);
  else {
    const o = headOutline(M, spec, D, angle, assets, N, style === 'pebble' ? 0.8 : 1);
    R = o.R;
    warnings.push(...o.notes);
  }
  const holeFrac = clamp(num(p, 'ringHole') / 100, 0.15, 0.7);
  const rings = style === 'ring' ? focusRings(32, [holeFrac, 1], 0.08, 10) : edgeRings(34);
  const g = polarGrid(R, rings);
  const Rmax = g.rMax;
  const baseR = Math.min(num(p, 'baseD') / 2, Rmax);
  const rn0 = Math.min(Math.max(num(p, 'neckD') / 2, holeR + 1.6), Rmax);
  const footR = Math.max(baseR, rn0);

  // ---- print orientation: a flat top on the bed when the head allows it
  const dC = g.d[0];
  const rTop = Math.min(rn0, dC - 0.5);
  const holeTop = Math.min(16, H - 2, zHB + rTop - holeR - 1.2);
  const canTop = !DOMED.includes(style) && rTop >= holeR + 1.2 && holeTop >= minDepth;
  const orient = str(p, 'orient');
  let flat = orient === 'top' ? canTop : orient === 'base' ? false : canTop && puff <= 0.15;
  if (orient === 'top' && !canTop) {
    tips.push(DOMED.includes(style) ? 'Deze kop is bol: hij wordt op de voet geprint in plaats van op de bovenkant.' : 'De hals past niet binnen het midden van deze vorm: de knop wordt op de voet geprint.');
  }

  // ---- base-down geometry: a 45° cone from the neck carries the head
  const zMin = 2.4;
  let zApex = zHB - (Rmax - rn0);
  let rn = rn0;
  if (zApex < zMin) {
    // too little height for the cone: widen the neck so the head is still carried at 45°
    zApex = zMin;
    rn = Math.min(Rmax, Rmax - (zHB - zMin));
  }
  // the stem widens at most 45° from the foot
  const rnMax = footR + (zApex - 1.6);
  const steep = rn > rnMax + 0.01;
  if (steep) rn = rnMax;
  if (!flat && steep && orient === 'auto' && canTop) flat = true;
  if (!flat && steep) warnings.push('De kop is te breed voor deze hoogte om zonder support op de voet te printen: de rand hangt steiler over dan 45°. Maak de knop hoger, de kop kleiner of de hals breder.');
  if (flat && puff > 0.15) tips.push('Geprint op de bovenkant: die is daarom vlak (de bolling vervalt).');

  // ---- head layers
  const layers: HeadLayer[] = [];
  if (style === 'ring') {
    const Ri = holeFrac * Rmax;
    const Rc = (Rmax + Ri) / 2;
    const a = (Rmax - Ri) / 2;
    const side = Math.min(1, th * 0.2);
    const A = th - side;
    layers.push({
      g,
      z0: zHB,
      top: (k) => {
        const r = g.rho[k];
        return r < Ri ? side : side + A * Math.sqrt(Math.max(0, 1 - ((r - Rc) / a) ** 2));
      },
    });
  } else if (style === 'bloom') {
    const t1 = th * 0.62;
    const prof1 = cushion({ th: t1, puff: Math.max(puff, 0.45), edge, dMax: g.dMax, flat: false });
    layers.push({ g, z0: zHB, top: (k) => prof1(g.d[k]) });
    // second ring of petals, smaller and turned half a petal
    const o2 = headOutline(M, spec, D * 0.66, angle + 180 / spec.count, assets, N);
    const g2 = polarGrid(o2.R, edgeRings(28));
    const z2 = zHB + th * 0.3;
    const t2 = th * 0.55;
    const prof2 = cushion({ th: t2, puff: Math.max(puff, 0.45), edge, dMax: g2.dMax, flat: false });
    layers.push({ g: g2, z0: z2, top: (k) => prof2(g2.d[k]) });
    // a domed heart with seeds
    const rh = Math.max(3.5, Math.min(D * 0.14, g2.d[0] * 0.8));
    const g3 = polarGrid(new Array(200).fill(rh), Array.from({ length: 22 }, (_, i) => (i + 1) / 22));
    const z3 = zHB + th * 0.5;
    const t3 = th * 0.5;
    const bumps = seedBumps(rh);
    layers.push({ g: g3, z0: z3, top: (k) => t3 * (0.25 + 0.75 * rise(g3.d[k] / rh)) + bumps(g3.x[k], g3.y[k]) });
  } else {
    const prof = cushion({ th, puff: style === 'pebble' ? Math.max(puff, 0.85) : puff, edge, dMax: g.dMax, flat, side: style === 'pebble' ? 0.8 : 1.2 });
    // a pebble leans a little to one side
    const tilt = style === 'pebble' ? (k: number) => 1 + (0.14 * g.x[k]) / Rmax : () => 1;
    layers.push({ g, z0: zHB, top: (k) => prof(g.d[k]) * tilt(k) });
  }

  // ---- undersides and stem
  const pieces: Manifold[] = [];
  let stem: Manifold;
  let depth: number;
  if (flat) {
    const lay = layers[0];
    const rim0 = lay.top(1 + (lay.g.s.length - 1) * N);
    const e2 = clamp(Math.min(edge * 0.6, rim0 - 0.6), 0, lay.g.dMax * 0.8);
    pieces.push(gridSolid(M, lay.g, (k) => zHB + lay.top(k), (k) => zHB + (e2 > 0.05 ? e2 * (1 - rise(lay.g.d[k] / e2)) : 0)));
    // stem: classic neck, but never wider than 45° from where it leaves the head (it prints hanging from it)
    const neck = (z: number) => {
      const t = clamp(z / zHB, 0, 1);
      return lerp(footR, rn0, smoothstep(0.05, 0.6, t));
    };
    stem = stemOf(M, (z) => Math.min(neck(z), rTop + (zHB - z)), zHB + 0.4, 'down');
    depth = Math.min(holeTop, H * 0.7);
  } else {
    // the cone grows from the neck with a soft fillet; inside the stem the head is flat
    const b = clamp((zApex - 2) * 0.6, 0, 4);
    const tq = b * Math.tan(Math.PI / 8);
    const zTop = zApex + b * (1 - Math.SQRT1_2);
    const zFlat = zTop + 1;
    for (const lay of layers) {
      const lg = lay.g;
      // each layer gets its own 45° cone so overhanging petals are carried too
      const apex = Math.max(zApex, lay.z0 - (lg.rMax - rn));
      const flatL = apex + (zFlat - zApex);
      pieces.push(gridSolid(M, lg, (k) => lay.z0 + lay.top(k), (k) => Math.min(lay.z0, Math.max(flatL, apex + lg.rho[k] - rn))));
    }
    const neck = (z: number) => {
      if (z >= zTop) return rn + (z - zApex) - 0.15;
      if (z >= zApex - tq) return rn + b - Math.sqrt(Math.max(0, b * b - (z - (zApex - tq)) ** 2));
      const t = clamp(z / Math.max(1, zApex - tq), 0, 1);
      return rn <= footR ? lerp(footR, rn, smoothstep(0.08, 0.75, t)) : Math.min(rn, footR + Math.max(0, z - 1.6));
    };
    stem = stemOf(M, neck, zFlat + 0.6, 'up');
    let lowest = Infinity;
    const lay = layers[0];
    for (let k = 0; k < 1 + lay.g.s.length * N; k++) if (lay.g.rho[k] <= holeR + 1.5) lowest = Math.min(lowest, lay.z0 + lay.top(k));
    depth = Math.min(16, H * 0.7, lowest - 1.6);
  }
  if (depth < minDepth) warnings.push(`Het schroefgat is maar ${depth.toFixed(1)} mm diep: maak de knop of de kop hoger voor meer grip.`);
  let solid = M.Manifold.union([...pieces, stem]).subtract(fixingHole(M, screw, mount, Math.max(3, depth)));
  if (flat) {
    solid = solid.rotate([180, 0, 0]);
    tips.push('Geprint met de bovenkant op het bed: een strak, vlak topvlak. De rand loopt onder 45° af, dus er is geen support nodig.');
  } else {
    tips.push('Geprint op de voet: de onderkant van de kop loopt onder 45° naar de hals, dus er is geen support nodig.');
    if (style === 'bloom') tips.push('Mooi in twee kleuren: wissel van filament op de hoogte waar het hartje begint (pauze in Bambu Studio).');
  }
  return { solid, tips, warnings };
}

function bar(M: ManifoldToplevel, p: Params) {
  const c = spacing(p);
  const e = num(p, 'overhang');
  const t = num(p, 'barD');
  const h = num(p, 'standoff');
  const pd = num(p, 'postD');
  const profile = str(p, 'barProfile');
  const L = c + 2 * e;
  const zc = h + t / 2;
  const roundEnds = str(p, 'ends') === 'round';
  let barSolid: Manifold;
  if (profile === 'round') {
    const r = t / 2;
    const len = roundEnds ? L - t : L;
    barSolid = M.Manifold.cylinder(len, r, r, 48).rotate([0, 90, 0]).translate([-len / 2, 0, zc]);
    if (roundEnds) barSolid = barSolid.add(M.Manifold.sphere(r, 48).translate([-len / 2, 0, zc])).add(M.Manifold.sphere(r, 48).translate([len / 2, 0, zc]));
  } else {
    const w = profile === 'flat' ? t * 1.7 : t;
    const th = profile === 'flat' ? t * 0.7 : t;
    const rr = Math.min(w, th) * (profile === 'flat' ? 0.45 : 0.25);
    if (roundEnds) {
      // hull of corner spheres = bar rounded on every edge
      const spheres: Manifold[] = [];
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1])
            spheres.push(M.Manifold.sphere(rr, 24).translate([sx * (L / 2 - rr), sy * (w / 2 - rr), zc + sz * (th / 2 - rr)]));
      barSolid = M.Manifold.hull(spheres);
    } else {
      barSolid = roundedRect(M, w, th, rr).extrude(L).rotate([90, 0, 90]).translate([-L / 2, 0, zc]);
    }
  }
  const posts: Manifold[] = [];
  for (const x of [-c / 2, c / 2]) {
    posts.push(M.Manifold.cylinder(zc, pd / 2, pd / 2, 48).translate([x, 0, 0]));
    posts.push(M.Manifold.cylinder(3, pd / 2 + 2, pd / 2, 48).translate([x, 0, 0]));
  }
  let solid = M.Manifold.union([barSolid, ...posts]);
  const holeDepth = Math.min(zc - 2, 16);
  for (const x of [-c / 2, c / 2]) solid = solid.subtract(fixingHole(M, str(p, 'screw'), str(p, 'mount'), holeDepth).translate([x, 0, 0]));
  // print upside down; give round bars a small flat to stand on
  const top = zc + (profile === 'flat' ? t * 0.35 : t / 2);
  if (profile === 'round') solid = solid.trimByPlane([0, 0, -1], -(top - 1.2));
  solid = solid.rotate([180, 0, 0]);
  const tips = ['Geprint op de bovenkant van de staaf (ondersteboven): de pootjes en schroefgaten staan dan recht omhoog.'];
  if (profile === 'round') tips.push('De ronde staaf heeft een klein plat vlak aan de bovenkant zodat hij stevig op het bed staat.');
  return { solid, tips };
}

function arch(M: ManifoldToplevel, p: Params) {
  const c = spacing(p);
  const h = num(p, 'clearance');
  const t = num(p, 'archT');
  const w = num(p, 'archW');
  const shape = str(p, 'archShape');
  const footL = num(p, 'footL');
  const zc = h + t / 2;
  let center: Vec2[];
  if (shape === 'square') {
    const r = Math.min(num(p, 'cornerR'), zc - 1, c / 2 - 1);
    center = [[-c / 2, -1]];
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI - (Math.PI / 2) * (i / 12);
      center.push([-c / 2 + r + r * Math.cos(a), zc - r + r * Math.sin(a)]);
    }
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI / 2 - (Math.PI / 2) * (i / 12);
      center.push([c / 2 - r + r * Math.cos(a), zc - r + r * Math.sin(a)]);
    }
    center.push([c / 2, -1]);
  } else {
    center = [];
    const k = shape === 'flat' ? 0.55 : 1;
    for (let i = 0; i <= 48; i++) {
      const a = Math.PI - (Math.PI * i) / 48;
      const s = Math.sin(a);
      // flatter top for the "flat" arch: superellipse
      const z = zc * Math.sign(s) * Math.pow(Math.abs(s), k);
      center.push([(c / 2) * Math.cos(a), z - (i === 0 || i === 48 ? 1 : 0)]);
    }
  }
  const segments: ReturnType<typeof M.CrossSection.circle>[] = [];
  for (let i = 0; i < center.length - 1; i++) {
    segments.push(
      M.CrossSection.hull([
        M.CrossSection.circle(t / 2, 24).translate(center[i]),
        M.CrossSection.circle(t / 2, 24).translate(center[i + 1]),
      ]),
    );
  }
  const footH = Math.max(4, t * 0.6);
  for (const x of [-c / 2, c / 2]) segments.push(roundedRect(M, footL, footH * 2, Math.min(2, footH)).translate([x, 0]));
  let outline = M.CrossSection.union(segments).intersect(M.CrossSection.square([c + footL + 4 * t, zc + t + 2]).translate([-(c + footL + 4 * t) / 2, 0]));
  outline = outline.offset(-0.6, 'Round').offset(0.6, 'Round');
  let solid = filletExtrude(M, outline, w, num(p, 'edgeR'), num(p, 'edgeR'));
  // screw holes go from the door face (y = 0 in the 2D outline) into the feet
  const holeDepth = Math.min(footH + t * 0.6, 16);
  for (const x of [-c / 2, c / 2]) {
    solid = solid.subtract(fixingHole(M, str(p, 'screw'), str(p, 'mount'), holeDepth).rotate([-90, 0, 0]).translate([x, 0, w / 2]));
  }
  const tips = ['Ligt plat op het bed: de laaglijnen lopen door de hele greep, dus hij is erg sterk.'];
  const s = SCREWS[str(p, 'screw')];
  if (s && w < (str(p, 'mount') === 'insert' ? s.insertD : s.nutAF) + 3) tips.push('Let op: de greep is smal voor deze bevestiging — maak hem breder.');
  return { solid, tips };
}

function cup(M: ManifoldToplevel, p: Params) {
  const c = spacing(p);
  const hw = Math.max(20, c - 2 * num(p, 'cupMargin'));
  const hd = num(p, 'cupDepth');
  const tp = 3;
  const tw = num(p, 'cupWall');
  const a = hw / 2;
  const b = hd; // 45° roof: height of the hood equals its depth
  const yc = 0;
  const plateH = b + 12;
  const plateL = c + 22;
  const plate = filletExtrude(M, roundedRect(M, plateL, plateH, 6).translate([0, yc + b / 2 - 2]), tp, 0.4, 1.2);
  const hood = (ai: number, bi: number, z0: number, depth: number, extendDown: number) => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 40; i++) {
      const ang = (Math.PI * i) / 40;
      const x = ai * Math.cos(ang);
      const y = yc + bi * Math.sin(ang);
      pts.push([x, y, z0], [x, yc - extendDown, z0]);
    }
    const topHalf = Math.max(0.5, ai - depth);
    pts.push([-topHalf, yc, z0 + depth], [topHalf, yc, z0 + depth], [-topHalf, yc - extendDown, z0 + depth], [topHalf, yc - extendDown, z0 + depth]);
    return M.Manifold.hull(pts);
  };
  const outer = hood(a, b, 0, hd, 0).intersect(M.Manifold.cube([plateL, plateH * 2, hd + 2]).translate([-plateL / 2, yc, -1]));
  const k = tw * Math.SQRT2;
  const inner = hood(a - k, b - k, 0, hd - k, 3).intersect(M.Manifold.cube([plateL, plateH * 2, hd + 2]).translate([-plateL / 2, yc - 5, tp]));
  let solid = M.Manifold.union([plate, outer]).subtract(inner);
  for (const x of [-c / 2, c / 2]) {
    solid = solid.subtract(countersunk(M, 4.2, 8.4, tp + 1).mirror([0, 0, 1]).translate([x, yc + b / 2, tp]));
  }
  return {
    solid,
    tips: [
      'Geprint met de achterkant op het bed. De kap heeft een dak van 45°, dus hij print zonder support.',
      'Bevestig met twee verzonken houtschroeven (Ø4 mm) door de gaten links en rechts.',
    ],
  };
}

function build(p: Params, { M, assets }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const type = str(p, 'type');
  const res: { solid: Manifold; tips: string[]; warnings?: string[] } =
    type === 'bar' ? bar(M, p) : type === 'arch' ? arch(M, p) : type === 'cup' ? cup(M, p) : isDesign(p) ? designKnob(M, p, assets) : knob(M, p);
  const tips = [...res.tips];
  const mount = str(p, 'mount');
  const s = SCREWS[str(p, 'screw')] ?? SCREWS.M4;
  if (type !== 'cup') {
    if (mount === 'insert') tips.push(`Druk een ${s.label} inzetmoer (Ø${s.insertD} mm) met de soldeerbout in het gat.`);
    else if (mount === 'nut') tips.push(`Druk een ${s.label} zeskantmoer in de uitsparing; schroef van binnenuit door de deur.`);
    else tips.push(`Het gat (Ø${s.pilot} mm) is voor een ${s.label} schroef die zijn eigen draad tapt — draai de eerste keer rustig in.`);
    tips.push('Gebruik minimaal 4 wandlussen en 40% infill: dan scheurt de schroef er niet uit.');
  }
  const info: BuildOutput['info'] = [];
  if (type !== 'knob') info.push({ kind: 'kv', title: 'Maat', rows: [['Gatafstand (hart-op-hart)', `${spacing(p)} mm`]] });
  const names: Record<string, string> = { knob: 'Knop', bar: 'Staafgreep', arch: 'Beugelgreep', cup: 'Schelpgreep' };
  return { parts: [{ name: names[type] ?? 'Greep', solid: res.solid, quantity: num(p, 'quantity') }], tips, info, warnings: res.warnings ?? [] };
}

/** An uploaded SVG for the knob head. */
function assetsOf(p: Params): AssetRef[] {
  return isDesign(p) && str(p, 'style') === 'custom' && p.headFile ? [{ kind: 'shape', key: str(p, 'headFile') }] : [];
}

const is = (...t: string[]) => (p: Params) => t.includes(str(p, 'type'));

export const handlesTool: ToolDef = {
  id: 'grepen',
  name: 'Knoppen & grepen',
  short: 'Grepen',
  icon: 'M5 15V11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4M8 9V7M16 9V7M3 15h18',
  description: 'Parametrische meubelknoppen en -grepen met standaard gatafstanden (64–320 mm) en gaten voor M3/M4/M5 schroeven, moeren of inzetmoeren.',
  params: [
    { type: 'group', label: 'Type' },
    {
      type: 'select', key: 'type', label: 'Soort', default: 'knob',
      options: [
        { value: 'knob', label: 'Knop' },
        { value: 'bar', label: 'Staafgreep' },
        { value: 'arch', label: 'Beugelgreep (D-greep)' },
        { value: 'cup', label: 'Schelpgreep (lade)' },
      ],
    },
    { type: 'number', key: 'quantity', label: 'Aantal', min: 1, max: 40, step: 1, default: 1 },
    { type: 'group', label: 'Knop', show: is('knob') },
    {
      type: 'select', key: 'style', label: 'Model', default: 'mushroom', show: is('knob'),
      options: [
        { value: 'mushroom', label: 'Paddenstoel' },
        { value: 'cylinder', label: 'Cilinder' },
        { value: 'cone', label: 'Trechter' },
        { value: 'ball', label: 'Bol' },
        ...DESIGN_STYLES,
      ],
    },
    { type: 'number', key: 'knobD', label: 'Diameter / breedte', min: 15, max: 80, step: 0.5, unit: 'mm', default: 32, show: is('knob') },
    { type: 'number', key: 'knobH', label: 'Hoogte', min: 12, max: 60, step: 0.5, unit: 'mm', default: 26, show: is('knob') },
    { type: 'number', key: 'baseD', label: 'Diameter voet', min: 8, max: 60, step: 0.5, unit: 'mm', default: 18, show: is('knob') },
    { type: 'number', key: 'neckD', label: 'Diameter hals', min: 6, max: 50, step: 0.5, unit: 'mm', default: 13, show: is('knob') },
    { type: 'number', key: 'headH', label: 'Dikte kop', min: 4, max: 30, step: 0.5, unit: 'mm', default: 10, show: isDesign },
    {
      type: 'number', key: 'puff', label: 'Bolling (kussen)', min: 0, max: 100, step: 5, unit: '%', default: 60, show: isDesign,
      help: '0% = vlakke bovenkant met ronde rand (wordt op de bovenkant geprint), 100% = helemaal opgeblazen.',
    },
    { type: 'number', key: 'headCount', label: 'Aantal (armen / punten / blaadjes)', min: 2, max: 24, step: 1, default: 5, show: headUses('count') },
    { type: 'number', key: 'headDepth', label: 'Diepte / slankheid', min: 0, max: 90, step: 1, unit: '%', default: 45, show: headUses('depth') },
    { type: 'number', key: 'headRounding', label: 'Afronding vorm', min: 0, max: 100, step: 1, unit: '%', default: 60, show: headUses('rounding') },
    { type: 'number', key: 'headSeed', label: 'Variant (willekeurig getal)', min: 1, max: 999, step: 1, default: 7, show: headUses('seed') },
    { type: 'number', key: 'ringHole', label: 'Kuil in het midden', min: 15, max: 70, step: 1, unit: '%', default: 40, show: headUses('hole') },
    { type: 'number', key: 'headM', label: 'Superformule m (symmetrie)', min: 0, max: 16, step: 1, default: 5, show: headUses('sf') },
    { type: 'number', key: 'headN1', label: 'Superformule n1', min: 0.2, max: 20, step: 0.1, default: 3, show: headUses('sf') },
    { type: 'number', key: 'headN2', label: 'Superformule n2', min: 0.2, max: 20, step: 0.1, default: 6, show: headUses('sf') },
    { type: 'number', key: 'headN3', label: 'Superformule n3', min: 0.2, max: 20, step: 0.1, default: 6, show: headUses('sf') },
    {
      type: 'file', key: 'headFile', label: 'SVG-bestand', asset: 'shape', accept: '.svg,image/svg+xml', default: '', show: headUses('file'),
      help: 'Een gevulde vorm; de buitencontour wordt de kop (passend geschaald). Dunne delen worden afgerond tot minstens 4 mm.',
    },
    { type: 'number', key: 'headAngle', label: 'Draai kop', min: 0, max: 180, step: 5, unit: '°', default: 0, show: (p) => isDesign(p) && str(p, 'style') !== 'ring' },
    { type: 'number', key: 'dome', label: 'Bolling bovenkant', min: 0, max: 100, step: 5, unit: '%', default: 0, show: (p) => is('knob')(p) && !isDesign(p) },
    { type: 'number', key: 'edge', label: 'Afronding rand', min: 0, max: 10, step: 0.5, unit: 'mm', default: 3, show: is('knob') },
    {
      type: 'select', key: 'pattern', label: 'Grip', default: 'smooth', show: (p) => is('knob')(p) && !isDesign(p),
      options: [
        { value: 'smooth', label: 'Glad' },
        { value: 'ribs', label: 'Ribbels' },
        { value: 'facets', label: 'Facetten (veelhoek)' },
        { value: 'knurl', label: 'Kartel (ruit)' },
      ],
    },
    { type: 'number', key: 'patternCount', label: 'Aantal', min: 3, max: 40, step: 1, default: 12, show: (p) => is('knob')(p) && !isDesign(p) && str(p, 'pattern') !== 'smooth' },
    { type: 'number', key: 'patternDepth', label: 'Diepte', min: 1, max: 20, step: 1, unit: '%', default: 6, show: (p) => is('knob')(p) && !isDesign(p) && ['ribs', 'knurl'].includes(str(p, 'pattern')) },
    {
      type: 'select', key: 'orient', label: 'Printstand', default: 'auto', show: is('knob'),
      options: [
        { value: 'auto', label: 'Automatisch' },
        { value: 'top', label: 'Bovenkant op bed' },
        { value: 'base', label: 'Voet op bed' },
      ],
    },
    { type: 'group', label: 'Maat', show: is('bar', 'arch', 'cup') },
    {
      type: 'select', key: 'spacing', label: 'Gatafstand (hart-op-hart)', default: '128', show: is('bar', 'arch', 'cup'),
      options: [...SPACINGS.map((s) => ({ value: String(s), label: `${s} mm` })), { value: 'custom', label: 'Eigen maat' }],
    },
    { type: 'number', key: 'spacingCustom', label: 'Eigen gatafstand', min: 20, max: 300, step: 1, unit: 'mm', default: 100, show: (p) => is('bar', 'arch', 'cup')(p) && str(p, 'spacing') === 'custom' },
    { type: 'number', key: 'overhang', label: 'Uitsteek voorbij gat', min: 0, max: 60, step: 1, unit: 'mm', default: 18, show: is('bar') },
    { type: 'number', key: 'barD', label: 'Dikte staaf', min: 8, max: 30, step: 0.5, unit: 'mm', default: 12, show: is('bar') },
    { type: 'number', key: 'standoff', label: 'Ruimte voor vingers', min: 15, max: 50, step: 1, unit: 'mm', default: 24, show: is('bar') },
    { type: 'number', key: 'postD', label: 'Diameter pootjes', min: 8, max: 30, step: 0.5, unit: 'mm', default: 12, show: is('bar') },
    {
      type: 'select', key: 'barProfile', label: 'Profiel staaf', default: 'round', show: is('bar'),
      options: [
        { value: 'round', label: 'Rond' },
        { value: 'square', label: 'Vierkant (afgerond)' },
        { value: 'flat', label: 'Plat' },
      ],
    },
    {
      type: 'select', key: 'ends', label: 'Uiteinden', default: 'round', show: is('bar'),
      options: [
        { value: 'round', label: 'Afgerond' },
        { value: 'flat', label: 'Recht' },
      ],
    },
    {
      type: 'select', key: 'archShape', label: 'Vorm', default: 'arch', show: is('arch'),
      options: [
        { value: 'arch', label: 'Boog' },
        { value: 'flat', label: 'Platte boog' },
        { value: 'square', label: 'Beugel (hoekig)' },
      ],
    },
    { type: 'number', key: 'clearance', label: 'Ruimte voor vingers', min: 15, max: 60, step: 1, unit: 'mm', default: 26, show: is('arch') },
    { type: 'number', key: 'archT', label: 'Dikte', min: 6, max: 20, step: 0.5, unit: 'mm', default: 10, show: is('arch') },
    { type: 'number', key: 'archW', label: 'Breedte', min: 8, max: 30, step: 0.5, unit: 'mm', default: 12, show: is('arch') },
    { type: 'number', key: 'footL', label: 'Lengte voetje', min: 10, max: 40, step: 1, unit: 'mm', default: 16, show: is('arch') },
    { type: 'number', key: 'cornerR', label: 'Hoekradius', min: 2, max: 30, step: 1, unit: 'mm', default: 10, show: (p) => is('arch')(p) && str(p, 'archShape') === 'square' },
    { type: 'number', key: 'edgeR', label: 'Afronding randen', min: 0, max: 4, step: 0.2, unit: 'mm', default: 2, show: is('arch') },
    { type: 'number', key: 'cupDepth', label: 'Diepte schelp', min: 10, max: 30, step: 1, unit: 'mm', default: 18, show: is('cup') },
    { type: 'number', key: 'cupMargin', label: 'Ruimte rond schroef', min: 6, max: 20, step: 1, unit: 'mm', default: 9, show: is('cup') },
    { type: 'number', key: 'cupWall', label: 'Wanddikte', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4, show: is('cup') },
    { type: 'group', label: 'Bevestiging', show: is('knob', 'bar', 'arch') },
    {
      type: 'select', key: 'screw', label: 'Schroefmaat', default: 'M4', show: is('knob', 'bar', 'arch'),
      options: [
        { value: 'M3', label: 'M3' },
        { value: 'M4', label: 'M4 (standaard meubel)' },
        { value: 'M5', label: 'M5' },
      ],
    },
    {
      type: 'select', key: 'mount', label: 'Methode', default: 'tap', show: is('knob', 'bar', 'arch'),
      options: [
        { value: 'tap', label: 'Schroef tapt zelf' },
        { value: 'nut', label: 'Ingeklemde moer' },
        { value: 'insert', label: 'Inzetmoer (heat-set)' },
      ],
    },
  ],
  presets: [
    { name: 'Paddenstoelknop', values: { type: 'knob', style: 'mushroom', knobD: 32, knobH: 26, baseD: 18, neckD: 13, dome: 0, edge: 3, pattern: 'smooth' } },
    { name: 'Geribbelde knop', values: { type: 'knob', style: 'cylinder', knobD: 30, knobH: 24, baseD: 20, neckD: 16, dome: 0, edge: 2, pattern: 'ribs', patternCount: 18, patternDepth: 8 } },
    { name: 'Achthoek knop', values: { type: 'knob', style: 'mushroom', knobD: 34, knobH: 26, baseD: 18, neckD: 14, dome: 0, edge: 1.5, pattern: 'facets', patternCount: 8 } },
    { name: 'Bolle knop met kartel', values: { type: 'knob', style: 'ball', knobD: 30, knobH: 30, baseD: 16, neckD: 12, dome: 60, edge: 4, pattern: 'knurl', patternCount: 16, patternDepth: 6 } },
    { name: 'Staafgreep 128', values: { type: 'bar', spacing: '128', overhang: 18, barD: 12, standoff: 24, postD: 12, barProfile: 'round', ends: 'round' } },
    { name: 'Platte greep 160', values: { type: 'bar', spacing: '160', overhang: 20, barD: 12, standoff: 22, postD: 12, barProfile: 'flat', ends: 'round' } },
    { name: 'Boog 96', values: { type: 'arch', spacing: '96', archShape: 'arch', clearance: 26, archT: 10, archW: 12 } },
    { name: 'Beugel 128', values: { type: 'arch', spacing: '128', archShape: 'square', clearance: 28, archT: 9, archW: 14, cornerR: 10 } },
    { name: 'Schelpgreep 96', values: { type: 'cup', spacing: '96', cupDepth: 18, cupMargin: 9 } },
  ],
  assets: assetsOf,
  build,
};

