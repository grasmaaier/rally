import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params, type PartResult } from '../src/core/types';
import { lampTool as tool } from '../src/tools/lamp';
import { FIT_GUIDE, clickOf, fitDims, tubePieceSolid, tubeSys, validLen } from '../src/tools/lampTube';
import { SHELL_SHAPES } from '../src/tools/lampShell';
import { TEXTURE_OPTIONS } from '../src/tools/lampParts';
import { parseSel, selKey, selValid } from '../src/designer/lampModel';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;

function seg(i: number, v: Record<string, string | number | boolean>): Partial<Params> {
  const out: Partial<Params> = { [`s${i}Tex`]: 'glad' };
  for (const [k, x] of Object.entries(v)) out[`s${i}${k[0].toUpperCase()}${k.slice(1)}`] = x;
  return out;
}
const lamp = (type: 'table' | 'pendant', segs: Record<string, string | number | boolean>[], extra: Partial<Params> = {}) =>
  params({ lampType: type, count: segs.length, ...Object.assign({}, ...segs.map((s, i) => seg(i + 1, s))), ...extra });

const solidOf = (p: PartResult) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices })));

/** Placed solids of the assembled view (printed parts only). */
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

function checkParts(res: BuildResult, label: string, printer = DEFAULT_PRINTER) {
  for (const part of res.parts) {
    expect(part.volume, `${label} ${part.name}`).toBeGreaterThan(0);
    expect(fitsOn(printer, part.size), `${label} ${part.name} past niet`).toBe(true);
    expect(overhangArea(part), `${label} ${part.name} overhang`).toBeLessThan(25);
  }
}

const ring = (rIn: number, rOut: number, z0: number, z1: number) =>
  M.Manifold.cylinder(z1 - z0, rOut, rOut, 128).subtract(M.Manifold.cylinder(z1 - z0 + 2, rIn, rIn, 128).translate([0, 0, -1])).translate([0, 0, z0]);

/**
 * Every rim of every hollow segment is closed: just beyond each rim, the
 * neighbouring part covers an annulus inside the rim (the opening) and one
 * just outside it (the rim rests on it), clear of the centring groove.
 */
function openRims(res: BuildResult, wall: number, vented = /^$/) {
  const solids = placed(res);
  const out: string[] = [];
  for (const sh of solids.filter((q) => q.name.endsWith('(hol)'))) {
    const others = M.Manifold.union(solids.filter((q) => q !== sh).map((q) => q.m));
    const b = sh.m.boundingBox();
    const mesh = sh.m.getMesh();
    const P = mesh.vertProperties;
    for (const [z, sign] of [[b.min[2], -1], [b.max[2], 1]] as const) {
      let ro = 0;
      for (let i = 0; i < P.length; i += mesh.numProp) if (Math.abs(P[i + 2] - z) < 1e-3) ro = Math.max(ro, Math.hypot(P[i], P[i + 1]));
      const za = sign > 0 ? z + 0.15 : z - 0.45;
      const zones: [number, number][] = [[ro + 0.5, ro + 0.65]];
      if (ro - wall - 0.8 > 13.5 + 0.5) zones.push([13.5, ro - wall - 0.8]);
      for (const [r0, r1] of zones) {
        const probe = ring(r0, r1, za, za + 0.3);
        const covered = probe.intersect(others).volume() / probe.volume();
        // a rim on a kap ceiling with hidden vents: the channels run under it on purpose (holes and grooves)
        const need = vented.test(sh.name) ? 0.35 : 0.95;
        if (covered < need) out.push(`${sh.name} ${sign > 0 ? 'boven' : 'onder'} (r ${r0.toFixed(1)}–${r1.toFixed(1)}): ${(covered * 100).toFixed(0)}% dicht`);
      }
    }
  }
  return out;
}

const SHELLS = [...SHELL_SHAPES];
const TEXTURES = TEXTURE_OPTIONS.map((o) => o.value);

