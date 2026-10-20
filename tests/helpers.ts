import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ManifoldToplevel } from 'manifold-3d';
import { AssetCache } from '../src/core/assets';
import { BUNDLED_FONTS } from '../src/core/fonts';
import { runBuild } from '../src/core/engine';
import { DEFAULT_PRINTER } from '../src/core/printer';
import type { Params, PartResult, PrinterProfile, ToolDef } from '../src/core/types';

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

/**
 * Area (mm²) of downward faces steeper than 45° (plus a little tolerance for
 * the tessellation: `limit` is the z-component of the face normal) that are
 * not on the bed. A part that prints without support has (almost) none.
 */
export function overhangArea(part: PartResult, limit = -0.75) {
  const { positions: P, indices: I } = part.mesh;
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
    if (nz / len < limit) area += len / 2;
  }
  return area;
}
