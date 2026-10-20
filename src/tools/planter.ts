import type { Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import type { BuildOutput, Params, PartOut, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { keep } from '../core/registry';
import { TAU, roundedRect, teardrop, translation } from '../geom/helpers';
import { type Surface, buildShape, insetSurface, shellOfSurface, solidOfSurface } from '../geom/surface';
import { sectionAssets, shapeNotes, shapeOptionsFrom, shapeParams } from './vase';

/** Radius of a surface at an actual (world) angle. */
const rAt = (S: Surface, z: number, a: number) => S.r(z, a - S.phi(z));

function outlineAt(M: ManifoldToplevel, S: Surface, z: number, n = 256) {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    const r = rAt(S, z, a);
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return keep(new M.CrossSection([pts]));
}

function maxRadius(S: Surface, z0: number, z1: number) {
  let m = 0;
  for (let i = 0; i <= 24; i++)
    for (let k = 0; k < 180; k++) m = Math.max(m, S.r(z0 + ((z1 - z0) * i) / 24, (TAU * k) / 180));
  return m;
}

function minRadiusAtAngle(S: Surface, z0: number, z1: number, a: number) {
  let m = Infinity;
  for (let i = 0; i <= 40; i++) m = Math.min(m, rAt(S, z0 + ((z1 - z0) * i) / 40, a));
  return m;
}

/** Radius of the largest circle around the axis that stays inside the surface between z0 and z1. */
function minRadius(S: Surface, z0: number, z1: number) {
  let m = Infinity;
  for (let k = 0; k < 180; k++) m = Math.min(m, minRadiusAtAngle(S, z0, z1, (TAU * k) / 180));
  return m;
}

/** True when a vertical circle (centre cx, cy; radius rc) stays inside the surface between z0 and z1. */
function circleInside(S: Surface, cx: number, cy: number, rc: number, z0: number, z1: number) {
  for (let i = 0; i < 24; i++) {
    const a = (TAU * i) / 24;
    const x = cx + rc * Math.cos(a);
    const y = cy + rc * Math.sin(a);
    if (Math.hypot(x, y) > minRadiusAtAngle(S, z0, z1, Math.atan2(y, x))) return false;
  }
  return true;
}

/**
 * Flatten a surface at y = yb (the back of a wall pot). The result is still a
 * radial graph around the axis, so shells built from it need no booleans.
 */
function clipBack(S: Surface, yb: number): Surface {
  return {
    phi: S.phi,
    r: (z, th) => {
      const r = S.r(z, th);
      const s = Math.sin(th + S.phi(z));
      return s > 1e-6 ? Math.min(r, yb / s) : r;
    },
  };
}

function build(p: Params, { M, assets }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const mount = str(p, 'mount');
  let water = str(p, 'water');
  const notes: string[] = [];
  if (mount !== 'stand' && water === 'drain') {
    water = 'self';
    notes.push(mount === 'hang' ? 'Hangend: geen afvoergaten (dat lekt). Automatisch omgezet naar zelfwaterend.' : 'Aan de muur: geen afvoergaten (dat lekt langs de muur). Automatisch omgezet naar zelfwaterend.');
  }
  const H = num(p, 'height');
  const rt = num(p, 'topD') / 2;
  const rb = num(p, 'bottomD') / 2;
  const belly = (num(p, 'belly') / 100) * Math.max(rt, rb) * 0.35;
  const radii = [rb, rb + (rt - rb) / 3 + belly, rb + (2 * (rt - rb)) / 3 + belly * 0.7, rt];
  const shape = buildShape(shapeOptionsFrom(p, H, radii, assets), 0.6);
  const shaped = shape.S;
  const { segs, rings, zs } = shape;
  const wall = num(p, 'wall');
  const bottomT = num(p, 'bottomT');
  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  const tips: string[] = [];
  const info: BuildOutput['info'] = [];
  const warnings: string[] = [];
  const Rmax = maxRadius(shaped, 0, H);
  // wall pots: flat back at yBack, a backboard of thickness backT behind the soil
  const backT = Math.max(wall, 3);
  const yBack = mount === 'wall' ? Math.max(0.1, num(p, 'backCut') / 100) * Rmax : Infinity;
  if (mount === 'wall' && yBack < backT + 12) throw new UserError('De vlakke achterkant zit te dicht bij het midden voor zo’n kleine pot. Verhoog "Vlakke achterkant".');
  const S = mount === 'wall' ? clipBack(shaped, yBack) : shaped;
  const Sin = insetSurface(S, wall);

  // ---- outer pot (also the reservoir for self-watering)
  let outer = shellOfSurface(M, S, Sin, { z0: 0, z1: H, floor: bottomT, segs, rings, zs });
  if (water === 'drain') {
    const holes: Manifold[] = [M.Manifold.cylinder(bottomT + 2, 4, 4, 24).translate([0, 0, -1])];
    // ring of holes well inside the narrowest part of the floor (stars, crosses, hearts)
    const rr = Math.min(minRadiusAtAngle(Sin, bottomT, bottomT + 1, 0) * 0.5, minRadius(Sin, bottomT, bottomT + 1) - 4.5);
    for (let i = 0; i < 5 && rr >= 7.5; i++) {
      const a = (TAU * i) / 5;
      holes.push(M.Manifold.cylinder(bottomT + 2, 2.5, 2.5, 16).translate([rr * Math.cos(a), rr * Math.sin(a), -1]));
    }
    outer = outer.subtract(M.Manifold.union(holes));
  }
  if (mount === 'hang') {
    const n = Math.round(num(p, 'tabs'));
    const tabL = 12;
    const tabH = 9;
    const tw = 12;
    const cord = num(p, 'cordD');
    const tabs: Manifold[] = [];
    const cuts: Manifold[] = [];
    const tabRoots: { a: number; r: number }[] = [];
    // the outer reach of the rim near each nominal tab angle: tabs move (≤ 25°) onto lobes, not into notches
    const reach = (a: number) => Math.min(rAt(S, H, a), rAt(S, H - tabH - tabL, a));
    for (let i = 0; i < n; i++) {
      let a = (TAU * i) / n + Math.PI / 2;
      let best = reach(a);
      for (let k = -10; k <= 10; k++) {
        const b = a + (k * Math.PI) / 72;
        if (reach(b) > best + 0.5) {
          best = reach(b);
          a = b;
        }
      }
      const Rw = reach(a);
      const pts: Vec3[] = [];
      for (const side of [-1, 1]) {
        const off = (side * tw) / 2;
        const at = (r: number, z: number): Vec3 => [r * Math.cos(a) - off * Math.sin(a), r * Math.sin(a) + off * Math.cos(a), z];
        pts.push(at(Rw - wall * 0.6, H), at(Rw - wall * 0.6, H - tabH - tabL), at(Rw + tabL, H), at(Rw + tabL, H - tabH));
      }
      tabs.push(M.Manifold.hull(pts));
      tabRoots.push({ a, r: Rw - wall * 0.6 });
      const hr = Rw + tabL - cord / 2 - 2.5;
      // only through the tab: a bulging wall further down must stay closed
      cuts.push(M.Manifold.cylinder(tabH + tabL + 3, cord / 2, cord / 2, 20).translate([hr * Math.cos(a), hr * Math.sin(a), H - tabH - tabL - 1]));
    }
    // a tab may poke into the pot where the wall is wavy or notched: clip the tabs (not the
    // whole pot) to a cavity that reaches 0.05 mm into the wall, so no faces coincide
    const z0 = H - tabH - tabL - 2;
    let tabSolid = M.Manifold.union(tabs);
    const intrudes = tabRoots.some(({ a, r }) => minRadiusAtAngle(Sin, z0, H, a) < r + 0.2) || shape.zs || (shape.opts.organic ?? 0) > 0 || str(p, 'section') !== 'round';
    if (intrudes) {
      const cavity = solidOfSurface(M, insetSurface(S, wall - 0.05), z0, H + 1, segs, Math.max(8, Math.round((rings * (H + 1 - z0)) / H) + 4), zs);
      tabSolid = tabSolid.subtract(cavity);
    }
    outer = M.Manifold.union([outer, tabSolid]).subtract(M.Manifold.compose(cuts));
    tips.push(`Rijg ${n} koorden (Ø${cord - 0.5} mm of dunner) door de lipjes; de schuine onderkant print zonder support.`);
  }
  if (mount === 'wall') {
    // backboard behind the pot, rising above the rim, with two keyholes
    let chord = 20;
    for (let k = 0; k < 720; k++) {
      const a = (TAU * k) / 720;
      for (const z of [0, H * 0.5, H]) {
        const r = rAt(S, z, a);
        if (Math.abs(r * Math.sin(a) - yBack) < 1) chord = Math.max(chord, Math.abs(r * Math.cos(a)));
      }
    }
    const ext = num(p, 'plateExtra');
    const plateW = chord * 2;
    const plateH = H + ext;
    let board = roundedRect(M, plateW, plateH, Math.min(14, ext / 2))
      .extrude(backT)
      .rotate([90, 0, 0])
      .translate([0, yBack, plateH / 2]);
    const keyZ = H + ext * 0.45;
    const kx = Math.min(plateW / 2 - 9, Math.max(12, chord * 0.5));
    const holes: Manifold[] = [];
    for (const x of [-kx, kx]) {
      // teardrop entry (screw head Ø9) + slot (shank Ø4.5) upwards
      holes.push(teardrop(M, 4.6, 32).extrude(backT + 2).rotate([90, 0, 0]).translate([x, yBack + 1, keyZ]));
      holes.push(M.Manifold.cube([4.6, backT + 2, 9]).translate([x - 2.3, yBack - backT - 1, keyZ]));
      holes.push(M.Manifold.cylinder(backT + 2, 2.3, 2.3, 20).rotate([90, 0, 0]).translate([x, yBack + 1, keyZ + 9]));
      // recess in the back face so the screw head slides behind the board
      holes.push(M.Manifold.cube([9.4, 2.6, 9]).translate([x - 4.7, yBack - 2.5, keyZ]));
      holes.push(M.Manifold.cylinder(2.6, 4.7, 4.7, 32).rotate([-90, 0, 0]).translate([x, yBack - 2.5, keyZ + 9]));
    }
    board = board.subtract(M.Manifold.union(holes));
    outer = outer.add(board);
    tips.push('Hang op aan twee schroeven (kop max. Ø9 mm) via de sleutelgaten; laat de schroefkop 3–4 mm uitsteken.');
  }
  parts.push({ name: 'Pot', solid: outer });
  scene.push({ kind: 'part', part: 0, matrix: translation(0, 0, 0) });

  // ---- self-watering inner pot
  if (water === 'self') {
    const gap = num(p, 'gap');
    const wi = num(p, 'innerWall');
    const yi = yBack - backT - gap;
    const Sgap0 = insetSurface(S, wall + gap);
    const Sgap = mount === 'wall' ? clipBack(Sgap0, yi) : Sgap0;
    // the wick column must fit inside the narrowest part of the shape (all angles, not just one)
    const rwo = Math.min(num(p, 'wickD') / 2 + wi, minRadius(Sgap, H * 0.2, H * 0.5) * 0.45, minRadiusAtAngle(Sgap, H * 0.2, H * 0.5, 0) * 0.45);
    const zTip = bottomT + 1.5;
    let hr = num(p, 'reservoir');
    let Rh = maxRadius(Sgap, hr, hr + 0.01);
    const minWick = 12;
    if (hr - (Rh - rwo) < zTip + minWick) {
      // the 45° funnel needs room: raise the inner pot until the wick column fits
      for (let i = 0; i < 60 && hr - (Rh - rwo) < zTip + minWick; i++) {
        hr = Math.max(hr + 2, zTip + minWick + Rh - rwo);
        Rh = maxRadius(Sgap, hr, hr + 0.01);
      }
      tips.push(`Reservoirhoogte ${Math.round(hr)} mm: de minimale hoogte voor een printbare 45°-trechter met wiek.`);
    }
    if (hr > H * 0.75) throw new UserError('De pot is te laag of te breed voor een zelfwaterend binnenpotje — maak hem hoger of smaller.');
    const phiH = S.phi(hr);
    const funnel: Surface = {
      phi: (z) => (z < hr ? phiH : S.phi(z)),
      r: (z, th) => (z >= hr ? Sgap.r(z, th) : Math.max(rwo, Sgap.r(hr, th) - (hr - z))),
    };
    const Sip = mount === 'wall' ? clipBack(funnel, yi) : funnel;
    const Sip2 = insetSurface(Sip, wi);
    const ringsIn = Math.round(Math.max(rings, (H - zTip) / 1.5));
    // the body reaches 0.5 mm into the flange so the two fuse; the flange rests exactly on the rim
    let inner = shellOfSurface(M, Sip, Sip2, { z0: zTip, z1: H + 0.5, floor: zTip + 1.6, segs, rings: ringsIn, zs });
    const flangeH = 2.4;
    const rimShape = mount === 'wall' ? clipBack(S, yi) : S;
    const rimOuter: Surface = { phi: () => S.phi(H), r: (_z, th) => rimShape.r(H, th) };
    const rimInner: Surface = { phi: () => S.phi(H), r: (_z, th) => Sip2.r(H, th) };
    inner = inner.add(shellOfSurface(M, rimOuter, rimInner, { z0: H, z1: H + flangeH, floor: null, segs, rings: 2 }));
    // wick column slots
    const coneBottom = hr - (Rh - rwo);
    const slotH = Math.max(4, coneBottom - zTip - 6);
    const cuts: Manifold[] = [];
    for (let i = 0; i < 6; i++) {
      cuts.push(M.Manifold.cube([rwo + 2, 2.4, slotH]).translate([0, -1.2, zTip + 3]).rotate([0, 0, (360 * i) / 6 + 30]));
    }
    // fill tube at the front (-y) from the rim down into the reservoir
    if (bool(p, 'fillTube')) {
      const a = -Math.PI / 2;
      const rf = num(p, 'fillD') / 2;
      const rfo = rf + 1.6;
      let Rt = minRadiusAtAngle(Sip2, hr + 1, H, a) - rfo - 0.4;
      // narrow tips (heart, drop, star points): move the tube inward until it fits between the walls
      while (Rt > rwo + rfo + 4 && !circleInside(Sip2, Rt * Math.cos(a), Rt * Math.sin(a), rfo + 0.4, hr + 1, H)) Rt -= 1;
      if (Rt > rwo + rfo + 4) {
        const zc = hr - (rAt(Sip, hr, a) - Rt) - 2;
        const cx = Rt * Math.cos(a);
        const cy = Rt * Math.sin(a);
        inner = inner.add(M.Manifold.cylinder(H + flangeH - zc, rfo, rfo, 40).translate([cx, cy, zc]));
        cuts.push(M.Manifold.cylinder(H + flangeH - zc + 12, rf, rf, 40).translate([cx, cy, zc - 10]));
        tips.push('Giet water in het vulbuisje; de wiek in het midden zuigt het op naar de aarde.');
      } else {
        warnings.push('Te weinig ruimte voor een vulbuisje: giet water langs de rand.');
      }
    }
    inner = inner.subtract(M.Manifold.union(cuts));
    parts.push({ name: 'Binnenpot (zelfwaterend)', solid: inner });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: translation(0, 0, 0) });
    // capacities
    // capacities are estimates: a coarse mesh is plenty
    const cs = Math.max(48, Math.round(segs / 3));
    const reservoir = solidOfSurface(M, Sin, bottomT, hr - 2, cs, 16).subtract(solidOfSurface(M, Sip, zTip, hr, cs, 32)).volume();
    const soil = solidOfSurface(M, Sip2, zTip + 1.6, H, cs, 32).volume();
    info.push({
      kind: 'kv',
      title: 'Zelfwaterend',
      rows: [
        ['Waterreservoir', `≈ ${(reservoir / 1e6).toFixed(2)} L`],
        ['Potgrond', `≈ ${(soil / 1e6).toFixed(2)} L`],
        ['Reservoirhoogte', `${Math.round(hr)} mm`],
      ],
    });
    tips.push(
      'Vul de wiekkolom met potgrond of steek er een katoenen koord door: water wordt dan vanzelf opgezogen.',
      'De binnenpot heeft een trechter van 45° naar de wiek: hij print rechtop zonder support.',
      'Waterdicht reservoir: 3+ wandlussen, 0.2 mm lagen, en eventueel "ironing" op de bodem. PETG is ideaal voor buiten.',
    );
  } else if (water === 'drain') {
    // saucer with ribs, sized to the pot footprint
    const base = outlineAt(M, S, 0);
    const gapS = 2.5;
    const sw = 2;
    const sh = 14;
    const ribH = 3;
    const saucer = base.offset(gapS + sw, 'Round').extrude(sh).subtract(base.offset(gapS, 'Round').extrude(sh).translate([0, 0, sw]));
    const ribs: Manifold[] = [];
    for (let i = 0; i < 3; i++) {
      // each rib stays under the pot along its own direction
      const rr = minRadiusAtAngle(S, 0, 0.1, (TAU * (120 * i + 90)) / 360);
      ribs.push(M.Manifold.cube([rr * 0.75, 2.4, ribH + 0.01]).translate([rr * 0.15, -1.2, sw - 0.01]).rotate([0, 0, 120 * i + 90]));
    }
    parts.push({ name: 'Schotel', solid: saucer.add(M.Manifold.union(ribs)) });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: translation(0, 0, -(sw + ribH)) });
    tips.push('De pot staat op ribbels in de schotel zodat overtollig water weg kan lopen.');
  } else {
    tips.push('Sierpot zonder gaten: zet er een kweekpotje in, of gebruik hem als opbergpot.');
  }

  if (mount === 'hang' && bool(p, 'hangerRing')) {
    const n = Math.round(num(p, 'tabs'));
    const cord = num(p, 'cordD');
    let ring = M.Manifold.cylinder(5, 22, 22, 96).subtract(M.Manifold.cylinder(7, 8, 8, 64).translate([0, 0, -1]));
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n + Math.PI / 2;
      ring = ring.subtract(M.Manifold.cylinder(7, cord / 2, cord / 2, 20).translate([15 * Math.cos(a), 15 * Math.sin(a), -1]));
    }
    parts.push({ name: 'Ophangring', solid: ring });
    scene.push({ kind: 'part', part: parts.length - 1, matrix: translation(0, 0, H + 160) });
    tips.push('De ophangring verzamelt de koorden; hang hem aan een haak door het middengat.');
  }

  notes.push(...shapeNotes(shape));
  warnings.push(...notes);
  info.push({
    kind: 'kv',
    title: 'Pot',
    rows: [
      ['Montage', mount === 'stand' ? 'Staand' : mount === 'hang' ? 'Hangend' : 'Aan de muur'],
      ['Water', water === 'self' ? 'Zelfwaterend' : water === 'drain' ? 'Afvoergaten + schotel' : 'Dichte bodem'],
      ['Grootste diameter', `${(Rmax * 2).toFixed(0)} mm`],
      ['Hoogte', `${H} mm`],
    ],
  });
  return { parts, scene, info, tips, warnings, defaultView: 'assembly' };
}

