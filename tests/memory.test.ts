import { expect, it } from 'vitest';
import { runBuild } from '../src/core/engine';
import { TOOLS } from '../src/tools';
import { defaultsOf } from '../src/core/types';
import { DEFAULT_PRINTER } from '../src/core/printer';

/**
 * Every build must free its WASM objects: the preview rebuilds on each slider
 * move, so a leak quickly exhausts the heap and crashes the geometry kernel.
 */
it('bouwen lekt geen WASM-geheugen', async () => {
  let memory: WebAssembly.Memory | null = null;
  const instantiate = WebAssembly.instantiate;
  (WebAssembly as { instantiate: unknown }).instantiate = async (...args: unknown[]) => {
    const result = await (instantiate as (...a: unknown[]) => Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance>)(...args);
    const instance = 'instance' in result ? result.instance : result;
    for (const v of Object.values(instance.exports)) if (v instanceof WebAssembly.Memory) memory = v;
    return result;
  };
  const { initManifold } = await import('../src/core/manifold');
  const M = await initManifold();
  const heap = () => (memory as WebAssembly.Memory | null)?.buffer.byteLength ?? 0;
  const buildAll = () => {
    for (const tool of TOOLS) runBuild(M, tool, defaultsOf(tool.params), DEFAULT_PRINTER);
  };
  buildAll();
  buildAll();
  const before = heap();
  expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 4; i++) buildAll();
  expect((heap() - before) / 1e6).toBeLessThan(4);
});
