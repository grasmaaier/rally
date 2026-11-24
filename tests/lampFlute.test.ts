import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params, type PartResult } from '../src/core/types';
import { lampTool as tool } from '../src/tools/lamp';
import { FLUTE_DEPTH, fluteDepthFrac, fluteOf, fluteProfile } from '../src/tools/lampFlute';
import { HIDDEN } from '../src/tools/lampClosed';
import { parseSel, selKey, selValid } from '../src/designer/lampModel';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;
const preset = (name: string) => tool.presets!.find((q) => q.name.startsWith(name))!.values;

function seg(i: number, v: Record<string, string | number | boolean>): Partial<Params> {
  const out: Partial<Params> = { [`s${i}Tex`]: 'glad' };
  for (const [k, x] of Object.entries(v)) out[`s${i}${k[0].toUpperCase()}${k.slice(1)}`] = x;
  return out;
}
const lamp = (type: 'table' | 'pendant', segs: Record<string, string | number | boolean>[], extra: Partial<Params> = {}) =>
  params({ lampType: type, count: segs.length, ...Object.assign({}, ...segs.map((s, i) => seg(i + 1, s))), ...extra });

const solidOf = (p: PartResult) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices })));

function placed(res: BuildResult) {
  const meshes = res.parts.map(solidOf);
  const out: { label: string; name: string; part: number; m: Manifold }[] = [];
  res.scene!.forEach((s, i) => {
    if (s.kind === 'part') out.push({ label: `${res.parts[s.part].name}#${i}`, name: res.parts[s.part].name, part: s.part, m: meshes[s.part].transform(s.matrix as unknown as Mat4) });
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

const area = (pts: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};
const inside = (p: [number, number], poly: [number, number][]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const contours = (cs: CrossSection) => cs.toPolygons().map((poly) => poly.map((q) => [q[0], q[1]] as [number, number]));

/** Radius of a star-shaped contour in `bins` angle bins (largest radius per bin). */
function radiusByAngle(poly: [number, number][], bins: number) {
  const r = new Array<number>(bins).fill(-1);
  for (const [x, y] of poly) {
    const a = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
    const k = Math.min(bins - 1, Math.floor((a / (2 * Math.PI)) * bins));
    r[k] = Math.max(r[k], Math.hypot(x, y));
  }
  // empty bins take their neighbour
  for (let pass = 0; pass < 4; pass++) for (let k = 0; k < bins; k++) if (r[k] < 0) r[k] = r[(k + bins - 1) % bins];
  return r;
}

/** Number of grooves around: runs of the outline below half the depth. */
function countGrooves(r: number[]) {
  const hi = Math.max(...r);
  const lo = Math.min(...r);
  const mid = (hi + lo) / 2;
  let n = 0;
  for (let k = 0; k < r.length; k++) if (r[k] < mid && r[(k + r.length - 1) % r.length] >= mid) n++;
  return { n, depth: hi - lo, hi };
}

function distToPoly(p: [number, number], poly: [number, number][]) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / Math.max(1e-12, vx * vx + vy * vy)));
    d = Math.min(d, Math.hypot(p[0] - ax - t * vx, p[1] - ay - t * vy));
  }
  return d;
}

