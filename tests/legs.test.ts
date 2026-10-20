import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { LEG_PROFILES, LEG_SECTIONS, buildLeg, buildRing, type LegSpec } from '../src/geom/legs';
import { furnitureTool } from '../src/tools/furniture';
import { defaultsOf, type BuildResult, type Params } from '../src/core/types';
import { DEFAULT_PRINTER, PRINTERS, fitsOn, usable } from '../src/core/printer';
import { buildTool } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = (over: Partial<LegSpec> = {}): LegSpec => ({
  height: 120, diameter: 40, profile: 'taper', foot: 0.6, ball: 1.35, waist: 0.6,
  section: { shape: 'circle', count: 6, depth: 0.25, rounding: 0.5, seed: 7, m: 6, n1: 1, n2: 1.7, n3: 1.7 },
  twist: 0, splay: 0, lean: 0, plate: 'round', plateT: 5, holes: 4, core: 'auto', bottom: 'felt', ...over,
});

/** Material left inside a thin probe through a screw hole (should be none). */
function holeIsOpen(solid: Manifold, x: number, y: number, T: number) {
  const probe = M.Manifold.cylinder(T - 0.2, 1.2, 1.2, 16).translate([x, y, 0.1]);
  return solid.intersect(probe).volume() < 0.05;
}

describe('poten: elk profiel × elke doorsnede', () => {
  const cases: [string, string][] = [];
  for (const p of LEG_PROFILES) for (const s of LEG_SECTIONS) cases.push([p.value, s]);
  it.each(cases)('%s / %s', (profile, shape) => {
    const twist = shape === 'circle' ? 0 : 90;
    const leg = buildLeg(M, base({ profile, section: { ...base().section, shape }, twist, holes: shape.length % 2 ? 3 : 4 }));
    try {
      expect(leg.solid.status()).toBe('NoError');
      expect(leg.solid.volume()).toBeGreaterThan(1000);
      expect(leg.solid.genus()).toBeGreaterThanOrEqual(leg.holes.length);
      const b = leg.solid.boundingBox();
      expect(b.min[2]).toBeCloseTo(0, 3);
      expect(b.max[2]).toBeCloseTo(120, 1);
      expect(leg.holes).toHaveLength(shape.length % 2 ? 3 : 4);
      for (const [x, y] of leg.holes) {
        expect(holeIsOpen(leg.solid, x, y, 5)).toBe(true);
        // the screw head must stay clear of the body
        expect(Math.hypot(x, y) + 4.3).toBeLessThanOrEqual(leg.plateR + 0.01);
      }
    } finally {
      collect();
    }
  });

  it.each(['round', 'square', 'shape'])('montageplaat %s met schuine, gedraaide poot en stelvoet', (plate) => {
    const leg = buildLeg(M, base({ plate, splay: 12, lean: 30, twist: 120, section: { ...base().section, shape: 'star', count: 5 }, bottom: 'level', height: 180, core: 'm8' }));
    try {
      expect(leg.solid.status()).toBe('NoError');
      const b = leg.solid.boundingBox();
      expect(b.min[2]).toBeCloseTo(0, 3);
      expect(b.max[2]).toBeCloseTo(180, 1);
      expect(leg.core?.label).toContain('M8');
      for (const [x, y] of leg.holes) expect(holeIsOpen(leg.solid, x, y, 5)).toBe(true);
      // the foot leans out by roughly L·sin(12°)
      expect(Math.hypot(...leg.foot)).toBeGreaterThan(30);
    } finally {
      collect();
    }
  });

  it('te korte poot geeft een nette melding', () => {
    expect(() => buildLeg(M, base({ height: 12 }))).toThrow(/minstens/);
    expect(() => buildLeg(M, base({ height: 30, bottom: 'level' }))).toThrow(/stelvoet/);
    collect();
  });
});

const params = (v: Partial<Params>): Params => ({ ...defaultsOf(furnitureTool.params), ...v } as Params);

/** Every printed part fits the bed and every scene item is a valid placement. */
function checkResult(res: BuildResult, printer = DEFAULT_PRINTER) {
  expect(res.parts.length).toBeGreaterThan(0);
  for (const p of res.parts) {
    expect(p.volume).toBeGreaterThan(0);
    expect(fitsOn(printer, p.size), `${p.name} ${p.size.map((v) => v.toFixed(0)).join('×')}`).toBe(true);
  }
  expect(res.scene?.length).toBeGreaterThan(0);
}

