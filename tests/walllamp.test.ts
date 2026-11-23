import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params, type PartResult } from '../src/core/types';
import { wallLampTool as tool, wallLayout } from '../src/tools/walllamp';
import { FLUSH_BOX, SHAPES, holeLattice, holePoly, latticeWeb, outlineOf } from '../src/tools/wallLampParts';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;
const solidOf = (p: PartResult) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices })));

/** Printed parts placed in the assembled view, by name. */
function placed(res: BuildResult): Record<string, Manifold> {
  const out: Record<string, Manifold> = {};
  res.scene!.forEach((s) => {
    if (s.kind === 'part') out[res.parts[s.part].name] = solidOf(res.parts[s.part]).transform(s.matrix as unknown as Mat4);
  });
  return out;
}

/** The bulb glass as shown in the assembled view. */
function glass(res: BuildResult): Manifold {
  const g = res.scene!.find((s) => s.kind === 'mesh' && s.label === 'G9 LED');
  if (!g || g.kind !== 'mesh') throw new Error('no bulb ghost');
  return keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: g.mesh.positions, triVerts: g.mesh.indices })));
}

function overlaps(res: BuildResult) {
  const solids = Object.entries(placed(res));
  const out: string[] = [];
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++) {
      const v = solids[a][1].intersect(solids[b][1]).volume();
      if (v > 0.5) out.push(`${solids[a][0]} ∩ ${solids[b][0]} = ${v.toFixed(1)} mm³`);
    }
  return out;
}

/** Length of material along a thin rod from a to b (mm). */
function rodHits(m: Manifold, a: [number, number, number], b: [number, number, number]): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const axis = d.map((v) => v / len) as [number, number, number];
  const k = Math.abs(axis[2]) < 0.9 ? 2 : 0;
  // a 0.3 mm square rod along the axis
  const rod = M.Manifold.cube([0.3, 0.3, len], true).translate([0, 0, len / 2]);
  const up: [number, number, number] = k === 2 ? [0, 0, 1] : [1, 0, 0];
  const ex = [axis[1] * up[2] - axis[2] * up[1], axis[2] * up[0] - axis[0] * up[2], axis[0] * up[1] - axis[1] * up[0]];
  const el = Math.hypot(ex[0], ex[1], ex[2]);
  const e1 = ex.map((v) => v / el);
  const e2 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
  const mat = [e1[0], e1[1], e1[2], 0, e2[0], e2[1], e2[2], 0, axis[0], axis[1], axis[2], 0, a[0], a[1], a[2], 1];
  return m.intersect(rod.transform(mat as unknown as Mat4)).volume() / 0.09;
}

const SHAPE_KEYS = SHAPES.map((s) => s.value);
const DIRS = ['both', 'up', 'down'];
const PATTERNS = ['glad', 'plisse', 'ribbels', 'gaatjes'];
const combos = SHAPE_KEYS.flatMap((shape) => DIRS.flatMap((dir) => PATTERNS.map((pattern) => [shape, dir, pattern] as const)));

