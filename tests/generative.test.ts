import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { strToU8, zipSync } from 'fflate';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { buildTool, testAssets } from './helpers';
import { generativeTool } from '../src/tools/generative';
import { defaultsOf, UserError, type BuildResult, type Params } from '../src/core/types';
import { DEFAULT_PRINTER, fitsOn } from '../src/core/printer';
import { decimate, parseMeshFile } from '../src/geom/meshfile';
import { DistanceGrid, TriangleBVH, bruteDistance } from '../src/geom/sdf';
import { builtinBody, signedVolume, type BodyMesh } from '../src/geom/bodies';
import { buildCage, buildStand, insideMargin, overhangShare, poseBody, type Body } from '../src/geom/generative';
import { fromArrays } from '../src/geom/helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const gen = (over: Partial<Params>): Params => ({ ...defaultsOf(generativeTool.params), quality: 'draft', ...over }) as Params;

// ---------------------------------------------------------------------------
// test files

/** A unit cube scaled by s, as 12 triangles (outward). */
function cubeTris(s = 10): number[][] {
  const v = (x: number, y: number, z: number) => [x * s, y * s, z * s];
  const quads = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
  ];
  return quads.flatMap((q) => [[...q[0], ...q[1], ...q[2]], [...q[0], ...q[2], ...q[3]]]);
}

function binarySTL(tris: number[][], header = 'binary test'): Uint8Array {
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(strToU8(header.slice(0, 80)));
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    for (let k = 0; k < 9; k++) view.setFloat32(84 + i * 50 + 12 + k * 4, t[k], true);
  });
  return bytes;
}

function asciiSTL(tris: number[][]): string {
  const f = (n: number) => n.toExponential(6);
  return `solid test\n${tris
    .map((t) => `  facet normal 0 0 0\n    outer loop\n${[0, 1, 2].map((c) => `      vertex ${f(t[c * 3])} ${f(t[c * 3 + 1])} ${f(t[c * 3 + 2])}`).join('\n')}\n    endloop\n  endfacet`)
    .join('\n')}\nendsolid test\n`;
}

function bodyToTris(b: BodyMesh): number[][] {
  const out: number[][] = [];
  for (let t = 0; t < b.indices.length; t += 3) out.push([0, 1, 2].flatMap((c) => [...b.positions.subarray(b.indices[t + c] * 3, b.indices[t + c] * 3 + 3)]));
  return out;
}

const sizeOf = (m: { positions: Float32Array }) => {
  const P = m.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  return max.map((v, k) => v - min[k]);
};

const expectUserError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    return;
  }
  throw new Error('expected a UserError');
};

