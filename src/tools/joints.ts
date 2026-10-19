import type { CrossSection, Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import type { BuildOutput, Params, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { asMat4, countersunk, deg, filletExtrude, rotateOnto, teardrop } from '../geom/helpers';

// ---------------------------------------------------------------------------
// Plank joints: a 2D profile with slots for boards, extruded along Z.

export interface PlankJointOptions {
  /** Board thickness. */
  t: number;
  clearance: number;
  wall: number;
  /** How deep a board slides into the joint. */
  depth: number;
  /** Extrusion length (along the board's width). */
  length: number;
  /** Arm directions in degrees (0 = +X). */
  angles: number[];
  screws: number;
  screwD: number;
  rounding: number;
}

export function plankGeometry(o: Pick<PlankJointOptions, 't' | 'clearance' | 'wall' | 'angles'>) {
  const tc = o.t + o.clearance;
  const half = tc / 2 + o.wall;
  const sorted = [...o.angles].map((a) => ((a % 360) + 360) % 360).sort((a, b) => a - b);
  let minGap = 360;
  for (let i = 0; i < sorted.length; i++) {
    const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
    minGap = Math.min(minGap, next - sorted[i]);
  }
  if (sorted.length < 2) minGap = 360;
  const r0 = minGap >= 180 ? half : Math.max(half, tc / 2 / Math.tan(deg(minGap / 2)) + 1);
  return { tc, half, r0 };
}

export function plankJoint(M: ManifoldToplevel, o: PlankJointOptions): Manifold {
  const { tc, half, r0 } = plankGeometry(o);
  const arms: CrossSection[] = [];
  const roots: CrossSection[] = [];
  const slots: CrossSection[] = [];
  for (const a of o.angles) {
    arms.push(M.CrossSection.square([r0 + o.depth, 2 * half]).translate([0, -half]).rotate(a));
    roots.push(M.CrossSection.square([r0, 2 * half]).translate([0, -half]).rotate(a));
    slots.push(M.CrossSection.square([o.depth + 1, tc]).translate([r0, -tc / 2]).rotate(a));
  }
  let outline = M.CrossSection.union([...arms, M.CrossSection.hull(roots)]);
  if (o.rounding > 0) outline = outline.offset(-o.rounding, 'Round').offset(o.rounding, 'Round');
  const profile = outline.subtract(M.CrossSection.union(slots));
  let solid = filletExtrude(M, profile, o.length, 0.8, 0.8);
  if (o.screws > 0) {
    const zs = o.screws === 1 ? [o.length / 2] : [o.length * 0.27, o.length * 0.73];
    const holes: Manifold[] = [];
    for (const a of o.angles) {
      // put the screw on the side of the arm that faces away from the other arms
      const ly: [number, number] = [-Math.sin(deg(a)), Math.cos(deg(a))];
      let plus = 0;
      let minus = 0;
      for (const b of o.angles) {
        if (b === a) continue;
        const d = Math.cos(deg(b)) * ly[0] + Math.sin(deg(b)) * ly[1];
        if (d > 0) plus += d;
        else minus -= d;
      }
      const side = plus > minus ? -1 : 1;
      for (const z of zs) {
        const h = countersunk(M, o.screwD + 0.3, o.screwD * 2 + 0.6, o.wall + 1)
          .rotate([side > 0 ? 90 : -90, 0, 0])
          .translate([r0 + o.depth / 2, side * half, z])
          .rotate([0, 0, a]);
        holes.push(h);
      }
    }
    solid = solid.subtract(M.Manifold.union(holes));
  }
  return solid;
}

// ---------------------------------------------------------------------------
// 3D cabinet corner: three slotted L-arms meeting in a solid core.

export interface CornerOptions {
  t: number;
  clearance: number;
  wall: number;
  depth: number;
  /** Length of each arm beyond the core. */
  arm: number;
  rounding: number;
}

export function cornerCore(o: Pick<CornerOptions, 't' | 'clearance' | 'wall'>) {
  return o.t + o.clearance + 2 * o.wall;
}

/** Corner in the positive octant; boards sit at x/y/z ∈ [wall, wall + t] beyond the core. */
export function cabinetCorner(M: ManifoldToplevel, o: CornerOptions): Manifold {
  const tc = o.t + o.clearance;
  const s = tc + 2 * o.wall;
  const w = o.wall;
  let outline = M.CrossSection.union([
    M.CrossSection.square([s, s + o.depth]),
    M.CrossSection.square([s + o.depth, s]),
  ]);
  if (o.rounding > 0) outline = outline.offset(-o.rounding, 'Round').offset(o.rounding, 'Round');
  const profile = outline.subtract(
    M.CrossSection.union([
      M.CrossSection.square([tc, o.depth + 1]).translate([w, s]),
      M.CrossSection.square([o.depth + 1, tc]).translate([s, w]),
    ]),
  );
  const arm = filletExtrude(M, profile, s + o.arm, 0, 0.8);
  const toX = asMat4([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const toY = asMat4([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  return M.Manifold.union([arm, arm.transform(toX), arm.transform(toY)]);
}

/** Stand the corner on its tip (diagonal up): every slot then prints without support. */
export function cornerForPrint(M: ManifoldToplevel, corner: Manifold, tipCut = 6): Manifold {
  const k = 1 / Math.sqrt(3);
  const r = corner.transform(asMat4(rotateOnto([k, k, k], [0, 0, 1])));
  const b = r.boundingBox();
  void M;
  return r.trimByPlane([0, 0, 1], b.min[2] + tipCut);
}

// ---------------------------------------------------------------------------
// Stick / dowel hubs: tubes in any direction around a core.

export interface HubOptions {
  profile: 'round' | 'square';
  size: number;
  clearance: number;
  wall: number;
  depth: number;
  dirs: Vec3[];
  screwD: number;
  /** Teardrop bores for horizontal round arms (prints without support). */
  teardrop: boolean;
  /** 45° braces under horizontal arms so a hub standing on a downward arm prints without support. */
  gussets?: boolean;
  /** Cut the hub flat at this height above its centre (e.g. flush with a table top). */
  trimTop?: number;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotation whose local Z is `d` and local Y points as close to world up as possible. */
export function armFrame(d: Vec3) {
  const e3 = norm(d);
  const ref: Vec3 = Math.abs(e3[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const e1 = norm(cross(ref, e3));
  const e2 = cross(e3, e1);
  return asMat4([e1[0], e1[1], e1[2], 0, e2[0], e2[1], e2[2], 0, e3[0], e3[1], e3[2], 0, 0, 0, 0, 1]);
}

export function hubGeometry(o: Pick<HubOptions, 'profile' | 'size' | 'clearance' | 'wall' | 'dirs'>) {
  const rb = o.size / 2 + o.clearance;
  const ro = rb + o.wall;
  const dirs = o.dirs.map(norm);
  let minAngle = Math.PI;
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) minAngle = Math.min(minAngle, Math.acos(Math.max(-1, Math.min(1, dot(dirs[i], dirs[j])))));
  const axisAligned = dirs.every((d) => d.filter((c) => Math.abs(c) > 0.999).length === 1);
  const ext = o.profile === 'square' && !axisAligned ? rb * Math.SQRT2 : rb;
  const r0 = minAngle > Math.PI * 0.99 ? 2 : Math.max(2, ext / Math.tan(minAngle / 2) + 1.2);
  return { rb, ro, r0, dirs };
}

export function stickHub(M: ManifoldToplevel, o: HubOptions): Manifold {
  const { rb, ro, r0, dirs } = hubGeometry(o);
  const L = r0 + o.depth;
  const tubes: Manifold[] = [];
  const roots: Manifold[] = [];
  const bores: Manifold[] = [];
  for (const d of dirs) {
    const f = armFrame(d);
    if (o.profile === 'round') {
      tubes.push(M.Manifold.cylinder(L, ro, ro, 64).transform(f));
      roots.push(M.Manifold.cylinder(r0, ro, ro, 64).transform(f));
      const horizontal = Math.abs(d[2]) < 0.35;
      const bore = horizontal && o.teardrop ? teardrop(M, rb, 48).extrude(o.depth + 1) : M.Manifold.cylinder(o.depth + 1, rb, rb, 64);
      bores.push(bore.translate([0, 0, r0]).transform(f));
    } else {
      tubes.push(M.Manifold.cube([2 * ro, 2 * ro, L]).translate([-ro, -ro, 0]).transform(f));
      roots.push(M.Manifold.cube([2 * ro, 2 * ro, r0]).translate([-ro, -ro, 0]).transform(f));
      bores.push(M.Manifold.cube([2 * rb, 2 * rb, o.depth + 1]).translate([-rb, -rb, r0]).transform(f));
    }
    if (o.screwD > 0) {
      bores.push(M.Manifold.cylinder(ro + 1, o.screwD / 2, o.screwD / 2, 20).rotate([-90, 0, 0]).translate([0, 0, r0 + o.depth / 2]).transform(f));
    }
  }
  const core = M.Manifold.hull(roots);
  const parts = [...tubes, core];
  if (o.profile === 'round') parts.push(M.Manifold.sphere(ro, 64));
  if (o.gussets && dirs.some((d) => d[2] < -0.99)) {
    for (const d of dirs) {
      if (Math.abs(d[2]) > 0.05) continue;
      // wedge in the vertical plane of the arm: from the arm's underside down to the leg tube
      const side: Vec3 = [-d[1], d[0], 0];
      const pts: Vec3[] = [];
      const reach = L - 1;
      const round = o.profile === 'round';
      const inner = round ? ro * 0.8 : ro - 0.5;
      const top = round ? -ro * 0.85 : -ro + 0.2;
      for (const k of [-1, 1]) {
        const off = k * (round ? ro * 0.45 : ro - 0.6);
        const at = (along: number, z: number): Vec3 => [d[0] * along + side[0] * off, d[1] * along + side[1] * off, z];
        pts.push(at(inner, top), at(reach, top), at(inner, top - (reach - inner)));
      }
      parts.push(M.Manifold.hull(pts));
    }
  }
  let solid = M.Manifold.union(parts).subtract(M.Manifold.union(bores));
  if (o.trimTop !== undefined) solid = solid.trimByPlane([0, 0, -1], -o.trimTop);
  return solid;
}

const CONFIGS: Record<string, { label: string; dirs: Vec3[] }> = {
  straight: { label: 'Recht (verlengstuk)', dirs: [[1, 0, 0], [-1, 0, 0]] },
  corner: { label: 'Hoek 90°', dirs: [[1, 0, 0], [0, 1, 0]] },
  tee: { label: 'T-stuk', dirs: [[1, 0, 0], [-1, 0, 0], [0, 1, 0]] },
  cross: { label: 'Kruis', dirs: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] },
  corner3d: { label: '3D-hoek (kubus)', dirs: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
  tee3d: { label: '3D T-stuk', dirs: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1]] },
  five: { label: '5-weg', dirs: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]] },
  six: { label: '6-weg (alle kanten)', dirs: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] },
};

export function hubDirections(p: Params): Vec3[] {
  const cfg = str(p, 'config');
  if (cfg !== 'custom' && CONFIGS[cfg]) return CONFIGS[cfg].dirs;
  const n = Math.round(num(p, 'armCount'));
  const step = num(p, 'armStep');
  const tilt = deg(num(p, 'armTilt'));
  const dirs: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = deg(i * step);
    dirs.push([Math.cos(a) * Math.cos(tilt), Math.sin(a) * Math.cos(tilt), Math.sin(tilt)]);
  }
  if (bool(p, 'armUp')) dirs.push([0, 0, 1]);
  if (bool(p, 'armDown')) dirs.push([0, 0, -1]);
  return dirs;
}

/** Choose a support-free orientation: arms pointing down are flipped up when possible. */
export function orientHub(dirs: Vec3[]) {
  const down = dirs.some((d) => d[2] < -0.5);
  const up = dirs.some((d) => d[2] > 0.5);
  const flipped = down && !up;
  const out = flipped ? dirs.map((d) => [d[0], d[1], -d[2]] as Vec3) : dirs;
  // straight-down arms stand on the bed and horizontal arms get 45° braces; only tilted-down arms need support
  const needsSupport = out.some((d) => d[2] < -0.2 && d[2] > -0.99);
  return { dirs: out, flipped, needsSupport };
}

const PLANK_SHAPES: Record<string, { label: string; angles: number[] }> = {
  I: { label: 'I — verlengen (in lijn)', angles: [0, 180] },
  L: { label: 'L — hoek 90°', angles: [0, 90] },
  T: { label: 'T — tussenschot', angles: [0, 90, 180] },
  X: { label: 'X — kruising', angles: [0, 90, 180, 270] },
  V: { label: 'V — eigen hoek', angles: [] },
};

export function plankAngles(shape: string, angle: number) {
  return shape === 'V' ? [0, angle] : PLANK_SHAPES[shape]?.angles ?? [0, 90];
}

function build(p: Params, { M }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const kind = str(p, 'kind');
  const quantity = num(p, 'quantity');
  const tips: string[] = [];
  const info: BuildOutput['info'] = [];
  if (kind === 'plank') {
    const o: PlankJointOptions = {
      t: num(p, 'plankT'),
      clearance: num(p, 'clearance'),
      wall: num(p, 'wall'),
      depth: num(p, 'insert'),
      length: num(p, 'length'),
      angles: plankAngles(str(p, 'shape'), num(p, 'angle')),
      screws: Number(str(p, 'screws')),
      screwD: num(p, 'screwD'),
      rounding: num(p, 'rounding'),
    };
    const solid = plankJoint(M, o);
    tips.push('Ligt plat op het bed met de sleuven naar boven: geen support nodig.');
    tips.push(`Speling ${o.clearance} mm: meet je plank na — echte 18 mm platen zijn vaak 17.6–18.4 mm.`);
    if (o.screws > 0) tips.push(`Zet vast met verzonken houtschroeven Ø${o.screwD} mm (lengte ≈ ${Math.round(o.wall + o.t * 0.8)} mm).`);
    info.push({ kind: 'kv', title: 'Maat', rows: [['Plankdikte', `${o.t} mm (+${o.clearance} speling)`], ['Insteekdiepte', `${o.depth} mm`], ['Lengte', `${o.length} mm`]] });
    return { parts: [{ name: `Plankverbinder ${str(p, 'shape')}`, solid, quantity }], tips, info };
  }
  if (kind === 'corner') {
    const o: CornerOptions = {
      t: num(p, 'plankT'),
      clearance: num(p, 'clearance'),
      wall: num(p, 'wall'),
      depth: num(p, 'insert'),
      arm: num(p, 'arm'),
      rounding: num(p, 'rounding'),
    };
    const solid = cornerForPrint(M, cabinetCorner(M, o));
    const s = cornerCore(o);
    tips.push('De hoek staat op zijn punt geprint: alle sleuven lopen dan onder 35° en printen zonder support. Gebruik een brim van 5 mm.');
    tips.push(`Panelen worden ${(2 * s).toFixed(1)} mm kleiner dan de buitenmaat van de kast (per richting).`);
    info.push({ kind: 'kv', title: 'Maat', rows: [['Kern', `${s.toFixed(1)} mm`], ['Armlengte', `${o.arm} mm`]] });
    return { parts: [{ name: 'Kasthoek 3D', solid, quantity }], tips, info };
  }
  const raw = hubDirections(p);
  if (raw.length === 0) throw new UserError('Kies minimaal één arm');
  const { dirs, flipped, needsSupport } = orientHub(raw);
  const profile = str(p, 'profile') as 'round' | 'square';
  let solid = stickHub(M, {
    profile,
    size: num(p, 'stickSize'),
    clearance: num(p, 'clearance'),
    wall: num(p, 'wall'),
    depth: num(p, 'insert'),
    dirs,
    screwD: num(p, 'stickScrew'),
    teardrop: true,
    gussets: true,
  });
  const b = solid.boundingBox();
  const flatBottom = dirs.some((d) => Math.abs(d[2]) > 0.999 && d[2] < 0) || (profile === 'square' && dirs.every((d) => Math.abs(d[2]) < 1e-6 || Math.abs(d[2]) > 0.999));
  if (!flatBottom) solid = solid.trimByPlane([0, 0, 1], b.min[2] + (profile === 'round' ? 0.8 : 0.5));
  if (flipped) tips.push('Ondersteboven geprint zodat de verticale arm omhoog wijst: geen support nodig.');
  if (dirs.some((d) => d[2] < -0.99) && dirs.some((d) => Math.abs(d[2]) < 0.05)) tips.push('Staat op de onderste arm; de schuine steunen onder de liggende armen maken support overbodig.');
  if (needsSupport) tips.push('Deze vorm heeft armen die naar beneden wijzen: zet "tree support" aan in Bambu Studio.');
  else tips.push('Liggende gaten zijn druppelvormig (teardrop) zodat ze zonder support printen.');
  return { parts: [{ name: `Stokverbinder ${str(p, 'config')}`, solid, quantity }], tips, info };
}

const isPlank = (p: Params) => str(p, 'kind') === 'plank';
const isCorner = (p: Params) => str(p, 'kind') === 'corner';
const isStick = (p: Params) => str(p, 'kind') === 'stick';
const isCustom = (p: Params) => isStick(p) && str(p, 'config') === 'custom';

export const jointsTool: ToolDef = {
  id: 'verbindingen',
  name: 'Verbindingen',
  short: 'Verbinders',
  icon: 'M4 4h6v6H4zM10 7h10M7 10v10M17 4v6M4 17h6',
  description: 'Verbinders voor planken (I, L, T, X en eigen hoek), 3D-kasthoeken voor kleine kastjes en verbinders voor ronde stokken of vierkante latten.',
  params: [
    { type: 'group', label: 'Soort' },
    {
      type: 'select', key: 'kind', label: 'Verbinding voor', default: 'plank',
      options: [
        { value: 'plank', label: 'Planken (profiel)' },
        { value: 'corner', label: 'Kastje — 3D-hoek voor panelen' },
        { value: 'stick', label: 'Stokken / latten' },
      ],
    },
    { type: 'number', key: 'quantity', label: 'Aantal', min: 1, max: 64, step: 1, default: 1 },
    { type: 'group', label: 'Vorm', show: (p) => isPlank(p) || isStick(p) },
    { type: 'select', key: 'shape', label: 'Vorm', default: 'L', show: isPlank, options: Object.entries(PLANK_SHAPES).map(([value, v]) => ({ value, label: v.label })) },
    { type: 'number', key: 'angle', label: 'Hoek tussen planken', min: 30, max: 170, step: 1, unit: '°', default: 120, show: (p) => isPlank(p) && str(p, 'shape') === 'V' },
    {
      type: 'select', key: 'config', label: 'Armen', default: 'corner3d', show: isStick,
      options: [...Object.entries(CONFIGS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Eigen ontwerp' }],
    },
    { type: 'number', key: 'armCount', label: 'Armen rondom', min: 0, max: 8, step: 1, default: 3, show: isCustom },
    { type: 'number', key: 'armStep', label: 'Hoek tussen armen', min: 15, max: 180, step: 1, unit: '°', default: 120, show: isCustom },
    { type: 'number', key: 'armTilt', label: 'Kanteling armen', min: -85, max: 85, step: 1, unit: '°', default: -70, show: isCustom, help: 'Negatief = naar beneden (bijv. poten van een driepoot)' },
    { type: 'bool', key: 'armUp', label: 'Arm recht omhoog', default: false, show: isCustom },
    { type: 'bool', key: 'armDown', label: 'Arm recht omlaag', default: false, show: isCustom },
    { type: 'group', label: 'Hout' },
    { type: 'number', key: 'plankT', label: 'Plankdikte', min: 3, max: 40, step: 0.5, unit: 'mm', default: 18, show: (p) => !isStick(p) },
    {
      type: 'select', key: 'profile', label: 'Doorsnede stok', default: 'round', show: isStick,
      options: [
        { value: 'round', label: 'Rond (deuvel / bezemsteel)' },
        { value: 'square', label: 'Vierkant (lat)' },
      ],
    },
    { type: 'number', key: 'stickSize', label: 'Diameter / breedte stok', min: 4, max: 50, step: 0.5, unit: 'mm', default: 18, show: isStick },
    { type: 'number', key: 'clearance', label: 'Speling', min: 0, max: 1.5, step: 0.05, unit: 'mm', default: 0.3 },
    { type: 'group', label: 'Verbinder' },
    { type: 'number', key: 'insert', label: 'Insteekdiepte', min: 8, max: 80, step: 1, unit: 'mm', default: 25 },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 1.6, max: 8, step: 0.2, unit: 'mm', default: 3 },
    { type: 'number', key: 'length', label: 'Lengte (breedte van de plank in de verbinder)', min: 10, max: 300, step: 1, unit: 'mm', default: 40, show: isPlank },
    { type: 'number', key: 'arm', label: 'Armlengte langs de randen', min: 5, max: 120, step: 1, unit: 'mm', default: 30, show: isCorner },
    { type: 'number', key: 'rounding', label: 'Afronding buitenhoeken', min: 0, max: 8, step: 0.5, unit: 'mm', default: 2, show: (p) => !isStick(p) },
    {
      type: 'select', key: 'screws', label: 'Schroefgaten per arm', default: '1', show: isPlank,
      options: [
        { value: '0', label: 'Geen (lijmen/klemmen)' },
        { value: '1', label: '1' },
        { value: '2', label: '2' },
      ],
    },
    { type: 'number', key: 'screwD', label: 'Schroefdiameter', min: 2.5, max: 6, step: 0.5, unit: 'mm', default: 4, show: (p) => isPlank(p) && str(p, 'screws') !== '0' },
    { type: 'number', key: 'stickScrew', label: 'Borggat Ø (0 = geen)', min: 0, max: 5, step: 0.1, unit: 'mm', default: 3, show: isStick },
  ],
  presets: [
    { name: 'L-hoek 18 mm plank', values: { kind: 'plank', shape: 'L', plankT: 18, insert: 25, wall: 3, length: 40, screws: '1' } },
    { name: 'T-verbinder 18 mm', values: { kind: 'plank', shape: 'T', plankT: 18, insert: 25, wall: 3, length: 40, screws: '1' } },
    { name: 'Kruis 12 mm multiplex', values: { kind: 'plank', shape: 'X', plankT: 12, insert: 20, wall: 2.6, length: 30, screws: '0' } },
    { name: 'Zeshoek 120° (honingraat)', values: { kind: 'plank', shape: 'V', angle: 120, plankT: 12, insert: 20, wall: 2.6, length: 40 } },
    { name: 'Kastje 3D-hoek 12 mm', values: { kind: 'corner', plankT: 12, insert: 18, wall: 2.6, arm: 25, rounding: 2 } },
    { name: 'Deuvel 3D-hoek Ø18', values: { kind: 'stick', profile: 'round', stickSize: 18, config: 'corner3d', insert: 25, wall: 3 } },
    { name: 'Lat 6-weg 20×20', values: { kind: 'stick', profile: 'square', stickSize: 20, config: 'six', insert: 25, wall: 3 } },
    { name: 'Driepoot Ø12', values: { kind: 'stick', profile: 'round', stickSize: 12, config: 'custom', armCount: 3, armStep: 120, armTilt: -70, armUp: false, armDown: false, insert: 25, wall: 2.6 } },
  ],
  build,
};