describe('geprinte schroefbuis: standaard en voorbeelden', () => {
  it('is the default: tube with click, discs, hollow shells, no M10 hardware', async () => {
    const res = await buildTool(M, tool, base);
    const names = res.parts.map((q) => q.name);
    expect(names).toContain('Schroefbuis met klik');
    expect(names.some((n) => n.startsWith('Tussenschijf'))).toBe(true);
    expect(names.some((n) => n.endsWith('(hol)'))).toBe(true);
    expect(res.scene!.some((s) => s.kind === 'box' && s.label?.startsWith('Draadbuis'))).toBe(false);
    const hw = res.info.find((b) => b.title === 'Benodigdheden')!;
    expect(hw.kind === 'table' && hw.rows.every((r) => !String(r[1]).includes('M10'))).toBe(true);
    expect(hw.kind === 'table' && hw.rows.some((r) => String(r[1]).includes('schroefring'))).toBe(true);
    const steps = res.info.find((b) => b.title === 'Montage')!;
    expect(steps.kind === 'text' && /klikken/.test(steps.text)).toBe(true);
    const kv = res.info.find((b) => b.kind === 'kv')!;
    expect(kv.kind === 'kv' && kv.rows.some(([k, v]) => k === 'Holle sierdelen' && /minder filament/.test(v))).toBe(true);
    expect(kv.kind === 'kv' && kv.rows.some(([k, v]) => k === 'Schroefbuis' && /zelfremmend/.test(v))).toBe(true);
    // hollow parts print in vase mode by default (filament estimate: one wall)
    for (const q of res.parts.filter((q) => q.name.endsWith('(hol)'))) expect(q.estimate).toBe('vase');
    const walls = await buildTool(M, tool, params({ shellPrint: 'walls', shellWall: 1.6 }));
    for (const q of walls.parts.filter((q) => q.name.endsWith('(hol)'))) expect(q.estimate).toBe('solid');
  });

  it.each(tool.presets!.map((p) => [p.name, p.values] as const))('voorbeeld %s: printbaar, dicht, geen botsingen', async (_n, v) => {
    const res = await buildTool(M, tool, params(v));
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    // closed lamps vent (hidden) through the kap ceiling under the part above
    const hidden = v.closed === true && (v.vent ?? 'verborgen') === 'verborgen';
    expect(openRims(res, 0.8, hidden ? /^1\. / : /^$/)).toEqual([]);
    for (const part of res.parts) {
      const s = parseSel(part.select);
      expect(selKey(s), `${part.name} → ${part.select}`).toBe(part.select);
      expect(selValid(s, params(v)), `${part.name} → ${part.select}`).toBe(true);
    }
  });

  it('the long lamp needs two tube pieces that fit the printer', async () => {
    const preset = tool.presets!.find((q) => q.name.startsWith('Lange totem'))!;
    const res = await buildTool(M, tool, params(preset.values));
    const tubes = res.parts.filter((q) => q.name.startsWith('Schroefbuis'));
    expect(tubes.length).toBe(2);
    for (const t of tubes) expect(t.size[2]).toBeLessThanOrEqual(DEFAULT_PRINTER.z);
    expect(res.parts.some((q) => q.name === 'Klemschijf')).toBe(true);
  });
});

