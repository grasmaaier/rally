import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { DEFAULT_PRINTER, PRINTERS } from '../src/core/printer';
import { defaultsOf, type ParamDef, type Params, type ToolDef } from '../src/core/types';
import { handlesTool } from '../src/tools/handles';
import { gridfinityTool } from '../src/tools/gridfinity';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES = Number(process.env.FUZZ_WALL ?? 24);

/** Random values for every parameter visible in this mode (fixed keys stay). */
function randomParams(tool: ToolDef, fixed: Params, rnd: () => number): Params {
  const p: Params = { ...defaultsOf(tool.params), ...fixed };
  for (const d of tool.params as ParamDef[]) {
    if (d.type === 'group' || d.key in fixed) continue;
    if (d.type === 'number') {
      const step = d.step ?? 1;
      p[d.key] = Math.round((d.min + rnd() * (d.max - d.min)) / step) * step;
    } else if (d.type === 'select') p[d.key] = d.options[Math.floor(rnd() * d.options.length)].value;
    else if (d.type === 'bool') p[d.key] = rnd() < 0.5;
  }
  return p;
}

const cases: [string, ToolDef, Params][] = [
  ['wandhaak', handlesTool, { type: 'wallhook' }],
  ['wandplaat', gridfinityTool, { mode: 'wall' }],
  ['bak met vanglip', gridfinityTool, { mode: 'bin' }],
];

describe.each(cases)('fuzz %s', (_name, tool, fixed) => {
  it(`${SAMPLES} willekeurige instellingen: geldig, zonder support, of een leesbare melding`, async () => {
    const rnd = mulberry32(_name.length * 1013 + 7);
    const failures: string[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const p = randomParams(tool, fixed, rnd);
      const printer = PRINTERS[Math.floor(rnd() * PRINTERS.length)] ?? DEFAULT_PRINTER;
      try {
        const res = await buildTool(M, tool, p, printer);
        // bins: the catch lip may not add overhang to what the bin already has (bridged magnet
        // holes, divider tops); knob-shaped hooks use the knob generator, which warns on its own
        const ref = fixed.mode === 'bin' ? await buildTool(M, tool, { ...p, wallLip: 0 }, printer) : null;
        res.parts.forEach((part, i) => {
          if (!(part.volume > 0)) failures.push(`${JSON.stringify(p)} → leeg ${part.name}`);
          if (p.whStyle === 'knob') return;
          const oh = overhangArea(part) - (ref ? overhangArea(ref.parts[i]) : 0);
          if (oh > (ref ? 5 : 25)) failures.push(`${JSON.stringify(p)} → overhang ${oh.toFixed(0)} mm² in ${part.name}`);
        });
      } catch (err) {
        if ((err as { user?: boolean })?.user !== true) failures.push(`${JSON.stringify(p)} → ${String((err as Error)?.message ?? err)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
