import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { build3MF, buildSTL, slug } from '../src/core/export';
import { arrange } from '../src/core/layout';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import type { PartResult } from '../src/core/types';

// a 10 mm tetrahedron
const mesh = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('3MF', () => {
  it('bevat een geldig pakket met objecten en build-items op het bed', () => {
    const data = build3MF([{ name: 'Test & co', mesh, transforms: [I, [...I.slice(0, 12), 20, 0, 0, 1]] }], DEFAULT_PRINTER, 'Titel');
    const files = unzipSync(data);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const model = strFromU8(files['3D/3dmodel.model']);
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('name="Test &amp; co"');
    expect(model.match(/<vertex /g)).toHaveLength(4);
    expect(model.match(/<triangle /g)).toHaveLength(4);
    // two copies, centred on the A2L plate (165, 160)
    expect(model).toContain('transform="1 0 0 0 1 0 0 0 1 165 160 0"');
    expect(model).toContain('transform="1 0 0 0 1 0 0 0 1 185 160 0"');
  });
});

describe('STL', () => {
  it('schrijft binaire driehoeken voor elke kopie', () => {
    const data = buildSTL([{ name: 't', mesh, transforms: [I, I] }]);
    const dv = new DataView(data.buffer);
    expect(dv.getUint32(80, true)).toBe(8);
    expect(data.length).toBe(84 + 8 * 50);
  });
});

describe('indeling op de printplaat', () => {
  const part = (size: [number, number, number], quantity: number): PartResult => ({
    name: 'p',
    mesh,
    quantity,
    size,
    volume: 1,
    area: 1,
    estimate: 'solid',
    triangles: 4,
  });

  it('verdeelt veel onderdelen over meerdere platen zonder overlap', () => {
    const placements = arrange([part([60, 60, 20], 40)], DEFAULT_PRINTER, true);
    expect(placements).toHaveLength(40);
    const plates = new Set(placements.map((p) => p.plate));
    expect(plates.size).toBeGreaterThan(1);
    for (const plate of plates) {
      const on = placements.filter((p) => p.plate === plate);
      for (const p of on) {
        expect(Math.abs(p.x) + 30).toBeLessThanOrEqual(DEFAULT_PRINTER.x / 2);
        expect(Math.abs(p.y) + 30).toBeLessThanOrEqual(DEFAULT_PRINTER.y / 2);
      }
      for (let a = 0; a < on.length; a++)
        for (let b = a + 1; b < on.length; b++) {
          const apart = Math.abs(on[a].x - on[b].x) >= 60 || Math.abs(on[a].y - on[b].y) >= 60;
          expect(apart).toBe(true);
        }
    }
  });

  it('draait een lang onderdeel als het anders niet past', () => {
    const [p] = arrange([part([100, 315, 10], 1)], PRINTERS.find((x) => x.id === 'a2l')!, true);
    expect(p.rotated).toBe(true);
  });

  it('controleert of iets op het bed past', () => {
    expect(fitsOn(DEFAULT_PRINTER, [300, 300, 300])).toBe(true);
    expect(fitsOn(DEFAULT_PRINTER, [340, 100, 10])).toBe(false);
    expect(fitsOn(DEFAULT_PRINTER, [100, 100, 330])).toBe(false);
  });
});

it('maakt nette bestandsnamen', () => {
  expect(slug('Gridfinity bak 2×1×6')).toBe('gridfinity-bak-2-1-6');
  expect(slug('Plantenpot (zelfwaterend)')).toBe('plantenpot-zelfwaterend');
});
