import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { LEG_PROFILES, LEG_SECTIONS, buildLeg, type LegSpec } from '../src/geom/legs';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = (over: Partial<LegSpec> = {}): LegSpec => ({
  height: 120, diameter: 40, profile: 'taper', foot: 0.6, ball: 1.35, waist: 0.6,
  section: { shape: 'circle', count: 6, depth: 0.25, rounding: 0.5, seed: 7, m: 6, n1: 1, n2: 1.7, n3: 1.7 },
  twist: 0, splay: 0, lean: 0, plate: 'round', plateT: 5, holes: 4, core: 'auto', bottom: 'felt', ...over,
});

describe('poten', () => {
  const cases: [string, string][] = [];
  for (const p of LEG_PROFILES) for (const s of LEG_SECTIONS) cases.push([p.value, s]);
  it.each(cases)('%s / %s', (profile, shape) => {
    const t0 = performance.now();
    const leg = buildLeg(M, base({ profile, section: { ...base().section, shape }, twist: shape === 'circle' ? 0 : 60 }));
    const ms = performance.now() - t0;
    expect(leg.solid.status()).toBe('NoError');
    expect(leg.solid.volume()).toBeGreaterThan(1000);
    const b = leg.solid.boundingBox();
    expect(b.min[2]).toBeCloseTo(0, 3);
    expect(b.max[2]).toBeCloseTo(120, 1);
    if (process.env.REPORT) console.log(profile, shape, Math.round(ms), 'ms', leg.solid.numTri(), leg.plateLabel, leg.warnings);
    collect();
  });
});