describe('geribbelde ring', () => {
  it('flute profile: U-shaped grooves of the asked depth, rounded ribs', () => {
    for (const [v, groove, round] of [[0, 0.3, 0], [0.5, 0.5, 0.5], [1, 0.8, 1], [1, 0.2, 1]] as const) {
      const f = fluteOf(80, v, 24, groove, round);
      const prof = fluteProfile(f);
      expect(Math.max(...prof)).toBeCloseTo(fluteDepthFrac(v) * 80, 1);
      expect(Math.min(...prof)).toBeCloseTo(0, 6);
      expect(f.depth / f.R).toBeGreaterThanOrEqual(FLUTE_DEPTH[0] - 1e-9);
      expect(f.depth / f.R).toBeLessThanOrEqual(FLUTE_DEPTH[1] + 1e-9);
    }
    // the deepest point is in the middle of the groove, the rib top is flat or round
    const f = fluteOf(80, 1, 24, 0.5, 1);
    const prof = fluteProfile(f);
    expect(prof[0]).toBeCloseTo(f.depth, 3);
    expect(prof[prof.length / 2]).toBeCloseTo(0, 3);
    // too many flutes for a small ring: fewer, with a note
    const notes: string[] = [];
    expect(fluteOf(15, 0.5, 48, 0.5, 0.5, notes).n).toBeLessThan(48);
    expect(notes.length).toBe(1);
  });

  it.each([
    ['plat (tafel)', 'table', 150, 12, 24, 60],
    ['plat (hang)', 'pendant', 210, 16, 40, 70],
    ['hoog, M10 (massief)', 'pendant', 120, 60, 18, 100],
  ] as const)('%s: flute count and depth measured on the mesh, flat on the bed, translucent', async (_n, type, D, H, N, v) => {
    const res = await buildTool(M, tool, lamp(type, [{ shape: 'ribring', d: D, h: H, n: N, var: v, groove: 45, round: 80 }, { shape: 'schijf', d: 80, h: 10 }], _n.includes('M10') ? { connection: 'm10' } : {}));
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    const part = res.parts.find((q) => q.name.endsWith('Ribbelring'))!;
    expect(part.material).toBe('petg-translucent');
    expect(part.select).toBe('seg:1');
    const solid = solidOf(part);
    const cut = contours(solid.slice(part.size[2] / 2));
    const outer = cut.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
    const g = countGrooves(radiusByAngle(outer, 2880));
    expect(g.n).toBe(N);
    expect(g.hi).toBeCloseTo(D / 2, 0);
    expect(g.depth).toBeGreaterThan(0.9 * fluteDepthFrac(v / 100) * (D / 2));
    expect(g.depth).toBeLessThan(1.1 * fluteDepthFrac(v / 100) * (D / 2) + 0.3);
    // a solid ring around the tube (one hole: the bore)
    expect(solid.genus()).toBe(1);
    expect(cut.length).toBe(2);
  });

  it('tall on the printed tube: hollow, one even wall following the flutes, round rims closed by discs', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'schijf', d: 140, h: 10 }, { shape: 'ribring', d: 120, h: 70, n: 20, var: 80, groove: 45, round: 80 }, { shape: 'cilinder', d: 70, h: 14 }]));
    checkParts(res, 'hoog hol');
    expect(overlaps(res)).toEqual([]);
    const part = res.parts.find((q) => q.name === '2. Ribbelring (hol)')!;
    expect(part, res.parts.map((q) => q.name).join(', ')).toBeTruthy();
    expect(part.estimate).toBe('vase');
    expect(part.material).toBe('petg-translucent');
    const solid = solidOf(part);
    expect(solid.genus()).toBe(1);
    // uniform wall: volume ≈ (area / 2) × wall (0.8 mm by default)
    expect(part.volume / (part.area / 2)).toBeGreaterThan(0.8 * 0.9);
    expect(part.volume / (part.area / 2)).toBeLessThan(0.8 * 1.15);
    const cut = contours(solid.slice(part.size[2] / 2));
    expect(cut.length).toBe(2);
    for (const c of cut) expect(countGrooves(radiusByAngle(c, 2880)).n).toBe(20);
    // round rims: the rim face is a full ring at the full radius
    const rim = contours(solid.slice(0.2));
    const rs = rim.flat().map((q) => Math.hypot(q[0], q[1]));
    expect(Math.max(...rs)).toBeGreaterThan(59.5);
    expect(countGrooves(radiusByAngle(rim.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a)), 720)).depth).toBeLessThan(1);
    // closed by discs on both rims
    expect(res.parts.filter((q) => /schijf/i.test(q.name) && !q.name.startsWith('1.')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('geribbelde koker (kap)', () => {
  it('uniform wall that follows the flutes, open at the rim, on a ceiling plate', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'kap', kap: 'geribbeld', d: 150, h: 170, n: 26, var: 60, groove: 40, round: 90 }], { shadeWall: 1.2 }));
    checkParts(res, 'koker');
    expect(overlaps(res)).toEqual([]);
    const part = res.parts.find((q) => q.name === '1. Kap')!;
    expect(part.material).toBe('petg-translucent');
    const solid = solidOf(part);
    // print orientation: ceiling plate on the bed, the fluted wall above it
    const cut = contours(solid.slice(part.size[2] / 2));
    expect(cut.length).toBe(2);
    const [outer, inner] = Math.abs(area(cut[0])) > Math.abs(area(cut[1])) ? cut : [cut[1], cut[0]];
    expect(countGrooves(radiusByAngle(outer, 2880)).n).toBe(26);
    expect(countGrooves(radiusByAngle(inner, 2880)).n).toBe(26);
    // every point of the inner wall is one wall thickness from the outer wall
    const d = inner.map((p) => distToPoly(p, outer)).sort((a, b) => a - b);
    expect(d[Math.floor(d.length * 0.02)]).toBeGreaterThan(1.2 * 0.92);
    expect(d[Math.floor(d.length * 0.98)]).toBeLessThan(1.2 * 1.08);
    // band area / centre line length = wall
    const len = (p: [number, number][]) => p.reduce((s, q, i) => s + Math.hypot(q[0] - p[(i + 1) % p.length][0], q[1] - p[(i + 1) % p.length][1]), 0);
    expect((Math.abs(area(outer)) - Math.abs(area(inner))) / ((len(outer) + len(inner)) / 2)).toBeCloseTo(1.2, 1);
  });

  it('scalloped rim: every other rib longer with a round end, on top while printing', async () => {
    const res = await buildTool(M, tool, params(preset('Rode kartelkap')));
    checkParts(res, 'kartel');
    const part = res.parts.find((q) => q.name === '1. Kap')!;
    const solid = solidOf(part);
    const top = part.size[2];
    // near the tips only the long ribs are left: 13 separate tongues; lower the wall is closed again
    const tongues = contours(solid.slice(top - 4));
    expect(tongues.length).toBe(13);
    for (const t of tongues) expect(area(t)).toBeGreaterThan(0);
    const closed = contours(solid.slice(top - 30));
    expect(closed.length).toBe(2);
    // round ends: just below the tip a tongue is narrower than further down
    const width = (z: number) => {
      const c = contours(solid.slice(z));
      return Math.max(...c.map((p) => Math.abs(area(p))));
    };
    expect(width(top - 0.5)).toBeLessThan(0.6 * width(top - 8));
    // an odd number of ribs becomes even (with a note)
    const odd = await buildTool(M, tool, lamp('pendant', [{ shape: 'kap', kap: 'geribbeld', d: 150, h: 160, n: 25, var: 50, scallop: 15 }]));
    expect(odd.warnings.some((w) => /even aantal/.test(w))).toBe(true);
  });

  it('as a sleeve around an opaque inner shade (Gele koker): gap kept, inner one longer, materials', async () => {
    const v = preset('Gele koker');
    const res = await buildTool(M, tool, params(v));
    checkParts(res, 'koker om kap');
    expect(overlaps(res)).toEqual([]);
    const sleeve = res.parts.find((q) => q.name.includes('laag 1'))!;
    const innerPart = res.parts.find((q) => q.name.includes('laag 2'))!;
    expect(sleeve.material).toBe('petg-translucent');
    expect(innerPart.material).toBe('petg-hf');
    expect(innerPart.select).toBe('layers');
    const disc = res.parts.find((q) => q.name === '1. Schijf')!;
    expect(disc.material).toBe('pla-matte');
    const cap = res.parts.find((q) => q.name.startsWith('Topkapje'))!;
    expect(cap.color).toBe(v.capColor);
    const solids = placed(res);
    const s = solids.find((q) => q.name === sleeve.name)!.m;
    const i = solids.find((q) => q.name === innerPart.name)!.m;
    expect(i.boundingBox().min[2]).toBeLessThan(s.boundingBox().min[2] - 20);
    // the gap between the flute bottoms and the inner shade, at several heights
    const zs = [0.2, 0.5, 0.8].map((t) => s.boundingBox().min[2] + 20 + t * (s.boundingBox().max[2] - s.boundingBox().min[2] - 40));
    for (const z of zs) {
      const rs = contours(s.slice(z)).flat().map((p) => Math.hypot(p[0], p[1]));
      const ri = contours(i.slice(z)).flat().map((p) => Math.hypot(p[0], p[1]));
      expect(Math.min(...rs) - Math.max(...ri), `z ${z.toFixed(0)}`).toBeGreaterThan(0.9 * Number(v.layerGap) - 0.2);
    }
  });

  it('table lamp (uplight) and the bought M10 tube', async () => {
    for (const extra of [{}, { connection: 'm10' }]) {
      const res = await buildTool(M, tool, lamp('table', [{ shape: 'kap', kap: 'geribbeld', d: 180, h: 120, n: 30, var: 40, scallop: 12 }, { shape: 'hals', d: 26, h: 60 }], { socket: 'e14', bulb14: 'g45', ...extra }));
      checkParts(res, JSON.stringify(extra));
      expect(overlaps(res)).toEqual([]);
      collect();
    }
  });

  it('not with a closed lamp (note) and not with lamellas (message)', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'cilinder', d: 50, h: 30 }, { shape: 'kap', kap: 'geribbeld', d: 200, h: 140 }], { closed: true }));
    expect(res.warnings.some((w) => /geribbelde koker/.test(w))).toBe(true);
    expect(res.parts.some((q) => /Onderkap/.test(q.name))).toBe(false);
    const louvre = params({ ...preset('Lagenkoepel'), s2Kap: 'geribbeld' });
    await expect(buildTool(M, tool, louvre)).rejects.toMatchObject({ user: true });
  });

  it('too narrow for the socket: made wider with a note', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'kap', kap: 'geribbeld', d: 60, h: 120, var: 100 }], { bulb27: 'a60' }));
    expect(res.warnings.some((w) => /breder gemaakt/.test(w))).toBe(true);
    checkParts(res, 'smal');
  });
});