/** No two scene solids overlap; every printed part touches wood. */
function checkAssembly(res: BuildResult) {
  const parts = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
  const solids: { label: string; m: Manifold; printed: boolean }[] = [];
  for (const [i, s] of (res.scene ?? []).entries()) {
    if (s.kind === 'part') solids.push({ label: `${res.parts[s.part].name}#${i}`, m: parts[s.part].transform(s.matrix as unknown as Mat4), printed: true });
    else if (s.material !== 'ghost') solids.push({ label: `${s.label ?? 'plank'}#${i}`, m: M.Manifold.cube(s.size).translate(s.position), printed: false });
  }
  const overlaps: string[] = [];
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++) {
      if (!solids[a].printed && !solids[b].printed) continue;
      const ba = solids[a].m.boundingBox();
      const bb = solids[b].m.boundingBox();
      if ([0, 1, 2].some((k) => ba.max[k] < bb.min[k] - 0.01 || bb.max[k] < ba.min[k] - 0.01)) continue;
      const v = solids[a].m.intersect(solids[b].m).volume();
      if (v > 2) overlaps.push(`${solids[a].label} ∩ ${solids[b].label} = ${v.toFixed(1)} mm³`);
    }
  expect(overlaps).toEqual([]);
  const wood = M.Manifold.union(solids.filter((s) => !s.printed).map((s) => s.m));
  for (const s of solids.filter((x) => x.printed)) expect(s.m.minGap(wood, 5), `${s.label} raakt geen hout`).toBeLessThan(1);
  // everything stands on the floor (z = 0), nothing sinks below it
  const zMin = Math.min(...solids.map((s) => s.m.boundingBox().min[2]));
  expect(zMin).toBeGreaterThan(-0.05);
  expect(zMin).toBeLessThan(0.05);
}

describe('verhoging / plankstandaard', () => {
  const forms: Partial<Params>[] = [
    { boardForm: 'rect', width: 500, depth: 260 },
    { boardForm: 'rounded', width: 420, depth: 300, boardRadius: 60 },
    { boardForm: 'circle', boardDia: 320 },
    { boardForm: 'oval', width: 480, depth: 300 },
    { boardForm: 'shape', boardShape: 'cloud', width: 480, depth: 360 },
    { boardForm: 'shape', boardShape: 'petals', boardCount: 5, width: 400, depth: 400 },
  ];
  const variants: [string, Partial<Params>][] = [
    ['poten', { riserH: 90 }],
    ['5 schuine poten', { riserH: 120, legCount: '5', legSplay: 10, legProfile: 'scandi' }],
    ['etagère 3 lagen', { riserH: 60, tiers: 3, tierScale: 85, tierGap: 120, legProfile: 'bun', legD: 30, legInset: 10 }],
  ];
  const cases: [string, string, Partial<Params>][] = [];
  for (const f of forms) for (const [name, v] of variants) cases.push([`${f.boardForm}${f.boardShape ? `/${f.boardShape}` : ''}`, name, { ...f, ...v }]);
  cases.push(['shape/custom', 'poten', { boardForm: 'shape', boardShape: 'custom', boardFile: 'upload:test-star', width: 700, depth: 700, legCount: '5', legD: 30 }]);
  cases.push(['circle', 'ring', { boardForm: 'circle', boardDia: 320, riserSupport: 'ring', ringPattern: 'diamonds' }]);
  cases.push(['circle', 'ring + etagère', { boardForm: 'circle', boardDia: 400, riserSupport: 'ring', ringPattern: 'slots', tiers: 2, tierGap: 140 }]);
  it.each(cases)('%s / %s', async (_f, _v, v) => {
    const res = await buildTool(M, furnitureTool, params({ kind: 'riser', ...v }));
    try {
      checkResult(res);
      checkAssembly(res);
      const cut = res.info.find((b) => b.kind === 'table' && b.title === 'Zaaglijst');
      expect(cut && cut.kind === 'table' ? cut.rows.length : 0).toBe(Number(v.tiers ?? 1));
      if (v.tiers) expect(res.parts.some((p) => p.name === 'Zuil etagère')).toBe(true);
      expect(res.ms).toBeLessThan(3000);
    } finally {
      collect();
    }
  });

  it('rond plankje krijgt standaard 3 poten, rechthoek 4', async () => {
    const r = await buildTool(M, furnitureTool, params({ kind: 'riser', boardForm: 'circle' }));
    const q = await buildTool(M, furnitureTool, params({ kind: 'riser', boardForm: 'rect', width: 400, depth: 300 }));
    expect(r.parts[0].quantity).toBe(3);
    expect(q.parts[0].quantity).toBe(4);
    const cut = r.info.find((b) => b.kind === 'table' && b.title === 'Zaaglijst');
    expect(JSON.stringify(cut)).toContain('Ø300');
  });

  it('ring alleen onder een rond plankje', async () => {
    const res = await buildTool(M, furnitureTool, params({ kind: 'riser', boardForm: 'rect', riserSupport: 'ring' }));
    expect(res.warnings.join(' ')).toMatch(/ring/);
    expect(res.parts[0].name).toBe('Poot');
  });
});

