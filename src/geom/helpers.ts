import type { CrossSection, Manifold, ManifoldToplevel, Mat4, Vec2, Vec3 } from 'manifold-3d';
import { keep } from '../core/registry';

export const TAU = Math.PI * 2;
export const deg = (d: number) => (d * Math.PI) / 180;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Points of a rounded rectangle centered on the origin, CCW. */
export function roundedRectPoints(w: number, h: number, r: number, segs = 8): Vec2[] {
  r = clamp(r, 0, Math.min(w, h) / 2 - 1e-4);
  const pts: Vec2[] = [];
  const cx = w / 2 - r;
  const cy = h / 2 - r;
  const corners: [number, number, number][] = [
    [cx, cy, 0],
    [-cx, cy, 90],
    [-cx, -cy, 180],
    [cx, -cy, 270],
  ];
  if (r <= 1e-3) {
    return [
      [w / 2, h / 2],
      [-w / 2, h / 2],
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
    ];
  }
  for (const [x, y, a0] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = deg(a0 + (90 * i) / segs);
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  }
  return pts;
}

export function roundedRect(M: ManifoldToplevel, w: number, h: number, r: number, segs = 8): CrossSection {
  return keep(new M.CrossSection([roundedRectPoints(w, h, r, segs)]));
}

/** 3D points of a rounded rectangle at height z (for convex hulls). */
export function roundedRectAt(w: number, h: number, r: number, z: number, segs = 8): Vec3[] {
  return roundedRectPoints(w, h, r, segs).map(([x, y]) => [x, y, z] as Vec3);
}

/**
 * Stack of rounded rectangles at given heights, hulled pairwise (each pair is
 * convex, the stack as a whole need not be).
 */
export function roundedRectStack(
  M: ManifoldToplevel,
  w: number,
  h: number,
  layers: { z: number; inset: number; r: number }[],
  segs = 8,
): Manifold {
  const pieces: Manifold[] = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const a = layers[i];
    const b = layers[i + 1];
    if (Math.abs(b.z - a.z) < 1e-6) continue;
    pieces.push(
      M.Manifold.hull([
        ...roundedRectAt(w - 2 * a.inset, h - 2 * a.inset, Math.max(0.01, a.r), a.z, segs),
        ...roundedRectAt(w - 2 * b.inset, h - 2 * b.inset, Math.max(0.01, b.r), b.z, segs),
      ]),
    );
  }
  return pieces.length === 1 ? pieces[0] : M.Manifold.union(pieces);
}

/** Build a Manifold from raw arrays (positions xyz, triangle indices). */
export function fromArrays(M: ManifoldToplevel, positions: number[] | Float32Array, indices: number[] | Uint32Array): Manifold {
  const mesh = new M.Mesh({
    numProp: 3,
    vertProperties: positions instanceof Float32Array ? positions : new Float32Array(positions),
    triVerts: indices instanceof Uint32Array ? indices : new Uint32Array(indices),
  });
  return keep(new M.Manifold(mesh));
}

/** Column-major 4x4 helpers. */
export type M4 = number[];

