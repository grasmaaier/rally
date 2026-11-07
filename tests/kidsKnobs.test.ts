import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { buildTool, overhangArea } from './helpers';
import { handlesTool } from '../src/tools/handles';
import { KID_SHAPES, KID_USES } from '../src/tools/kidsKnobs';
import { defaultsOf, type Params, type PartResult } from '../src/core/types';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

/** Faces steeper than 46° from vertical count as overhang (as in abstract.test.ts). */
const STEEP = -Math.sin((46 * Math.PI) / 180);
// only the small ceilings of the screw hole / nut pocket may bridge (M4 nut: about 46 mm²)
const MAX_BRIDGE = 60;

const kids = (over: Partial<Params>) => ({ ...defaultsOf(handlesTool.params), type: 'kids', ...over }) as Params;
const set = (over: Partial<Params>) => ({ ...defaultsOf(handlesTool.params), type: 'set', ...over }) as Params;
const solidOf = (part: PartResult) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices })));
const pieces = (part: PartResult) => solidOf(part).decompose().length;
/** A blind screw hole keeps the knob one closed body (genus 0): otherwise the hole breaks out somewhere. */
const closed = (part: PartResult) => pieces(part) === 1 && solidOf(part).genus() === 0;

/** The extra count a shape has, at its smallest and largest. */
const COUNTS: Record<string, [string, number, number]> = {
  rings: ['kidRings', 3, 6],
  petals: ['kidPetals', 5, 8],
  bands: ['kidBands', 3, 5],
  dots: ['kidDots', 0, 9],
};

describe('speelse knoppen: elke vorm × elke bevestiging', () => {
  const cases = KID_SHAPES.flatMap((s) => ['tap', 'nut', 'insert'].map((mount) => [s.value, mount] as [string, string]));
  it.each(cases)('%s / %s', async (kidShape, mount) => {
    const res = await buildTool(M, handlesTool, kids({ kidShape, mount }));
    expect(res.parts).toHaveLength(1);
    const part = res.parts[0];
    expect(part.material).toBe('pla-matte');
    expect(part.volume).toBeGreaterThan(2000);
    expect(closed(part)).toBe(true);
    expect(overhangArea(part, STEEP)).toBeLessThan(MAX_BRIDGE);
    expect(res.warnings).toEqual([]);
    expect(res.ms).toBeLessThan(3000);
  });
});

describe('speelse knoppen: uitersten zonder support', () => {
  const cases: [string, Partial<Params>][] = [];
  for (const { value } of KID_SHAPES) {
    const use = KID_USES[value];
    const counts: Partial<Params>[] = use ? [{ [COUNTS[use][0]]: COUNTS[use][1] }, { [COUNTS[use][0]]: COUNTS[use][2] }] : [{}];
    for (const kidD of [20, 60])
      for (const kidTall of [70, 140])
        for (const c of counts) cases.push([`${value} Ø${kidD} mm, hoogte ${kidTall} ${JSON.stringify(c)}`, { kidShape: value, kidD, kidTall, ...c }]);
  }
  it.each(cases)('%s', async (_name, over) => {
    const res = await buildTool(M, handlesTool, kids({ mount: 'nut', ...over }));
    const part = res.parts[0];
    expect(part.volume).toBeGreaterThan(300);
    expect(pieces(part)).toBe(1);
    // a nut that does not fit is allowed only with a warning
    if (!closed(part)) expect(res.warnings.length).toBeGreaterThan(0);
    expect(overhangArea(part, STEEP)).toBeLessThan(MAX_BRIDGE);
  });

  it.each(KID_SHAPES.map((s) => s.value))('%s: smalste knop met een M5-moer of -inzetmoer', async (kidShape) => {
    for (const mount of ['nut', 'insert']) {
      const res = await buildTool(M, handlesTool, kids({ kidShape, kidD: 20, kidTall: 70, screw: 'M5', mount }));
      expect(pieces(res.parts[0]), mount).toBe(1);
      if (!closed(res.parts[0])) expect(res.warnings.length, mount).toBeGreaterThan(0);
      expect(overhangArea(res.parts[0], STEEP), mount).toBeLessThan(90);
    }
  });
});

