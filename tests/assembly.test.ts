import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { runBuild } from '../src/core/engine';
import { TOOLS } from '../src/tools';
import { defaultsOf, type Params } from '../src/core/types';
import { DEFAULT_PRINTER } from '../src/core/printer';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

/**
 * In the assembled view nothing may overlap: printed parts must not cut into
 * boards or into each other. A wrongly rotated connector shows up here.
 */
const cases = TOOLS.flatMap((t) =>
  (t.presets ?? []).map((p) => [t.id, p.name, { ...defaultsOf(t.params), ...p.values } as Params] as const),
).filter(([id]) => ['meubels', 'plantenpot', 'gridfinity'].includes(id));

describe('samengestelde weergave', () => {
  it.each(cases)('%s / %s: geen overlap', (id, _name, params) => {
    const tool = TOOLS.find((t) => t.id === id)!;
    const res = runBuild(M, tool, params, DEFAULT_PRINTER);
    if (!res.scene) return;
    const solids: { label: string; m: Manifold }[] = [];
    try {
      const base = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
      res.scene.forEach((s, i) => {
        if (s.kind === 'part') solids.push({ label: `${res.parts[s.part].name}#${i}`, m: base[s.part].transform(s.matrix as unknown as Mat4) });
        else if (s.material !== 'ghost') solids.push({ label: `${s.label ?? 'plank'}#${i}`, m: M.Manifold.cube(s.size).translate(s.position) });
      });
      const overlaps: string[] = [];
      for (let a = 0; a < solids.length; a++)
        for (let b = a + 1; b < solids.length; b++) {
          const ba = solids[a].m.boundingBox();
          const bb = solids[b].m.boundingBox();
          const apart = [0, 1, 2].some((k) => ba.max[k] < bb.min[k] - 0.01 || bb.max[k] < ba.min[k] - 0.01);
          if (apart) continue;
          const v = solids[a].m.intersect(solids[b].m).volume();
          if (v > 2) overlaps.push(`${solids[a].label} ∩ ${solids[b].label} = ${v.toFixed(1)} mm³`);
        }
      expect(overlaps).toEqual([]);
      // every printed part must touch something (it holds a board or rests on a part)
      if (id === 'meubels') {
        const boards = M.Manifold.union(solids.filter((s) => !s.label.includes('#') || !res.parts.some((p) => s.label.startsWith(p.name))).map((s) => s.m));
        for (const s of solids) {
          if (!res.parts.some((p) => s.label.startsWith(p.name))) continue;
          expect(s.m.minGap(boards, 5), `${s.label} raakt geen hout`).toBeLessThan(1);
        }
      }
    } finally {
      collect();
    }
  });
});