/** Horizontal slices of the shades: at every height the wall must close around the axis (no straight look inside). */
function leakHeights(res: BuildResult, names: RegExp, step = 0.5) {
  const shades = placed(res).filter((q) => names.test(q.name));
  const all = M.Manifold.union(shades.map((q) => q.m));
  const b = all.boundingBox();
  const leaks: number[] = [];
  for (let z = b.min[2] + 0.3; z < b.max[2] - 0.3; z += step) {
    // closed: a wall ring around the axis (a hole contour around it) or a floor across it
    const polys = contours(all.slice(z));
    if (!polys.some((p) => inside([0, 0], p))) leaks.push(Math.round(z * 10) / 10);
  }
  return leaks;
}

/** The kv rows of the info panel. */
const kv = (res: BuildResult) => {
  const b = res.info.find((q) => q.kind === 'kv');
  return b && b.kind === 'kv' ? Object.fromEntries(b.rows) : {};
};

describe('dichte lamp: verborgen ventilatie', () => {
  const globe = (v: Partial<Params> = {}) => lamp('pendant', [{ shape: 'cilinder', d: 46, h: 30 }, { shape: 'kap', kap: 'koepel', d: 240, h: 120 }], { closed: true, bulb27: 'a60', ...v });

  it.each([
    ['hanglamp, printbuis', globe()],
    ['hanglamp, M10', globe({ connection: 'm10' })],
    ['hanglamp met opening', globe({ closedShape: 'binnen', closedOpen: 90 })],
    ['tafellamp', lamp('table', [{ shape: 'kap', kap: 'koepel', d: 220, h: 110 }, { shape: 'bol', d: 80, h: 60 }], { closed: true, socket: 'e14', bulb14: 'g45' })],
    ['stijlen op de kap', lamp('pendant', [{ shape: 'schijf', d: 160, h: 10 }, { shape: 'stijlen', d: 100, h: 30, n: 4, var: 20 }, { shape: 'kap', kap: 'koepel', d: 240, h: 120 }], { closed: true })],
  ])('%s: no hole visible from the side, enough open area, printable', async (_n, p) => {
    const res = await buildTool(M, tool, p);
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    expect(leakHeights(res, /Kap$|Onderkap|Bovenkap/)).toEqual([]);
    const row = kv(res).Ventilatie;
    expect(row).toMatch(/^verborgen/);
    const nums = [...row.matchAll(/(uit|in) ≈ (\d+) mm²/g)].map((m) => Number(m[2]));
    expect(nums.length).toBe(2);
    for (const a of nums) expect(a).toBeGreaterThanOrEqual(60);
    // the channels really go through: every vent is a handle of the kap
    const kap = res.parts.find((q) => /\. Kap$/.test(q.name))!;
    expect(solidOf(kap).genus()).toBeGreaterThanOrEqual(6);
    expect(res.tips.some((t) => /verborgen/.test(t))).toBe(true);
  });

  it('exhaust leaves under the rim of the part above; intake slits at the seam end on the neck', async () => {
    const res = await buildTool(M, tool, globe());
    expect(kv(res).Ventilatie).toMatch(/onder de rand van het deel erboven \(1\. Cilinder\)/);
    expect(kv(res).Ventilatie).toMatch(/sleufjes in de naad/);
    const solids = placed(res);
    const under = solids.find((q) => q.name.endsWith('Onderkap'))!;
    const kap = solids.find((q) => q.name === '2. Kap')!;
    const seam = under.m.boundingBox().max[2];
    const both = M.Manifold.union([under.m, kap.m]);
    // a look straight into a seam slit (just under the seam, at the slit's angle) hits the threaded neck
    for (let j = 0; j < HIDDEN.n; j++) {
      const th = ((j + 0.5) * 2 * Math.PI) / HIDDEN.n;
      for (const dz of [0.5, 1.2]) {
        const ray = M.Manifold.cube([200, 0.4, 0.4], true).translate([100, 0, seam - dz]).rotate([0, 0, (th * 180) / Math.PI]);
        // look from outside to the axis: the ray hits material somewhere, and the slit itself is open at the rim
        expect(ray.intersect(both).volume()).toBeGreaterThan(0.01);
      }
    }
  });

  it('visible vents leak (the test sees them), none gives a warning', async () => {
    const holes = await buildTool(M, tool, globe({ vent: 'gaatjes' }));
    expect(leakHeights(holes, /Kap$|Onderkap/).length).toBeGreaterThan(0);
    expect(kv(holes).Ventilatie).toMatch(/zichtbare gaatjes/);
    const none = await buildTool(M, tool, globe({ vent: 'geen' }));
    expect(none.warnings.some((w) => /zonder ventilatie/.test(w) && /5 W/.test(w) && /PETG/.test(w))).toBe(true);
    expect(kv(none).Ventilatie).toMatch(/geen/);
    // the kap only has its bore for the tube, the second shade nothing at all
    expect(solidOf(none.parts.find((q) => q.name === '2. Kap')!).genus()).toBe(1);
    expect(solidOf(none.parts.find((q) => q.name.endsWith('Onderkap'))!).genus()).toBe(0);
    expect(leakHeights(none, /Kap$|Onderkap/)).toEqual([]);
    // the LED tip stays
    expect(none.tips.some((t) => /LED/.test(t))).toBe(true);
  });
});

