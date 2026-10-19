import type { Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { BuildOutput, Params, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { usable } from '../core/printer';
import { asMat4, deg, mul, rotZ, roundedRectStack, translation } from '../geom/helpers';
import { keep } from '../core/registry';

// Gridfinity standard (Zack Freedman), dimensions as used by gridfinity-rebuilt.
export const GRID = 42;
export const UNIT_H = 7;
const BIN_CLEAR = 0.5;
const R_BIN = 3.75;
const R_PLATE = 4;
const FOOT_H = 4.75;
const LIP_H = 4.4;
const PLATE_PROFILE_H = 4.65;
const MAGNET_D = 6.5;
const MAGNET_H = 2.4;
const HOLE_OFFSET = 13;

function rr(inset: number, r0: number) {
  return Math.max(0.3, r0 - inset);
}

/** Solid foot for one grid cell, centred on the origin, z = 0..FOOT_H. */
function foot(M: ManifoldToplevel): Manifold {
  const s = GRID - BIN_CLEAR;
  return roundedRectStack(M, s, s, [
    { z: 0, inset: 2.95, r: rr(2.95, R_BIN) },
    { z: 0.8, inset: 2.15, r: rr(2.15, R_BIN) },
    { z: 2.6, inset: 2.15, r: rr(2.15, R_BIN) },
    { z: FOOT_H, inset: 0, r: R_BIN },
  ]);
}

/** Rectangle outline with an individual radius per corner (ccw from +x+y). */
function cornerRect(M: ManifoldToplevel, x0: number, y0: number, x1: number, y1: number, radii: [number, number, number, number]) {
  const pts: Vec2[] = [];
  const corners: [number, number, number, number][] = [
    [x1, y1, 0, radii[0]],
    [x0, y1, 90, radii[1]],
    [x0, y0, 180, radii[2]],
    [x1, y0, 270, radii[3]],
  ];
  for (const [x, y, a0, r] of corners) {
    if (r <= 0.01) {
      pts.push([x, y]);
      continue;
    }
    const cx = x - Math.sign(Math.cos(deg(a0 + 45))) * r;
    const cy = y - Math.sign(Math.sin(deg(a0 + 45))) * r;
    for (let i = 0; i <= 8; i++) {
      const a = deg(a0 + (90 * i) / 8);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return keep(new M.CrossSection([pts]));
}

export interface BinOptions {
  ux: number;
  uy: number;
  uz: number;
  divX: number;
  divY: number;
  lip: boolean;
  scoop: number;
  label: string;
  holes: string;
  wall: number;
}

export function gridfinityBin(M: ManifoldToplevel, o: BinOptions): Manifold {
  const W = o.ux * GRID - BIN_CLEAR;
  const D = o.uy * GRID - BIN_CLEAR;
  const zb = o.uz * UNIT_H;
  const wall = o.wall;
  const screws = o.holes === 'screws' || o.holes === 'both';
  const magnets = o.holes === 'magnets' || o.holes === 'both';
  const floor = screws ? 6.8 : 5.8;
  const lipTop = zb + LIP_H - 0.6;
  const top = o.lip ? lipTop : zb;

  const body = roundedRectStack(M, W, D, [
    { z: FOOT_H - 0.01, inset: 0, r: R_BIN },
    { z: top, inset: 0, r: R_BIN },
  ]);
  const f = foot(M);
  // holes for one foot, built once (magnet and screw holes overlap, so union them)
  const footHoles: Manifold[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const at: [number, number, number] = [sx * HOLE_OFFSET, sy * HOLE_OFFSET, -0.01];
      const h: Manifold[] = [];
      if (magnets) h.push(M.Manifold.cylinder(MAGNET_H + 0.01, MAGNET_D / 2, MAGNET_D / 2, 32).translate(at));
      if (screws) h.push(M.Manifold.cylinder(6.01, 1.5, 1.5, 20).translate(at));
      if (h.length) footHoles.push(h.length === 1 ? h[0] : M.Manifold.union(h));
    }
  const holeSet = footHoles.length ? M.Manifold.compose(footHoles) : null;
  const feet: Manifold[] = [];
  const holes: Manifold[] = [];
  for (let i = 0; i < o.ux; i++)
    for (let j = 0; j < o.uy; j++) {
      const at: [number, number, number] = [(i - (o.ux - 1) / 2) * GRID, (j - (o.uy - 1) / 2) * GRID, 0];
      feet.push(f.translate(at));
      if (holeSet) holes.push(holeSet.translate(at));
    }
  // feet (0.5 mm apart), holes and pockets never touch each other: compose instead of union
  let solid = body.add(M.Manifold.compose(feet));

  // interior: compartments, optional scoop and label shelf
  const supportZ = zb - (2.6 - wall);
  const pocketTop = o.lip ? supportZ + 0.01 : zb + 1;
  const Wi = W - 2 * wall;
  const Di = D - 2 * wall;
  const dt = 1.2;
  const cw = (Wi - (o.divX - 1) * dt) / o.divX;
  const cd = (Di - (o.divY - 1) * dt) / o.divY;
  if (cw < 5 || cd < 5) throw new UserError('Te veel vakken voor deze bakmaat');
  const rc = Math.max(0.5, Math.min(R_BIN - wall, cw / 2 - 0.01, cd / 2 - 0.01));
  const ph = pocketTop - floor;
  const scoopR = Math.min(cd * 0.5, ph * 0.9) * (o.scoop / 100);
  const labelDepth = Math.min(12, cd * 0.4);
  // YZ-plane profiles are extruded along X: local x→y, y→z, z→x
  const yzToWorld = asMat4([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const pockets: Manifold[] = [];
  for (let i = 0; i < o.divX; i++)
    for (let j = 0; j < o.divY; j++) {
      const x = -Wi / 2 + cw / 2 + i * (cw + dt);
      const y = -Di / 2 + cd / 2 + j * (cd + dt);
      let pocket = roundedRectStack(M, cw, cd, [
        { z: floor, inset: 0, r: rc },
        { z: pocketTop, inset: 0, r: rc },
      ]).translate([x, y, 0]);
      if (scoopR > 0.5) {
        const y0 = y - cd / 2 - 0.01;
        const prof = M.CrossSection.square([scoopR + 0.01, scoopR + 0.01])
          .translate([y0, floor - 0.01])
          .subtract(M.CrossSection.circle(scoopR, 48).translate([y0 + scoopR, floor + scoopR]));
        const fill = prof.extrude(cw + 2).transform(yzToWorld).translate([x - cw / 2 - 1, 0, 0]);
        pocket = pocket.subtract(fill);
      }
      if (o.label !== 'none' && j === o.divY - 1) {
        const yb = y + cd / 2 + 0.01;
        const tw = o.label === 'full' ? cw : Math.min(cw, Math.max(15, cw * 0.4));
        const tx = o.label === 'left' ? x - cw / 2 + tw / 2 : x;
        const tri = keep(new M.CrossSection([[[yb, pocketTop + 0.01], [yb - labelDepth, pocketTop + 0.01], [yb - labelDepth, pocketTop - 0.8], [yb, pocketTop - labelDepth]]]));
        const tab = tri.extrude(tw + (o.label === 'full' ? 2 : 0)).transform(yzToWorld).translate([tx - tw / 2 - (o.label === 'full' ? 1 : 0), 0, 0]);
        pocket = pocket.subtract(tab);
      }
      pockets.push(pocket);
    }
  solid = solid.subtract(M.Manifold.compose([...pockets, ...holes]));
  if (o.lip) {
    solid = solid.subtract(
      roundedRectStack(M, W, D, [
        { z: supportZ, inset: wall, r: rr(wall, R_BIN) },
        { z: zb, inset: 2.6, r: rr(2.6, R_BIN) },
        { z: zb + 1.9, inset: 0.7, r: rr(0.7, R_BIN) },
        { z: zb + 3.7, inset: 0.7, r: rr(0.7, R_BIN) },
        { z: lipTop + 0.5, inset: 0.1, r: rr(0.1, R_BIN) },
      ]),
    );
  }
  return solid;
}

export interface PlateOptions {
  ux: number;
  uy: number;
  type: string;
  /** Extra solid border per side: [left, right, front, back]. */
  pad: [number, number, number, number];
  /** Round the four outer corners (false for inner edges of split pieces). */
  round: [boolean, boolean, boolean, boolean];
}

export function plateHeight(type: string) {
  return PLATE_PROFILE_H + (type === 'magnet' ? 3 : type === 'solid' ? 1 : 0);
}

export function gridfinityPlate(M: ManifoldToplevel, o: PlateOptions): Manifold {
  const [pl, pr, pf, pb] = o.pad;
  const gw = o.ux * GRID;
  const gd = o.uy * GRID;
  const floor = o.type === 'magnet' ? 3 : o.type === 'solid' ? 1 : 0;
  const H = floor + PLATE_PROFILE_H;
  // radii ccw from back-right: [+x+y, -x+y, -x-y, +x-y]
  const radii: [number, number, number, number] = [
    o.round[1] && o.round[3] ? R_PLATE : 0,
    o.round[0] && o.round[3] ? R_PLATE : 0,
    o.round[0] && o.round[2] ? R_PLATE : 0,
    o.round[1] && o.round[2] ? R_PLATE : 0,
  ];
  const outline = cornerRect(M, -gw / 2 - pl, -gd / 2 - pf, gw / 2 + pr, gd / 2 + pb, radii);
  let plate = outline.extrude(H);
  const s = GRID;
  const cutter = roundedRectStack(M, s, s, [
    ...(floor === 0 ? [{ z: -1, inset: 2.85, r: rr(2.85, R_PLATE) }] : []),
    { z: floor, inset: 2.85, r: rr(2.85, R_PLATE) },
    { z: floor + 0.7, inset: 2.15, r: rr(2.15, R_PLATE) },
    { z: floor + 2.5, inset: 2.15, r: rr(2.15, R_PLATE) },
    { z: H, inset: 0.05, r: rr(0.05, R_PLATE) },
    { z: H + 1, inset: 0.05, r: rr(0.05, R_PLATE) },
  ]);
  let cell = cutter;
  if (o.type === 'magnet') {
    const magnets: Manifold[] = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        magnets.push(M.Manifold.cylinder(MAGNET_H + 0.02, MAGNET_D / 2, MAGNET_D / 2, 32).translate([sx * HOLE_OFFSET, sy * HOLE_OFFSET, floor - MAGNET_H]));
    cell = M.Manifold.union([cutter, ...magnets]);
  }
  // neighbouring cell cutters stay 0.1 mm apart, so they can be composed without a boolean
  const cuts: Manifold[] = [];
  for (let i = 0; i < o.ux; i++)
    for (let j = 0; j < o.uy; j++) cuts.push(cell.translate([(i - (o.ux - 1) / 2) * GRID, (j - (o.uy - 1) / 2) * GRID, 0]));
  plate = plate.subtract(M.Manifold.compose(cuts));
  return plate;
}

/** Split `n` cells into groups whose width (incl. edge padding) fits `max`. */
export function splitAxis(n: number, padA: number, padB: number, max: number): number[] {
  for (let groups = 1; groups <= n; groups++) {
    const base = Math.floor(n / groups);
    const extra = n % groups;
    const sizes = Array.from({ length: groups }, (_, i) => base + (i < extra ? 1 : 0));
    const widths = sizes.map((c, i) => c * GRID + (i === 0 ? padA : 0) + (i === groups - 1 ? padB : 0));
    if (widths.every((w) => w <= max)) return sizes;
  }
  return Array.from({ length: n }, () => 1);
}

function drawerPlan(p: Params, printer: PrinterProfile) {
  const W = num(p, 'drawerW');
  const D = num(p, 'drawerD');
  const tol = 1;
  const ux = Math.floor((W - tol) / GRID);
  const uy = Math.floor((D - tol) / GRID);
  if (ux < 1 || uy < 1) throw new UserError('De lade is kleiner dan één Gridfinity-vak (42 mm)');
  const padX = W - tol - ux * GRID;
  const padY = D - tol - uy * GRID;
  const align = str(p, 'align');
  const [pl, pr] = align === 'center' ? [padX / 2, padX / 2] : [0, padX];
  const [pf, pb] = align === 'center' ? [padY / 2, padY / 2] : [0, padY];
  const u = usable(printer);
  // the longest side of a piece may go along the longest side of the plate
  const maxA = Math.max(u.x, u.y);
  const maxB = Math.min(u.x, u.y);
  let gx = splitAxis(ux, pl, pr, maxA);
  let gy = splitAxis(uy, pf, pb, maxB);
  const alt = [splitAxis(ux, pl, pr, maxB), splitAxis(uy, pf, pb, maxA)];
  if (alt[0].length * alt[1].length < gx.length * gy.length) [gx, gy] = alt;
  return { W, D, ux, uy, pl, pr, pf, pb, gx, gy };
}

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const mode = str(p, 'mode');
  const tips: string[] = [];
  const info: BuildOutput['info'] = [];
  const warnings: string[] = [];

  if (mode === 'bin') {
    const o: BinOptions = {
      ux: num(p, 'ux'),
      uy: num(p, 'uy'),
      uz: num(p, 'uz'),
      divX: num(p, 'divX'),
      divY: num(p, 'divY'),
      lip: bool(p, 'lip'),
      scoop: num(p, 'scoop'),
      label: str(p, 'label'),
      holes: str(p, 'holes'),
      wall: num(p, 'wall'),
    };
    const solid = gridfinityBin(M, o);
    const W = o.ux * GRID - BIN_CLEAR;
    const D = o.uy * GRID - BIN_CLEAR;
    info.push({
      kind: 'kv',
      title: 'Bak',
      rows: [
        ['Raster', `${o.ux} × ${o.uy} × ${o.uz}U`],
        ['Buitenmaat', `${W.toFixed(1)} × ${D.toFixed(1)} × ${(o.uz * UNIT_H + (o.lip ? LIP_H - 0.6 : 0)).toFixed(1)} mm`],
        ['Vakken', `${o.divX * o.divY} (${o.divX} × ${o.divY})`],
      ],
    });
    tips.push('Print zonder support, 0.2 mm laagdikte. 2–3 wandlussen en 10–15% infill is genoeg.');
    if (o.holes !== 'none') tips.push('Magneetgaten zijn voor 6 × 2 mm magneten — druk ze na het printen in (eventueel met een druppel lijm).');
    return { parts: [{ name: `Gridfinity bak ${o.ux}x${o.uy}x${o.uz}`, solid }], info, tips, warnings };
  }

  const type = str(p, 'plateType');
  if (mode === 'baseplate') {
    const ux = num(p, 'ux');
    const uy = num(p, 'uy');
    const solid = gridfinityPlate(M, { ux, uy, type, pad: [0, 0, 0, 0], round: [true, true, true, true] });
    info.push({ kind: 'kv', title: 'Basisplaat', rows: [['Raster', `${ux} × ${uy}`], ['Maat', `${ux * GRID} × ${uy * GRID} × ${plateHeight(type).toFixed(2)} mm`]] });
    tips.push('Basisplaten printen snel: 2 wandlussen, 15% infill. Voor ladekasten werkt "Ladeplanner" handiger: die vult de hele lade.');
    return { parts: [{ name: `Gridfinity basisplaat ${ux}x${uy}`, solid }], info, tips, warnings };
  }

  // drawer planner
  const plan = drawerPlan(p, printer);
  const { gx, gy, pl, pr, pf, pb } = plan;
  const parts: BuildOutput['parts'] = [];
  const scene: SceneItem[] = [];
  const keyToPart = new Map<string, number>();
  const layoutRows: (string | number)[][] = [];
  // left/front edge of the grid, with the drawer centred on the origin
  const x0 = -(plan.ux * GRID) / 2 + (pl - pr) / 2;
  const y0 = -(plan.uy * GRID) / 2 + (pf - pb) / 2;
  let cellY = 0;
  gy.forEach((cy, j) => {
    let cellX = 0;
    gx.forEach((cx, i) => {
      const pad: [number, number, number, number] = [i === 0 ? pl : 0, i === gx.length - 1 ? pr : 0, j === 0 ? pf : 0, j === gy.length - 1 ? pb : 0];
      const round: [boolean, boolean, boolean, boolean] = [i === 0, i === gx.length - 1, j === 0, j === gy.length - 1];
      const keyOf = (pd: number[], rd: boolean[]) => `${cx}x${cy}|${pd.map((v) => v.toFixed(2)).join(',')}|${rd.join(',')}`;
      const key = keyOf(pad, round);
      // a piece turned 180° is the same print: reuse it
      const turnedKey = keyOf([pad[1], pad[0], pad[3], pad[2]], [round[1], round[0], round[3], round[2]]);
      let idx = keyToPart.get(key);
      let turned = false;
      if (idx === undefined && keyToPart.has(turnedKey)) {
        idx = keyToPart.get(turnedKey)!;
        turned = true;
      }
      if (idx === undefined) {
        idx = parts.length;
        keyToPart.set(key, idx);
        parts.push({ name: `Basisplaat ${String.fromCharCode(65 + idx)} (${cx}×${cy})`, solid: gridfinityPlate(M, { ux: cx, uy: cy, type, pad, round }), quantity: 0 });
      }
      parts[idx].quantity = (parts[idx].quantity ?? 0) + 1;
      // position of this piece's grid centre in the drawer
      const px = x0 + (cellX + cx / 2) * GRID;
      const py = y0 + (cellY + cy / 2) * GRID;
      scene.push({ kind: 'part', part: idx, matrix: turned ? mul(translation(px, py, 0), rotZ(180)) : translation(px, py, 0) });
      layoutRows.push([`${String.fromCharCode(65 + idx)}`, `rij ${j + 1}, kolom ${i + 1}`, `${cx} × ${cy}`]);
      cellX += cx;
    });
    cellY += cy;
  });
  const H = plateHeight(type);
  const dh = num(p, 'drawerH');
  const maxU = Math.floor((dh - H - LIP_H) / UNIT_H);
  scene.push({ kind: 'box', size: [plan.W, plan.D, dh], position: [-plan.W / 2, -plan.D / 2, 0], color: '#8aa0b8', material: 'ghost', label: 'Lade' });
  info.push({
    kind: 'kv',
    title: 'Ladeplan',
    rows: [
      ['Lade (binnenmaat)', `${plan.W} × ${plan.D} × ${dh} mm`],
      ['Raster', `${plan.ux} × ${plan.uy} vakken (${plan.ux * GRID} × ${plan.uy * GRID} mm)`],
      ['Opvulrand', `links ${pl.toFixed(1)} · rechts ${pr.toFixed(1)} · voor ${pf.toFixed(1)} · achter ${pb.toFixed(1)} mm`],
      ['Stukken', `${gx.length * gy.length} (${gx.length} × ${gy.length}) — passend op ${printer.name}`],
      ['Max. bakhoogte', maxU >= 2 ? `${maxU}U (${maxU * UNIT_H} mm) met stapelrand` : 'lade te ondiep voor bakken met stapelrand'],
    ],
  });
  info.push({ kind: 'table', title: 'Indeling', headers: ['Stuk', 'Plek', 'Vakken'], rows: layoutRows });
  tips.push('Leg de stukken naast elkaar in de lade; de opvulrand zorgt dat alles klemvast ligt.');
  tips.push('Met "Exporteer alles" krijg je elk stuk in de juiste aantallen, verdeeld over de printplaten.');
  return { parts, scene, info, tips, warnings, defaultView: 'assembly' };
}

const units = (key: string, label: string, def: number, max: number, show?: (p: Params) => boolean) =>
  ({ type: 'number', key, label, min: 1, max, step: 1, default: def, show }) as const;

const isBin = (p: Params) => str(p, 'mode') === 'bin';
const isDrawer = (p: Params) => str(p, 'mode') === 'drawer';

export const gridfinityTool: ToolDef = {
  id: 'gridfinity',
  name: 'Gridfinity',
  short: 'Gridfinity',
  icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  description: 'Gridfinity-bakken met vakken, schep en labelrand, basisplaten en een ladeplanner die je lade vult en opdeelt in stukken die op je printbed passen.',
  params: [
    { type: 'group', label: 'Wat maak je?' },
    {
      type: 'select', key: 'mode', label: 'Onderdeel', default: 'bin',
      options: [
        { value: 'bin', label: 'Bak' },
        { value: 'baseplate', label: 'Basisplaat' },
        { value: 'drawer', label: 'Ladeplanner (hele lade)' },
      ],
    },
    { type: 'group', label: 'Afmeting', show: (p) => !isDrawer(p) },
    units('ux', 'Breedte (vakken)', 2, 7, (p) => !isDrawer(p)),
    units('uy', 'Diepte (vakken)', 1, 7, (p) => !isDrawer(p)),
    { type: 'number', key: 'uz', label: 'Hoogte (× 7 mm)', min: 2, max: 40, step: 1, default: 6, show: isBin },
    { type: 'group', label: 'Indeling', show: isBin },
    { type: 'number', key: 'divX', label: 'Vakken in breedte', min: 1, max: 10, step: 1, default: 2, show: isBin },
    { type: 'number', key: 'divY', label: 'Vakken in diepte', min: 1, max: 10, step: 1, default: 1, show: isBin },
    { type: 'number', key: 'scoop', label: 'Schep (afgeronde voorkant)', min: 0, max: 100, step: 5, unit: '%', default: 60, show: isBin },
    {
      type: 'select', key: 'label', label: 'Labelrand', default: 'full', show: isBin,
      options: [
        { value: 'none', label: 'Geen' },
        { value: 'full', label: 'Volledige breedte' },
        { value: 'left', label: 'Links' },
        { value: 'center', label: 'Midden' },
      ],
    },
    { type: 'group', label: 'Details', show: isBin },
    { type: 'bool', key: 'lip', label: 'Stapelrand', default: true, show: isBin },
    {
      type: 'select', key: 'holes', label: 'Gaten in de voet', default: 'none', show: isBin,
      options: [
        { value: 'none', label: 'Geen' },
        { value: 'magnets', label: 'Magneten (6×2 mm)' },
        { value: 'screws', label: 'Schroeven (M3)' },
        { value: 'both', label: 'Magneten + schroeven' },
      ],
    },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 0.8, max: 2.4, step: 0.05, unit: 'mm', default: 1.2, show: isBin },
    { type: 'group', label: 'Lade', show: isDrawer },
    { type: 'number', key: 'drawerW', label: 'Binnenbreedte lade', min: 43, max: 2000, step: 1, unit: 'mm', default: 455, show: isDrawer },
    { type: 'number', key: 'drawerD', label: 'Binnendiepte lade', min: 43, max: 2000, step: 1, unit: 'mm', default: 470, show: isDrawer },
    { type: 'number', key: 'drawerH', label: 'Binnenhoogte lade', min: 10, max: 600, step: 1, unit: 'mm', default: 70, show: isDrawer },
    {
      type: 'select', key: 'align', label: 'Uitlijning raster', default: 'center', show: isDrawer,
      options: [
        { value: 'center', label: 'Midden (rand rondom)' },
        { value: 'corner', label: 'Linksvoor (rand rechts/achter)' },
      ],
    },
    { type: 'group', label: 'Basisplaat', show: (p) => !isBin(p) },
    {
      type: 'select', key: 'plateType', label: 'Type plaat', default: 'light', show: (p) => !isBin(p),
      options: [
        { value: 'light', label: 'Licht (open onderkant)' },
        { value: 'solid', label: 'Dichte bodem' },
        { value: 'magnet', label: 'Met magneetgaten' },
      ],
    },
  ],
  presets: [
    { name: 'Bak 2×1 met 2 vakken', values: { mode: 'bin', ux: 2, uy: 1, uz: 6, divX: 2, divY: 1, scoop: 60, label: 'full', lip: true } },
    { name: 'Schroevenbak 3×2, 6 vakken', values: { mode: 'bin', ux: 3, uy: 2, uz: 3, divX: 3, divY: 2, scoop: 80, label: 'full', lip: true } },
    { name: 'Gereedschapsbak 4×1 hoog', values: { mode: 'bin', ux: 4, uy: 1, uz: 8, divX: 1, divY: 1, scoop: 0, label: 'left', lip: true } },
    { name: 'Magneetbak 1×1', values: { mode: 'bin', ux: 1, uy: 1, uz: 4, divX: 1, divY: 1, scoop: 50, label: 'none', holes: 'magnets', lip: true } },
    { name: 'Basisplaat 7×7 (vol bed)', values: { mode: 'baseplate', ux: 7, uy: 7, plateType: 'light' } },
    { name: 'Lade IKEA Alex', values: { mode: 'drawer', drawerW: 300, drawerD: 520, drawerH: 75, align: 'center', plateType: 'light' } },
    { name: 'Keukenla 60 cm', values: { mode: 'drawer', drawerW: 505, drawerD: 470, drawerH: 80, align: 'center', plateType: 'light' } },
  ],
  build,
};

export { cornerRect };
