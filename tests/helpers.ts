import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ManifoldToplevel } from 'manifold-3d';
import { AssetCache } from '../src/core/assets';
import { BUNDLED_FONTS } from '../src/core/fonts';
import { runBuild } from '../src/core/engine';
import { DEFAULT_PRINTER } from '../src/core/printer';
import type { Params, PrinterProfile, ToolDef } from '../src/core/types';

const require = createRequire(import.meta.url);

/** Offline asset store for tests: bundled fonts from node_modules, plus test shapes. */
export const testAssets = new AssetCache({
  bundledFont: async (id) => {
    const f = BUNDLED_FONTS.find((x) => x.id === id);
    if (!f) throw new Error(`unknown font ${id}`);
    const buf = await readFile(require.resolve(f.file));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  fetchBytes: async () => {
    throw new Error('offline in tests');
  },
});

// an uploaded SVG stand-in: a five-pointed star with a round hole
const star: [number, number][] = [];
for (let i = 0; i < 10; i++) {
  const a = Math.PI / 2 + (i * Math.PI) / 5;
  const r = i % 2 === 0 ? 0.5 : 0.22;
  star.push([r * Math.cos(a), r * Math.sin(a)]);
}
const hole: [number, number][] = [];
for (let i = 0; i < 24; i++) {
  const a = -(i * 2 * Math.PI) / 24;
  hole.push([0.08 * Math.cos(a), 0.08 * Math.sin(a)]);
}
testAssets.putShape('upload:test-star', { name: 'ster.svg', polygons: [star, hole], aspect: 1 });

/** Load what a tool needs, then build — like the worker does. */
export async function buildTool(M: ManifoldToplevel, tool: ToolDef, params: Params, printer: PrinterProfile = DEFAULT_PRINTER) {
  await testAssets.ensure(tool.assets?.(params) ?? []);
  return runBuild(M, tool, params, printer, testAssets);
}
