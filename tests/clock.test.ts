import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { buildTool } from './helpers';
import { clockTool } from '../src/tools/clock';
import { MOVEMENTS } from '../src/tools/clockParts';
import { defaultsOf, type BuildResult, type Params, type PartResult } from '../src/core/types';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const params = (over: Partial<Params> = {}) => ({ ...defaultsOf(clockTool.params), ...over }) as Params;
const build = (over: Partial<Params> = {}) => buildTool(M, clockTool, params(over));
const part = (res: BuildResult, name: string) => {
  const p = res.parts.find((x) => x.name === name);
  if (!p) throw new Error(`no part ${name} in ${res.parts.map((x) => x.name).join(', ')}`);
  return p;
};
const solidOf = (p: PartResult) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices })));

function signedArea(poly: [number, number][]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Holes (clockwise contours) of a slice, smallest first, with their bounding-box size. */
function holesOf(cs: CrossSection) {
  return cs
    .toPolygons()
    .filter((poly) => signedArea(poly as [number, number][]) < 0)
    .map((poly) => {
      const xs = poly.map((v) => v[0]);
      const ys = poly.map((v) => v[1]);
      return { area: -signedArea(poly as [number, number][]), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    })
    .sort((a, b) => a.area - b.area);
}

describe('klok: modi', () => {
  it.each(['clock', 'dial', 'hands', 'wall', 'fit'])('modus %s bouwt', async (mode) => {
    const res = await build({ mode });
    expect(res.parts.length).toBeGreaterThan(0);
    for (const p of res.parts) expect(p.volume).toBeGreaterThan(0);
    if (mode !== 'fit') expect(res.scene?.length).toBeGreaterThan(0);
  });

  it('complete klok: wijzerplaat plus drie wijzers, info over as en gaten', async () => {
    const res = await build();
    expect(res.parts.map((p) => p.name)).toEqual(['Wijzerplaat', 'Uurwijzer', 'Minutenwijzer', 'Secondewijzer']);
    const rows = res.info.flatMap((b) => (b.kind === 'kv' ? b.rows : []));
    expect(rows.find(([k]) => k === 'Schroefdraad uurwerk')?.[1]).toMatch(/5,5 mm/);
    expect(rows.find(([k]) => k === 'Gat uurwijzer')?.[1]).toBe('Ø 5,5 mm');
    // hands print flat
    for (const name of ['Uurwijzer', 'Minutenwijzer']) expect(part(res, name).size[2]).toBeCloseTo(1.6, 3);
  });

  it('wijzers staan op 10:10:30 in volgorde uur–minuut–seconde voor de plaat', async () => {
    const res = await build();
    const scene = res.scene!;
    const depth = (i: number) => {
      const s = scene.find((x) => x.kind === 'part' && x.part === i)!;
      // world Y of the part's centre: the face points at -Y
      return (s as { matrix: number[] }).matrix[13];
    };
    const [dial, hour, minute, second] = [0, 1, 2, 3].map(depth);
    expect(hour).toBeLessThan(dial);
    expect(minute).toBeLessThan(hour);
    expect(second).toBeLessThan(minute);
  });
});

describe('klok: wijzergaten', () => {
  it.each(Object.entries(MOVEMENTS))('%s: gaten hebben de juiste maat', async (movement, mv) => {
    const res = await build({ mode: 'hands', movement, handStyle: 'baton' });
    const hour = holesOf(solidOf(part(res, 'Uurwijzer')).slice(0.8))[0];
    expect(hour.w).toBeCloseTo(mv.hour, 1);
    expect(hour.h).toBeCloseTo(mv.hour, 1);
    // minute hole: round with two flats (sliced below the counterbore for the cap nut)
    const minute = holesOf(solidOf(part(res, 'Minutenwijzer')).slice(0.4))[0];
    expect(minute.w).toBeCloseTo(mv.minuteFlat, 1);
    expect(minute.h).toBeCloseTo(mv.minute, 1);
    const second = holesOf(solidOf(part(res, 'Secondewijzer')).slice(0.8))[0];
    expect(Math.sqrt((4 * second.area) / Math.PI)).toBeCloseTo(mv.second, 1);
  });

  it('eigen maat en correctie veranderen de gaten', async () => {
    const res = await build({ mode: 'hands', movement: 'custom', hourHole: 6, minuteHole: 4.2, minuteFlat: 3, secondHole: 1.5, holeAdjust: 0.2, handStyle: 'lolly' });
    const hour = holesOf(solidOf(part(res, 'Uurwijzer')).slice(0.8))[0];
    expect(hour.w).toBeCloseTo(6.2, 1);
    const minute = holesOf(solidOf(part(res, 'Minutenwijzer')).slice(0.4))[0];
    expect(minute.w).toBeCloseTo(3.2, 1);
    expect(minute.h).toBeCloseTo(4.4, 1);
  });

  it('minutenwijzer is rond het asje verzonken zodat het dopmoertje past', async () => {
    const res = await build({ mode: 'hands', handT: 2, minHubT: 1.2 });
    const m = solidOf(part(res, 'Minutenwijzer'));
    const low = holesOf(m.slice(0.6))[0];
    const high = holesOf(m.slice(1.8))[0];
    expect(high.w).toBeGreaterThan(7);
    expect(low.w).toBeLessThan(4);
  });

  it('pasproef maakt strips met varianten rond de gekozen maat', async () => {
    const res = await build({ mode: 'fit', fitCount: 5, fitStep: 0.1 });
    expect(res.parts.map((p) => p.name)).toEqual(['Pasproef uurwijzer', 'Pasproef minutenwijzer', 'Pasproef secondewijzer', 'Pasproef middengat']);
    const strip = solidOf(part(res, 'Pasproef uurwijzer')).slice(0.5);
    const sizes = holesOf(strip)
      .filter((h) => h.w > 4)
      .map((h) => h.w)
      .sort((a, b) => a - b);
    expect(sizes.length).toBe(5);
    expect(sizes[0]).toBeCloseTo(5.3, 1);
    expect(sizes[4]).toBeCloseTo(5.7, 1);
    const table = res.info.find((b) => b.kind === 'table');
    expect(JSON.stringify(table)).toContain('5,5');
  });
});

describe('klok: cijfers blijven binnen de plaat', () => {
  const shapes: Partial<Params>[] = [
    { dialShape: 'circle', numSize: 16 },
    { dialShape: 'squircle', dialRounding: 30, numSize: 12, numPos: 90 },
    { dialShape: 'star', dialCount: 6, dialDepth: 40, numSize: 12 },
    { dialShape: 'heart', numSize: 11, numPos: 85 },
    { dialShape: 'petals', dialCount: 12, dialDepth: 30, numSize: 9, numPos: 85, numOrient: 'radial' },
    { dialShape: 'circle', rim: true, rimW: 14, rimH: 3, numSize: 12, numPos: 95, numerals: 'roman' },
  ];
  it.each(shapes)('%o', async (over) => {
    const res = await build({ mode: 'dial', relief: 'raised', reliefH: 1.2, dialT: 4, ...over });
    const dial = solidOf(part(res, 'Wijzerplaat'));
    // printed face up: body below z = 4, raised numerals and ticks up to 5.2, a rim (if any) higher
    const body = dial.slice(3.5);
    const rim = dial.slice(5.6);
    const decor = dial.slice(4.6).subtract(rim);
    expect(decor.area()).toBeGreaterThan(200);
    expect(decor.subtract(body.offset(-0.9, 'Round')).area()).toBeLessThan(1);
    if (!rim.isEmpty()) expect(decor.intersect(rim.offset(0.4, 'Round')).area()).toBeLessThan(1);
  });

  it('te grote cijfers worden verkleind met een waarschuwing', async () => {
    const res = await build({ mode: 'dial', numSize: 22, numPos: 90 });
    expect(res.warnings.join(' ')).toMatch(/verkleind|verschoven/);
  });

  it('gegraveerde plaat print met de voorkant op het bed', async () => {
    const res = await build({ mode: 'dial', relief: 'engraved', reliefH: 1 });
    const dial = solidOf(part(res, 'Wijzerplaat'));
    // the engraving is in the first layers
    expect(dial.slice(0.5).area()).toBeLessThan(dial.slice(2).area() * 0.98);
    expect(res.tips.join(' ')).toMatch(/voorkant op het bed/);
  });
});

describe('klok: uurwerk en as', () => {
  it('korte schroefdraad geeft advies voor een uitsparing', async () => {
    const res = await build({ mode: 'dial', dialT: 6, shaftThread: 5 });
    expect(res.warnings.join(' ')).toMatch(/Uitsparing achterkant/);
  });

  it('uitsparing maakt de plaat dunner bij de as', async () => {
    const res = await build({ mode: 'dial', dialT: 6, pocket: 'square', pocketDepth: 3 });
    const rows = res.info.flatMap((b) => (b.kind === 'kv' ? b.rows : []));
    expect(rows.find(([k]) => k === 'Dikte bij de as')?.[1]).toBe('3 mm');
  });

  it('wijzerplaat groter dan het bed geeft een melding', async () => {
    await expect(build({ mode: 'dial', diameter: 320 })).rejects.toMatchObject({ user: true });
  });

  it('zware wijzers geven een waarschuwing over het uurwerk', async () => {
    const res = await build({ mode: 'hands', diameter: 320, handW: 14, handT: 3, minLen: 100 });
    expect(res.warnings.join(' ')).toMatch(/high-torque/);
  });
});

describe('klok: losse cijfers', () => {
  it('elk cijfer is een eigen onderdeel en de tabel geeft de plek', async () => {
    const res = await build({ mode: 'wall', numerals: 'arabic', hourTicks: 'none', wallD: 700, wallNumH: 60 });
    const nums = res.parts.filter((p) => p.name.startsWith('Cijfer '));
    expect(nums.length).toBe(12);
    expect(res.parts.some((p) => p.name === 'Middenplaat')).toBe(true);
    const table = res.info.find((b) => b.kind === 'table' && b.title.startsWith('Plaats'));
    expect(table && table.kind === 'table' && table.rows.length).toBe(12);
    const twelve = table && table.kind === 'table' ? table.rows.find((r) => r[0] === '12') : undefined;
    expect(twelve?.[2]).toBe(0);
    expect(twelve?.[3]).toBe(320);
  });

  it('markeringen op de uren zonder cijfer', async () => {
    const res = await build({ mode: 'wall', numerals: 'quarters', hourTicks: 'dot' });
    const markers = res.parts.find((p) => p.name === 'Uurmarkering');
    expect(markers?.quantity).toBe(8);
  });

  it('sleutelgat haalt materiaal weg aan de achterkant', async () => {
    const tape = await build({ mode: 'wall', numerals: 'quarters', wallT: 8, wallMount: 'tape' });
    const key = await build({ mode: 'wall', numerals: 'quarters', wallT: 8, wallMount: 'keyhole' });
    expect(part(key, 'Cijfer 6').volume).toBeLessThan(part(tape, 'Cijfer 6').volume - 50);
  });

  it('te lange wijzers worden weggelaten in plaats van alles te blokkeren', async () => {
    const res = await build({ mode: 'wall', wallD: 1600, wallNumH: 100 });
    expect(res.parts.some((p) => p.name.startsWith('Cijfer'))).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/weggelaten/);
  });
});

describe('klok: eigen vormen en lettertypes', () => {
  it('geüploade SVG als wijzerplaat en als wijzer', async () => {
    const over = { dialShape: 'custom', dialFile: 'upload:test-star', handStyle: 'custom', handFile: 'upload:test-star', pivot: 20 };
    expect(clockTool.assets!(params(over))).toEqual([
      { kind: 'font', key: 'bundled:montserrat' },
      { kind: 'shape', key: 'upload:test-star' },
      { kind: 'shape', key: 'upload:test-star' },
    ]);
    const res = await build(over);
    expect(part(res, 'Wijzerplaat').size[0]).toBeGreaterThan(150);
    expect(res.parts.length).toBe(4);
    // the hand keeps its requested length from the pivot to the tip (+ 20% drawing below the pivot)
    const hands = await build({ ...over, mode: 'hands', diameter: 220 });
    const hour = part(hands, 'Uurwijzer');
    expect(hour.size[1]).toBeGreaterThan(0.55 * 110);
    expect(hour.size[1]).toBeLessThan(0.55 * 110 * 1.4);
    const holes = holesOf(solidOf(hour).slice(0.8));
    expect(holes.some((h) => Math.abs(h.w - 5.5) < 0.1)).toBe(true);
  });

  it('eigen vorm zonder bestand valt terug met een melding', async () => {
    const res = await build({ mode: 'hands', handStyle: 'custom' });
    expect(res.warnings.join(' ')).toMatch(/SVG/);
  });

  it('Google Font zonder internet geeft een nette melding', async () => {
    const over = { font: 'google', googleFont: 'Roboto Slab', googleWeight: '700' };
    expect(clockTool.assets!(params(over))).toContainEqual({ kind: 'font', key: 'google:Roboto Slab:700' });
    await expect(build(over)).rejects.toMatchObject({ user: true });
  });

  it('vraagt alleen de lettertypes en vormen die gebruikt worden', () => {
    const a = (over: Partial<Params>) => clockTool.assets!(params(over));
    expect(a({})).toEqual([{ kind: 'font', key: 'bundled:montserrat' }]);
    expect(a({ numerals: 'none' })).toEqual([]);
    expect(a({ numerals: 'none', label: 'Rally' })).toEqual([{ kind: 'font', key: 'bundled:montserrat' }]);
    expect(a({ mode: 'hands' })).toEqual([]);
    expect(a({ mode: 'wall', numerals: 'none' })).toEqual([]);
    expect(a({ mode: 'fit' })).toEqual([{ kind: 'font', key: 'bundled:montserrat' }]);
    expect(a({ font: 'bundled:cinzel' })).toEqual([{ kind: 'font', key: 'bundled:cinzel' }]);
    expect(a({ font: 'upload' })).toEqual([{ kind: 'font', key: 'bundled:montserrat' }]);
    expect(a({ font: 'upload', fontFile: 'upload:abc' })).toEqual([{ kind: 'font', key: 'upload:abc' }]);
    expect(a({ mode: 'dial', handStyle: 'custom', handFile: 'upload:x' })).toEqual([{ kind: 'font', key: 'bundled:montserrat' }]);
  });

  it('tekens die het lettertype mist worden weggelaten met een melding', async () => {
    const res = await build({ mode: 'dial', numerals: 'custom', customLabels: '★,2,3,4,5,6,7,8,9,10,11,12' });
    expect(res.warnings.join(' ')).toContain('★');
    expect(part(res, 'Wijzerplaat').volume).toBeGreaterThan(0);
  });

  it('dezelfde label meer keer is één onderdeel met een aantal', async () => {
    const res = await build({ mode: 'wall', numerals: 'custom', customLabels: '12,·,·,3,·,·,6,·,·,9,·,·', hourTicks: 'none' });
    const dot = part(res, 'Cijfer ·');
    expect(dot.quantity).toBe(8);
    expect(res.parts.filter((p) => p.name === 'Cijfer ·').length).toBe(1);
    expect(res.scene!.filter((s) => s.kind === 'part' && res.parts[s.part].name === 'Cijfer ·').length).toBe(8);
  });

  it('smallere cijfers en leesbare stand onderaan', async () => {
    const wide = await build({ mode: 'wall', numerals: 'quarters', hourTicks: 'none', wallBacking: 'none', numOrient: 'radial' });
    const narrow = await build({ mode: 'wall', numerals: 'quarters', hourTicks: 'none', wallBacking: 'none', numWidth: 60, numOrient: 'readable' });
    expect(part(narrow, 'Cijfer 12').size[0]).toBeCloseTo(part(wide, 'Cijfer 12').size[0] * 0.6, 0);
    // the 6 stands on its head when radial, upright when readable (cos of its rotation in the matrix)
    const rot = (res: BuildResult) => {
      const i = res.parts.findIndex((p) => p.name === 'Cijfer 6');
      return (res.scene!.find((s) => s.kind === 'part' && s.part === i) as { matrix: number[] }).matrix[0];
    };
    expect(rot(wide)).toBeCloseTo(-1, 5);
    expect(rot(narrow)).toBeCloseTo(1, 5);
  });

  it('eigen labels: een ander aantal begint bovenaan', async () => {
    const res = await build({ mode: 'wall', numerals: 'custom', customLabels: 'N,O,Z,W', hourTicks: 'none' });
    const table = res.info.find((b) => b.kind === 'table' && b.title.startsWith('Plaats'));
    const rows = table && table.kind === 'table' ? table.rows : [];
    expect(rows.map((r) => [r[0], r[1]])).toEqual([
      ['N', 0],
      ['O', 90],
      ['Z', 180],
      ['W', 270],
    ]);
  });
});