describe('holle sierdelen', () => {
  const cases = SHELLS.flatMap((shape) => TEXTURES.map((tex) => [shape, tex] as const));
  it.each(cases)('%s / %s: open schaal, gelijke wand, ruim om de buis, dicht in de stapel', async (shape, tex) => {
    const res = await buildTool(
      M,
      tool,
      lamp('pendant', [
        { shape: 'schijf', d: 130, h: 10 },
        { shape, d: 110, h: shape === 'kussen' ? 40 : 76, var: 40, n: 2, tex, texN: tex === 'ringen' ? 6 : 90 },
        { shape: 'cilinder', d: 70, h: 40, var: 30 },
      ]),
    );
    checkParts(res, `${shape}/${tex}`);
    expect(overlaps(res)).toEqual([]);
    expect(openRims(res, 0.8)).toEqual([]);
    const solids = placed(res);
    const sh = solids.find((q) => q.name === `2. ${shape === 'trap' ? 'Ziggurat' : shape[0].toUpperCase() + shape.slice(1)} (hol)`)!;
    expect(sh, res.parts.map((q) => q.name).join(', ')).toBeTruthy();
    const part = res.parts[sh.part];
    // open at both ends: one hole straight through (genus 1, no other openings), nothing within the tube's clearance
    expect(sh.m.genus()).toBe(1);
    expect(sh.m.intersect(M.Manifold.cylinder(1000, 12.6, 12.6, 96).translate([0, 0, -500])).volume()).toBeLessThan(0.01);
    // uniform wall: volume ≈ (area / 2) × wall
    const wall = part.volume / (part.area / 2);
    expect(wall, `${shape}/${tex} wand`).toBeGreaterThan(0.8 * 0.85);
    expect(wall, `${shape}/${tex} wand`).toBeLessThan(0.8 * 1.35);
  });

  it('thick walls (2 lines) and wide openings for the disc hubs', async () => {
    const res = await buildTool(M, tool, lamp('table', [{ shape: 'bol', d: 120, h: 90, var: 10, tex: 'plisse', texN: 100 }, { shape: 'tol', d: 110, h: 60, var: 10, n: 1 }], { shellPrint: 'walls', shellWall: 2 }));
    checkParts(res, 'dik');
    expect(overlaps(res)).toEqual([]);
    expect(openRims(res, 2)).toEqual([]);
    // the small ends grew for the hub (note)
    expect(res.warnings.some((w) => /opening/.test(w))).toBe(true);
  });

  it('flat shapes stay solid with a plain bore; too low shells become solid', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'bloem', d: 140, h: 16, n: 7 }, { shape: 'bol', d: 80, h: 14 }, { shape: 'tandwiel', d: 120, h: 14, n: 20 }]));
    expect(res.parts.some((q) => q.name.endsWith('(hol)'))).toBe(false);
    expect(res.tips.some((t) => /massief/.test(t))).toBe(true);
    expect(res.warnings.some((w) => /te laag voor een hol deel/.test(w))).toBe(true);
    expect(overlaps(res)).toEqual([]);
  });
});