export const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export const translation = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function rotX(d: number): M4 {
  const c = Math.cos(deg(d));
  const s = Math.sin(deg(d));
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
export function rotY(d: number): M4 {
  const c = Math.cos(deg(d));
  const s = Math.sin(deg(d));
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
export function rotZ(d: number): M4 {
  const c = Math.cos(deg(d));
  const s = Math.sin(deg(d));
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation taking unit vector `from` onto unit vector `to`. */
export function rotateOnto(from: Vec3, to: Vec3): M4 {
  const [ax, ay, az] = from;
  const [bx, by, bz] = to;
  const vx = ay * bz - az * by;
  const vy = az * bx - ax * bz;
  const vz = ax * by - ay * bx;
  const c = ax * bx + ay * by + az * bz;
  if (c < -0.999999) {
    // 180°: rotate around any axis perpendicular to `from`
    const perp: Vec3 = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const px = ay * perp[2] - az * perp[1];
    const py = az * perp[0] - ax * perp[2];
    const pz = ax * perp[1] - ay * perp[0];
    const l = Math.hypot(px, py, pz);
    return axisAngle([px / l, py / l, pz / l], 180);
  }
  const k = 1 / (1 + c);
  // Rodrigues in matrix form, column-major
  return [
    vx * vx * k + c, vy * vx * k + vz, vz * vx * k - vy, 0,
    vx * vy * k - vz, vy * vy * k + c, vz * vy * k + vx, 0,
    vx * vz * k + vy, vy * vz * k - vx, vz * vz * k + c, 0,
    0, 0, 0, 1,
  ];
}

export function axisAngle(axis: Vec3, d: number): M4 {
  const [x, y, z] = axis;
  const c = Math.cos(deg(d));
  const s = Math.sin(deg(d));
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

export function applyM4(m: M4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

export const asMat4 = (m: M4) => m as unknown as Mat4;

/**
 * Teardrop cross-section for horizontal holes: a circle with a 45° point on
 * top so the hole prints without support. Axis of the hole is Z after
 * extrusion; rotate so that +Y ends up pointing up in print orientation.
 */
export function teardrop(M: ManifoldToplevel, r: number, segs = 32): CrossSection {
  const pts: Vec2[] = [];
  // arc from 135° CCW around the bottom to 405° (=45°), then the apex on top
  for (let i = 0; i < segs; i++) {
    const a = Math.PI * 0.75 + (Math.PI * 1.5 * i) / (segs - 1);
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  pts.push([0, r * Math.SQRT2]);
  return keep(new M.CrossSection([pts]));
}

/**
 * Extrude a 2D outline with rounded/chamfered top and bottom edges by stacking
 * slightly inset layers (0.2 mm steps = one print layer, so the result prints
 * exactly like a true fillet).
 */
export function filletExtrude(
  M: ManifoldToplevel,
  shape: CrossSection,
  height: number,
  radiusBottom: number,
  radiusTop: number,
  step = 0.2,
): Manifold {
  const pieces: Manifold[] = [];
  const rb = Math.min(radiusBottom, height / 2.2);
  const rt = Math.min(radiusTop, height / 2.2);
  const nb = Math.max(0, Math.round(rb / step));
  const nt = Math.max(0, Math.round(rt / step));
  const inset = (r: number, d: number) => r - Math.sqrt(Math.max(0, r * r - (r - d) * (r - d)));
  for (let i = 0; i < nb; i++) {
    const z0 = i * step;
    const ins = inset(rb, z0 + step / 2);
    const s = shape.offset(-ins, 'Round');
    if (s.isEmpty()) continue;
    pieces.push(s.extrude(step + 0.01).translate([0, 0, z0]));
  }
  const midStart = nb * step;
  const midEnd = height - nt * step;
  pieces.push(shape.extrude(midEnd - midStart + 0.02).translate([0, 0, midStart - 0.01]));
  for (let i = 0; i < nt; i++) {
    const z0 = midEnd + i * step;
    const ins = inset(rt, height - (z0 + step / 2));
    const s = shape.offset(-ins, 'Round');
    if (s.isEmpty()) continue;
    pieces.push(s.extrude(step + (i === nt - 1 ? 0 : 0.01)).translate([0, 0, z0]));
  }
  return pieces.length === 1 ? pieces[0] : M.Manifold.union(pieces);
}

/** Regular hexagon (nut trap) with given across-flats size. */
export function hexagon(M: ManifoldToplevel, acrossFlats: number): CrossSection {
  const r = acrossFlats / Math.sqrt(3);
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) pts.push([r * Math.cos(deg(30 + i * 60)), r * Math.sin(deg(30 + i * 60))]);
  return keep(new M.CrossSection([pts]));
}

export interface ScrewSpec {
  label: string;
  /** Self-tapping pilot diameter into plastic. */
  pilot: number;
  /** Clearance hole. */
  clear: number;
  nutAF: number;
  nutH: number;
  insertD: number;
  insertL: number;
  headD: number;
}

export const SCREWS: Record<string, ScrewSpec> = {
  M3: { label: 'M3', pilot: 2.6, clear: 3.4, nutAF: 5.5, nutH: 2.4, insertD: 4.0, insertL: 5.7, headD: 6.0 },
  M4: { label: 'M4', pilot: 3.4, clear: 4.4, nutAF: 7.0, nutH: 3.2, insertD: 5.6, insertL: 8.1, headD: 8.0 },
  M5: { label: 'M5', pilot: 4.3, clear: 5.4, nutAF: 8.0, nutH: 4.0, insertD: 6.4, insertL: 9.5, headD: 9.5 },
};

/**
 * Cutter for a fixing hole entering from z=0 upward (into the part), for the
 * typical "screw from inside the door into the knob" mount.
 */
export function fixingHole(
  M: ManifoldToplevel,
  size: string,
  method: string,
  depth: number,
): Manifold {
  const s = SCREWS[size] ?? SCREWS.M4;
  const seg = 32;
  if (method === 'insert') {
    const l = Math.min(s.insertL, depth);
    return M.Manifold.union([
      M.Manifold.cylinder(l + 0.01, s.insertD / 2, s.insertD / 2, seg).translate([0, 0, -0.01]),
      M.Manifold.cylinder(Math.max(0.1, depth - l) + 0.02, s.clear / 2, s.clear / 2, seg).translate([0, 0, l - 0.01]),
    ]);
  }
  if (method === 'nut') {
    // hex nut pressed in flush with the mounting face, bolt comes through the door
    const nut = hexagon(M, s.nutAF + 0.3).extrude(s.nutH + 0.41).translate([0, 0, -0.01]);
    const bolt = M.Manifold.cylinder(depth + 0.02, s.clear / 2, s.clear / 2, seg).translate([0, 0, -0.01]);
    return M.Manifold.union([nut, bolt]);
  }
  return M.Manifold.cylinder(depth + 0.01, s.pilot / 2, s.pilot / 2, seg).translate([0, 0, -0.01]);
}

/** Countersunk wood-screw hole along +Z starting at z=0 (head side) to z=depth. */
export function countersunk(M: ManifoldToplevel, shaftD: number, headD: number, depth: number): Manifold {
  const sink = (headD - shaftD) / 2;
  return M.Manifold.union([
    M.Manifold.cylinder(depth + 0.2, shaftD / 2, shaftD / 2, 24).translate([0, 0, -0.1]),
    M.Manifold.cylinder(sink + 0.01, headD / 2, shaftD / 2, 24).translate([0, 0, -0.01]),
    M.Manifold.cylinder(1, headD / 2, headD / 2, 24).translate([0, 0, -1]),
  ]);
}

/** Catmull-Rom interpolation through evenly spaced control values. */
export function catmull(values: number[], t: number): number {
  const n = values.length - 1;
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const p0 = values[Math.max(0, i - 1)];
  const p1 = values[i];
  const p2 = values[i + 1];
  const p3 = values[Math.min(n, i + 2)];
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}

export function bboxOf(m: Manifold) {
  const b = m.boundingBox();
  return { min: b.min as Vec3, max: b.max as Vec3 };
}
