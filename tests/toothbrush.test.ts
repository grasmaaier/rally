import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { DEFAULT_PRINTER, fitsOn } from '../src/core/printer';
import { NO_ASSETS, defaultsOf, type BuildResult, type Params } from '../src/core/types';
import { BRANDS, CUPS, holderLayout, mountPlan, toothbrushTool as tool } from '../src/tools/toothbrush';
import { buildTool } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;

/** Area (mm²) of downward faces steeper than 45° that are not on the bed. */
function overhangArea(res: BuildResult, part = 0) {
  const { positions: P, indices: I } = res.parts[part].mesh;
  let minZ = Infinity;
  for (let i = 2; i < P.length; i += 3) minZ = Math.min(minZ, P[i]);
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const zLow = Math.min(P[a + 2], P[b + 2], P[c + 2]);
    if (zLow < minZ + 0.3) continue;
    // steeper than 45° (plus a little tolerance for the tessellation)
    if (nz / len < -0.75) area += len / 2;
  }
  return area;
}

describe('tandenborstelhouder', () => {
  const brands = [...Object.keys(BRANDS), 'custom'];
  const types = ['ring', 'fork', 'charger'];
  const cups = [...Object.keys(CUPS), 'custom'];
  const combos = brands.flatMap((b) => types.flatMap((t) => cups.map((c) => [b, t, c] as const)));

  it.each(combos)('%s / %s / %s bouwt', async (brand, type, cup) => {
    const res = await buildTool(M, tool, params({ brand1: brand, type1: type, cup, heads: 1 }));
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0].volume).toBeGreaterThan(0);
    expect(fitsOn(DEFAULT_PRINTER, res.parts[0].size)).toBe(true);
    // printable upright without support: only tiny bits (tessellated teardrop tips, fillet steps)
    expect(overhangArea(res)).toBeLessThan(60);
  });

  it.each(['hook', 'pin'])('zuignap %s bouwt', async (mount) => {
    const res = await buildTool(M, tool, params({ mount, type1: 'fork', paste: true }));
    expect(res.parts[0].volume).toBeGreaterThan(0);
    expect(overhangArea(res)).toBeLessThan(60);
  });

  it.each(tool.presets!.map((p) => [p.name, p.values] as const))('voorbeeld %s print zonder support', async (_n, v) => {
    const res = await buildTool(M, tool, params(v));
    for (let i = 0; i < res.parts.length; i++) expect(overhangArea(res, i)).toBeLessThan(60);
  });

  it('sleutelgat: hals-sleuf smaller dan het kopgat, plaat bij de sleuf zo dik als de hals', () => {
    for (const cup of Object.keys(CUPS)) {
      const p = params({ cup });
      const L = holderLayout(p);
      const mp = L.mount;
      expect(mp.rNeck).toBeLessThan(mp.rHead - 1);
      expect(mp.rHead * 2).toBeGreaterThan(CUPS[cup].headD);
      expect(mp.rNeck * 2).toBeGreaterThan(CUPS[cup].neckD);
      expect(Math.abs(mp.thin - CUPS[cup].neckL)).toBeLessThanOrEqual(0.3);
      expect(mp.T).toBeGreaterThanOrEqual(mp.thin + CUPS[cup].headH);

      const out = tool.build(p, { M, printer: DEFAULT_PRINTER, assets: NO_ASSETS });
      const solid = out.parts[0].solid;
      // material along a line through the plate (along y) at a given x, z
      const probe = (x: number, z: number): [number, number] | null => {
        const hit: Manifold = solid.intersect(M.Manifold.cube([0.2, 40, 0.2]).translate([x - 0.1, -20, z - 0.1]));
        if (hit.isEmpty()) return null;
        const b = hit.boundingBox();
        return [b.min[1], b.max[1]];
      };
      const x = L.cupXs[0];
      // neck slot and entry hole go through the plate
      expect(probe(x, mp.zTop - 0.5)).toBeNull();
      expect(probe(x, mp.zEntry)).toBeNull();
      expect(probe(x + (mp.rNeck + mp.rHead) / 2, mp.zEntry)).toBeNull();
      // beside the neck at its final position the plate is thinned to the neck length
      const thin = probe(x + (mp.rNeck + mp.rHead) / 2, mp.zTop)!;
      expect(thin).not.toBeNull();
      expect(thin[1]).toBeCloseTo(0, 1);
      expect(thin[1] - thin[0]).toBeCloseTo(mp.thin, 1);
      // well beside the keyhole the plate has its full thickness
      const full = probe(x + mp.rHead + 3, mp.zTop)!;
      expect(full[1] - full[0]).toBeCloseTo(mp.T, 1);
      collect();
    }
  });

  it('pasproef maakt kleine onderdelen', async () => {
    const res = await buildTool(M, tool, params({ mode: 'test', count: 3, brand1: 'sonicare', brand2: 'oralb', type2: 'charger', brand3: 'oralbio', type3: 'fork' }));
    const names = res.parts.map((p) => p.name);
    expect(names.some((n) => n.includes('zuignap'))).toBe(true);
    expect(names.filter((n) => n.includes('handvat'))).toHaveLength(3);
    expect(names.filter((n) => n.includes('ophangvork'))).toHaveLength(3);
    expect(names.some((n) => n.includes('opzetborstel'))).toBe(true);
    expect(names.some((n) => n.includes('oplader'))).toBe(true);
    for (const p of res.parts) {
      expect(Math.max(...p.size)).toBeLessThan(70);
      expect(p.volume / 1000).toBeLessThan(12);
    }
    expect(res.scene).toBeUndefined();
  });

  it('3 borstels en 6 opzetborstels passen op de A2L', async () => {
    for (const type of ['ring', 'fork', 'charger']) {
      for (const headStore of ['pegs', 'holes']) {
        const p = params({ count: 3, brand1: 'oralbio', brand2: 'oralb', brand3: 'sonicare', type1: type, type2: type, type3: type, heads: 6, headStore, paste: type !== 'charger' });
        const res = await buildTool(M, tool, p);
        expect(fitsOn(DEFAULT_PRINTER, res.parts[0].size), `${type}/${headStore}: ${res.parts[0].size.join(' × ')}`).toBe(true);
        expect(holderLayout(p).cupXs.length).toBe(3);
      }
    }
  });

  it('zuignappen: automatisch 1-3 naar breedte, nooit overlappend', () => {
    for (const count of [1, 2, 3])
      for (const cups of ['auto', '1', '2', '3']) {
        const L = holderLayout(params({ count, cups }));
        if (cups !== 'auto') expect(L.cupXs.length).toBe(Number(cups));
        for (let i = 1; i < L.cupXs.length; i++) expect(L.cupXs[i] - L.cupXs[i - 1]).toBeGreaterThanOrEqual(L.mount.cup.cupD);
        for (const x of L.cupXs) expect(Math.abs(x) + L.mount.cup.cupD / 2).toBeLessThanOrEqual(L.W / 2);
      }
  });

  it('te brede hals geeft een nette foutmelding', async () => {
    await expect(buildTool(M, tool, params({ brand1: 'custom', type1: 'fork', neckW: 20, handleW: 22, handleD: 22 }))).rejects.toMatchObject({ user: true });
    expect(() => mountPlan(params({ cup: 'custom', cupHeadD: 7, cupNeckD: 6 }))).toThrow();
  });
});