describe('montage en sluiting', () => {
  it.each([
    ['hanglamp zonder kap', lamp('pendant', [{ shape: 'bol', d: 90, h: 70 }, { shape: 'cilinder', d: 100, h: 50 }])],
    ['tafellamp met kap', lamp('table', [{ shape: 'kap', kap: 'kegel', d: 200, h: 110, var: 20 }, { shape: 'bol', d: 90, h: 70 }, { shape: 'diabolo', d: 100, h: 60, n: 1 }], { socket: 'e14', bulb14: 'g45' })],
    ['stijlen naast holle delen', lamp('pendant', [{ shape: 'koepel', d: 150, h: 70, var: 30 }, { shape: 'stijlen', d: 90, h: 40, n: 4, var: 20 }, { shape: 'cilinder', d: 120, h: 50 }, { shape: 'kap', kap: 'cilinder', d: 160, h: 90 }])],
    ['extra buis (hanglamp)', lamp('pendant', [{ shape: 'bol', d: 90, h: 70 }, { shape: 'kap', kap: 'koepel', d: 200, h: 110 }], { tubeExtra: 150 })],
    ['draadstang (tafellamp)', lamp('table', [{ shape: 'bol', d: 90, h: 70 }, { shape: 'schijf', d: 120, h: 8 }], { tubeExtra: 120 })],
  ])('%s: geen botsingen, alles dicht, printbaar', async (_n, p) => {
    const res = await buildTool(M, tool, p);
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    expect(openRims(res, 0.8)).toEqual([]);
    // the cable passes: a Ø6 rod along the axis through every printed part
    const rod = M.Manifold.cylinder(4000, 3, 3, 32).translate([0, 0, -2000]);
    for (const s of placed(res)) if (!/Plafondkap|Stijlen|Voet|Bodemplaat/.test(s.name)) expect(s.m.intersect(rod).volume(), s.label).toBeLessThan(0.05);
  });

  it('posts stand on threaded discs next to hollow segments', async () => {
    const res = await buildTool(M, tool, lamp('pendant', [{ shape: 'koepel', d: 150, h: 70, var: 30 }, { shape: 'stijlen', d: 90, h: 40, n: 4, var: 20 }, { shape: 'cilinder', d: 120, h: 50 }, { shape: 'kap', kap: 'cilinder', d: 160, h: 90 }]));
    const discs = res.parts.filter((q) => q.name.startsWith('Schijf') || q.name.startsWith('Tussenschijf'));
    expect(discs.length).toBeGreaterThanOrEqual(2);
    expect(res.parts.find((q) => q.name.includes('Stijlen'))!.quantity).toBe(4);
  });

  it('splits the tube for a small printer (A1 mini)', async () => {
    const mini = PRINTERS.find((q) => q.id === 'a1mini')!;
    const p = lamp('pendant', [{ shape: 'bol', d: 100, h: 80 }, { shape: 'cilinder', d: 90, h: 60 }, { shape: 'tol', d: 100, h: 70, n: 1 }, { shape: 'kap', kap: 'koepel', d: 160, h: 90 }], { canopyD: 100 });
    const res = await buildTool(M, tool, p, mini);
    checkParts(res, 'mini', mini);
    const tubes = res.parts.filter((q) => q.name.startsWith('Schroefbuis'));
    expect(tubes.length).toBeGreaterThanOrEqual(2);
    expect(res.warnings.some((w) => /stukken/.test(w))).toBe(true);
    expect(overlaps(res)).toEqual([]);
  });

  it('every tube diameter builds, also with a tight and a loose clearance', async () => {
    for (const tubeD of ['20', '24', '28', '32'])
      for (const threadPlay of [0.15, 0.6]) {
        const res = await buildTool(M, tool, params({ tubeD, threadPlay, lampType: 'pendant' }));
        checkParts(res, `Ø${tubeD} ${threadPlay}`);
        expect(overlaps(res), `Ø${tubeD} ${threadPlay}`).toEqual([]);
        collect();
      }
  });

  it('G9 has no shade ring to click: clear message', async () => {
    await expect(buildTool(M, tool, params({ socket: 'g9' }))).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, params({ socket: 'g9' }))).rejects.toThrow(/schroefring/);
  });
});