const isSelf = (p: Params) => str(p, 'water') === 'self' || (str(p, 'mount') !== 'stand' && str(p, 'water') === 'drain');

export const planterTool: ToolDef = {
  id: 'plantenpot',
  name: 'Plantenpotten',
  short: 'Potten',
  icon: 'M6 8h12l-1.5 12h-9zM5 8h14M12 8V5M12 5c-2-3-5-2-5-2s1 3 5 2zM12 5c2-3 5-2 5-2s-1 3-5 2z',
  description: 'Plantenpotten die zichzelf water geven. Kies staand, hangend of aan de muur: het ontwerp past zich automatisch aan (schotel, ophanglipjes of vlakke achterkant met sleutelgaten). Met abstracte vormen, getrapte of bolle profielen en organische vervorming.',
  params: [
    { type: 'group', label: 'Plaats & water' },
    {
      type: 'select', key: 'mount', label: 'Montage', default: 'stand',
      options: [
        { value: 'stand', label: 'Staand' },
        { value: 'hang', label: 'Hangend (koorden)' },
        { value: 'wall', label: 'Aan de muur' },
      ],
    },
    {
      type: 'select', key: 'water', label: 'Water', default: 'self',
      options: [
        { value: 'self', label: 'Zelfwaterend (reservoir + wiek)' },
        { value: 'drain', label: 'Afvoergaten + schotel' },
        { value: 'closed', label: 'Dichte bodem (sierpot)' },
      ],
    },
    { type: 'group', label: 'Vorm' },
    { type: 'number', key: 'height', label: 'Hoogte', min: 50, max: 300, step: 1, unit: 'mm', default: 140 },
    { type: 'number', key: 'topD', label: 'Diameter boven', min: 50, max: 310, step: 1, unit: 'mm', default: 150 },
    { type: 'number', key: 'bottomD', label: 'Diameter onder', min: 40, max: 310, step: 1, unit: 'mm', default: 110 },
    { type: 'number', key: 'belly', label: 'Buik', min: -30, max: 60, step: 1, unit: '%', default: 0 },
    ...shapeParams({ section: 'round', count: 12, depth: 6 }),
    { type: 'group', label: 'Wand' },
    { type: 'number', key: 'wall', label: 'Wanddikte pot', min: 1.2, max: 5, step: 0.1, unit: 'mm', default: 2.4 },
    { type: 'number', key: 'bottomT', label: 'Bodemdikte', min: 1.2, max: 6, step: 0.1, unit: 'mm', default: 2.4 },
    { type: 'group', label: 'Zelfwaterend', show: isSelf },
    { type: 'number', key: 'reservoir', label: 'Min. reservoirhoogte', min: 15, max: 150, step: 1, unit: 'mm', default: 40, show: isSelf },
    { type: 'number', key: 'wickD', label: 'Diameter wiekkolom', min: 12, max: 60, step: 1, unit: 'mm', default: 28, show: isSelf },
    { type: 'number', key: 'gap', label: 'Ruimte tussen potten', min: 0.6, max: 5, step: 0.1, unit: 'mm', default: 1.5, show: isSelf },
    { type: 'number', key: 'innerWall', label: 'Wanddikte binnenpot', min: 1.2, max: 4, step: 0.1, unit: 'mm', default: 1.8, show: isSelf },
    { type: 'bool', key: 'fillTube', label: 'Vulbuisje', default: true, show: isSelf },
    { type: 'number', key: 'fillD', label: 'Diameter vulbuisje', min: 8, max: 25, step: 1, unit: 'mm', default: 12, show: (p) => isSelf(p) && bool(p, 'fillTube') },
    { type: 'group', label: 'Ophangen', show: (p) => str(p, 'mount') === 'hang' },
    { type: 'number', key: 'tabs', label: 'Aantal lipjes', min: 3, max: 6, step: 1, default: 3, show: (p) => str(p, 'mount') === 'hang' },
    { type: 'number', key: 'cordD', label: 'Gat voor koord', min: 2, max: 8, step: 0.5, unit: 'mm', default: 4, show: (p) => str(p, 'mount') === 'hang' },
    { type: 'bool', key: 'hangerRing', label: 'Ophangring meeprinten', default: true, show: (p) => str(p, 'mount') === 'hang' },
    { type: 'group', label: 'Muur', show: (p) => str(p, 'mount') === 'wall' },
    { type: 'number', key: 'backCut', label: 'Vlakke achterkant (vanaf midden)', min: 10, max: 70, step: 1, unit: '%', default: 35, show: (p) => str(p, 'mount') === 'wall' },
    { type: 'number', key: 'plateExtra', label: 'Ophangplaat boven rand', min: 20, max: 80, step: 1, unit: 'mm', default: 35, show: (p) => str(p, 'mount') === 'wall' },
  ],
  presets: [
    { name: 'Zelfwaterende pot', values: { mount: 'stand', water: 'self', height: 140, topD: 150, bottomD: 110, belly: 0, section: 'round', twist: 0 } },
    { name: 'Geribbelde pot + schotel', values: { mount: 'stand', water: 'drain', height: 120, topD: 140, bottomD: 120, belly: 10, section: 'scallop', count: 16, depth: 6, twist: 0 } },
    { name: 'Gedraaide zeshoek', values: { mount: 'stand', water: 'self', height: 150, topD: 150, bottomD: 120, belly: 0, section: 'polygon', count: 6, rounding: 35, twist: 60 } },
    { name: 'Hangpot bloem', values: { mount: 'hang', water: 'self', height: 130, topD: 170, bottomD: 110, belly: 15, section: 'flower', count: 10, depth: 8, twist: 30 } },
    { name: 'Muurpot', values: { mount: 'wall', water: 'self', height: 140, topD: 160, bottomD: 120, belly: 0, section: 'round', twist: 0, backCut: 35 } },
    { name: 'Muurpot facetten', values: { mount: 'wall', water: 'self', height: 150, topD: 170, bottomD: 120, belly: 5, section: 'polygon', count: 8, rounding: 10, twist: 0, backCut: 25 } },
    { name: 'Vensterbankbak klein', values: { mount: 'stand', water: 'closed', height: 90, topD: 110, bottomD: 90, belly: 0, section: 'gear', count: 20, depth: 5, twist: 0 } },
    { name: 'Bloempot met blaadjes', values: { mount: 'stand', water: 'self', height: 140, topD: 170, bottomD: 120, belly: 10, section: 'petals', count: 9, depth: 22, rounding: 55, twist: 20, twistMode: 'ease' } },
    { name: 'Organische pot', values: { mount: 'stand', water: 'self', height: 150, topD: 160, bottomD: 120, belly: 25, section: 'blob', count: 4, depth: 30, seed: 21, twist: 0, organic: 12, organicScale: 50, organicSeed: 9 } },
    { name: 'Getrapte pot', values: { mount: 'stand', water: 'drain', height: 130, topD: 160, bottomD: 110, belly: 0, section: 'round', twist: 0, profile: 'terraced', profileCount: 5, profileDepth: 45 } },
    { name: 'Wolk hangpot', values: { mount: 'hang', water: 'self', height: 130, topD: 175, bottomD: 120, belly: 15, section: 'cloud', count: 6, depth: 45, seed: 4, twist: 0 } },
    { name: 'Kristal muurpot', values: { mount: 'wall', water: 'self', height: 150, topD: 165, bottomD: 120, belly: 5, section: 'polygon', count: 7, rounding: 0, twist: 0, profile: 'facet', profileCount: 4, profileDepth: 30, organicSeed: 5, backCut: 30 } },
  ],
  assets: sectionAssets,
  build,
};

