import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params } from '../src/core/types';
import { lampTool as tool } from '../src/tools/lamp';
import { KAP_OPTIONS, SHAPE_OPTIONS, TEXTURE_OPTIONS } from '../src/tools/lampParts';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;

/** Segment values for slot i. */
function seg(i: number, v: Record<string, string | number | boolean>): Partial<Params> {
  const out: Partial<Params> = { [`s${i}Tex`]: 'glad' };
  for (const [k, x] of Object.entries(v)) out[`s${i}${k[0].toUpperCase()}${k.slice(1)}`] = x;
  return out;
}
const lamp = (type: 'table' | 'pendant', segs: Record<string, string | number | boolean>[], extra: Partial<Params> = {}) =>
  params({ lampType: type, count: segs.length, ...Object.assign({}, ...segs.map((s, i) => seg(i + 1, s))), ...extra });

/** Placed solids of the assembled view (printed parts only). */
function placed(res: BuildResult) {
  const meshes = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
  const out: { label: string; m: Manifold }[] = [];
  res.scene!.forEach((s, i) => {
    if (s.kind === 'part') out.push({ label: `${res.parts[s.part].name}#${i}`, m: meshes[s.part].transform(s.matrix as unknown as Mat4) });
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

/** The M10 tube (Ø10) along the axis must pass every part of the stack. */
function boreBlocked(res: BuildResult) {
  const tube = res.scene!.find((s) => s.kind === 'box' && s.label?.startsWith('Draadbuis'));
  if (!tube || tube.kind !== 'box') throw new Error('no tube');
  const rod = M.Manifold.cylinder(tube.size[2], 5, 5, 48).translate([0, 0, tube.position[2]]);
  return placed(res)
    .map((s) => ({ label: s.label, v: s.m.intersect(rod).volume() }))
    .filter((x) => x.v > 0.5)
    .map((x) => `${x.label}: ${x.v.toFixed(1)} mm³`);
}

function checkParts(res: BuildResult, label: string) {
  for (const part of res.parts) {
    expect(part.volume, `${label} ${part.name}`).toBeGreaterThan(0);
    expect(fitsOn(DEFAULT_PRINTER, part.size), `${label} ${part.name} past niet`).toBe(true);
    // prints without support: only tessellation crumbs
    expect(overhangArea(part), `${label} ${part.name} overhang`).toBeLessThan(25);
  }
}

const SOLID = SHAPE_OPTIONS.map((o) => o.value).filter((s) => !['kap', 'lamel', 'stijlen'].includes(s));
const TEXTURES = TEXTURE_OPTIONS.map((o) => o.value);

describe('lampsegmenten: elke vorm × elke textuur', () => {
  const cases = SOLID.flatMap((shape) => TEXTURES.map((tex) => [shape, tex] as const));
  it.each(cases)('%s / %s', async (shape, tex) => {
    // the shape between two discs, so it gets centring cones on both faces
    const res = await buildTool(
      M,
      tool,
      lamp('table', [
        { shape: 'schijf', d: 120, h: 10 },
        { shape, d: shape === 'hals' ? 30 : 110, h: ['bloem', 'tandwiel', 'schijf', 'kussen'].includes(shape) ? 18 : 70, var: 40, n: shape === 'tandwiel' ? 20 : 5, tex, texN: tex === 'ringen' ? 6 : 96 },
        { shape: 'schijf', d: 120, h: 10 },
      ]),
    );
    checkParts(res, `${shape}/${tex}`);
    expect(overlaps(res)).toEqual([]);
    expect(boreBlocked(res)).toEqual([]);
  });

  it.each(['bol', 'kegel', 'koepel', 'boog', 'trap', 'tol'])('%s ondersteboven', async (shape) => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'cilinder', d: 60, h: 30 }, { shape, d: 120, h: 80, var: 20, n: 3, flip: true, tex: 'plisse', texN: 60 }]));
    checkParts(res, shape);
    expect(overlaps(res)).toEqual([]);
    expect(boreBlocked(res)).toEqual([]);
  });

  it('fijne plissé (180 vouwen) en grove ribbels', async () => {
    for (const [tex, texN] of [['plisse', 180], ['ribbels', 24], ['ribbels', 150]] as const) {
      const res = await buildTool(M, tool, lamp('table', [{ shape: 'bol', d: 140, h: 120, tex, texN }]));
      checkParts(res, `${tex} ${texN}`);
    }
  });
});