describe('klik voor de fitting', () => {
  it.each([
    ['E27 richtwaarden', 'e27', {}],
    ['E14 richtwaarden', 'e14', {}],
    ['eigen maten', 'e27', { fitSize: 'custom', fitRingD: 60, fitRingH: 15.5, fitBodyD: 40, fitTopD: 36, fitTopH: 18, fitH: 60 }],
  ] as const)('%s: ring passes and is held, socket clear, support-free', (_n, socket, v) => {
    const p = params({ socket, ...v });
    const s = tubeSys(p);
    const d = fitDims(p, socket, []);
    const k = clickOf(d, s);
    const ringR = d.ringD / 2;
    expect(k.zoneR).toBeGreaterThan(ringR);
    expect(ringR - k.hookR).toBeGreaterThanOrEqual(1.2 - 1e-9);
    expect(k.lead).toBeCloseTo(k.zoneR - k.hookR, 6);
    expect(k.topR).toBeGreaterThan(d.topD / 2);
    expect(k.strain).toBeLessThan(0.03);
    const cup = tubePieceSolid(M, s, { index: 1, len: validLen(s, Math.ceil((k.H + 12) / 4)), cup: k, female: false, stub: true });
    expect(overhangArea({ mesh: { positions: new Float32Array(cup.getMesh().vertProperties), indices: new Uint32Array(cup.getMesh().triVerts) } } as PartResult)).toBeLessThan(25);
    // the ring seated on the hooks: only the anti-rotation ribs touch it
    const seated = ring(d.bodyD / 2, ringR, k.hookTop + 0.05, k.hookTop + d.ringH);
    const touch = cup.intersect(seated).volume();
    expect(touch).toBeGreaterThan(0.5);
    expect(touch).toBeLessThan(k.fingers * 1.8 * 0.3 * d.ringH);
    // a ring 1 mm lower runs into the hooks: it cannot fall out
    expect(cup.intersect(ring(d.bodyD / 2, ringR, k.hookTop - 1, k.hookTop - 1 + d.ringH)).volume()).toBeGreaterThan(30);
    // the socket body below the ring and the top part above it are free
    expect(cup.intersect(M.Manifold.cylinder(k.hookTop + 1, d.bodyD / 2, d.bodyD / 2, 96).translate([0, 0, -1])).volume()).toBeLessThan(0.05);
    expect(cup.intersect(M.Manifold.cylinder(d.topH - 0.1, d.topD / 2, d.topD / 2, 96).translate([0, 0, k.ringTop])).volume()).toBeLessThan(0.05);
    // wires: the bore of the tube opens into the cup over the M10 hole of the socket
    expect(cup.intersect(M.Manifold.cylinder(200, s.bore - 0.2, s.bore - 0.2, 48).translate([0, 0, -10])).volume()).toBeLessThan(0.05);
  });

  it('guide values come from common sockets with a shade ring', () => {
    expect(FIT_GUIDE.e27.ringD).toBeGreaterThan(50);
    expect(FIT_GUIDE.e27.bodyD).toBe(40);
    expect(FIT_GUIDE.e14.bodyD).toBeLessThan(FIT_GUIDE.e27.bodyD);
  });
});

