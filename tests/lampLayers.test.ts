import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params } from '../src/core/types';
import { lampTool as tool } from '../src/tools/lamp';
import { HOLEABLE, LAYER_PATTERNS } from '../src/tools/lampLayers';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const base = defaultsOf(tool.params);
const PATTERNS = LAYER_PATTERNS.map((o) => o.value);
const W = '#f2efe8';

interface Layer {
  pat: string;
  n?: number;
  up?: number;
  depth?: number;
  twist?: number;
  holes?: boolean;
  len?: number;
}

/** A pendant (or table lamp) with a layered kap. */
function layered(layers: Layer[], o: { type?: 'pendant' | 'table'; kap?: string; D?: number; H?: number; gap?: number; extra?: Partial<Params> } = {}): Params {
  const v: Params = { ...base, lampType: o.type ?? 'pendant', layers: String(layers.length), layerGap: o.gap ?? 6, shadeWall: 1 };
  const kap = { Shape: 'kap', Kap: o.kap ?? 'cilinder', D: o.D ?? 220, H: o.H ?? 150, Var: 30, Tex: 'glad', Color: W };
  const top = { Shape: 'cilinder', D: 48, H: 30, Var: 30, Tex: 'glad', Color: '#2b2b2e' };
  const slots = o.type === 'table' ? [kap, { Shape: 'hals', D: 26, H: 60, Tex: 'glad', Color: '#2b2b2e' }] : [top, kap];
  v.count = slots.length;
  slots.forEach((s, i) => {
    for (const [k, x] of Object.entries(s)) v[`s${i + 1}${k}`] = x;
  });
  layers.forEach((l, i) => {
    const k = (x: string) => `kl${i + 1}${x}`;
    v[k('Pat')] = l.pat;
    v[k('N')] = l.n ?? (l.pat === 'golfRond' ? 5 : 30);
    v[k('Up')] = l.up ?? 7;
    v[k('Depth')] = l.depth ?? 1.4;
    v[k('Twist')] = l.twist ?? 0;
    v[k('Holes')] = l.holes ?? false;
    v[k('Len')] = l.len ?? 100 - 8 * i;
  });
  return { ...v, ...(o.extra ?? {}) } as Params;
}

const layerParts = (res: BuildResult) => res.parts.filter((p) => /^\d+\. Kap/.test(p.name));

function placed(res: BuildResult) {
  const meshes = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
  const out: { label: string; part: number; m: Manifold; matrix: number[] }[] = [];
  res.scene!.forEach((s) => {
    if (s.kind === 'part') out.push({ label: res.parts[s.part].name, part: s.part, m: meshes[s.part].transform(s.matrix as unknown as Mat4), matrix: s.matrix });
  });
  return out;
}

function overlaps(res: BuildResult) {
  const solids = placed(res);
  const out: string[] = [];
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++) {
      const v = solids[a].m.intersect(solids[b].m).volume();
      if (v > 1) out.push(`${solids[a].label} ∩ ${solids[b].label} = ${v.toFixed(1)} mm³`);
    }
  return out;
}

function checkParts(res: BuildResult, label: string) {
  for (const part of res.parts) {
    expect(part.volume, `${label} ${part.name}`).toBeGreaterThan(0);
    expect(fitsOn(DEFAULT_PRINTER, part.size), `${label} ${part.name} past niet`).toBe(true);
    expect(overhangArea(part), `${label} ${part.name} overhang`).toBeLessThan(25);
  }
}

/** World vertices (r, z, angle) of a placed part. */
function worldVerts(res: BuildResult, name: string) {
  const s = res.scene!.find((q) => q.kind === 'part' && res.parts[q.part].name === name);
  if (!s || s.kind !== 'part') throw new Error(`no ${name}`);
  const m = s.matrix;
  const P = res.parts[s.part].mesh.positions;
  const out: { r: number; z: number; a: number }[] = [];
  for (let i = 0; i < P.length; i += 3) {
    const x = m[0] * P[i] + m[4] * P[i + 1] + m[8] * P[i + 2] + m[12];
    const y = m[1] * P[i] + m[5] * P[i + 1] + m[9] * P[i + 2] + m[13];
    const z = m[2] * P[i] + m[6] * P[i + 1] + m[10] * P[i + 2] + m[14];
    out.push({ r: Math.hypot(x, y), z, a: Math.atan2(y, x) });
  }
  return out;
}

/**
 * Smallest radial gap between two nested layers, in bins of height and angle
 * over the open wall of the inner one: inner surface of the outer layer
 * (smallest radius per bin) minus outer surface of the inner layer.
 */
