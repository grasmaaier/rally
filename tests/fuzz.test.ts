import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { buildTool } from './helpers';
import { TOOLS } from '../src/tools';
import { defaultsOf, type Params } from '../src/core/types';
import { DEFAULT_PRINTER } from '../src/core/printer';

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

const SAMPLES = Number(process.env.FUZZ ?? 12);

/**
 * Random settings within the slider ranges must either build a valid model
 * or fail with a deliberate message for the user — never with a geometry-kernel error.
 */
describe.each(TOOLS.map((t) => [t.id, t] as const))('fuzz %s', (_id, tool) => {
  it(`${SAMPLES} willekeurige instellingen`, async () => {
    const rnd = mulberry32(tool.id.length * 7919 + 17);
    const failures: string[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const params: Params = { ...defaultsOf(tool.params) };
      for (const d of tool.params) {
        if (d.type === 'number') {
          const step = d.step ?? 1;
          params[d.key] = Math.round((d.min + rnd() * (d.max - d.min)) / step) * step;
        } else if (d.type === 'select') params[d.key] = d.options[Math.floor(rnd() * d.options.length)].value;
        else if (d.type === 'bool') params[d.key] = rnd() < 0.5;
      }
      try {
        if (process.env.FUZZ_LOG === '2') process.stderr.write(`START ${tool.id} ${JSON.stringify(params)}\n`);
        const t0 = performance.now();
        const res = await buildTool(M, tool, params, DEFAULT_PRINTER);
        const ms = performance.now() - t0;
        if (process.env.FUZZ_LOG && ms > 1500) process.stderr.write(`SLOW ${tool.id} ${Math.round(ms)}ms ${JSON.stringify(params)}\n`);
        for (const p of res.parts) if (!(p.volume > 0)) failures.push(`${JSON.stringify(params)} → leeg onderdeel ${p.name}`);
      } catch (err) {
        if (process.env.FUZZ_LOG) process.stderr.write(`ERR ${tool.id} ${String((err as Error)?.message).slice(0, 120)}\n`);
        const msg = String((err as Error)?.message ?? err);
        // deliberate messages for the user are fine; anything else is a bug
        const readable = (err as { user?: boolean })?.user === true;
        if (!readable) failures.push(`${JSON.stringify(params)} → ${msg}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