describe('kappen en lamellen', () => {
  const cases = KAP_OPTIONS.map((o) => o.value).flatMap((kap) => TEXTURES.map((tex) => [kap, tex] as const));
  it.each(cases)('hangende kap %s / %s', async (kap, tex) => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'bol', d: 70, h: 56 }, { shape: 'kap', kap, d: 220, h: 140, var: 20, n: 4, tex, texN: tex === 'ringen' ? 8 : 120 }], { bulb27: 'a60' }));
    checkParts(res, `${kap}/${tex}`);
    expect(overlaps(res)).toEqual([]);
    expect(boreBlocked(res)).toEqual([]);
    // the shade is open at the bottom and much lighter than a solid of the same size
    const shade = res.parts.find((q) => q.name.includes('Kap'))!;
    expect(shade.volume).toBeLessThan(0.25 * Math.PI * 110 * 110 * 140);
  });

  it.each(KAP_OPTIONS.map((o) => o.value))('staande kap (uplight) %s', async (kap) => {
    const res = await buildTool(M, tool, lamp('table', [{ shape: 'kap', kap, d: 200, h: 110, var: 30, n: 4 }, { shape: 'hals', d: 26, h: 80 }], { socket: 'e14', bulb14: 'g45' }));
    checkParts(res, kap);
    expect(overlaps(res)).toEqual([]);
  });

  it('lamellen hangen aan stijlen onder de kap (louvre)', async () => {
    const preset = tool.presets!.find((q) => q.name.startsWith('Lagenkoepel'))!;
    const res = await buildTool(M, tool, params(preset.values));
    checkParts(res, 'louvre');
    expect(overlaps(res)).toEqual([]);
    expect(res.parts.filter((q) => q.name.includes('Lamel'))).toHaveLength(3);
    const pins = res.parts.filter((q) => q.name.includes('Stijlen'));
    expect(pins).toHaveLength(3);
    for (const p of pins) expect(p.quantity).toBe(4);
  });

  it('stijlen tussen schijven: zwevende schijven op pennen', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [
      { shape: 'koepel', d: 160, h: 60 },
      { shape: 'stijlen', d: 90, h: 40, n: 4, var: 20 },
      { shape: 'schijf', d: 220, h: 8 },
      { shape: 'stijlen', d: 90, h: 40, n: 4, var: 20 },
      { shape: 'schijf', d: 180, h: 8 },
      { shape: 'kap', kap: 'cilinder', d: 150, h: 80 },
    ]));
    checkParts(res, 'stijlen');
    expect(overlaps(res)).toEqual([]);
    expect(boreBlocked(res)).toEqual([]);
    expect(res.parts.filter((q) => q.name.includes('Stijlen')).map((q) => q.quantity)).toEqual([4, 4]);
  });

  it('stijlen zonder buurman worden een hals', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'stijlen', d: 60, h: 30 }, { shape: 'bol', d: 80, h: 70 }]));
    expect(res.warnings.some((w) => w.includes('hals'))).toBe(true);
    expect(res.parts.some((q) => q.name.includes('Stijlen'))).toBe(false);
  });
});