describe('dichte lamp: naar binnen met opening', () => {
  const inward = (v: Partial<Params> = {}) =>
    lamp('pendant', [{ shape: 'cilinder', d: 46, h: 30 }, { shape: 'kap', kap: 'koepel', d: 240, h: 120 }], { closed: true, closedShape: 'binnen', bulb27: 'a60', ...v });

  it.each([
    ['recht, opening 100', inward({ closedWall: 'recht', closedDrop: 40, closedOpen: 100 })],
    ['volgt de kap', inward({ closedWall: 'kap', closedDrop: 30, closedOpen: 120 })],
    ['kort recht stuk', inward({ closedDrop: 0, closedOpen: 80 })],
    ['plissé kegel', inward({ s2Kap: 'kegel', s2Var: 10, s2Tex: 'plisse', s2TexN: 120, closedOpen: 90 })],
    ['tafellamp (opening boven)', lamp('table', [{ shape: 'kap', kap: 'koepel', d: 220, h: 110 }, { shape: 'bol', d: 80, h: 60 }], { closed: true, closedShape: 'binnen', closedOpen: 80, socket: 'e14', bulb14: 'g45' })],
    ['M10', inward({ connection: 'm10' })],
  ])('%s: opening as asked, 45° bend, bulb clear, seam fits', async (_n, p) => {
    const res = await buildTool(M, tool, p);
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    expect(res.warnings.some((w) => /tussen de lamp/.test(w))).toBe(false);
    const second = res.parts.find((q) => /Onderkap|Bovenkap/.test(q.name))!;
    expect(second.select).toBe('closed');
    // print orientation: the opening on the bed — its inside is the asked diameter (the lip)
    const s = solidOf(second);
    const lip = contours(s.slice(2));
    const hole = lip.find((q) => area(q) < 0)!;
    const r = hole.map((q) => Math.hypot(q[0], q[1]));
    expect(2 * Math.min(...r)).toBeCloseTo(Number(p.closedOpen), 0);
    // open: the part is a tube (genus 1 plus its seam slits)
    expect(s.genus()).toBeGreaterThanOrEqual(1);
    // the seam still closes: the kap's neck sits in the band
    const solids = placed(res);
    const kap = solids.find((q) => /\. Kap$/.test(q.name))!;
    const sec = solids.find((q) => q.name === second.name)!;
    const pend = p.lampType === 'pendant';
    const seamZ = pend ? sec.m.boundingBox().max[2] : sec.m.boundingBox().min[2];
    expect(pend ? kap.m.boundingBox().min[2] : kap.m.boundingBox().max[2]).toBeCloseTo(pend ? seamZ - 10 : seamZ + 10, 0);
    expect(leakHeights(res, /Kap$|Onderkap|Bovenkap/)).toEqual([]);
  });

  it('an opening wider than the bulb: change the bulb through it; too wide: made smaller with a note', async () => {
    const wide = await buildTool(M, tool, inward({ bulb27: 'a60', closedOpen: 110 }));
    expect(wide.tips.some((t) => /door de opening/.test(t))).toBe(true);
    const narrow = await buildTool(M, tool, inward({ bulb27: 'a60', closedOpen: 50 }));
    expect(narrow.tips.some((t) => /Draai de onderkap los/.test(t))).toBe(true);
    const huge = await buildTool(M, tool, inward({ closedOpen: 240 }));
    expect(huge.warnings.some((w) => /opening Ø/.test(w))).toBe(true);
    checkParts(huge, 'te grote opening');
  });

  it('a bend that would hit the bulb: clear message', async () => {
    // a long bulb hanging far below a short kap (seam not at the bulb's middle)
    await expect(buildTool(M, tool, inward({ bulb27: 'st64', centerBulb: false, s2H: 60, closedDrop: 0, closedOpen: 40 }))).rejects.toThrow(/raakt de bocht/);
  });
});

