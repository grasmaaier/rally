import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type BuildResult, type Params, type PartResult } from '../src/core/types';
import { asMat4 } from '../src/geom/helpers';
import {
  BOLTS,
  armGeometry,
  armRanges,
  bracketSolid,
  headSolid,
  shelfGeometry,
  shelfSolid,
  speakersTool as tool,
  yokeSolid,
} from '../src/tools/speakers';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;

const THREADS = ['1/4-20', 'M5', 'M6'];
const STYLES: [string, Partial<Params>][] = [
  ['arm, draadgat achter', { style: 'arm', insertPos: 'back' }],
  ['arm, draadgat onder', { style: 'arm', insertPos: 'bottom', spkH: 130 }],
  ['plank, bout + rand', { style: 'shelf', shelfFix: 'both' }],
  ['plank, alleen bout', { style: 'shelf', shelfFix: 'bolt' }],
  ['plank, alleen rand', { style: 'shelf', shelfFix: 'rim' }],
];

/** Overhang faces of a part that lie outside a vertical cylinder of radius r around (cx, cy) (print frame, placed on the bed). */
function overhangOutside(part: PartResult, r: number) {
  const { positions: P, indices: I } = part.mesh;
  let minZ = Infinity;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    minZ = Math.min(minZ, P[i + 2]);
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]);
    y1 = Math.max(y1, P[i + 1]);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.min(P[a + 2], P[b + 2], P[c + 2]) < minZ + 0.3 || nz / len >= -0.75) continue;
    const mx = (P[a] + P[b] + P[c]) / 3 - cx;
    const my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy;
    if (Math.hypot(mx, my) > r) area += len / 2;
  }
  return area;
}

function sceneSolids(res: BuildResult) {
  const base = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
  const out: { name: string; m: Manifold }[] = [];
  for (const s of res.scene ?? []) if (s.kind === 'part') out.push({ name: res.parts[s.part].name, m: base[s.part].transform(s.matrix as unknown as Mat4) });
  return out;
}

function overlaps(solids: { name: string; m: Manifold }[]) {
  const bad: string[] = [];
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++) {
      const v = solids[a].m.intersect(solids[b].m).volume();
      if (v > 2) bad.push(`${solids[a].name} ∩ ${solids[b].name} = ${v.toFixed(1)} mm³`);
    }
  return bad;
}

const named = (solids: { name: string; m: Manifold }[], start: string) => solids.find((s) => s.name.startsWith(start))!.m;

/** Number from an info row like "≈ 1,79 N·m (…)". */
function infoNumber(res: BuildResult, title: string, row: string): number {
  const block = res.info.find((b) => b.title === title);
  if (!block || block.kind !== 'kv') throw new Error(`no ${title}`);
  const r = block.rows.find(([k]) => k === row);
  if (!r) throw new Error(`no ${row}`);
  return Number(r[1].replace(/^[^\d]*/, '').split(' ')[0].replace(',', '.'));
}