function radialGap(res: BuildResult, outer: string, inner: string) {
  const a = worldVerts(res, outer).filter((v) => v.r > 15);
  const b = worldVerts(res, inner);
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const v of b) {
    z0 = Math.min(z0, v.z);
    z1 = Math.max(z1, v.z);
  }
  z0 += 3;
  z1 -= 8;
  const key = (v: { z: number; a: number }) => `${Math.floor(v.z / 2)}|${Math.floor(((v.a + Math.PI) * 180) / Math.PI / 4)}`;
  const lo = new Map<string, number>();
  for (const v of a) if (v.z > z0 && v.z < z1) lo.set(key(v), Math.min(lo.get(key(v)) ?? Infinity, v.r));
  const hi = new Map<string, number>();
  for (const v of b) if (v.z > z0 && v.z < z1) hi.set(key(v), Math.max(hi.get(key(v)) ?? 0, v.r));
  let gap = Infinity;
  let bins = 0;
  for (const [k, r] of hi) {
    const o = lo.get(k);
    if (o === undefined) continue;
    bins++;
    gap = Math.min(gap, o - r);
  }
  return { gap, bins };
}

describe('kap in lagen: elk patroon op elke laag', () => {
  // every pattern once on each of the three layers
  const cases = PATTERNS.map((_, i) => [PATTERNS[i], PATTERNS[(i + 3) % PATTERNS.length], PATTERNS[(i + 6) % PATTERNS.length]] as const);
  it.each(cases)('%s / %s / %s', async (a, b, c) => {
    const res = await buildTool(M, tool, layered([{ pat: a, twist: 45 }, { pat: b, twist: -30 }, { pat: c }], { kap: 'klok', D: 240, H: 160 }));
    checkParts(res, `${a}/${b}/${c}`);
    const shades = layerParts(res);
    expect(shades.map((q) => q.name)).toEqual(['2. Kap laag 1 (buiten)', '2. Kap laag 2', '2. Kap laag 3 (binnen)']);
    expect(overlaps(res)).toEqual([]);
    for (const [o, i] of [[0, 1], [1, 2]]) {
      const g = radialGap(res, shades[o].name, shades[i].name);
      expect(g.bins).toBeGreaterThan(200);
      expect(g.gap, `${shades[o].name} → ${shades[i].name}`).toBeGreaterThan(6 * 0.85);
    }
  });

  it.each([...HOLEABLE])('doorbroken %s: echte gaatjes, zonder support', async (pat) => {
    const res = await buildTool(M, tool, layered([{ pat: 'golfOp', n: 20 }, { pat, holes: true, n: 28 }], { kap: 'klok', D: 240, H: 150 }));
    checkParts(res, pat);
    expect(overlaps(res)).toEqual([]);
    const inner = res.parts.find((q) => q.name.includes('laag 2'))!;
    const m = keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: inner.mesh.positions, triVerts: inner.mesh.indices })));
    // every opening is a handle of the surface
    expect(m.genus()).toBeGreaterThan(40);
    const closed = await buildTool(M, tool, layered([{ pat: 'golfOp', n: 20 }, { pat, holes: false, depth: 0.3, n: 28 }], { kap: 'klok', D: 240, H: 150 }));
    const solid = closed.parts.find((q) => q.name.includes('laag 2'))!;
    expect(inner.volume).toBeLessThan(0.85 * solid.volume);
  });

  it('ook een enkele patroonkap (1 laag) en een segmenttextuur buiten', async () => {
    const one = await buildTool(M, tool, layered([{ pat: 'golfRond', up: 9 }]));
    checkParts(one, 'enkel');
    expect(layerParts(one)).toHaveLength(1);
    const tex = await buildTool(M, tool, layered([{ pat: 'segment' }, { pat: 'ruit' }], { extra: { s2Tex: 'plisse', s2TexN: 90 } }));
    checkParts(tex, 'segment buiten');
    expect(overlaps(tex)).toEqual([]);
    expect(radialGap(tex, '2. Kap laag 1 (buiten)', '2. Kap laag 2 (binnen)').gap).toBeGreaterThan(6 * 0.85);
  });
});

