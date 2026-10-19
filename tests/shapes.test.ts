import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { CUSTOM_SHAPE_OPTION, SHAPE_OPTIONS, radialShape, shapeCross, type ShapeSpec } from '../src/geom/shapes2d';
import { textCross, sizeForHeight } from '../src/geom/text';
import { BUNDLED_FONTS } from '../src/core/fonts';
import { testAssets } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
  await testAssets.ensure(BUNDLED_FONTS.map((f) => ({ kind: 'font' as const, key: `bundled:${f.id}` })));
});

const spec = (shape: string, over: Partial<ShapeSpec> = {}): ShapeSpec => ({
  shape, count: 5, depth: 0.4, rounding: 0.4, seed: 7, m: 6, n1: 1, n2: 1.7, n3: 1.7, ...over,
});

describe('2D-vormen', () => {
  const variants: [string, Partial<ShapeSpec>][] = [];
  for (const o of SHAPE_OPTIONS) {
    variants.push([o.value, {}]);
    variants.push([o.value, { count: 3, depth: 0.9, rounding: 0 }]);
    variants.push([o.value, { count: 12, depth: 0, rounding: 1, seed: 501, m: 17, n1: 0.3, n2: 9, n3: 0.4 }]);
  }
  it.each(variants)('%s %j: geldige straal en contour', (shape, over) => {
    const s = spec(shape, over);
    const r = radialShape(s);
    let max = 0;
    for (let i = 0; i < 720; i++) {
      const v = r((Math.PI * 2 * i) / 720);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0.099);
      max = Math.max(max, v);
    }
    expect(max).toBeGreaterThan(0.95);
    expect(max).toBeLessThanOrEqual(1.0001);
    const cs = shapeCross(M, s, 40);
    expect(cs.area()).toBeGreaterThan(30);
    const solid = cs.extrude(3);
    expect(solid.status()).toBe('NoError');
    expect(solid.volume()).toBeGreaterThan(90);
    collect();
  });

  it('eigen SVG-vorm behoudt gaten', () => {
    const s = spec(CUSTOM_SHAPE_OPTION.value, { file: 'upload:test-star' });
    const cs = shapeCross(M, s, 100, testAssets);
    const filled = shapeCross(M, { ...s }, 100, testAssets).hull();
    expect(cs.area()).toBeGreaterThan(500);
    expect(cs.area()).toBeLessThan(filled.area());
    expect(cs.numContour()).toBeGreaterThanOrEqual(2);
    expect(radialShape(s, testAssets)(Math.PI / 2)).toBeCloseTo(1, 2);
    collect();
  });
});

describe('tekst', () => {
  it.each(BUNDLED_FONTS.map((f) => [f.id]))('%s: cijfers worden een geldige vorm', (id) => {
    const font = testAssets.font(`bundled:${id}`);
    const size = sizeForHeight(font, 12);
    const cs = textCross(M, font, '0123456789 XII', size);
    const b = cs.bounds();
    expect(b.max[1] - b.min[1]).toBeGreaterThan(10);
    expect(b.max[1] - b.min[1]).toBeLessThan(20);
    expect(cs.area()).toBeGreaterThan(50);
    // the counter of an "8" stays open
    const eight = textCross(M, font, '8', size);
    expect(eight.numContour()).toBeGreaterThanOrEqual(2);
    const solid = cs.extrude(1.2);
    expect(solid.status()).toBe('NoError');
    collect();
  });
});
