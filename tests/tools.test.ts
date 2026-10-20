import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { buildTool } from './helpers';
import { TOOLS } from '../src/tools';
import { defaultsOf } from '../src/core/types';
import { DEFAULT_PRINTER } from '../src/core/printer';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

describe.each(TOOLS.map((t) => [t.id, t] as const))('%s', (_id, tool) => {
  const cases: [string, Record<string, unknown>][] = [['standaard', {}], ...(tool.presets ?? []).map((p) => [p.name, p.values] as [string, Record<string, unknown>])];
  it.each(cases)('bouwt geldige geometrie: %s', async (_name, values) => {
    const params = { ...defaultsOf(tool.params), ...values } as Record<string, string | number | boolean>;
    const res = await buildTool(M, tool, params, DEFAULT_PRINTER);
    if (process.env.REPORT) {
      console.log(`${tool.id} / ${_name}: ${res.ms} ms`, res.parts.map((p) => `${p.name} x${p.quantity} [${p.size.map((v) => v.toFixed(1)).join('×')}] ${(p.volume / 1000).toFixed(1)}cm³ ${p.triangles}tri`).join(' | '), res.warnings.join(' / '));
    }
    expect(res.parts.length).toBeGreaterThan(0);
    for (const p of res.parts) {
      expect(p.triangles).toBeGreaterThan(0);
      expect(p.volume).toBeGreaterThan(0);
      expect(p.mesh.indices.length % 3).toBe(0);
      for (const v of p.mesh.positions) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
