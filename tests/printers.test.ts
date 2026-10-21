import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { strFromU8, unzipSync } from 'fflate';
import { initManifold } from '../src/core/manifold';
import { DEFAULT_PRINTER, PRINTERS, fitsOn, plateCenter, printerById, usable } from '../src/core/printer';
import { arrange } from '../src/core/layout';
import { build3MF } from '../src/core/export';
import { defaultsOf, type PartResult } from '../src/core/types';
import { gridfinityTool } from '../src/tools/gridfinity';
import { buildTool } from './helpers';

const byId = (id: string) => PRINTERS.find((p) => p.id === id)!;

describe('printerlijst', () => {
  it('unieke ids, positieve bouwvolumes en AMS-gegevens', () => {
    expect(new Set(PRINTERS.map((p) => p.id)).size).toBe(PRINTERS.length);
    expect(new Set(PRINTERS.map((p) => p.name)).size).toBe(PRINTERS.length);
    for (const p of PRINTERS) {
      for (const v of [p.x, p.y, p.z]) {
        expect(v).toBeGreaterThan(100);
        expect(v).toBeLessThan(400);
      }
      expect(p.name).toMatch(/^Bambu Lab /);
      if (p.ams) {
        expect(p.ams.units.length).toBeGreaterThan(0);
        expect(p.ams.maxSlots).toBeGreaterThanOrEqual(p.ams.typicalSlots);
      }
      const [cx, cy] = plateCenter(p);
      expect(cx).toBeGreaterThan(0);
      expect(cy).toBeGreaterThan(0);
    }
  });

  it('A2L blijft de standaard', () => {
    expect(DEFAULT_PRINTER.id).toBe('a2l');
    expect([DEFAULT_PRINTER.x, DEFAULT_PRINTER.y, DEFAULT_PRINTER.z]).toEqual([330, 320, 325]);
    expect(printerById('bestaat-niet')).toBe(DEFAULT_PRINTER);
    expect(printerById(null)).toBe(DEFAULT_PRINTER);
  });

  it('bevat de huidige Bambu Lab-reeks met de officiële maten', () => {
    const vol = (id: string) => {
      const p = byId(id);
      return [p.x, p.y, p.z];
    };
    expect(vol('a1mini')).toEqual([180, 180, 180]);
    expect(vol('a1')).toEqual([256, 256, 256]);
    expect(vol('p1s')).toEqual([256, 256, 256]);
    expect(vol('p2s')).toEqual([256, 256, 256]);
    expect(vol('x1c')).toEqual([256, 256, 256]);
    expect(vol('h2d')).toEqual([325, 320, 325]);
    expect(vol('h2d-dual')).toEqual([300, 320, 325]);
    expect(vol('h2s')).toEqual([340, 320, 340]);
    expect(vol('x2d')).toEqual([256, 256, 260]);
    expect(vol('x2d-dual')).toEqual([235.5, 256, 256]);
  });

  it('twee nozzles: kleiner of gelijk aan één nozzle', () => {
    for (const p of PRINTERS.filter((q) => q.nozzles === 2)) {
      const single = byId(p.id.replace(/-dual$/, ''));
      expect(single.nozzles).toBe(1);
      expect(p.x).toBeLessThanOrEqual(single.x);
      expect(p.z).toBeLessThanOrEqual(single.z);
    }
  });

  it('gesloten printers voor ABS/ASA: A-serie is open', () => {
    expect(byId('a2l').enclosed).toBe(false);
    expect(byId('a1').enclosed).toBe(false);
    expect(byId('p1s').enclosed).toBe(true);
    expect(byId('h2s').enclosed).toBe(true);
  });
});

describe('de gekozen printer wordt overal gebruikt', () => {
  const part = (size: [number, number, number]): PartResult => ({
    name: 'p',
    mesh: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) },
    quantity: 1,
    size,
    volume: 1,
    area: 1,
    estimate: 'solid',
    triangles: 1,
  });

  it('fitsOn kijkt naar het bed van de gekozen printer', () => {
    expect(fitsOn(byId('a2l'), [300, 300, 300])).toBe(true);
    expect(fitsOn(byId('a1'), [300, 300, 300])).toBe(false);
    expect(fitsOn(byId('a1mini'), [170, 170, 170])).toBe(true);
    expect(fitsOn(byId('a1mini'), [175, 100, 100])).toBe(false);
    // H2S is the tallest
    expect(fitsOn(byId('h2s'), [100, 100, 335])).toBe(true);
    expect(fitsOn(byId('h2d'), [100, 100, 335])).toBe(false);
    // the dual-nozzle area is narrower
    expect(fitsOn(byId('h2d'), [310, 100, 100])).toBe(true);
    expect(fitsOn(byId('h2d-dual'), [310, 310, 100])).toBe(false);
  });

  it('plaatindeling volgt het bed: een A1 mini heeft meer platen nodig', () => {
    const parts = [{ ...part([80, 80, 10]), quantity: 12 }];
    const plates = (id: string) => new Set(arrange(parts, byId(id), true).map((p) => p.plate)).size;
    expect(plates('a1mini')).toBeGreaterThan(plates('a2l'));
    for (const pl of arrange(parts, byId('a1mini'), true)) {
      expect(Math.abs(pl.x) + 40).toBeLessThanOrEqual(usable(byId('a1mini')).x / 2 + 0.01);
    }
  });

  it('3MF centreert op het bereik van beide nozzles van de H2D', () => {
    const mesh = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2]) };
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const model = (id: string) => strFromU8(unzipSync(build3MF([{ name: 'x', mesh, transforms: [I] }], byId(id), 't'))['3D/3dmodel.model']);
    expect(model('h2d-dual')).toContain('transform="1 0 0 0 1 0 0 0 1 175 160 0"');
    expect(model('h2d')).toContain('transform="1 0 0 0 1 0 0 0 1 162.5 160 0"');
    expect(model('a1mini')).toContain('transform="1 0 0 0 1 0 0 0 1 90 90 0"');
  });

  it('gereedschappen gebruiken ctx.printer, niet DEFAULT_PRINTER', () => {
    const dir = fileURLToPath(new URL('../src/tools', import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      // allowed: the import and a default for helpers called from tests; builds pass ctx.printer
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/printer: PrinterProfile = DEFAULT_PRINTER/g, '');
      expect(src, f).not.toMatch(/DEFAULT_PRINTER/);
    }
  });

  describe('met de rekenkern', () => {
    let M: ManifoldToplevel;
    beforeAll(async () => {
      M = await initManifold();
    });

    it('ladeplanner deelt de basisplaat op naar het gekozen bed', async () => {
      const p = { ...defaultsOf(gridfinityTool.params), mode: 'drawer', drawerW: 505, drawerD: 470, plateType: 'light' };
      const pieces = async (id: string) => (await buildTool(M, gridfinityTool, p, byId(id))).parts.reduce((s, q) => s + q.quantity, 0);
      const big = await pieces('h2s');
      const mini = await pieces('a1mini');
      expect(mini).toBeGreaterThan(big);
      const res = await buildTool(M, gridfinityTool, p, byId('a1mini'));
      for (const q of res.parts) expect(fitsOn(byId('a1mini'), q.size), q.name).toBe(true);
    });
  });
});
