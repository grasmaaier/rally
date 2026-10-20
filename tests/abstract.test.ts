import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { buildTool } from './helpers';
import { handlesTool, DESIGN_STYLES } from '../src/tools/handles';
import { defaultsOf, type Params } from '../src/core/types';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const knob = (over: Partial<Params>): Params => ({ ...defaultsOf(handlesTool.params), type: 'knob', ...over }) as Params;

describe('designknoppen', () => {
  const cases: [string, string, string][] = [];
  for (const s of DESIGN_STYLES) for (const mount of ['tap', 'nut', 'insert']) cases.push([s.value, mount, 'M4']);
  it.each(cases)('%s / %s', async (style, mount, screw) => {
    const t0 = performance.now();
    const res = await buildTool(M, handlesTool, knob({ style, mount, screw, headFile: style === 'custom' ? 'upload:test-star' : '' }));
    const ms = performance.now() - t0;
    if (process.env.REPORT) console.log(style, mount, Math.round(ms), 'ms', res.parts[0].triangles, res.parts[0].size.map((v) => v.toFixed(1)).join('x'), res.warnings.join(' / '), res.tips[0]);
    expect(res.parts[0].volume).toBeGreaterThan(1000);
  });
});

const handle = (over: Partial<Params>): Params => ({ ...defaultsOf(handlesTool.params), ...over }) as Params;

describe('abstracte staafgrepen', () => {
  const cases: [string, string, string][] = [];
  for (const barStyle of ['twisted', 'wavy', 'bone', 'branch']) for (const mount of ['tap', 'nut', 'insert']) cases.push([barStyle, mount, '128']);
  it.each(cases)('%s / %s / %s', async (barStyle, mount, spacing) => {
    const t0 = performance.now();
    const res = await buildTool(M, handlesTool, handle({ type: 'bar', barStyle, mount, spacing }));
    const ms = performance.now() - t0;
    if (process.env.REPORT) console.log(barStyle, mount, Math.round(ms), 'ms', res.parts.map((q) => `${q.name} ${q.triangles} ${q.size.map((v) => v.toFixed(1)).join('x')}`).join(' | '), res.warnings.join(' / '));
    for (const q of res.parts) expect(q.volume).toBeGreaterThan(500);
  });
});
