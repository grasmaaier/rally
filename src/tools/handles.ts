import type { Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { BuildOutput, Params, ToolDef } from '../core/types';
import { num, str } from '../core/types';
import { keep } from '../core/registry';
import { SCREWS, clamp, countersunk, filletExtrude, fixingHole, roundedRect, smoothstep } from '../geom/helpers';
import { sectionFn } from '../geom/surface';

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

function build(p: Params, { M }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const type = str(p, 'type');
  const res = type === 'bar' ? bar(M, p) : type === 'arch' ? arch(M, p) : type === 'cup' ? cup(M, p) : knob(M, p);
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
  return { parts: [{ name: names[type] ?? 'Greep', solid: res.solid, quantity: num(p, 'quantity') }], tips, info };
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
      ],
    },
    { type: 'number', key: 'knobD', label: 'Diameter', min: 15, max: 80, step: 0.5, unit: 'mm', default: 32, show: is('knob') },
    { type: 'number', key: 'knobH', label: 'Hoogte', min: 12, max: 60, step: 0.5, unit: 'mm', default: 26, show: is('knob') },
    { type: 'number', key: 'baseD', label: 'Diameter voet', min: 8, max: 60, step: 0.5, unit: 'mm', default: 18, show: is('knob') },
    { type: 'number', key: 'neckD', label: 'Diameter hals', min: 6, max: 50, step: 0.5, unit: 'mm', default: 13, show: is('knob') },
    { type: 'number', key: 'dome', label: 'Bolling bovenkant', min: 0, max: 100, step: 5, unit: '%', default: 0, show: is('knob') },
    { type: 'number', key: 'edge', label: 'Afronding rand', min: 0, max: 10, step: 0.5, unit: 'mm', default: 3, show: is('knob') },
    {
      type: 'select', key: 'pattern', label: 'Grip', default: 'smooth', show: is('knob'),
      options: [
        { value: 'smooth', label: 'Glad' },
        { value: 'ribs', label: 'Ribbels' },
        { value: 'facets', label: 'Facetten (veelhoek)' },
        { value: 'knurl', label: 'Kartel (ruit)' },
      ],
    },
    { type: 'number', key: 'patternCount', label: 'Aantal', min: 3, max: 40, step: 1, default: 12, show: (p) => is('knob')(p) && str(p, 'pattern') !== 'smooth' },
    { type: 'number', key: 'patternDepth', label: 'Diepte', min: 1, max: 20, step: 1, unit: '%', default: 6, show: (p) => is('knob')(p) && ['ribs', 'knurl'].includes(str(p, 'pattern')) },
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
  build,
};

