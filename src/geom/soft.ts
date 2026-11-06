import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import { keep } from '../core/registry';
import { fromArrays } from './helpers';

/**
 * Soft, rounded solids for the "toy-like" product style: outlines are lofted
 * through a stack of offset copies (same vertex count per layer), which gives
 * truly smooth rounded edges instead of stair-stepped ones.
 */

export type Loop = Vec2[];
/** A loft layer: position along the loft axis and inward offset of the outline. */
export interface Layer {
  t: number;
  d: number;
}

export function signedArea(l: Loop) {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const [x0, y0] = l[i];
    const [x1, y1] = l[(i + 1) % l.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function csOf(M: ManifoldToplevel, loops: Loop[]): CrossSection {
  return keep(new M.CrossSection(loops));
}

/** Outer loops (CCW) and holes (returned CCW too) of a cross-section. */
export function loopsOf(cs: CrossSection): { outers: Loop[]; holes: Loop[] } {
  const outers: Loop[] = [];
  const holes: Loop[] = [];
  for (const poly of cs.toPolygons()) {
    const l = poly.map((p) => [p[0], p[1]] as Vec2);
    if (l.length < 3) continue;
    if (signedArea(l) > 0) outers.push(l);
    else holes.push(l.reverse());
  }
  return { outers, holes };
}

/** Evenly spaced points along a closed loop. */
export function resample(loop: Loop, ds: number): Loop {
  const n0 = loop.length;
  const cum = [0];
  for (let i = 0; i < n0; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n0];
    cum.push(cum[i] + Math.hypot(x1 - x0, y1 - y0));
  }
  const P = cum[n0];
  const n = Math.max(12, Math.round(P / ds));
  const out: Loop = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (P * k) / n;
    while (cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = (s - cum[j]) / seg;
    const [x0, y0] = loop[j];
    const [x1, y1] = loop[(j + 1) % n0];
    out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
  }
  return out;
}

export function perimeter(loop: Loop) {
  let P = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    P += Math.hypot(x1 - x0, y1 - y0);
  }
  return P;
}

/** Outward unit normals of a CCW loop (central difference). */
export function unitNormals(loop: Loop): Vec2[] {
  const n = loop.length;
  return loop.map((_, i) => {
    const [xa, ya] = loop[(i - 1 + n) % n];
    const [xb, yb] = loop[(i + 1) % n];
    const tx = xb - xa;
    const ty = yb - ya;
    const l = Math.hypot(tx, ty) || 1;
    return [ty / l, -tx / l] as Vec2;
  });
}

/** Outward normals scaled so that an offset keeps edges parallel (miter, capped). */
function miterNormals(loop: Loop): Vec2[] {
  const n = loop.length;
  return loop.map((p, i) => {
    const a = loop[(i - 1 + n) % n];
    const b = loop[(i + 1) % n];
    const e1x = p[0] - a[0], e1y = p[1] - a[1];
    const e2x = b[0] - p[0], e2y = b[1] - p[1];
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n1: Vec2 = [e1y / l1, -e1x / l1];
    const n2: Vec2 = [e2y / l2, -e2x / l2];
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) return n1;
    mx /= ml;
    my /= ml;
    const s = 1 / Math.max(0.5, mx * n1[0] + my * n1[1]);
    return [mx * s, my * s] as Vec2;
  });
}

/**
 * Vertical flutes (reeded look) as an outward offset per vertex: ridges stand
 * `depth` proud of the outline, with rounded crests and crisp grooves.
 * `weight` (0..1 per outward normal) fades them out, e.g. on flat faces.
 */
export function fluteOffsets(loop: Loop, pitch: number, depth: number, weight?: (n: Vec2) => number): number[] {
  const normals = unitNormals(loop);
  let P = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    P += Math.hypot(x1 - x0, y1 - y0);
  }
  const count = Math.max(3, Math.round(P / pitch));
  return loop.map((_, i) => {
    const crest = Math.sqrt(Math.abs(Math.sin((Math.PI * count * i) / loop.length)));
    return depth * crest * (weight ? weight(normals[i]) : 1);
  });
}