describe('wandlampen', () => {
  it.each(combos)('%s / %s / %s: geldig, past, zonder support, 10 mm van de lamp', async (shape, dir, pattern) => {
    const p = params({ shape, dir, pattern, W: 160, D: 90, H: 120, rimTop: 6, rimBottom: 6, endWindow: 20, reflector: pattern === 'gaatjes' });
    const res = await buildTool(M, tool, p);
    const names = res.parts.map((q) => q.name);
    expect(names).toEqual(expect.arrayContaining(['Kap', 'Muurplaat', 'G9-houder']));
    for (const part of res.parts) {
      expect(part.volume, part.name).toBeGreaterThan(0);
      expect(fitsOn(DEFAULT_PRINTER, part.size), `${part.name} past niet`).toBe(true);
      expect(overhangArea(part), `${part.name} overhang`).toBeLessThan(25);
      expect(part.material, part.name).toBeTruthy();
    }
    // every printed part keeps 10 mm from the glass
    const g = glass(res);
    for (const [name, s] of Object.entries(placed(res))) expect(s.minGap(g, 12), `${name} te dicht bij de lamp`).toBeGreaterThanOrEqual(9.95);
    expect(overlaps(res)).toEqual([]);
  });

  it('doorschijnende dunne wand: materiaal en wanddikte', async () => {
    const res = await buildTool(M, tool, params({ translucent: true, wall: 3, pattern: 'plisse' }));
    const kap = res.parts.find((q) => q.name === 'Kap')!;
    expect(kap.material).toBe('petg-translucent');
    expect(res.warnings.some((w) => w.includes('1,6 mm'))).toBe(true);
    expect(overhangArea(kap)).toBeLessThan(25);
    const opaque = await buildTool(M, tool, params({ translucent: false }));
    expect(opaque.parts.find((q) => q.name === 'Kap')!.material).toBe('petg-hf');
  });

  it.each(tool.presets!.map((pr) => [pr.name, pr.values] as const))('voorbeeld %s: bouwt, geen botsingen, 10 mm afstand', async (_n, v) => {
    const res = await buildTool(M, tool, params(v));
    for (const part of res.parts) expect(overhangArea(part), part.name).toBeLessThan(25);
    expect(overlaps(res)).toEqual([]);
    const g = glass(res);
    for (const [name, s] of Object.entries(placed(res))) expect(s.minGap(g, 12), name).toBeGreaterThanOrEqual(9.95);
  });

  it('te grote rand wordt kleiner gemaakt zodat hij 10 mm van de lamp blijft', async () => {
    const res = await buildTool(M, tool, params({ dir: 'up', bulbPos: 'staand', rimTop: 40 }));
    expect(res.warnings.some((w) => w.includes('Rand bovenaan verkleind'))).toBe(true);
    const g = glass(res);
    expect(placed(res).Kap.minGap(g, 12)).toBeGreaterThanOrEqual(9.95);
  });

  it('te ondiep, te laag of te groot geeft een leesbare melding', async () => {
    await expect(buildTool(M, tool, params({ D: 55, plateT: 26, bulbD: 22 }))).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, params({ dir: 'up', bulbPos: 'staand', H: 90 }))).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, params({ W: 250, H: 240 }), PRINTERS.find((x) => x.id === 'a1mini'))).rejects.toMatchObject({ user: true });
    // automatic: a low lamp lays the bulb down instead
    const res = await buildTool(M, tool, params({ dir: 'up', bulbPos: 'auto', H: 90 }));
    expect(res.warnings.some((w) => w.includes('liggend'))).toBe(true);
  });

  it('muurplaat wordt smaller als hij niet in de kap past', async () => {
    const res = await buildTool(M, tool, params({ shape: 'pil', W: 120, D: 80, plateW: 140 }));
    expect(res.warnings.some((w) => w.includes('Muurplaat smaller'))).toBe(true);
    expect(overlaps(res)).toEqual([]);
  });

  it.each(['both', 'up', 'down'])('%s: kap haakt achter de muurplaat en de borgschroeven lijnen uit', async (dir) => {
    const p = params({ dir });
    const res = await buildTool(M, tool, p);
    const s = placed(res);
    const L = wallLayout(p, M, DEFAULT_PRINTER);
    // the plate lies flat against the wall (y = 0), the lamp in front of it (−y)
    expect(s.Muurplaat.boundingBox().max[1]).toBeCloseTo(0, 1);
    expect(s.Kap.boundingBox().max[1]).toBeCloseTo(0, 1);
    // pulled away from the wall, sideways or towards the lock screws the housing hits the plate
    const hit = (dx: number, dy: number, dz: number) => s.Kap.translate([dx, dy, dz]).intersect(s.Muurplaat).volume();
    expect(hit(0, -1, 0), 'lippen achter de plaat').toBeGreaterThan(5);
    expect(hit(1, 0, 0), 'rib rechts').toBeGreaterThan(5);
    expect(hit(-1, 0, 0), 'rib links').toBeGreaterThan(5);
    const towardsPillars = dir === 'down' ? -1 : 1;
    expect(hit(0, 0, towardsPillars), 'steunen').toBeGreaterThan(5);
    // the other way it slides off (that is how it comes off for a new bulb)
    expect(hit(0, 0, -towardsPillars * 3)).toBeLessThan(0.5);
    // lock screws: a line through the hole in the pillar runs into the pilot hole of the plate
    const zEnd = dir === 'down' ? L.H : 0;
    const zIn = dir === 'down' ? L.H - L.plate.z0 - 9 : L.plate.z0 + 9;
    for (const sx of [-1, 1]) {
      // frame (x, y) → world: up/both turn half round (−x, −y), down flips (x, −y)
      const wx = dir === 'down' ? sx * L.lockX : -sx * L.lockX;
      const wy = -L.lockY;
      expect(rodHits(s.Kap, [wx, wy, dir === 'down' ? L.H + 1 : -1], [wx, wy, dir === 'down' ? L.H - L.plate.z0 + 0.5 : L.plate.z0 - 0.5]), 'gat in de kap').toBeLessThan(0.3);
      expect(rodHits(s.Muurplaat, [wx, wy, zEnd], [wx, wy, zIn]), 'voorgeboord gat in de plaat').toBeLessThan(0.3);
      expect(rodHits(s.Muurplaat, [wx + 3, wy, zEnd], [wx + 3, wy, zIn]), 'plaat naast het gat').toBeGreaterThan(5);
    }
  });

  it.each(['h', 'v', 'beide'])('schroefgaten inbouwdoos (%s): 60 mm uit elkaar, vrij en verzonken', async (boxScrews) => {
    const p = params({ boxScrews });
    const L = wallLayout(p, M, DEFAULT_PRINTER);
    const pairs = boxScrews === 'beide' ? 2 : 1;
    expect(L.boxHoles.length).toBe(2 * pairs);
    for (let i = 0; i < L.boxHoles.length; i += 2) {
      const [a, b] = [L.boxHoles[i], L.boxHoles[i + 1]];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(FLUSH_BOX.spacing, 6);
      // centred on the box
      expect((a[0] + b[0]) / 2).toBeCloseTo(0, 6);
      expect((a[1] + b[1]) / 2).toBeCloseTo(L.plate.zb, 6);
    }
    const res = await buildTool(M, tool, p);
    const plate = solidOf(res.parts.find((q) => q.name === 'Muurplaat')!);
    // print coordinates: front on the bed, centred; the box centre is the plate centre
    const T = L.plate.T;
    for (const [x, z] of L.boxHoles) {
      const y = z - L.plate.zb;
      expect(rodHits(plate, [x, y, -1], [x, y, T + 1]), 'schroefgat vrij').toBeLessThan(0.3);
      expect(rodHits(plate, [x + 3.2, y, -1], [x + 3.2, y, 0.4]), 'verzinking').toBeLessThan(0.3);
      expect(rodHits(plate, [x + 3.2, y, 3], [x + 3.2, y, T]), 'boss om de schroef').toBeGreaterThan(5);
    }
    // the plate covers the drilled hole of the box (Ø68) with margin
    expect(Math.min(L.plate.W, L.plate.H)).toBeGreaterThanOrEqual(FLUSH_BOX.holeD + 12);
  });

  it.each(['both', 'up'])('%s: kabelweg van de inbouwdoos naar de fitting', async (dir) => {
    const p = params({ dir, bulbPos: dir === 'up' ? 'staand' : 'liggend' });
    const L = wallLayout(p, M, DEFAULT_PRINTER);
    const res = await buildTool(M, tool, p);
    const plate = solidOf(res.parts.find((q) => q.name === 'Muurplaat')!);
    const [lx, lz] = L.bulb.lead;
    const y = lz - L.plate.zb;
    // straight through the plate: from the wall side (the box) through the front
    expect(rodHits(plate, [lx, y, -1], [lx, y, L.plate.T + 1])).toBeLessThan(0.3);
    // the cavity behind the front is open over the box (the Wago connectors go there)
    expect(rodHits(plate, [0, -10, 3.5], [0, -10, L.plate.T + 1])).toBeLessThan(0.3);
    expect(L.plate.T - 3).toBeGreaterThanOrEqual(8.4 + 2);
    // vertical bracket: its base has the same hole in line with the plate's
    if (L.bulb.orient === 'vertical') {
      const s = placed(res);
      const wx = -lx;
      expect(rodHits(s['G9-houder'], [wx, -L.plate.T + 0.5, lz], [wx, -L.plate.T - 6, lz])).toBeLessThan(0.3);
    }
    expect(res.info.some((b) => b.title === 'Benodigdheden' && b.kind === 'table' && b.rows.some((r) => String(r[1]).includes('Wago 221')))).toBe(true);
  });

  it('gaatjes: bruggen zijn minstens zo breed als gevraagd', () => {
    for (const shape of ['ruit', 'druppel'])
      for (const size of [4, 8, 14, 20])
        for (const web of [1.2, 2.5, 5]) {
          const lat = holeLattice(shape, size, web);
          expect(latticeWeb(holePoly(shape, size), lat.ps, lat.pz)).toBeGreaterThanOrEqual(web - 1e-6);
          // and not much wider than needed
          expect(latticeWeb(holePoly(shape, size), lat.ps, lat.pz)).toBeLessThan(web + 0.6);
        }
  });

  it('gaatjes: de kap heeft gaten, de achterkant blijft dicht', async () => {
    const p = params({ pattern: 'gaatjes', holeSize: 9, holeWeb: 3 });
    const res = await buildTool(M, tool, p);
    const holes = res.info.find((b) => b.title === 'Gaatjes');
    expect(holes).toBeTruthy();
    const count = Number((holes as { rows: [string, string][] }).rows[0][1]);
    expect(count).toBeGreaterThan(30);
    const glad = await buildTool(M, tool, params({ pattern: 'glad' }));
    const kap = res.parts.find((q) => q.name === 'Kap')!;
    expect(kap.volume).toBeLessThan(glad.parts.find((q) => q.name === 'Kap')!.volume * 0.95);
    // the attachment region (back corners, ribs, lips) is the same with or without holes
    const L = wallLayout(p, M, DEFAULT_PRINTER);
    const back = M.Manifold.cube([L.W + 10, L.yb + 4, L.H + 2]).translate([-L.W / 2 - 5, 0, -1]);
    const a = solidOf(kap).translate([0, 0, 0]);
    const b = solidOf(glad.parts.find((q) => q.name === 'Kap')!);
    // parts are centred on the bed: compare in frame terms through the volume of the back band
    const bbA = a.boundingBox();
    const bbB = b.boundingBox();
    const toFrame = (m: Manifold, bb: { min: number[]; max: number[] }) => m.translate([-(bb.min[0] + bb.max[0]) / 2, -bb.min[1], -bb.min[2]]);
    expect(toFrame(a, bbA).intersect(back).volume()).toBeCloseTo(toFrame(b, bbB).intersect(back).volume(), 0);
  });

  it('plissé laat de achterkant glad en houdt de wand overal even dik', async () => {
    const res = await buildTool(M, tool, params({ pattern: 'plisse', depth: 3, pitch: 8 }));
    const kap = res.parts.find((q) => q.name === 'Kap')!;
    expect(kap.size[0]).toBeGreaterThan(150);
    expect(overhangArea(kap)).toBeLessThan(25);
  });

  it('vormen: vlakke achterkant op de muur, binnen de opgegeven maat', () => {
    for (const shape of SHAPE_KEYS)
      for (const [W, D] of [
        [150, 80],
        [100, 90],
        [240, 60],
      ]) {
        const o = outlineOf({ shape, W, D, corner: 12, waves: 5, waveDepth: 15 });
        const ys = o.loop.map((q) => q[1]);
        const xs = o.loop.map((q) => q[0]);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-6);
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(W + 0.01);
        expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(D, o.D) + 0.01);
        // flat back: the loop starts with the back edge on y = 0
        expect(o.loop[0][1]).toBeCloseTo(0, 6);
        expect(o.xb).toBeGreaterThan(W * 0.25);
        // a simple polygon (no self-intersections): Clipper keeps the area
        const cs = keep(new M.CrossSection([o.loop], 'EvenOdd'));
        const pos = keep(new M.CrossSection([o.loop], 'Positive'));
        expect(cs.area()).toBeCloseTo(pos.area(), 3);
      }
  });

  it('past op elke printer of geeft een melding', async () => {
    for (const printer of PRINTERS) {
      try {
        const res = await buildTool(M, tool, params({ W: 200, H: 180 }), printer);
        for (const part of res.parts) expect(fitsOn(printer, part.size), `${printer.id} ${part.name}`).toBe(true);
      } catch (err) {
        expect((err as { user?: boolean }).user, printer.id).toBe(true);
      }
    }
  });
});