describe('stapel en bevestiging', () => {
  it.each(tool.presets!.map((p) => [p.name, p.values] as const))('voorbeeld %s: printbaar, buis vrij, past', async (_n, v) => {
    const res = await buildTool(M, tool, params(v));
    checkParts(res, _n);
    expect(boreBlocked(res)).toEqual([]);
    expect(res.defaultView).toBe('assembly');
    // every segment has its own colour in the viewer
    for (const part of res.parts) expect(part.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('centreerkegels: de segmenten van de standaardlamp grijpen in elkaar', async () => {
    const res = await buildTool(M, tool, base);
    const bol = res.parts.find((q) => q.name === '2. Bol')!;
    // body 62 mm + a 1.8 mm spigot
    expect(bol.size[2]).toBeCloseTo(62 + 1.8, 0);
    expect(overlaps(res)).toEqual([]);
  });

  it('tafellamp: voet met bodemplaat, kabelsleuf en stabiliteit', async () => {
    const res = await buildTool(M, tool, base);
    const names = res.parts.map((q) => q.name);
    expect(names).toContain('Voet');
    expect(names).toContain('Bodemplaat');
    expect(names).toContain('Fittingkraag');
    const kv = res.info.find((b) => b.kind === 'kv')!;
    expect(kv.kind === 'kv' && kv.rows.some(([k]) => k === 'Kantelhoek')).toBe(true);
    const hw = res.info.find((b) => b.title === 'Benodigdheden')!;
    expect(hw.kind === 'table' && hw.rows.some((r) => String(r[1]).includes('M10x1'))).toBe(true);
  });

  it('topzware tafellamp geeft een waarschuwing', async () => {
    const res = await buildTool(
      M,
      tool,
      lamp('table', [
        { shape: 'bol', d: 200, h: 180 },
        { shape: 'bol', d: 200, h: 180 },
        { shape: 'hals', d: 26, h: 250 },
      ], { baseD: 90, baseH: 30, ballast: 'geen', bulb27: 'g125' }),
    );
    expect(res.warnings.some((w) => w.includes('topzwaar') || w.includes('wankel'))).toBe(true);
  });

  it('hanglamp: kapje, plafondkap met schroefgaten en trekontlasting', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'bol', d: 80, h: 64 }, { shape: 'kap', kap: 'koepel', d: 220, h: 120 }]));
    const names = res.parts.map((q) => q.name);
    expect(names).toContain('Plafondkap');
    expect(names).toContain('Kapje trekontlasting');
    const can = res.parts.find((q) => q.name === 'Plafondkap')!;
    expect(can.size[0]).toBeCloseTo(110, 0);
    const hw = res.info.find((b) => b.title === 'Benodigdheden')!;
    expect(hw.kind === 'table' && hw.rows.some((r) => String(r[1]).includes('Trekontlasting'))).toBe(true);
  });

  it.each(['e27', 'e14', 'g9'])('fitting %s past in kap en kraag', async (socket) => {
    const pend = await buildTool(M, tool, lamp('pendant', [{ shape: 'cilinder', d: 50, h: 30 }, { shape: 'kap', kap: 'kegel', d: 180, h: 120, var: 0 }], { socket }));
    checkParts(pend, socket);
    const table = await buildTool(M, tool, lamp('table', [{ shape: 'bol', d: 90, h: 70 }], { socket }));
    expect(table.parts.some((q) => q.name === 'Fittingkraag')).toBe(true);
    expect(overlaps(table)).toEqual([]);
  });
});

describe('lamp en veiligheid', () => {
  const kap = (d: number) => lamp('pendant', [{ shape: 'bol', d: 70, h: 56 }, { shape: 'kap', kap: 'cilinder', d, h: 150 }], { bulb27: 'g95' });

  it('lamp raakt de kap → nette foutmelding', async () => {
    await expect(buildTool(M, tool, kap(96))).rejects.toMatchObject({ user: true });
  });

  it('te weinig ruimte → waarschuwing, ruim genoeg → niets', async () => {
    const tight = await buildTool(M, tool, kap(115));
    expect(tight.warnings.some((w) => w.includes('tussen de lamp'))).toBe(true);
    const roomy = await buildTool(M, tool, kap(200));
    expect(roomy.warnings.some((w) => w.includes('tussen de lamp'))).toBe(false);
    expect(roomy.tips.some((t) => t.includes('LED'))).toBe(true);
  });
});

describe('ongeldige combinaties geven een leesbare melding', () => {
  it.each([
    ['kap in het midden', lamp('pendant', [{ shape: 'kap', kap: 'koepel', d: 200, h: 100 }, { shape: 'bol', d: 80, h: 60 }])],
    ['lamel zonder kap', lamp('pendant', [{ shape: 'bol', d: 80, h: 60 }, { shape: 'lamel', d: 150, h: 8 }])],
    ['twee kappen', lamp('pendant', [{ shape: 'kap', d: 200, h: 100 }, { shape: 'kap', d: 200, h: 100 }])],
    ['alleen stijlen', lamp('table', [{ shape: 'stijlen', d: 60, h: 30 }])],
    ['lamel direct onder de kap', lamp('pendant', [{ shape: 'kap', d: 200, h: 100 }, { shape: 'lamel', d: 150, h: 8 }])],
  ])('%s', async (_n, p) => {
    await expect(buildTool(M, tool, p)).rejects.toMatchObject({ user: true });
  });

  it('te groot voor de printer', async () => {
    const mini = PRINTERS.find((q) => q.id === 'a1mini')!;
    await expect(buildTool(M, tool, lamp('table', [{ shape: 'bol', d: 240, h: 150 }]), mini)).rejects.toThrow(/past niet/);
  });
});

describe('verras me', () => {
  it('15 willekeurige lampen bouwen of geven een nette melding', async () => {
    let built = 0;
    for (let i = 0; i < 15; i++) {
      const p = params(tool.randomize!({} as Params));
      try {
        const res = await buildTool(M, tool, p);
        for (const part of res.parts) expect(overhangArea(part), `${part.name} ${JSON.stringify(p)}`).toBeLessThan(25);
        built++;
      } catch (e) {
        expect((e as { user?: boolean }).user, `${(e as Error).message} ${JSON.stringify(p)}`).toBe(true);
      }
      collect();
    }
    expect(built).toBeGreaterThan(8);
  });
});