describe('ringsegmenten passen op de printplaat', () => {
  it.each([200, 300, 350, 500, 800, 1200])('Ø%i mm', async (dia) => {
    for (const printer of [DEFAULT_PRINTER, PRINTERS.find((p) => p.id === 'a1mini')!]) {
      const res = await buildTool(M, furnitureTool, params({ kind: 'riser', boardForm: 'circle', boardDia: dia, riserH: 100, riserSupport: 'ring', legInset: 10 }), printer);
      checkResult(res, printer);
      const ring = res.parts[0];
      const ro = dia / 2 - 10;
      if (2 * ro > usable(printer).y) expect(ring.quantity).toBeGreaterThan(1);
      else expect(ring.quantity).toBe(1);
      if (dia <= 500 && printer === DEFAULT_PRINTER) checkAssembly(res);
      collect();
    }
  });

  it('segmenten sluiten met speling op elkaar aan', () => {
    const ring = buildRing(M, { radius: 300, height: 80, wall: 4, pattern: 'none', bed: { x: 320, y: 310 } });
    try {
      expect(ring.segments).toBeGreaterThan(1);
      const a = ring.solid;
      const b = a.rotate([0, 0, ring.angle]);
      expect(a.intersect(b).volume()).toBeLessThan(0.5);
      expect(a.minGap(b, 2)).toBeLessThan(0.4);
      // the dovetail locks: pulling the neighbour away along the joint makes them collide
      const h = (ring.angle / 2) * (Math.PI / 180);
      const pulled = b.translate([-Math.sin(h) * 1, Math.cos(h) * 1, 0]);
      expect(a.intersect(pulled).volume()).toBeGreaterThan(2);
    } finally {
      collect();
    }
  });
});

describe('poten onder kasten', () => {
  const cases: [string, Partial<Params>][] = [
    ['kastje 4 poten', { kind: 'box', width: 400, depth: 300, height: 400, plankT: 12, insert: 18, wall: 2.6, cabLegs: '4', legH: 120 }],
    ['kastje 6 schuine poten', { kind: 'box', width: 700, depth: 350, height: 400, plankT: 18, cabLegs: '6', legH: 150, legSplay: 12, legProfile: 'scandi' }],
    ['kastje vierkante plaat', { kind: 'box', width: 500, depth: 300, height: 350, plankT: 12, cabLegs: '4', legH: 60, legPlate: 'square', legProfile: 'bun', edges: 'full' }],
    ['kast 4 poten', { kind: 'shelf', cabLegs: '4', legH: 100 }],
    ['kast 6 poten, 3 verbinders', { kind: 'shelf', width: 1400, depth: 400, height: 450, cols: 3, rows: 1, perNode: '3', cabLegs: '6', legH: 120, legPlate: 'shape', legSecShape: 'cross', legSecCount: 4 }],
    ['kast oneven kolommen, schuin', { kind: 'shelf', width: 1200, cols: 3, cabLegs: '6', legH: 140, legSplay: 15, legPlate: 'square' }],
  ];
  it.each(cases)('%s', async (_n, v) => {
    const res = await buildTool(M, furnitureTool, params(v));
    try {
      checkResult(res);
      checkAssembly(res);
      const legs = res.parts.find((p) => p.name === 'Meubelpoot');
      expect(legs?.quantity).toBe(Number(v.cabLegs));
      // the whole cabinet is lifted by the leg height
      const boxes = (res.scene ?? []).filter((s) => s.kind === 'box');
      const zMin = Math.min(...boxes.map((s) => (s.kind === 'box' ? s.position[2] : 0)));
      expect(zMin).toBeGreaterThanOrEqual(Number(v.legH) - 0.01);
    } finally {
      collect();
    }
  });
});

describe('losse poten', () => {
  it.each([1, 3, 4, 7])('%i poten', async (n) => {
    const res = await buildTool(M, furnitureTool, params({ kind: 'legs', legQty: n, legH: 150, legProfile: 'hourglass', legSecShape: 'blob' }));
    try {
      checkResult(res);
      checkAssembly(res);
      expect(res.parts[0].quantity).toBe(n);
    } finally {
      collect();
    }
  });

  it('te hoge poot voor de printer', async () => {
    const a1mini = PRINTERS.find((p) => p.id === 'a1mini')!;
    await expect(buildTool(M, furnitureTool, params({ kind: 'legs', legH: 250 }), a1mini)).rejects.toThrow(/te hoog/);
  });
});
