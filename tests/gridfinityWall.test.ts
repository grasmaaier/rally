import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { NO_ASSETS, defaultsOf, type Params } from '../src/core/types';
import { CLEAT, GRID, cleatProfile, cleatStrip, gridfinityBin, gridfinityPlate, gridfinityTool as tool, wallFixCells, wallKeyhole, wallPlate } from '../src/tools/gridfinity';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, mode: 'wall', ...v }) as Params;

/** Volume of `solid` inside an axis-aligned box. */
function inBox(solid: Manifold, min: [number, number, number], max: [number, number, number]) {
  return solid.intersect(M.Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).translate(min)).volume();
}

describe('gridfinity aan de muur', () => {
  const sizes: [number, number][] = [[1, 1], [2, 2], [4, 3], [7, 5]];
  const fixes = ['screws', 'keyhole', 'cleat'];
  const combos = sizes.flatMap(([x, y]) => fixes.map((f) => [x, y, f] as const));

  it.each(combos)('wandplaat %i×%i (%s) bouwt, past en print zonder support', async (wallUx, wallUy, wallFix) => {
    const res = await buildTool(M, tool, params({ wallUx, wallUy, wallFix, wallMagnets: true }));
    expect(res.parts.length).toBeGreaterThan(0);
    for (const part of res.parts) {
      expect(part.volume).toBeGreaterThan(0);
      expect(fitsOn(DEFAULT_PRINTER, part.size)).toBe(true);
      expect(overhangArea(part)).toBeLessThan(20);
    }
    if (wallFix === 'cleat') {
      expect(res.parts.some((x) => x.name.startsWith('Franse lat'))).toBe(true);
      expect(res.parts.find((x) => x.name.startsWith('Franse lat'))!.quantity).toBe(2 * res.parts.filter((x) => x.name.startsWith('Wandplaat')).reduce((n, x) => n + x.quantity, 0));
    }
  });

  it('grote wandplaat wordt opgedeeld in stukken die op het bed passen', async () => {
    for (const printer of PRINTERS) {
      const res = await buildTool(M, tool, params({ wallUx: 16, wallUy: 12, wallFix: 'screws' }), printer);
      let cells = 0;
      for (const part of res.parts) {
        expect(fitsOn(printer, part.size)).toBe(true);
        const m = part.name.match(/\((\d+)×(\d+)\)/)!;
        cells += Number(m[1]) * Number(m[2]) * part.quantity;
      }
      expect(cells).toBe(16 * 12);
    }
  });

  it('schroefgaten zijn vrij, door de hele bodem', () => {
    const floor = 4;
    const plate = wallPlate(M, { cx: 3, cy: 2, floor, magnets: true, fix: 'screws', screw: 'M4', round: [true, true, true, true] });
    for (const [i, j] of wallFixCells(3, 2)) {
      const x = (i - 1) * GRID;
      const y = (j - 0.5) * GRID;
      // a 3 mm rod through the hole axis meets no material; next to it, the floor is solid
      expect(inBox(plate, [x - 1.5, y - 1.5, -1], [x + 1.5, y + 1.5, floor + 1])).toBeLessThan(1e-6);
      expect(inBox(plate, [x + 8, y - 1, 0], [x + 10, y + 1, floor - 0.5])).toBeGreaterThan(0.9 * 2 * 2 * (floor - 0.5));
    }
    // cells without a fixing keep a closed floor
    expect(inBox(plate, [-1.5, -GRID / 2 - 1.5, 0], [1.5, -GRID / 2 + 1.5, floor - 0.5])).toBeGreaterThan(0.99 * 9 * (floor - 0.5));
    collect();
  });

  it('sleutelgat: ingang en sleuf gaan door, de kop ligt onder het vak', () => {
    const floor = 6;
    const k = wallKeyhole('M4');
    const plate = wallPlate(M, { cx: 1, cy: 1, floor, magnets: false, fix: 'keyhole', screw: 'M4', round: [true, true, true, true] });
    // entry hole (head size) through, slot (shank) through, the head recess stays below the pocket floor
    expect(inBox(plate, [-k.rHead + 0.5, -k.travel - 0.5, -1], [k.rHead - 0.5, -k.travel + 0.5, floor + 1])).toBeLessThan(1e-6);
    expect(inBox(plate, [-k.rShank + 0.3, -1, -1], [k.rShank - 0.3, 0, floor + 1])).toBeLessThan(1e-6);
    // the lip behind the head: material beside the shank slot, at the back
    expect(inBox(plate, [k.rShank + 0.4, -1, 0], [k.rHead - 0.4, 0, k.lip - 0.2])).toBeGreaterThan(0);
    // and above the lip the head has room
    expect(inBox(plate, [k.rShank + 0.4, -1, k.lip + 0.2], [k.rHead - 0.4, 0, floor - 0.1])).toBeLessThan(1e-6);
    collect();
  });

  it('wandplaat heeft het standaard vakprofiel boven de bodem', () => {
    const floor = 4;
    const wall = wallPlate(M, { cx: 2, cy: 2, floor, magnets: true, fix: 'screws', screw: 'M4', round: [true, true, true, true] });
    const std = gridfinityPlate(M, { ux: 2, uy: 2, type: 'solid', pad: [0, 0, 0, 0], round: [true, true, true, true] });
    const a = inBox(wall, [-50, -50, floor], [50, 50, floor + 5]);
    const b = inBox(std, [-50, -50, 1], [50, 50, 6]);
    expect(Math.abs(a - b) / b).toBeLessThan(1e-3);
    collect();
  });

  it('Franse lat heeft een schuine kant van 45°', () => {
    const pts = cleatProfile();
    const [, , top, low] = pts;
    expect((Math.atan2(top[1] - low[1], top[0] - low[0]) * 180) / Math.PI).toBeCloseTo(45, 6);
    // the bevel rises away from the wall (x = 0), so the plate side hooks behind it
    expect(top[0]).toBeGreaterThan(low[0]);
    expect(top[1]).toBeGreaterThan(low[1]);
    // in the printed strip the bevel is a plane at exactly 45°
    const strip = cleatStrip(M, 84, [21, 63], 'M4');
    const mesh = strip.getMesh();
    const P = mesh.vertProperties;
    const I = mesh.triVerts;
    const n = mesh.numProp;
    let bevel = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * n, b = I[t + 1] * n, c = I[t + 2] * n;
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(nn[0], nn[1], nn[2]);
      if (len > 1e-9 && Math.abs(Math.abs(nn[2] / len) - Math.SQRT1_2) < 1e-4) bevel += len / 2;
    }
    expect(bevel).toBeCloseTo(84 * CLEAT.c * Math.SQRT2, 0);
    collect();
  });

  it('bak met vanglip heeft nog precies de standaard voet', () => {
    const o = { ux: 2, uy: 1, uz: 6, divX: 1, divY: 1, lip: true, scoop: 40, label: 'none', holes: 'magnets', wall: 1.2 };
    const plain = gridfinityBin(M, o);
    const caught = gridfinityBin(M, { ...o, wallLip: 8 });
    const foot = (s: Manifold) => inBox(s, [-50, -30, -1], [50, 30, 4.75]);
    expect(Math.abs(foot(caught) - foot(plain))).toBeLessThan(1e-3);
    const bp = plain.boundingBox();
    const bc = caught.boundingBox();
    for (let i = 0; i < 3; i++) {
      expect(bc.min[i]).toBeCloseTo(bp.min[i], 6);
      expect(bc.max[i]).toBeCloseTo(bp.max[i], 6);
    }
    // the lip adds material inside the front wall, near the top
    expect(caught.volume()).toBeGreaterThan(plain.volume() + 100);
    collect();
  });

  it('bak met vanglip print zonder support en past in de wandplaat', async () => {
    const res = await buildTool(M, tool, { ...base, mode: 'bin', ux: 2, uy: 1, uz: 6, wallLip: 8, holes: 'none' } as Params);
    const ref = await buildTool(M, tool, { ...base, mode: 'bin', ux: 2, uy: 1, uz: 6, wallLip: 0, holes: 'none' } as Params);
    expect(overhangArea(res.parts[0])).toBeLessThan(overhangArea(ref.parts[0]) + 5);
  });

  it('montage: de wandplaat staat rechtop tegen de muur', () => {
    const out = tool.build(params({ wallUx: 2, wallUy: 2 }), { M, printer: DEFAULT_PRINTER, assets: NO_ASSETS });
    expect(out.scene?.some((s) => s.kind === 'box' && s.label === 'Muur')).toBe(true);
    collect();
  });
});
