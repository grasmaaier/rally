import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { collect } from './registry';
import { NO_ASSETS, UserError, type AssetStore, type BuildResult, type Params, type PartResult, type PrinterProfile, type SceneResult, type ToolDef } from './types';
import { mul, translation } from '../geom/helpers';

function meshOf(m: Manifold) {
  const mesh = m.getMesh();
  const n = mesh.numProp;
  const vp = mesh.vertProperties;
  const count = vp.length / n;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = vp[i * n];
    positions[i * 3 + 1] = vp[i * n + 1];
    positions[i * 3 + 2] = vp[i * n + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

/** Run a tool and convert its manifolds into plain, transferable mesh data. */
export function runBuild(M: ManifoldToplevel, tool: ToolDef, params: Params, printer: PrinterProfile, assets: AssetStore = NO_ASSETS): BuildResult {
  const t0 = performance.now();
  try {
    const out = tool.build(params, { M, printer, assets });
    const offsets: [number, number, number][] = [];
    const parts: PartResult[] = out.parts.map((p) => {
      const status = p.solid.status();
      if (status !== 'NoError') throw new UserError(`Onderdeel "${p.name}" is ongeldig (${status}). Probeer andere maten.`);
      if (p.solid.isEmpty()) throw new UserError(`Onderdeel "${p.name}" is leeg. Controleer de maten.`);
      const b = p.solid.boundingBox();
      // Place on the bed: centred in XY, resting on z = 0.
      const d: [number, number, number] = [-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]];
      offsets.push(d);
      const placed = p.solid.translate(d);
      const mesh = meshOf(placed);
      return {
        name: p.name,
        mesh,
        quantity: Math.max(1, Math.round(p.quantity ?? 1)),
        color: p.color,
        size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
        volume: placed.volume(),
        area: placed.surfaceArea(),
        estimate: p.estimate ?? 'solid',
        triangles: placed.numTri(),
      };
    });
    const scene: SceneResult[] | undefined = out.scene?.map((s) => {
      if (s.kind === 'box') return s;
      const d = offsets[s.part];
      return { kind: 'part', part: s.part, matrix: mul(s.matrix, translation(-d[0], -d[1], -d[2])) };
    });
    return {
      parts,
      scene,
      info: out.info ?? [],
      tips: out.tips ?? [],
      warnings: out.warnings ?? [],
      defaultView: out.defaultView ?? (scene ? 'assembly' : 'plate'),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    collect();
  }
}