describe('speakerhouders', () => {
  it.each(STYLES.flatMap(([name, v]) => THREADS.map((thread) => [name, thread, v] as const)))('%s / %s: geldig, past en print zonder support', async (_name, thread, v) => {
    for (const clampBolt of ['M5', 'M6']) {
      const res = await buildTool(M, tool, params({ ...v, thread, clampBolt }));
      expect(res.parts.length).toBeGreaterThan(3);
      for (const part of res.parts) {
        expect(part.volume, part.name).toBeGreaterThan(0);
        expect(fitsOn(DEFAULT_PRINTER, part.size), part.name).toBe(true);
        expect(overhangArea(part), `${part.name} overhang`).toBeLessThan(5);
      }
      expect(res.info.some((b) => b.title === 'Belasting')).toBe(true);
      expect(res.info.some((b) => b.title.startsWith('Benodigdheden'))).toBe(true);
      expect(res.info.some((b) => b.title === 'Montage')).toBe(true);
      expect(res.scene?.some((s) => s.kind === 'mesh' && s.label === 'Speaker')).toBe(true);
      expect(res.scene?.some((s) => s.kind === 'box' && s.label === 'Muur')).toBe(true);
    }
  });

  it.each([
    ['arm', { style: 'arm', connect: 'printed' }],
    ['plank', { style: 'shelf', shelfFix: 'bolt', connect: 'printed' }],
  ])('geprinte draad (%s): alleen de draadflanken hangen over, met waarschuwing', async (_n, v) => {
    for (const thread of THREADS) {
      const res = await buildTool(M, tool, params({ ...v, thread }));
      const knob = res.parts.find((p) => p.name.includes('geprinte draad'))!;
      expect(knob).toBeTruthy();
      // the ISO 60° flanks of the small thread are the only overhangs (they print fine at fine layers)
      expect(overhangOutside(knob, BOLTS[thread].d / 2 + 0.2)).toBeLessThan(2);
      for (const part of res.parts) if (part !== knob) expect(overhangArea(part), part.name).toBeLessThan(5);
      expect(res.warnings.some((w) => w.includes('Geprinte draad'))).toBe(true);
    }
  });

  it('presets bouwen, zonder support en zonder overlap', async () => {
    for (const pr of tool.presets!) {
      const res = await buildTool(M, tool, params(pr.values));
      for (const part of res.parts) expect(overhangArea(part), `${pr.name}: ${part.name}`).toBeLessThan(5);
      try {
        expect(overlaps(sceneSolids(res)), pr.name).toEqual([]);
      } finally {
        collect();
      }
    }
  });

  describe('scharnier', () => {
    const cases = [
      ['achter', { insertPos: 'back' }],
      ['onder', { insertPos: 'bottom', spkH: 120, armLen: 120 }],
    ] as const;

    it.each(cases)('draadgat %s: geen overlap bij verschillende standen, en de klemmen pakken', async (_n, v) => {
      const p0 = params({ style: 'arm', ...v });
      const g = armGeometry(p0);
      const R = armRanges(g);
      expect(R.tiltMin).toBeLessThanOrEqual(-20);
      expect(R.tiltMax).toBeGreaterThanOrEqual(5);
      expect(R.panMax).toBeGreaterThanOrEqual(45);
      const poses: [number, number][] = [[0, 0], [R.panMax, 0], [R.panMin, R.tiltMin], [Math.round(R.panMax / 2), R.tiltMax], [-30, Math.round(R.tiltMin / 2)]];
      for (const [pan, tilt] of poses) {
        const res = await buildTool(M, tool, { ...p0, pan, tilt });
        try {
          const solids = sceneSolids(res);
          expect(overlaps(solids), `pan ${pan} tilt ${tilt}`).toEqual([]);
          const yoke = named(solids, 'Draaistuk');
          const head = named(solids, 'Speakerkop');
          const bracket = named(solids, 'Muurbeugel');
          // the yoke sits on the boss; the cheeks hug the tongue with only the clamp gap
          expect(yoke.minGap(bracket, 1)).toBeLessThan(0.05);
          const gap = yoke.minGap(head, 2);
          expect(gap).toBeGreaterThan(0.1);
          expect(gap).toBeLessThan(0.45);
          // every knob bears on its part
          expect(named(solids, 'Knop draaien').minGap(bracket, 1)).toBeLessThan(0.05);
          expect(named(solids, 'Knop kantelen').minGap(head, 1)).toBeLessThan(0.05);
          expect(named(solids, 'Speakerknop').minGap(head, 1)).toBeLessThan(0.05);
        } finally {
          collect();
        }
      }
    });

    it.each(['M5', 'M6'])('boutlengtes kloppen (%s)', (clampBolt) => {
      for (const thread of THREADS) {
        const g = armGeometry(params({ style: 'arm', clampBolt, thread }));
        const cb = g.cb;
        // tilt: knob floor + cheek + gaps + tongue + cheek up to the nut pocket + through the nut, ≤ 6 mm sticking out
        const pocket = cb.nutH + 0.4;
        const toNutEnd = g.tiltKnob.floor + 2 * g.tc + 2 * g.g + g.Tt - pocket + cb.nutH;
        expect(g.tiltKnob.L - toNutEnd).toBeGreaterThanOrEqual(0.5);
        expect(g.tiltKnob.L - toNutEnd).toBeLessThanOrEqual(6);
        expect(cb.lengths).toContain(g.tiltKnob.L);
        // pan: knob floor + boss + disc up to through the nut in the tongue, ending under the slot roof
        const panToNut = g.panKnob.floor + g.Ha + g.zn + cb.nutH;
        expect(g.panKnob.L - panToNut).toBeGreaterThanOrEqual(0.5);
        expect(g.panKnob.L - panToNut).toBeLessThanOrEqual(0.4 + (cb.nutAF + 0.4) / 2);
        // speaker bolt: never deeper than the insert, at least 3.5 mm of thread
        const depth = Number(base.insertDepth);
        expect(g.e).toBeLessThanOrEqual(depth - 0.5);
        expect(g.e).toBeGreaterThanOrEqual(3.5);
        expect(g.speakerKnob.L - g.speakerKnob.floor - g.tp - g.tpad).toBeCloseTo(g.e, 5);
        expect(g.sb.lengths.some((l) => Math.abs(l - g.speakerKnob.L) < 1e-6)).toBe(true);
        // the knob can back off far enough to unscrew from the speaker without hitting the tongue
        expect(g.dp - g.speakerKnob.H - g.rt).toBeGreaterThanOrEqual(g.e + 1);
      }
    });

    it.each(['M5', 'M6'])('gaten en moerkamers passen de bouten (%s)', (clampBolt) => {
      const p = params({ style: 'arm', clampBolt, thread: '1/4-20' });
      const g = armGeometry(p);
      const cb = g.cb;
      try {
        const bracket = bracketSolid(M, p, g);
        const yoke = yokeSolid(M, g);
        const head = headSolid(M, g);
        // pan bolt along the boss axis
        const panBolt = M.Manifold.cylinder(200, cb.d / 2, cb.d / 2, 32).translate([0, g.L, -100]);
        expect(bracket.intersect(panBolt).volume()).toBeLessThan(0.01);
        expect(yoke.intersect(M.Manifold.cylinder(g.zn + cb.nutH, cb.d / 2, cb.d / 2, 32)).volume()).toBeLessThan(0.01);
        // the nut fits its slot in the tongue (centred on the pan axis, flats facing ±x)
        const nut = M.Manifold.cylinder(cb.nutH, cb.nutAF / Math.sqrt(3), cb.nutAF / Math.sqrt(3), 6).rotate([0, 0, 30]).translate([0, 0, g.zn]);
        expect(yoke.intersect(nut).volume()).toBeLessThan(0.01);
        // tilt bolt through the tongue and both cheeks (along x)
        const tiltBolt = M.Manifold.cylinder(100, cb.d / 2, cb.d / 2, 32).translate([0, 0, -50]).rotate([0, 90, 0]);
        expect(yoke.intersect(tiltBolt.translate([0, 0, g.ha])).volume()).toBeLessThan(0.01);
        expect(head.intersect(tiltBolt).volume()).toBeLessThan(0.01);
        // the tilt nut fits the hex pocket on the outer cheek (corner up = towards −z in the plate frame)
        const hexNut = M.Manifold.cylinder(cb.nutH, cb.nutAF / Math.sqrt(3), cb.nutAF / Math.sqrt(3), 6).rotate([0, 90, 0]).translate([g.xout - cb.nutH - 0.2, 0, 0]);
        expect(head.intersect(hexNut).volume()).toBeLessThan(0.01);
        // a nut one size up does not fit: the pocket keys the nut
        const big = M.Manifold.cylinder(cb.nutH, (cb.nutAF + 1) / Math.sqrt(3), (cb.nutAF + 1) / Math.sqrt(3), 6).rotate([0, 90, 0]).translate([g.xout - cb.nutH - 0.2, 0, 0]);
        expect(head.intersect(big).volume()).toBeGreaterThan(1);
        // speaker bolt through the plate
        const sbolt = M.Manifold.cylinder(40, g.sb.d / 2, g.sb.d / 2, 32);
        expect(head.intersect(sbolt).volume()).toBeLessThan(0.01);
      } finally {
        collect();
      }
    });

    it('knoppen houden de boutkop vast in een zeskant', async () => {
      const res = await buildTool(M, tool, params({ style: 'arm', clampBolt: 'M6', thread: 'M5' }));
      try {
        for (const [name, b] of [['Knop draaien', BOLTS.M6], ['Knop kantelen', BOLTS.M6], ['Speakerknop', BOLTS.M5]] as const) {
          const part = res.parts.find((p) => p.name === name)!;
          const k = keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices })));
          const H = part.size[2];
          const head = (af: number) => M.Manifold.cylinder(b.headH, af / Math.sqrt(3), af / Math.sqrt(3), 6).rotate([0, 0, 30]).translate([0, 0, H - b.headH]);
          expect(k.intersect(head(b.headAF)).volume(), name).toBeLessThan(0.01);
          expect(k.intersect(head(b.headAF + 0.6)).volume(), name).toBeGreaterThan(0.5);
          // the shaft passes through the bearing face
          expect(k.intersect(M.Manifold.cylinder(H + 2, b.d / 2, b.d / 2, 24).translate([0, 0, -1])).volume(), name).toBeLessThan(0.01);
        }
      } finally {
        collect();
      }
    });
  });

  describe('kabel', () => {
    /** A cable (cylinder of diameter d) along a polyline of use-frame points. */
    function cablePath(pts: [number, number, number][], d: number): Manifold {
      const pieces: Manifold[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = M.Manifold.sphere(d / 2, 16).translate(pts[i]);
        const b = M.Manifold.sphere(d / 2, 16).translate(pts[i + 1]);
        pieces.push(M.Manifold.hull([a, b]));
      }
      return M.Manifold.union(pieces);
    }

    it.each([['down', 6], ['wall', 6], ['down', 10], ['wall', 3.5]] as const)('arm: kabel %s (Ø%s) loopt vrij van de speaker tot de muur', async (cable, cableD) => {
      const p = params({ style: 'arm', cable, cableD });
      const g = armGeometry(p);
      try {
        const bracket = bracketSolid(M, p, g);
        const x = g.W / 2 - g.tr - (g.dc - g.tr) / 2;
        const d = cableD - 0.3;
        const tip: [number, number, number] = [x, g.L + g.Rb + 5, g.zc];
        const path: [number, number, number][] = cable === 'down' ? [tip, [x, g.ypc, g.zc], [x, g.ypc, g.zBot - 5]] : [tip, [x, -5, g.zc]];
        expect(bracket.intersect(cablePath(path, d)).volume()).toBeLessThan(0.05);
        // with the cover strips in place
        const res = await buildTool(M, tool, p);
        const solids = sceneSolids(res).filter((s) => s.name.startsWith('Kabelafdekking'));
        expect(solids.length).toBe(cable === 'down' ? 2 : 1);
        // scene = use frame turned 180° about z
        const toScene = asMat4([-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const cab = cablePath(path, d).transform(toScene);
        for (const s of solids) expect(s.m.intersect(cab).volume(), s.name).toBeLessThan(0.05);
        // the strips sit flush in their dovetail: they touch the bracket but do not cut into it
        const br = named(sceneSolids(res), 'Muurbeugel');
        for (const s of solids) {
          expect(s.m.intersect(br).volume(), s.name).toBeLessThan(0.5);
          expect(s.m.minGap(br, 1), s.name).toBeLessThan(0.2);
        }
      } finally {
        collect();
      }
    });

    it.each(['down', 'wall'])('plank: kabel %s gaat achter het plateau door de plank', (cable) => {
      const p = params({ style: 'shelf', cable, cableD: 6 });
      const s = shelfGeometry(p);
      try {
        const shelf = shelfSolid(M, p, s);
        const d = 2 * s.rch - 1;
        const path: [number, number, number][] = cable === 'down' ? [[0, s.ych, 10], [0, s.ych, s.zBot - 5]] : [[0, s.ych, 10], [0, s.ych, s.zEx], [0, -5, s.zEx]];
        expect(shelf.intersect(cablePath(path, d)).volume()).toBeLessThan(0.05);
        // and the plateau stays clear of the cable hole
        expect(s.yc - s.Rp).toBeGreaterThan(s.ych + s.rch);
      } finally {
        collect();
      }
    });
  });

  describe('belasting', () => {
    it('moment op de muur groeit met armlengte en gewicht; draagvermogen daalt met de arm', async () => {
      const get = async (armLen: number, spkKg: number) => {
        const res = await buildTool(M, tool, params({ style: 'arm', armLen, spkKg, pan: 0, tilt: 0 }));
        return { m: infoNumber(res, 'Belasting', 'Moment op de muur'), cap: infoNumber(res, 'Belasting', 'Draagvermogen (richtwaarde)') };
      };
      const a = await get(80, 1);
      const b = await get(160, 1);
      const c = await get(160, 2);
      expect(b.m).toBeGreaterThan(a.m);
      expect(c.m).toBeGreaterThan(b.m * 1.9);
      expect(b.cap).toBeLessThan(a.cap);
    });

    it('te zware speaker geeft een waarschuwing', async () => {
      const res = await buildTool(M, tool, params({ style: 'arm', armLen: 250, spkKg: 6, armH: 18 }));
      expect(res.warnings.some((w) => w.includes('richtwaarde'))).toBe(true);
    });
  });

  describe('grenzen', () => {
    it('te lange arm voor een kleine printer: leesbare melding met de maximale lengte', async () => {
      const mini = PRINTERS.find((pr) => pr.id === 'a1mini')!;
      await expect(buildTool(M, tool, params({ style: 'arm', armLen: 250 }), mini)).rejects.toMatchObject({ user: true, message: expect.stringContaining('korter') });
      const ok = await buildTool(M, tool, params({ style: 'arm', armLen: 120 }), mini);
      for (const p of ok.parts) expect(fitsOn(mini, p.size)).toBe(true);
    });

    it('grote speaker op een korte arm: leesbare melding', async () => {
      await expect(buildTool(M, tool, params({ style: 'arm', insertPos: 'bottom', spkD: 300, armLen: 30 }))).rejects.toMatchObject({ user: true });
    });

    it('draaibereik wordt kleiner bij een korte arm en het voorbeeld wordt begrensd', async () => {
      const short = armRanges(armGeometry(params({ style: 'arm', insertPos: 'bottom', spkD: 140, spkW: 140, armLen: 90 })));
      const long = armRanges(armGeometry(params({ style: 'arm', insertPos: 'bottom', spkD: 140, spkW: 140, armLen: 200 })));
      expect(short.panMax).toBeLessThan(long.panMax);
      const res = await buildTool(M, tool, params({ style: 'arm', insertPos: 'bottom', spkD: 140, spkW: 140, armLen: 90, pan: 90 }));
      expect(res.warnings.some((w) => w.includes('voorbeeld') || w.includes('Draaien kan'))).toBe(true);
    });

    it('ondiep draadgat: leesbare melding', async () => {
      await expect(buildTool(M, tool, params({ style: 'arm', insertDepth: 4 }))).rejects.toMatchObject({ user: true });
    });

    it('rand om de speaker maakt het plateau groot genoeg', () => {
      const s = shelfGeometry(params({ style: 'shelf', shelfFix: 'rim', plateD: 60, spkW: 120, spkD: 90 }));
      expect(2 * s.Rp).toBeGreaterThanOrEqual(120 + 2);
      expect(s.notes.length).toBeGreaterThan(0);
    });
  });
});