describe('3D-model inlezen', () => {
  it('binaire STL: driehoeken, gelaste hoekpunten en maat', () => {
    const m = parseMeshFile(binarySTL(cubeTris(10)), 'kubus.stl');
    expect(m.indices.length / 3).toBe(12);
    expect(m.positions.length / 3).toBe(8);
    expect(sizeOf(m)).toEqual([10, 10, 10]);
    expect(m.unitKnown).toBe(false);
  });

  it('binaire STL waarvan de kop met "solid" begint', () => {
    const m = parseMeshFile(binarySTL(cubeTris(5), 'solid exported by some CAD tool'), 'kubus.stl');
    expect(m.indices.length / 3).toBe(12);
  });

  it('tekst-STL', () => {
    const m = parseMeshFile(strToU8(asciiSTL(cubeTris(20))), 'kubus.stl');
    expect(m.indices.length / 3).toBe(12);
    expect(sizeOf(m)).toEqual([20, 20, 20]);
  });

  it('OBJ met vierhoeken, negatieve indices en texturen', () => {
    const obj = [
      '# kubus', 'o cube',
      'v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0', 'v 0 0 10', 'v 10 0 10', 'v 10 10 10', 'v 0 10 10',
      'vt 0 0', 'vn 0 0 1',
      'f 1/1/1 4/1/1 3/1/1 2/1/1', 'f 5 6 7 8', 'f 1 2 6 5', 'f -5 -1 -2 -6', 'f 1 5 8 4', 'f 2//1 3//1 7//1 6//1',
    ].join('\n');
    const m = parseMeshFile(strToU8(obj), 'kubus.obj');
    expect(m.indices.length / 3).toBe(12);
    expect(sizeOf(m)).toEqual([10, 10, 10]);
  });

  it('3MF met eenheid, component en transformatie', () => {
    const tris = cubeTris(1);
    const verts: number[][] = [];
    const idx: number[] = [];
    for (const t of tris)
      for (let c = 0; c < 3; c++) {
        const v = t.slice(c * 3, c * 3 + 3);
        let i = verts.findIndex((w) => w.every((x, k) => x === v[k]));
        if (i < 0) i = verts.push(v) - 1;
        idx.push(i);
      }
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model"><mesh><vertices>${verts.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices>
  <triangles>${Array.from({ length: idx.length / 3 }, (_, t) => `<triangle v1="${idx[t * 3]}" v2="${idx[t * 3 + 1]}" v3="${idx[t * 3 + 2]}"/>`).join('')}</triangles></mesh></object>
  <object id="2" type="model"><components><component objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 5 5"/></build>
</model>`;
    const zip = zipSync({ '3D/3dmodel.model': strToU8(model), '[Content_Types].xml': strToU8('<Types/>') });
    const m = parseMeshFile(zip, 'kubus.3mf');
    expect(m.unitKnown).toBe(true);
    // 1 cm cube, stretched ×2 in X by the component
    const s = sizeOf(m);
    expect(s[0]).toBeCloseTo(20, 4);
    expect(s[1]).toBeCloseTo(10, 4);
    expect(s[2]).toBeCloseTo(10, 4);
  });

  it.each([
    ['onzin.stl', strToU8('dit is geen 3D-model maar gewoon tekst die lang genoeg is')],
    ['afgekapt.stl', binarySTL(cubeTris()).subarray(0, 300)],
    ['leeg.stl', new Uint8Array(0)],
    ['kapot.obj', strToU8('v 0 0 0\nv 1 0 0\nf 1 2 9\n')],
    ['geenvlakken.obj', strToU8('v 0 0 0\nv 1 0 0\nv 0 1 0\n')],
    ['plat.stl', binarySTL([[0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 0, 0, 0, 1, 0, 0, 2, 0]])],
    ['nan.stl', strToU8(asciiSTL([[NaN, 0, 0, 1, 0, 0, 0, 1, 0]]))],
    ['kapot.3mf', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])],
    ['leeg.3mf', zipSync({ 'readme.txt': strToU8('hallo') })],
    ['foto.png', strToU8('PNG................................')],
  ])('ongeldig bestand %s geeft een nette melding', (name, bytes) => {
    expectUserError(() => parseMeshFile(bytes, name));
  });

  it('vereenvoudigt grote modellen tot het budget', () => {
    const dense = builtinBody('sphere');
    const before = dense.indices.length / 3;
    const d = decimate(dense.positions, dense.indices, Math.floor(before / 4));
    expect(d.indices.length / 3).toBeLessThanOrEqual(before / 4);
    expect(d.indices.length / 3).toBeGreaterThan(before / 40);
    const s = sizeOf(d);
    for (const v of s) expect(Math.abs(v - 60)).toBeLessThan(4);
  });
});

// ---------------------------------------------------------------------------
// distance fields

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('afstand tot een mesh', () => {
  it.each(['earbuds', 'egg', 'phone'])('BVH = brute force (%s)', (id) => {
    const b = builtinBody(id);
    const bvh = new TriangleBVH(b.positions, b.indices);
    const rnd = mulberry32(id.length);
    for (let i = 0; i < 150; i++) {
      const p = [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200, rnd() * 200 - 30];
      const exact = bruteDistance(b.positions, b.indices, p[0], p[1], p[2]);
      expect(bvh.distance(p[0], p[1], p[2])).toBeCloseTo(exact, 6);
      // capped queries return the cap when nothing is closer
      expect(bvh.distance(p[0], p[1], p[2], 5)).toBeCloseTo(Math.min(exact, 5), 6);
    }
  });

  it('BVH op losse driehoeken (triangle soup)', () => {
    const rnd = mulberry32(3);
    const pos: number[] = [];
    const idx: number[] = [];
    for (let t = 0; t < 300; t++) {
      const c = [rnd() * 100, rnd() * 100, rnd() * 100];
      for (let k = 0; k < 3; k++) pos.push(c[0] + rnd() * 8, c[1] + rnd() * 8, c[2] + rnd() * 8);
      idx.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    const bvh = new TriangleBVH(pos, idx);
    for (let i = 0; i < 200; i++) {
      const p = [rnd() * 120 - 10, rnd() * 120 - 10, rnd() * 120 - 10];
      expect(bvh.distance(p[0], p[1], p[2])).toBeCloseTo(bruteDistance(pos, idx, p[0], p[1], p[2]), 6);
    }
  });

  it('afstandsraster van een bol: teken en grootte', () => {
    const b = builtinBody('sphere');
    const g = DistanceGrid.build(b.positions, b.indices, { min: [-40, -40, -10], max: [40, 40, 70] }, 1, 6);
    // centre (0, 0, 30), radius 30 (faceted: a little smaller between the vertices)
    expect(g.sample(0, 0, 30)).toBeCloseTo(-6, 5);
    for (const [x, y, z, d] of [[0, 0, 63, 3], [33, 0, 30, 3], [0, -28, 30, -2], [0, 0, 1.5, -1.5]]) expect(Math.abs(g.sample(x, y, z) - d)).toBeLessThan(0.3);
    expect(g.sample(200, 0, 0)).toBe(6);
    const { volume, centroid } = g.massProperties();
    expect(Math.abs(volume - (4 / 3) * Math.PI * 30 ** 3) / volume).toBeLessThan(0.05);
    expect(Math.abs(centroid[2] - 30)).toBeLessThan(0.5);
  });

  it('een model met gaten (niet waterdicht) is binnen nog steeds binnen', () => {
    const b = builtinBody('earbuds');
    const keepTris: number[] = [];
    for (let t = 0; t < b.indices.length / 3; t++) if (t % 37 !== 5) keepTris.push(b.indices[t * 3], b.indices[t * 3 + 1], b.indices[t * 3 + 2]);
    const g = DistanceGrid.build(b.positions, keepTris, { min: [-30, -16, -4], max: [30, 16, 58] }, 1, 5);
    let wrong = 0;
    let total = 0;
    for (let x = -20; x <= 20; x += 4)
      for (let z = 6; z <= 48; z += 4) {
        total++;
        if (!(g.sample(x, 0, z) < 0)) wrong++;
      }
    expect(wrong / total).toBeLessThan(0.02);
    expect(g.sample(0, 15, 27)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// builds

/** The printed parts placed back in the assembled view (as manifolds). */
function placedParts(res: BuildResult): Manifold[] {
  const out: Manifold[] = [];
  for (const s of res.scene ?? []) {
    if (s.kind !== 'part') continue;
    const p = res.parts[s.part].mesh;
    out.push(keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.positions, triVerts: p.indices }))).transform(s.matrix as unknown as Mat4));
  }
  return out;
}

function ghostSolid(res: BuildResult): Manifold {
  const g = res.scene!.find((s) => s.kind === 'mesh');
  if (!g || g.kind !== 'mesh') throw new Error('no ghost');
  return fromArrays(M, g.mesh.positions, g.mesh.indices);
}

function expectValid(res: BuildResult) {
  expect(res.parts.length).toBeGreaterThan(0);
  for (const p of res.parts) {
    const m = keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices })));
    expect(m.status()).toBe('NoError');
    expect(m.decompose().length, `${p.name} is één stuk`).toBe(1);
    expect(p.volume).toBeGreaterThan(500);
    expect(fitsOn(DEFAULT_PRINTER, p.size)).toBe(true);
    // flat on the bed: a decent contact area at z = 0
    expect(m.slice(0.2).area(), `${p.name} staat vlak op het bed`).toBeGreaterThan(20);
  }
}

describe('generatief: elke modus × patroon op de ingebouwde voorwerpen', () => {
  const cases: [string, Partial<Params>][] = [];
  for (const pattern of ['voronoi', 'blobs', 'gyroid'])
    for (const [body, opening] of [['earbuds', 'top'], ['egg', 'halves'], ['phone', 'bottom']]) cases.push([`hoes ${pattern} ${body} ${opening}`, { mode: 'cage', pattern, body, opening, up: body === 'phone' ? '-y' : 'z' }]);
  for (const standStyle of ['takken', 'voronoi', 'blobs', 'gyroid'])
    for (const [body, up] of [['phone', 'z'], ['earbuds', 'z'], ['phone', 'x']]) cases.push([`standaard ${standStyle} ${body} ${up}`, { mode: 'stand', standStyle, body, up, cell: 12 }]);
  for (const pattern of ['voronoi', 'blobs', 'gyroid'])
    for (const structure of ['skin', 'lattice', 'both']) cases.push([`lattice ${pattern} ${structure}`, { mode: 'lattice', pattern, structure, body: pattern === 'blobs' ? 'egg' : 'sphere', cell: 10, strut: 2 }]);
  it.each(cases)('%s', async (_name, over) => {
    const t0 = performance.now();
    const res = await buildTool(M, generativeTool, gen(over));
    expectValid(res);
    expect(performance.now() - t0).toBeLessThan(8000);
    if (over.mode !== 'lattice') {
      // the reference object is shown and nothing printed cuts into it
      const ghost = ghostSolid(res);
      for (const part of placedParts(res)) expect(part.intersect(ghost).volume()).toBeLessThan(5);
    }
  });
});

const pose = (id: string, up: 'z' | '-y' = 'z'): Body => poseBody(builtinBody(id), 1, up, 0);

describe('hoes: speling en omsluiting', () => {
  it.each([
    ['earbuds', 'voronoi', 0.3, 2],
    ['egg', 'blobs', 0.5, 2.4],
  ] as const)('%s / %s: raakt het voorwerp niet en zit binnen speling + wand', (id, kind, clearance, wall) => {
    const body = pose(id);
    const res = buildCage(M, body, { clearance, wall, opening: 'top', cut: 0.7, quality: 'normal', pattern: { kind, cell: 9, strut: 2, smooth: 0.6, porosity: 0.5, seed: 3 } });
    const cage = res.parts[0].solid;
    const solidBody = fromArrays(M, body.positions, body.indices);
    expect(cage.intersect(solidBody).volume()).toBeLessThan(0.05);
    // every surface point of the cage lies within the shell band around the body
    const bvh = new TriangleBVH(body.positions, body.indices);
    const mesh = cage.getMesh();
    const tol = res.edge * 0.6 + 0.05;
    let inner = Infinity;
    let outer = 0;
    for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
      const d = bvh.distance(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
      inner = Math.min(inner, d);
      outer = Math.max(outer, d);
    }
    expect(inner).toBeGreaterThan(clearance - 0.05);
    expect(outer).toBeLessThan(clearance + wall + tol);
    // and it really wraps: most of the lower body is covered within reach
    expect(cage.volume()).toBeGreaterThan(1000);
  });

  it('waarschuwt als de opening kleiner is dan het voorwerp', async () => {
    const res = await buildTool(M, generativeTool, gen({ mode: 'cage', body: 'sphere', opening: 'top', cut: 85 }));
    expect(res.warnings.some((w) => w.includes('oprekken'))).toBe(true);
    const ok = await buildTool(M, generativeTool, gen({ mode: 'cage', body: 'sphere', opening: 'top', cut: 45 }));
    expect(ok.warnings.some((w) => w.includes('oprekken'))).toBe(false);
  });
});

describe('standaard: stabiliteit en printbaarheid', () => {
  it.each([50, 65, 75, 88])('telefoon onder %i° staat stabiel', (angle) => {
    const body = pose('phone');
    const res = buildStand(M, body, {
      angle, lift: 14, lip: 10, wall: 2.8, clearance: 0.5, strut: 3, support: 0.6, cable: true, cableWidth: 12, branches: 3, smooth: 0.6, seed: 7, style: 'takken', cell: 10, quality: 'draft',
    });
    expect(res.margin).toBeGreaterThan(5);
    const foot = res.parts[0].solid.slice(0.3).hull().toPolygons()[0] as [number, number][];
    expect(insideMargin(foot, res.centerOfMass[0], res.centerOfMass[1])).toBeGreaterThan(0);
    // branches mostly self-supporting
    expect(overhangShare(res.parts[0].solid)).toBeLessThan(0.2);
  });

  it('kabelsleuf: vrije doorgang onder het midden van het voorwerp', async () => {
    const res = await buildTool(M, generativeTool, gen({ mode: 'stand', body: 'phone', cable: true, cableWidth: 12 }));
    const stand = placedParts(res)[0];
    const ghost = ghostSolid(res).boundingBox();
    // a 10 mm wide column straight below the phone's bottom edge stays empty
    const probe = M.Manifold.cube([10, 6, 8], true).translate([0, (ghost.min[1] + 4), 5]);
    expect(stand.intersect(probe).volume()).toBeLessThan(1);
  });

  it('insideMargin', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(insideMargin(sq, 5, 5)).toBeCloseTo(5);
    expect(insideMargin(sq, 1, 5)).toBeCloseTo(1);
    expect(insideMargin(sq, -2, 5)).toBeLessThan(0);
    expect(insideMargin([...sq].reverse(), 5, 5)).toBeCloseTo(5);
  });
});

describe('eigen 3D-model', () => {
  it('geüploade STL (ook met gaten) wordt een hoes en een standaard', async () => {
    const tris = bodyToTris(builtinBody('earbuds')).filter((_, i) => i % 41 !== 7);
    const mesh = parseMeshFile(binarySTL(tris.map((t) => t.map((v) => v / 10))), 'case-in-cm.stl');
    testAssets.putMesh('upload:test-case', mesh);
    const cage = await buildTool(M, generativeTool, gen({ body: 'upload', modelFile: 'upload:test-case', unit: 'cm', mode: 'cage' }));
    expectValid(cage);
    const kv = cage.info[0];
    expect(kv.kind === 'kv' && kv.rows[0][1]).toContain('50,0 × 24,0 × 54,0');
    const stand = await buildTool(M, generativeTool, gen({ body: 'upload', modelFile: 'upload:test-case', unit: 'cm', mode: 'stand' }));
    expectValid(stand);
  });

  it('zonder bestand: ingebouwd voorwerp en een tip', async () => {
    const res = await buildTool(M, generativeTool, gen({ body: 'upload', modelFile: '' }));
    expect(res.tips.some((t) => t.includes('Upload'))).toBe(true);
  });

  it('te groot of te klein geeft een nette melding', async () => {
    await expect(buildTool(M, generativeTool, gen({ body: 'phone', scale: 400 }))).rejects.toBeInstanceOf(UserError);
    await expect(buildTool(M, generativeTool, gen({ body: 'phone', scale: 10 }))).rejects.toBeInstanceOf(UserError);
    // fits, but the cage around it would not
    await expect(buildTool(M, generativeTool, gen({ body: 'sphere', scale: 300, mode: 'lattice', quality: 'fine', strut: 1.2 }))).rejects.toBeInstanceOf(UserError);
  });

  it('ingebouwde voorwerpen zijn gesloten en naar buiten gericht', () => {
    for (const id of ['phone', 'earbuds', 'egg', 'sphere']) {
      const b = builtinBody(id);
      expect(signedVolume(b)).toBeGreaterThan(0);
      const m = fromArrays(M, b.positions, b.indices);
      expect(m.status()).toBe('NoError');
      expect(m.volume()).toBeCloseTo(signedVolume(b), 0);
    }
  });
});

describe('verras me', () => {
  it('8 willekeurige ontwerpen bouwen', async () => {
    for (let i = 0; i < 8; i++) {
      const mode = ['cage', 'stand', 'lattice'][i % 3];
      const p = gen({ mode, body: mode === 'stand' ? 'phone' : 'earbuds', ...generativeTool.randomize!({ mode } as Params) });
      const res = await buildTool(M, generativeTool, p);
      expect(res.parts[0].volume, JSON.stringify(p)).toBeGreaterThan(500);
    }
  });
});
