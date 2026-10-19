import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';

import { track } from './registry';

export { collect, keep } from './registry';

function intercept(target: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function (this: unknown, ...args: unknown[]) {
      return track((original as (...a: unknown[]) => unknown).apply(this, args));
    };
  }
}

const MANIFOLD_STATIC = [
  'cube', 'cylinder', 'sphere', 'tetrahedron', 'extrude', 'revolve', 'compose',
  'union', 'difference', 'intersection', 'levelSet', 'smooth', 'ofMesh', 'hull',
];
const MANIFOLD_MEMBER = [
  'add', 'subtract', 'intersect', 'decompose', 'warp', 'warpBatch', 'transform', 'translate',
  'rotate', 'scale', 'mirror', 'calculateCurvature', 'calculateNormals', 'smoothByNormals',
  'smoothOut', 'refine', 'refineToLength', 'refineToTolerance', 'setProperties',
  'setTolerance', 'simplify', 'asOriginal', 'trimByPlane', 'split', 'splitByPlane', 'slice',
  'project', 'hull', 'minkowskiSum', 'minkowskiDifference',
];
const CROSS_STATIC = ['square', 'circle', 'union', 'difference', 'intersection', 'compose', 'ofPolygons', 'hull'];
const CROSS_MEMBER = [
  'add', 'subtract', 'intersect', 'rectClip', 'decompose', 'transform', 'translate', 'rotate',
  'scale', 'mirror', 'simplify', 'offset', 'hull', 'extrude', 'revolve', 'warp',
];

let instance: Promise<ManifoldToplevel> | null = null;

export function initManifold(wasmUrl?: string): Promise<ManifoldToplevel> {
  if (!instance) {
    instance = (wasmUrl ? Module({ locateFile: () => wasmUrl }) : Module()).then((M) => {
      M.setup();
      // `M.Manifold` is a factory wrapper: the methods live on the prototype of real instances
      const probeM = M.Manifold.cube(1);
      const probeC = M.CrossSection.square(1);
      const manifoldProto = Object.getPrototypeOf(probeM) as Record<string, unknown>;
      const crossProto = Object.getPrototypeOf(probeC) as Record<string, unknown>;
      probeM.delete();
      probeC.delete();
      intercept(M.Manifold as unknown as Record<string, unknown>, MANIFOLD_STATIC);
      intercept(manifoldProto, MANIFOLD_MEMBER);
      intercept(M.CrossSection as unknown as Record<string, unknown>, CROSS_STATIC);
      intercept(crossProto, CROSS_MEMBER);
      return M;
    });
  }
  return instance;
}