describe('kap in lagen: montage en veiligheid', () => {
  it('tafellamp (uplight) met drie lagen: buis vrij, geen botsingen', async () => {
    const res = await buildTool(M, tool, layered([{ pat: 'plisse' }, { pat: 'stippen', holes: true }, { pat: 'golfOp' }], { type: 'table', kap: 'kegel', D: 220, H: 130, extra: { socket: 'e14', bulb14: 'g45' } }));
    checkParts(res, 'tafel');
    expect(overlaps(res)).toEqual([]);
    const tube = res.scene!.find((s) => s.kind === 'box' && s.label?.startsWith('Draadbuis'));
    if (!tube || tube.kind !== 'box') throw new Error('no tube');
    const rod = M.Manifold.cylinder(tube.size[2], 5, 5, 48).translate([0, 0, tube.position[2]]);
    for (const s of placed(res)) expect(s.m.intersect(rod).volume(), s.label).toBeLessThan(0.5);
    const g = radialGap(res, '1. Kap laag 1 (buiten)', '1. Kap laag 2');
    expect(g.gap).toBeGreaterThan(6 * 0.85);
  });

  it('lagen liggen op elkaar en de fitting onder de binnenste laag', async () => {
    const res = await buildTool(M, tool, layered([{ pat: 'glad' }, { pat: 'glad' }, { pat: 'glad' }]));
    const sock = res.scene!.find((s) => s.kind === 'box' && s.label?.startsWith('Fitting'))!;
    const low = (name: string) => worldVerts(res, name).reduce((m, v) => (v.r < 9 ? Math.min(m, v.z) : m), Infinity);
    // the socket presses against the ceiling of the innermost layer, below the outer ceiling (two inner ceilings of 5 mm)
    if (sock.kind !== 'box') throw new Error('no socket');
    const socketTop = sock.position[2] + sock.size[2];
    expect(low('2. Kap laag 3 (binnen)')).toBeCloseTo(socketTop, 1);
    // two inner ceilings of 5 mm, minus the centring cone under the outer ceiling
    expect(low('2. Kap laag 1 (buiten)') - socketTop).toBeCloseTo(10 - 1.8, 0);
    expect(res.info.find((b) => b.title === 'Montage')!.kind).toBe('text');
    expect(JSON.stringify(res.info)).toContain('Kap in lagen');
  });

  it('lamp raakt de binnenste laag → nette foutmelding', async () => {
    const p = layered([{ pat: 'glad' }, { pat: 'glad', len: 130 }, { pat: 'glad', len: 130 }], { D: 140, H: 200, gap: 12, extra: { bulb27: 'g95' } });
    await expect(buildTool(M, tool, p)).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, p)).rejects.toThrow(/laag|fitting/i);
  });

  it('te smalle kap voor drie lagen → breder gemaakt met een melding', async () => {
    const p = layered([{ pat: 'golfOp', depth: 4 }, { pat: 'raster', depth: 4 }, { pat: 'hex', depth: 4 }], { kap: 'kegel', D: 90, H: 120, gap: 15 });
    const res = await buildTool(M, tool, p);
    checkParts(res, 'smal');
    expect(overlaps(res)).toEqual([]);
    expect(res.warnings.some((w) => w.includes('breder'))).toBe(true);
  });

  it('te korte binnenlaag → nette foutmelding', async () => {
    const p = layered([{ pat: 'glad' }, { pat: 'glad' }, { pat: 'glad', len: 30 }], { H: 60 });
    await expect(buildTool(M, tool, p)).rejects.toMatchObject({ user: true });
  });

  it('lamellen aan de rand: binnenlaag niet langer dan de kap', async () => {
    const preset = tool.presets!.find((q) => q.name.startsWith('Lagenkoepel'))!;
    const res = await buildTool(M, tool, { ...base, ...preset.values, layers: '2', layerGap: 6, kl1Pat: 'segment', kl2Pat: 'golfRond', kl2Len: 120 } as Params);
    checkParts(res, 'louvre');
    expect(overlaps(res)).toEqual([]);
    expect(res.warnings.some((w) => w.includes('lamellen'))).toBe(true);
  });

  it('past niet op een kleine printer → nette melding', async () => {
    const mini = PRINTERS.find((q) => q.id === 'a1mini')!;
    await expect(buildTool(M, tool, layered([{ pat: 'glad' }, { pat: 'glad' }], { D: 260 }), mini)).rejects.toThrow(/past niet/);
  });

  it.each(tool.presets!.filter((p) => p.values.layers && p.values.layers !== '1').map((p) => [p.name, p.values] as const))('voorbeeld %s: lagen in eigen kleur, geen botsingen', async (_n, v) => {
    const res = await buildTool(M, tool, { ...base, ...v } as Params);
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    expect(layerParts(res)).toHaveLength(Number(v.layers));
    expect(res.tips.some((t) => t.includes('doorschijnend'))).toBe(true);
  });
});