describe('blote lamp aan een ring', () => {
  it('Roze ring met blote lamp: bulb clear of the rings, cup in the ring colour, the globe below', async () => {
    const v = preset('Roze ring');
    const res = await buildTool(M, tool, params(v));
    checkParts(res, 'blote lamp');
    expect(overlaps(res)).toEqual([]);
    expect(res.warnings.some((w) => /tussen de lamp/.test(w))).toBe(false);
    const cup = res.parts.find((q) => q.name.startsWith('Schroefbuis'))!;
    expect(cup.color).toBe(v.cupColor);
    const bulb = res.scene!.find((s) => s.kind === 'mesh' && s.label?.startsWith('G95'));
    expect(bulb).toBeTruthy();
    if (!bulb || bulb.kind !== 'mesh') return;
    const zs = Array.from(bulb.mesh.positions).filter((_, i) => i % 3 === 2);
    const ring = placed(res).find((q) => q.name.endsWith('Ribbelring'))!;
    // the globe hangs below the rings
    expect(Math.max(...zs)).toBeLessThan(ring.m.boundingBox().min[2]);
  });

  it('without a kap the cup takes the colour of the part above (automatic)', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'ribring', d: 160, h: 14, n: 30 }, { shape: 'cilinder', d: 70, h: 14, color: '#2f5aa8' }], { bulb27: 'g80' }));
    expect(res.parts.find((q) => q.name.startsWith('Schroefbuis'))!.color).toBe('#2f5aa8');
    expect(res.warnings.some((w) => /tussen de lamp/.test(w))).toBe(false);
    checkParts(res, 'auto');
  });
});

describe('nieuwe voorbeelden', () => {
  it.each(['Gele koker', 'Rode kartelkap', 'Roze ring', 'Blauw-oranje', 'Dichte bol met opening'])('%s: builds, support-free, mapped', async (name) => {
    const p = params(preset(name));
    const res = await buildTool(M, tool, p);
    checkParts(res, name);
    for (const part of res.parts) {
      const s = parseSel(part.select);
      expect(selKey(s), `${part.name}`).toBe(part.select);
      expect(selValid(s, p), `${part.name}`).toBe(true);
    }
    // coloured caps are matte, translucent parts see-through
    const cap = res.parts.find((q) => q.name.startsWith('Topkapje'));
    if (p.capColor !== 'auto') expect(cap?.material).toBe('pla-matte');
  });
});
