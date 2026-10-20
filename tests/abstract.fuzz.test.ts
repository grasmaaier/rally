import { it, expect } from 'vitest';
import { initManifold } from '../src/core/manifold';
import { buildTool } from './helpers';
import { handlesTool, DESIGN_STYLES } from '../src/tools/handles';
import { defaultsOf, type Params } from '../src/core/types';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('knop-fuzz', async () => {
  const M = await initManifold();
  const rnd = mulberry32(Number(process.env.SEED ?? 1));
  const fails: string[] = [];
  for (let i = 0; i < Number(process.env.N ?? 60); i++) {
    const p: Params = { ...defaultsOf(handlesTool.params) };
    for (const d of handlesTool.params) {
      if (d.type === 'number') p[d.key] = Math.round((d.min + rnd() * (d.max - d.min)) / (d.step ?? 1)) * (d.step ?? 1);
      else if (d.type === 'select') p[d.key] = d.options[Math.floor(rnd() * d.options.length)].value;
    }
    p.type = 'knob';
    p.style = DESIGN_STYLES[Math.floor(rnd() * DESIGN_STYLES.length)].value;
    if (p.style === 'custom' && rnd() < 0.7) p.headFile = 'upload:test-star';
    const t0 = performance.now();
    try {
      const res = await buildTool(M, handlesTool, p);
      const ms = performance.now() - t0;
      if (ms > 1500) console.log('SLOW', Math.round(ms), JSON.stringify(p));
      if (process.env.LOG) console.log(p.style, Math.round(ms), res.warnings.join(' | '));
    } catch (e) {
      const msg = String((e as Error).message);
      if (!(e as { user?: boolean }).user) fails.push(`${msg} ${JSON.stringify(p)}`);
      else if (process.env.LOG) console.log('USER', msg);
    }
  }
  expect(fails).toEqual([]);
});