describe('speelse knoppen: kleurwissels', () => {
  it('donut: tabel met kleurwissels en de tip voor de laagschuif', async () => {
    const res = await buildTool(M, handlesTool, kids({ kidShape: 'donut' }));
    const block = res.info.find((b) => b.title === 'Kleurwissels (optioneel)');
    expect(block?.kind).toBe('kv');
    if (block?.kind !== 'kv') return;
    expect(block.rows[0][0]).toBe('Begin');
    expect(block.rows.length).toBeGreaterThan(1);
    expect(res.tips.some((t) => t.includes('laagschuif'))).toBe(true);
  });

  it('bal: één kleur, dus geen tabel', async () => {
    const res = await buildTool(M, handlesTool, kids({ kidShape: 'bal' }));
    expect(res.info.some((b) => b.title === 'Kleurwissels (optioneel)')).toBe(false);
  });
});

describe('set: verschillende knoppen tegelijk', () => {
  it('standaardset: een onderdeel per knop met eigen kleur en aantal', async () => {
    const res = await buildTool(M, handlesTool, set({}));
    expect(res.parts.map((p) => p.name)).toEqual(['1 · Donut', '2 · Bellenbloem', '3 · Berenkop', '4 · Stapeltoren']);
    expect(res.parts.map((p) => p.color)).toEqual(['#e8afcf', '#a3d8e1', '#f7d959', '#c2e189']);
    expect(res.parts.every((p) => p.quantity === 2 && p.material === 'pla-matte')).toBe(true);
    expect(res.defaultView).toBe('plate');
    for (const part of res.parts) {
      expect(closed(part)).toBe(true);
      expect(overhangArea(part, STEEP)).toBeLessThan(MAX_BRIDGE);
    }
    const table = res.info.find((b) => b.title === 'Set');
    expect(table?.kind === 'table' && table.rows.map((r) => r[1])).toEqual(['Sakura-roze', 'IJsblauw', 'Citroengeel', 'Appelgroen']);
  });

  it('kastdeur: elke knop zit met zijn deurkant tegen de voorkant van de deur, naast elkaar', async () => {
    const res = await buildTool(
      M,
      handlesTool,
      // the beehive prints front-down; the pillow knobs may print on their top
      set({ setCount: 6, set1Shape: 'korf', set2Shape: 'regenboog', set3Shape: 'star', set4Shape: 'heart', set5Shape: 'cloud', set6Shape: 'bloom' }),
    );
    const door = res.scene!.find((s) => s.kind === 'box');
    expect(door?.kind === 'box' && door.label).toBe('Kastdeur');
    if (door?.kind !== 'box') return;
    const knobs = res.scene!.flatMap((s) => (s.kind === 'part' ? [solidOf(res.parts[s.part]).transform(s.matrix as unknown as Mat4).boundingBox()] : []));
    expect(knobs).toHaveLength(6);
    let right = -Infinity;
    for (const b of knobs) {
      // touches the door front (y = 0) and sticks out towards the viewer
      expect(b.max[1]).toBeCloseTo(0, 1);
      expect(b.min[1]).toBeLessThan(-10);
      expect(b.min[0]).toBeGreaterThan(door.position[0]);
      expect(b.max[0]).toBeLessThan(door.position[0] + door.size[0]);
      expect(b.min[2]).toBeGreaterThan(door.position[2]);
      expect(b.max[2]).toBeLessThan(door.position[2] + door.size[2]);
      expect(b.min[0]).toBeGreaterThan(right);
      right = b.max[0];
    }
  });

  it('kussenknoppen in de set printen zonder support', async () => {
    const res = await buildTool(M, handlesTool, set({ setCount: 4, set1Shape: 'star', set2Shape: 'heart', set3Shape: 'cloud', set4Shape: 'bloom' }));
    expect(res.parts.map((p) => p.name)).toEqual(['1 · Ster', '2 · Hart', '3 · Wolk', '4 · Bloem']);
    for (const part of res.parts) {
      expect(part.volume).toBeGreaterThan(1000);
      expect(closed(part)).toBe(true);
      expect(overhangArea(part, STEEP)).toBeLessThan(90);
    }
  });

  it.each([2, 6])('%d verschillende knoppen', async (setCount) => {
    const res = await buildTool(M, handlesTool, set({ setCount }));
    expect(res.parts).toHaveLength(setCount);
    expect(res.scene!.filter((s) => s.kind === 'part')).toHaveLength(setCount);
  });

  it('dezelfde vorm twee keer: unieke namen, zodat elk zijn eigen filament houdt', async () => {
    const res = await buildTool(M, handlesTool, set({ setCount: 2, set1Shape: 'donut', set2Shape: 'donut', set2Color: '#ae96d4', set2Qty: 5 }));
    expect(res.parts.map((p) => p.name)).toEqual(['1 · Donut', '2 · Donut']);
    expect(res.parts.map((p) => [p.color, p.quantity])).toEqual([['#e8afcf', 2], ['#ae96d4', 5]]);
  });
});
