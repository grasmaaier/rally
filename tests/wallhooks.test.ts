import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { NO_ASSETS, defaultsOf, type Params } from '../src/core/types';
import { collect } from '../src/core/registry';
import { handlesTool as tool } from '../src/tools/handles';
import { HOOK_STYLES, mountSpec } from '../src/tools/wallhooks';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, type: 'wallhook', ...v }) as Params;

const STYLES = HOOK_STYLES.map((s) => s.value).filter((s) => s !== 'knob');
const MOUNTS = ['screws', 'keyhole', 'adhesive', 'suction', 'insert'];
const combos = STYLES.flatMap((s) => MOUNTS.filter((m) => !(s === 'peg' && m === 'suction')).map((m) => [s, m] as const));

describe('wandhaken', () => {
  it.each(combos)('%s / %s bouwt, past en print zonder support', async (whStyle, whMount) => {
    const res = await buildTool(M, tool, params({ whStyle, whMount, whCap: whMount === 'screws' }));
    expect(res.parts[0].volume).toBeGreaterThan(0);
    for (const part of res.parts) {
      expect(fitsOn(DEFAULT_PRINTER, part.size)).toBe(true);
      // only tessellation crumbs of teardrop tips and fillet steps
      expect(overhangArea(part)).toBeLessThan(25);
    }
    expect(res.info.some((b) => b.title === 'Belasting')).toBe(true);
  });

  it.each(['soft', 'classic'])('uitstraling %s, ronde randen', async (whLook) => {
    for (const whStyle of ['single', 'double', 'ball', 'j']) {
      const res = await buildTool(M, tool, params({ whStyle, whLook, whEdge: 9, whWidth: 22 }));
      expect(overhangArea(res.parts[0])).toBeLessThan(25);
    }
  });

  it('pin kan niet aan een zuignap (leesbare melding)', async () => {
    await expect(buildTool(M, tool, params({ whStyle: 'peg', whMount: 'suction' }))).rejects.toMatchObject({ user: true });
  });

  it('knop als haak bouwt met de knopvormen', async () => {
    for (const style of ['mushroom', 'pebble', 'bloom', 'cross']) {
      const res = await buildTool(M, tool, params({ whStyle: 'knob', style, mount: 'insert' }));
      expect(res.parts[0].volume).toBeGreaterThan(0);
      expect(res.info.some((b) => b.title === 'Belasting')).toBe(true);
    }
  });

  it('presets voor wandhaken printen zonder support', async () => {
    for (const pr of tool.presets!.filter((x) => x.values.type === 'wallhook')) {
      const res = await buildTool(M, tool, params(pr.values));
      for (const part of res.parts) expect(overhangArea(part)).toBeLessThan(25);
    }
  });

  /** Does a line along x (through the plate thickness) at use (y, z) hit material? Returns the solid length. */
  function probeX(solid: ReturnType<typeof tool.build>['parts'][number]['solid'], y: number, z: number, x0: number, x1: number) {
    const rod = M.Manifold.cube([x1 - x0, 0.2, 0.2]).translate([x0, y - 0.1, z - 0.1]);
    return solid.intersect(rod).volume() / 0.04;
  }

  it.each(['screws', 'insert', 'keyhole'])('bevestiging %s: gat zit waar het hoort', (whMount) => {
    const p = params({ whStyle: 'single', whMount, whScrewN: 2 });
    const out = tool.build(p, { M, printer: DEFAULT_PRINTER, assets: NO_ASSETS });
    const solid = out.parts[0].solid;
    const T = mountSpec(p).T;
    const b = solid.boundingBox();
    const zc = (b.min[2] + b.max[2]) / 2;
    // scan the plate along its height for the hole axis: some y where the rod is (partly) empty
    let through = 0;
    let blindHidden = 0;
    for (let y = b.min[1] + 1; y < b.max[1] - 1; y += 0.5) {
      const back = probeX(solid, y, zc, 0.05, 1);
      const front = probeX(solid, y, zc, T - 1, T - 0.05);
      if (back < 0.1 && front < 0.1 && probeX(solid, y, zc, 0, T) < 0.1) through++;
      if (back < 0.1 && front > 0.8) blindHidden++;
    }
    collect();
    if (whMount === 'screws') expect(through).toBeGreaterThan(4); // clear through the plate
    else expect(blindHidden).toBeGreaterThan(4); // open at the back, closed at the front
  });

  it('sleutelrekje past op elk bed of geeft een melding', async () => {
    for (const printer of PRINTERS) {
      const p = params({ whStyle: 'rail', whCount: 7, whPitch: 32 });
      try {
        const res = await buildTool(M, tool, p, printer);
        for (const part of res.parts) expect(fitsOn(printer, part.size)).toBe(true);
      } catch (err) {
        expect((err as { user?: boolean }).user).toBe(true);
      }
    }
    const res = await buildTool(M, tool, params({ whStyle: 'rail', whCount: 8, whPitch: 36 }));
    expect(fitsOn(DEFAULT_PRINTER, res.parts[0].size)).toBe(true);
    expect(Math.max(res.parts[0].size[0], res.parts[0].size[1])).toBeGreaterThan(7 * 36);
    await expect(buildTool(M, tool, params({ whStyle: 'rail', whCount: 12, whPitch: 40 }), PRINTERS.find((x) => x.id === 'a1mini'))).rejects.toMatchObject({ user: true });
  });

  it('draagvermogen groeit met de dikte van de arm', async () => {
    const kg = async (whThick: number) => {
      const res = await buildTool(M, tool, params({ whStyle: 'single', whThick, whMount: 'screws' }));
      const row = (res.info.find((b) => b.title === 'Belasting') as { rows: [string, string][] }).rows[0][1];
      return Number(row.match(/≈ ([\d.]+) kg in PETG/)![1]);
    };
    expect(await kg(12)).toBeGreaterThan(await kg(6));
  });
});
