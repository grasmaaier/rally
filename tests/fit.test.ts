import { describe, expect, it } from 'vitest';
import { fitRatio, isSizeParam, scaleParams, sizeHint, sizeKeys, fitToPrinter, type Attempt } from '../src/core/fit';
import { printerById } from '../src/core/printer';
import type { BuildResult, ParamDef, Params } from '../src/core/types';

const defs: ParamDef[] = [
  { type: 'number', key: 'height', label: 'Hoogte', min: 30, max: 320, step: 1, unit: 'mm', default: 150 },
  { type: 'number', key: 'd', label: 'Diameter', min: 20, max: 320, step: 0.5, unit: 'mm', default: 100 },
  { type: 'number', key: 'wall', label: 'Wanddikte', min: 0.8, max: 6, step: 0.1, unit: 'mm', default: 2 },
  { type: 'number', key: 'screw', label: 'Schroefafstand', min: 40, max: 130, step: 1, unit: 'mm', default: 60 },
  { type: 'number', key: 'small', label: 'Hoogte rand', min: 1, max: 40, step: 1, unit: 'mm', default: 10 },
  { type: 'number', key: 'count', label: 'Aantal', min: 1, max: 12, step: 1, default: 7, scale: true },
  { type: 'number', key: 'hw', label: 'Breedte apparaat', min: 50, max: 300, step: 1, unit: 'mm', default: 200, scale: false },
  { type: 'select', key: 'shape', label: 'Vorm', default: 'a', options: [{ value: 'a', label: 'A' }] },
];
const base: Params = { height: 300, d: 250, wall: 2, screw: 60, small: 10, count: 7, hw: 200, shape: 'a' };

describe('maten schalen', () => {
  it('kiest alleen maten (mm, groot bereik), met de vlag van de tool als laatste woord', () => {
    expect(sizeKeys(defs)).toEqual(['height', 'd', 'count']);
    expect(isSizeParam(defs[2])).toBe(false);
    expect(isSizeParam(defs[7])).toBe(false);
  });

  it('schaalt alleen die maten, naar beneden afgerond op de stap en binnen het bereik', () => {
    const p = scaleParams(defs, base, 0.8);
    expect(p).toEqual({ ...base, height: 240, d: 200, count: 5 });
    const q = scaleParams(defs, base, 0.333);
    expect(q.height).toBe(99);
    expect(q.d).toBe(83);
    expect(scaleParams(defs, base, 0.05).height).toBe(30);
    expect(scaleParams(defs, base, 1)).toEqual(base);
    // a value already at the minimum is left alone
    expect(scaleParams(defs, { ...base, d: 20 }, 0.5).d).toBe(20);
    expect(scaleParams(defs, { ...base, d: 101.3 }, 0.5).d).toBe(50.5);
  });

  it('rekent uit hoeveel kleiner het moet, ook gedraaid op de plaat', () => {
    const mini = printerById('a1mini'); // 170 × 170 × 180 usable
    expect(fitRatio(mini, [[100, 100, 100]])).toBeGreaterThan(1);
    expect(fitRatio(mini, [[340, 100, 100]])).toBeCloseTo(0.5);
    expect(fitRatio(mini, [[100, 100, 360]])).toBeCloseTo(0.5);
    const x2d = printerById('x2d-dual'); // 225.5 × 246
    expect(fitRatio(x2d, [[240, 220, 10]])).toBeGreaterThan(1); // turned 90°
  });

  it('leest een maat uit de foutmelding van een tool', () => {
    const mini = printerById('a1mini');
    expect(sizeHint('De kap (180 × 85 × 110 mm) past niet op de printplaat.', mini)).toBeCloseTo(170 / 180);
    expect(sizeHint('6. Lamel (Ø200 × 8 mm) past niet op de Bambu Lab A1 mini.', mini)).toBeCloseTo(170 / 200);
    expect(sizeHint('Gaatjesmal (213,5 × 53 × 20 mm) past niet.', mini)).toBeCloseTo(170 / 213.5);
    expect(sizeHint('Maak de achterkant minstens 40 mm hoog.', mini)).toBe(0);
  });
});

/** A fake design: a box of height × d × d; it refuses (like a tool) when taller than its own limit. */
function fakeBuild(limit = Infinity) {
  let n = 0;
  const build = async (p: Params): Promise<Attempt> => {
    n++;
    const h = Number(p.height);
    const d = Number(p.d) + 2 * Number(p.wall);
    if (h > limit) return { ok: false, error: `De vaas (${d} × ${d} × ${h} mm) past niet op de printer.` };
    const result = { parts: [{ size: [d, d, h] }] } as unknown as BuildResult;
    return { ok: true, result };
  };
  return { build, count: () => n };
}

describe('passend maken', () => {
  it('laat een ontwerp dat past met rust (één build)', async () => {
    const f = fakeBuild();
    const out = await fitToPrinter(defs, { ...base, height: 150, d: 150 }, printerById('a1'), f.build);
    expect(out.factor).toBe(1);
    expect(out.fits).toBe(true);
    expect(f.count()).toBe(1);
  });

  it('verkleint tot het net past, in een paar builds', async () => {
    const f = fakeBuild();
    const mini = printerById('a1mini');
    const out = await fitToPrinter(defs, base, mini, f.build);
    expect(out.fits).toBe(true);
    expect(out.factor).toBeLessThan(1);
    expect(out.factor).toBeGreaterThan(0.6 * 0.95); // 300 high on a 180 printer: about 0.6
    expect(Number(out.params.height)).toBeLessThanOrEqual(180);
    expect(Number(out.params.height)).toBeGreaterThan(170);
    expect(out.params.wall).toBe(2);
    expect(out.params.hw).toBe(200);
    expect(f.count()).toBeLessThanOrEqual(4);
  });

  it('verkleint ook na een maatfout van de tool', async () => {
    const f = fakeBuild(200);
    const out = await fitToPrinter(defs, base, printerById('x2d'), f.build);
    expect(out.fits).toBe(true);
    expect(Number(out.params.height)).toBeLessThanOrEqual(200);
    expect(Number(out.params.height)).toBeGreaterThan(185);
    expect(f.count()).toBeLessThanOrEqual(5);
  });

  it('geeft de fout terug als zelfs de kleinste versie niet lukt', async () => {
    const out = await fitToPrinter(defs, base, printerById('a1mini'), async () => ({ ok: false, error: 'Kan niet.' }));
    expect(out.result).toBeUndefined();
    expect(out.fits).toBe(false);
    expect(out.error).toBe('Kan niet.');
    expect(out.params).toEqual(base);
  });
});