describe('dichte lamp', () => {
  const globe = (v: Partial<Params> = {}) =>
    lamp('pendant', [{ shape: 'cilinder', d: 46, h: 30 }, { shape: 'kap', kap: 'koepel', d: 240, h: 120 }], { closed: true, bulb27: 'a60', ...v });

  it.each([
    ['koepel + spiegel', globe()],
    ['kegel + kegel', globe({ s2Kap: 'kegel', s2Var: 10, closedShape: 'spiegel' })],
    ['klok + koepel, plissé', globe({ s2Kap: 'klok', s2Tex: 'plisse', s2TexN: 120, closedShape: 'koepel', closedH: 120 })],
    ['cilinder, platte bodem', globe({ s2Kap: 'cilinder', s2D: 200, closedShape: 'cilinder', closedH: 110 })],
    ['tafellamp', lamp('table', [{ shape: 'kap', kap: 'koepel', d: 220, h: 110 }, { shape: 'bol', d: 80, h: 60 }], { closed: true, socket: 'e14', bulb14: 'g45' })],
    ['M10 (oude buis)', globe({ connection: 'm10' })],
  ])('%s: printbaar, naad sluit, geen botsingen', async (_n, p) => {
    const res = await buildTool(M, tool, p);
    checkParts(res, _n);
    expect(overlaps(res)).toEqual([]);
    const second = res.parts.find((q) => /Onderkap|Bovenkap/.test(q.name))!;
    expect(second.select).toBe('closed');
    expect(res.warnings.some((w) => /tussen de lamp/.test(w))).toBe(false);
    expect(res.tips.some((t) => /LED/.test(t) && /Dichte lamp/.test(t))).toBe(true);
  });

  it('puts the seam at the middle of the bulb and has vents top and bottom', async () => {
    const res = await buildTool(M, tool, globe({ vent: 'gaatjes' }));
    const solids = placed(res);
    const under = solids.find((q) => q.name.endsWith('Onderkap'))!;
    const kap = solids.find((q) => q.name === '2. Kap')!;
    const bulb = res.scene!.find((s) => s.kind === 'mesh' && s.label?.startsWith('A60'));
    if (!bulb || bulb.kind !== 'mesh') throw new Error('no bulb');
    const zs = Array.from(bulb.mesh.positions).filter((_, i) => i % 3 === 2);
    const seam = under.m.boundingBox().max[2];
    // the A60 (Ø60) is widest 30 mm above its tip
    expect(Math.abs(seam - (Math.min(...zs) + 30))).toBeLessThan(1);
    // the threaded neck of the kap reaches into the second shade
    expect(kap.m.boundingBox().min[2]).toBeLessThan(seam - 8);
    // visible vents: every opening is a handle of the surface
    expect(kap.m.genus()).toBeGreaterThanOrEqual(8);
    expect(under.m.genus()).toBeGreaterThanOrEqual(6);
    const closedVents = await buildTool(M, tool, globe({ vent: 'geen' }));
    expect(solidOf(closedVents.parts.find((q) => q.name.endsWith('Onderkap'))!).genus()).toBe(0);
  });

  it('a second shade that is too short for the bulb: clear message', async () => {
    // the lower half of an A60 reaches 30 mm below the seam
    await expect(buildTool(M, tool, globe({ closedShape: 'koepel', closedH: 30 }))).rejects.toMatchObject({ user: true });
    const tight = await buildTool(M, tool, globe({ closedShape: 'koepel', closedH: 42 }));
    expect(tight.warnings.some((w) => /tussen de lamp/.test(w))).toBe(true);
  });

  it('not with lamellas (message) and not with layers (switched off with a note)', async () => {
    const preset = tool.presets!.find((q) => q.name.startsWith('Lagenkoepel'))!;
    await expect(buildTool(M, tool, params({ ...preset.values, closed: true }))).rejects.toMatchObject({ user: true });
    const layered = tool.presets!.find((q) => q.name.startsWith('Moiré'))!;
    const res = await buildTool(M, tool, params({ ...layered.values, closed: true }));
    expect(res.warnings.some((w) => /Dichte lamp/.test(w))).toBe(true);
    expect(res.parts.some((q) => /laag 2/.test(q.name))).toBe(false);
    expect(overlaps(res)).toEqual([]);
  });
});

describe('pasproef', () => {
  it('prints only test pieces, support-free, and they fit together', async () => {
    for (const socket of ['e27', 'e14']) {
      const res = await buildTool(M, tool, params({ fitTest: true, socket }));
      expect(res.parts.map((q) => q.name)).toEqual([
        'Pasproef buiseinde met klik',
        'Pasproef schijfmoer',
        'Pasproef koppelstuk',
        'Pasproef naadring (buitendraad)',
        'Pasproef naadring (binnendraad)',
      ]);
      checkParts(res, `pasproef ${socket}`);
      expect(overlaps(res)).toEqual([]);
      expect(res.defaultView).toBe('plate');
      for (const q of res.parts) expect(q.select).toBe('tube');
      expect(res.info.some((b) => b.kind === 'text' && /klikken/.test(b.text))).toBe(true);
      collect();
    }
  });
});

describe('robuust', () => {
  it('random printed-tube lamps build or give a clear message', async () => {
    let built = 0;
    for (let i = 0; i < 12; i++) {
      const p = params({ ...tool.randomize!({} as Params), tubeD: ['20', '24', '28', '32'][i % 4], threadPlay: 0.15 + (i % 4) * 0.15, tubeExtra: (i % 3) * 60, shellPrint: i % 2 ? 'walls' : 'vase' });
      try {
        const res = await buildTool(M, tool, p);
        for (const part of res.parts) expect(overhangArea(part), `${part.name} ${JSON.stringify(p)}`).toBeLessThan(25);
        built++;
      } catch (e) {
        expect((e as { user?: boolean }).user, `${(e as Error).message} ${JSON.stringify(p)}`).toBe(true);
      }
      collect();
    }
    expect(built).toBeGreaterThan(6);
  });
});