/**
 * Largest safe offset per vertex: an outline can only be offset by less than
 * its local radius of curvature before it folds over itself. `sign` > 0 checks
 * convex bends (inward offsets), < 0 concave bends (outward offsets).
 */
function offsetLimits(loop: Loop, sign: number, win = 4, spread = 6): number[] {
  const n = loop.length;
  const raw = loop.map((p, i) => {
    const a = loop[(i - win + n) % n];
    const b = loop[(i + win) % n];
    const a1 = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const a2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let turn = a2 - a1;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    if (turn * sign <= 1e-6) return Infinity;
    const s = (Math.hypot(p[0] - a[0], p[1] - a[1]) + Math.hypot(b[0] - p[0], b[1] - p[1])) / 2;
    return (0.85 * s) / Math.abs(turn);
  });
  return raw.map((_, i) => {
    let m = Infinity;
    for (let k = -spread; k <= spread; k++) m = Math.min(m, raw[(i + k + n) % n]);
    return m;
  });
}

/**
 * Loft one CCW loop along Z through the given layers (inward offset per layer).
 * `relief` pushes vertices outward along their unit normal: one value per
 * vertex (same on every layer) or one array per layer.
 */
export function loftLoop(M: ManifoldToplevel, loop: Loop, layers: Layer[], weights?: number[], relief?: number[] | number[][]): Manifold {
  const n = loop.length;
  const normals = miterNormals(loop);
  const unit = relief ? unitNormals(loop) : [];
  const inMax = Math.max(0, ...layers.map((l) => l.d));
  const outMax = Math.max(0, ...layers.map((l) => -l.d));
  const limIn = inMax > 0 ? offsetLimits(loop, 1) : [];
  const limOut = outMax > 0 ? offsetLimits(loop, -1) : [];
  const rings: Loop[] = layers.map(({ d }, k) => loop.map(([x, y], i) => {
    const scale = d > 0 ? Math.min(1, limIn[i] / inMax) : d < 0 ? Math.min(1, limOut[i] / outMax) : 1;
    const o = d * scale * (weights ? weights[i] : 1);
    const [ux, uy] = relief ? unit[i] : [0, 0];
    const row = relief ? relief[k] : undefined;
    const r = !relief ? 0 : Array.isArray(row) ? row[i] : (relief as number[])[i];
    return [x - normals[i][0] * o + ux * r, y - normals[i][1] * o + uy * r] as Vec2;
  }));
  const pos: number[] = [];
  rings.forEach((ring, k) => {
    for (const [x, y] of ring) pos.push(x, y, layers[k].t);
  });
  const tri: number[] = [];
  for (let k = 0; k < layers.length - 1; k++) {
    const a = k * n;
    const b = (k + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  const last = (layers.length - 1) * n;
  for (const [i, j, k] of M.triangulate([rings[0]], 1e-7)) tri.push(i, k, j);
  for (const [i, j, k] of M.triangulate([rings[rings.length - 1]], 1e-7)) tri.push(last + i, last + j, last + k);
  return fromArrays(M, pos, tri);
}

const arc = (steps: number, f: (a: number) => Layer): Layer[] =>
  Array.from({ length: steps }, (_, i) => f((Math.PI / 2) * ((i + 1) / steps)));

/** Straight sides, a 45° chamfer at the bottom (prints clean) and a rounded top. */
export function softLayers(h: number, rTop: number, chamfer: number, steps = 8): Layer[] {
  const r = Math.max(0, Math.min(rTop, h - chamfer - 0.2));
  const L: Layer[] = chamfer > 0 ? [{ t: 0, d: chamfer }, { t: chamfer, d: 0 }] : [{ t: 0, d: 0 }];
  if (r <= 0.05) return [...L, { t: h, d: 0 }];
  L.push({ t: h - r, d: 0 });
  L.push(...arc(steps, (a) => ({ t: h - r + r * Math.sin(a), d: r * (1 - Math.cos(a)) })));
  return L;
}

/** Rounded at both ends of the loft axis (a pillow / tube-like slab). */
export function pillowLayers(len: number, r: number, steps = 8): Layer[] {
  r = Math.min(r, len / 2 - 0.05);
  const head: Layer[] = [{ t: 0, d: r }, ...arc(steps, (a) => ({ t: r - r * Math.cos(a), d: r - r * Math.sin(a) }))];
  const tail = head.map(({ t, d }) => ({ t: len - t, d })).reverse();
  return [...head, ...tail];
}

/**
 * Surface relief on the outside of a soft prism. `at` gives the outward offset
 * at arc length s on a loop of perimeter P, at height z, for outward normal n.
 */
export interface Texture {
  /** Sample spacing along the outline. */
  ds: number;
  /** Layer spacing along the height; 0 when the relief does not change with z. */
  dz: number;
  at: (s: number, P: number, z: number, n: Vec2) => number;
}

export interface SoftOptions {
  rTop: number;
  chamfer?: number;
  flute?: { pitch: number; depth: number; weight?: (n: Vec2) => number };
  texture?: Texture;
  ds?: number;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const wrap = (d: number, P: number) => d - P * Math.round(d / P);

export const TEXTURES = ['flutes', 'smooth', 'rings', 'bubbles', 'twist', 'bulge', 'pills'] as const;

/**
 * Relief patterns for the band z0..z1 of an upright wall. Every slope stays
 * below 45° so they print without support; z-varying patterns fade out at the
 * band ends so the rounded rim and the bed chamfer stay clean.
 */
export function surfaceTexture(kind: string, z0: number, z1: number): Texture | undefined {
  const H = Math.max(1, z1 - z0);
  const fade = (z: number, f: number) => smooth((z - z0) / f) * smooth((z1 - z) / f);
  const flutes = (s: number, P: number, pitch: number, depth: number) =>
    depth * Math.sqrt(Math.abs(Math.sin((Math.PI * Math.max(3, Math.round(P / pitch)) * s) / P)));
  switch (kind) {
    case 'flutes':
      return { ds: 4.4 / 14, dz: 0, at: (s, P) => flutes(s, P, 4.4, 1) };
    case 'rings': {
      // soft horizontal ribs; a whole number of them so both ends sit in a groove
      const pitch = H / Math.max(1, Math.round(H / 4.2));
      return { ds: 0.7, dz: pitch / 10, at: (_s, _P, z) => (z < z0 || z > z1 ? 0 : 0.6 * (1 - Math.cos((2 * Math.PI * (z - z0)) / pitch))) };
    }
    case 'twist': {
      const pitch = 6;
      const lead = pitch / Math.tan(Math.PI / 6);
      return {
        ds: 0.6,
        dz: 0.8,
        at: (s, P, z) => {
          const n = Math.max(3, Math.round(P / pitch));
          return 0.7 * (1 + Math.cos(2 * Math.PI * ((n * s) / P + z / lead))) * fade(z, 5);
        },
      };
    }
    case 'bulge': {
      // stacked round segments, each covered in fine ribs
      const seg = H / Math.max(1, Math.round(H / 30));
      const depth = Math.min(5, seg * 0.16);
      return {
        ds: 3.2 / 12,
        dz: 0.8,
        at: (s, P, z) => {
          if (z < z0 || z > z1) return 0;
          const f = Math.sin((Math.PI * (((z - z0) / seg) % 1)));
          return depth * f + flutes(s, P, 3.2, 0.7) * (0.3 + 0.7 * f);
        },
      };
    }
    case 'bubbles': {
      const a = 10;
      const rows = Math.max(1, Math.round(H / (a * 0.87)));
      const rs = H / rows;
      return {
        ds: 0.7,
        dz: 0.7,
        at: (s, P, z) => {
          const cols = Math.max(3, Math.round(P / a));
          const sc = P / cols;
          const j0 = Math.floor((z - z0) / rs);
          let best = 0;
          for (let j = j0 - 1; j <= j0 + 1; j++) {
            if (j < 0 || j >= rows) continue;
            const zc = z0 + rs * (j + 0.5);
            const off = j % 2 ? 0.5 : 0;
            const k = Math.round(s / sc - off);
            for (let q = k - 1; q <= k + 1; q++) {
              const r = Math.hypot(wrap(s - (q + off) * sc, P) / (sc * 0.62), (z - zc) / (rs * 0.64));
              if (r < 1) best = Math.max(best, Math.cos((Math.PI / 2) * r) ** 2);
            }
          }
          return 2 * best * fade(z, 5);
        },
      };
    }
    case 'pills': {
      // raised capsules; every other column is split by a round button
      const w = 10;
      const edge = 3;
      const m = 5;
      return {
        ds: 0.7,
        dz: 0.7,
        at: (s, P, z) => {
          const cols = Math.max(3, Math.round(P / 21));
          const sc = P / cols;
          const k = Math.round(s / sc);
          const du = Math.abs(wrap(s - k * sc, P));
          const zm = (z0 + z1) / 2;
          const capsule = (za: number, zb: number) => {
            const zz = Math.min(Math.max(z, za + w / 2), zb - w / 2);
            return Math.hypot(du, z - zz);
          };
          let r: number;
          if (k % 2 && H > 60) {
            const R = 8;
            const gap = 3;
            r = Math.min(Math.hypot(du, z - zm) - R + w / 2, capsule(z0 + m, zm - R - gap), capsule(zm + R + gap, z1 - m));
          } else r = capsule(z0 + m, z1 - m);
          return 1.6 * smooth((w / 2 - r) / edge + 0.5);
        },
      };
    }
    default:
      return undefined;
  }
}

/** Extra layers wherever two straight layers are more than dz apart. */
function densify(layers: Layer[], dz: number): Layer[] {
  if (dz <= 0) return layers;
  const out: Layer[] = [layers[0]];
  for (let k = 1; k < layers.length; k++) {
    const a = layers[k - 1];
    const b = layers[k];
    if (a.d === 0 && b.d === 0 && b.t - a.t > dz) {
      const n = Math.ceil((b.t - a.t) / dz);
      for (let i = 1; i < n; i++) out.push({ t: a.t + ((b.t - a.t) * i) / n, d: 0 });
    }
    out.push(b);
  }
  return out;
}

/** Extrude a cross-section to height h with soft edges (holes get matching rounded rims). */
export function softPrism(M: ManifoldToplevel, cs: CrossSection, h: number, o: SoftOptions): Manifold {
  const c = o.chamfer ?? 0;
  const ds = o.ds ?? 0.6;
  const { outers, holes } = loopsOf(cs);
  const layers = softLayers(h, o.rTop, c);
  const solids = outers.map((l) => {
    if (o.texture) {
      const tx = o.texture;
      const loop = resample(l, Math.min(ds, tx.ds));
      const normals = unitNormals(loop);
      const P = perimeter(loop);
      const step = P / loop.length;
      const tl = densify(layers, tx.dz);
      const relief = tx.dz > 0
        ? tl.map(({ t }) => loop.map((_, i) => tx.at(i * step, P, t, normals[i])))
        : loop.map((_, i) => tx.at(i * step, P, 0, normals[i]));
      return loftLoop(M, loop, tl, undefined, relief);
    }
    if (!o.flute) return loftLoop(M, resample(l, ds), layers);
    const loop = resample(l, Math.min(ds, o.flute.pitch / 14));
    return loftLoop(M, loop, layers, undefined, fluteOffsets(loop, o.flute.pitch, o.flute.depth, o.flute.weight));
  });
  let solid = solids.length === 1 ? solids[0] : M.Manifold.union(solids);
  if (holes.length) {
    const hl: Layer[] = [{ t: -1, d: -c }, ...layers.map(({ t, d }) => ({ t, d: -d })), { t: h + 1, d: -o.rTop }];
    solid = solid.subtract(M.Manifold.union(holes.map((l) => loftLoop(M, resample(l, ds), hl))));
  }
  return solid;
}

/**
 * Cutter for a cup-like cavity from z0 (floor) up through the top at h, with a
 * rounded rim and a cove where floor and wall meet.
 */
export function softCavity(M: ManifoldToplevel, cs: CrossSection, z0: number, h: number, rTop: number, rFloor: number, ds = 0.6): Manifold {
  const rf = Math.max(0, Math.min(rFloor, (h - z0) / 2 - rTop));
  const L: Layer[] = rf > 0.05
    ? [{ t: z0, d: rf }, ...arc(8, (a) => ({ t: z0 + rf - rf * Math.cos(a), d: rf - rf * Math.sin(a) }))]
    : [{ t: z0, d: 0 }];
  L.push({ t: h - rTop, d: 0 });
  L.push(...arc(8, (a) => ({ t: h - rTop + rTop * Math.sin(a), d: -rTop * (1 - Math.cos(a)) })));
  L.push({ t: h + 1, d: -rTop });
  const parts = loopsOf(cs).outers.map((l) => loftLoop(M, resample(l, ds), L));
  return parts.length === 1 ? parts[0] : M.Manifold.union(parts);
}

/**
 * Loft a profile along Z over `len`, rounding both ends (pillow). `weight`
 * keeps chosen faces (e.g. the one on the bed, or the back against a wall)
 * flat by fading the rounding out per outward normal.
 */
export function pillowPrism(M: ManifoldToplevel, cs: CrossSection, len: number, r: number, weight?: (n: Vec2) => number, ds = 0.5): Manifold {
  const layers = pillowLayers(len, r);
  const parts = loopsOf(cs).outers.map((l) => {
    const loop = resample(l, ds);
    const w = weight ? unitNormals(loop).map(weight) : undefined;
    return loftLoop(M, loop, layers, w);
  });
  return parts.length === 1 ? parts[0] : M.Manifold.union(parts);
}

/** Round convex corners (opening) and fill concave ones (closing). */
export function soften(cs: CrossSection, convex: number, concave: number): CrossSection {
  let out = cs;
  if (concave > 0) out = out.offset(concave, 'Round', 2, 48).offset(-concave, 'Round', 2, 48);
  if (convex > 0) out = out.offset(-convex, 'Round', 2, 48).offset(convex, 'Round', 2, 48);
  return out;
}

/**
 * soften() for a profile that stands on the bed (y = 0): corners touching the
 * bed stay square, because a rounded bottom edge would be an overhang.
 */
export function softenOnBed(M: ManifoldToplevel, cs: CrossSection, convex: number, concave: number): CrossSection {
  const b = cs.bounds();
  const band = M.CrossSection.square([b.max[0] - b.min[0] + 2, convex + 0.01]).translate([b.min[0] - 1, b.min[1]]);
  return soften(cs, convex, concave).add(cs.intersect(band));
}

/**
 * Centreline of a meander (hairpin wall): vertical runs at `xs`, joined by
 * half circles alternately at the top (`yTop`) and bottom (`yBot`). The first
 * run starts at `yStart`, the last one ends at `yEnd`. Feed it to ribbon().
 */
export function meanderPath(xs: number[], yBot: number, yTop: number, yStart: number, yEnd: number, step = 0.6): Vec2[] {
  const out: Vec2[] = [];
  const line = (x: number, y0: number, y1: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(y1 - y0) / step));
    for (let k = 0; k <= n; k++) out.push([x, y0 + ((y1 - y0) * k) / n]);
  };
  const turn = (x0: number, x1: number, y: number, up: boolean) => {
    const r = (x1 - x0) / 2;
    const n = Math.max(8, Math.ceil((Math.PI * r) / step));
    for (let k = 1; k < n; k++) {
      const a = Math.PI - (Math.PI * k) / n;
      out.push([x0 + r + r * Math.cos(a), y + (up ? 1 : -1) * r * Math.sin(a)]);
    }
  };
  xs.forEach((x, i) => {
    const goingUp = i % 2 === 0;
    const from = i === 0 ? yStart : goingUp ? yBot : yTop;
    const to = i === xs.length - 1 ? yEnd : goingUp ? yTop : yBot;
    line(x, from, to);
    if (i < xs.length - 1) turn(x, xs[i + 1], goingUp ? yTop : yBot, goingUp);
  });
  return out;
}

/** A band of constant width along an open polyline, with round caps. */
export function ribbon(M: ManifoldToplevel, path: Vec2[], width: number): CrossSection {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l;
    const ny = tx / l;
    left.push([path[i][0] + nx * width / 2, path[i][1] + ny * width / 2]);
    right.push([path[i][0] - nx * width / 2, path[i][1] - ny * width / 2]);
  }
  const body = csOf(M, [[...right, ...left.reverse()]]);
  const caps = [path[0], path[n - 1]].map((p) => M.CrossSection.circle(width / 2, 32).translate(p));
  return M.CrossSection.union([body, ...caps]);
}
