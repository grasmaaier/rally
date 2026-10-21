import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type PartResult, type Params } from '../src/core/types';
import {
  WOOD_KINDS,
  bevelLayout,
  centerEdgeLayout,
  centerRoundLayout,
  chamferLayout,
  chiselLayout,
  dovetailLayout,
  dowelLayout,
  drillLayout,
  hingeLayout,
  parseList,
  scribeLayout,
  setupLayout,
  shelfLayout,
  squareLayout,
  woodworkingTool as tool,
} from '../src/tools/woodworking';
import { buildTool, testAssets } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
  await testAssets.ensure([{ kind: 'font', key: 'bundled:montserrat' }]);
});

const base = defaultsOf(tool.params);
const params = (v: Partial<Params>) => ({ ...base, ...v }) as Params;

/** Build without placing on the bed, so the layout coordinates still apply. */
function solidOf(v: Partial<Params>, part = 0): Manifold {
  return tool.build(params(v), { M, printer: DEFAULT_PRINTER, assets: testAssets }).parts[part].solid;
}

type Poly = [number, number][];
// simplify drops the collinear points where triangle diagonals cross the plane
const slice = (m: Manifold, z: number): Poly[] => m.slice(z).simplify(1e-6).toPolygons();

function signedArea(p: Poly) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
function centroid(p: Poly): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}
/** Hole contours (clockwise) with their centroids. */
const holesOf = (polys: Poly[]) => polys.filter((p) => signedArea(p) < 0).map(centroid);

/** The neighbours of the contour vertex at (x, y). */
function vertexAt(polys: Poly[], x: number, y: number, tol = 1e-4) {
  for (const p of polys)
    for (let i = 0; i < p.length; i++)
      if (Math.hypot(p[i][0] - x, p[i][1] - y) < tol) return { v: p[i], prev: p[(i + p.length - 1) % p.length], next: p[(i + 1) % p.length] };
  return null;
}
const angleDeg = (a: [number, number], b: [number, number]) => {
  const c = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];

/**
 * Downward faces steeper than 45° that are not on the bed. Labels engraved in
 * the bed face (0.4 mm deep) are bridged by the slicer and do not count.
 */
function overhang(part: PartResult) {
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
    const zHigh = Math.max(P[a + 2], P[b + 2], P[c + 2]);
    if (zHigh < minZ + 0.42) continue;
    if (nz / len < -0.75) area += len / 2;
  }
  return area;
}

describe('houtbewerking', () => {
  it('lijsten met Nederlandse komma', () => {
    expect(parseList('15; 22,5; 30')).toEqual([15, 22.5, 30]);
    expect(parseList('15 22,5 30°')).toEqual([15, 22.5, 30]);
    expect(parseList('15, 22.5, 30')).toEqual([15, 22.5, 30]);
    expect(parseList('3mm; ; x; 4')).toEqual([3, 4]);
  });

  const cases: [string, Partial<Params>][] = [
    ...WOOD_KINDS.map((k) => [k.value, { kind: k.value }] as [string, Partial<Params>]),
    ...tool.presets!.map((p) => [p.name, p.values] as [string, Partial<Params>]),
    ['hoekmal zonder labels', { kind: 'bevel', labels: false }],
    ['middenlijn stalen pennen', { kind: 'centerEdge', cePin: 'steel' }],
    ['duwblok zonder hak', { kind: 'pushBlock', pbHeel: 'none', pbPad: false }],
    ['boorgeleider 45° ', { kind: 'drill', dgAngle: 45, dgSizes: '6; 10' }],
    ['boorgeleider V-groef', { kind: 'drill', dgVee: true }],
    ['deuvel met aanslag en bussen', { kind: 'dowel', dwStop: 20, dwBush: true, dwBushOD: 12, dwHoles: 3 }],
    ['scharnier met aanslag', { kind: 'hinge', hgTop: 100, hgPattern: '48' }],
    ['veerbord klemmen', { kind: 'feather', fbMount: 'clamp' }],
    ['lijmhoek 45°', { kind: 'square', sqAngle: 45 }],
    ['lijmhoek 135°', { kind: 'square', sqAngle: 135 }],
    ['kegel', { kind: 'pyramid', pyStyle: 'cone' }],
    ['werkstukklos', { kind: 'pyramid', pyStyle: 'cookie' }],
  ];

  it.each(cases)('%s: geldig, past op de printer, print zonder support', async (_n, v) => {
    const res = await buildTool(M, tool, params(v));
    expect(res.parts.length).toBeGreaterThan(0);
    for (const part of res.parts) {
      expect(part.volume).toBeGreaterThan(0);
      expect(fitsOn(DEFAULT_PRINTER, part.size), `${part.name}: ${part.size.join(' × ')}`).toBe(true);
      expect(overhang(part), part.name).toBeLessThan(1);
    }
  });

  it('elke soort bouwt op elke printer of geeft een nette melding', async () => {
    for (const printer of PRINTERS)
      for (const k of WOOD_KINDS) {
        try {
          const res = await buildTool(M, tool, params({ kind: k.value }), printer);
          for (const part of res.parts) expect(fitsOn(printer, part.size), `${k.value} op ${printer.id}`).toBe(true);
        } catch (err) {
          expect((err as { user?: boolean }).user, `${k.value} op ${printer.id}: ${String(err)}`).toBe(true);
        }
      }
  });

  it('te groot geeft een melding, lange delen worden schuin gelegd', async () => {
    await expect(buildTool(M, tool, params({ kind: 'shelf', spHoles: 12, spPitch: 64 }))).rejects.toMatchObject({ user: true });
    const mini = PRINTERS.find((p) => p.id === 'a1mini')!;
    const heights = Array.from({ length: 22 }, (_, i) => i + 1).join('; ');
    const res = await buildTool(M, tool, params({ kind: 'setup', suHeights: heights, suW: 8 }), mini);
    expect(fitsOn(mini, res.parts[0].size)).toBe(true);
    expect(res.tips.some((t) => t.includes('gedraaid'))).toBe(true);
  });

  it('ongeldige hoeken geven een melding', async () => {
    await expect(buildTool(M, tool, params({ kind: 'bevel', bvAngles: '' }))).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, params({ kind: 'bevel', bvAngles: '15; 95' }))).rejects.toMatchObject({ user: true });
    await expect(buildTool(M, tool, params({ kind: 'dowel', dwD: '12', dwBoard: 12 }))).rejects.toMatchObject({ user: true });
  });

  it.each(['tilt', 'edge'])('hoekmal (%s): schuine randen hebben exact de hoek', (mode) => {
    const v = { kind: 'bevel', bvMode: mode, bvAngles: mode === 'tilt' ? '0; 7,5; 15; 22,5; 30; 45' : '30; 45; 60; 67,5; 90' };
    const L = bevelLayout(params(v));
    const polys = slice(solidOf(v), 1);
    for (const f of L.fingers) {
      const hit = vertexAt(polys, f.c, 0);
      expect(hit, `hoek ${f.value}`).not.toBeNull();
      const up = [hit!.prev, hit!.next].find((q) => q[1] > 1)!;
      const flat = [hit!.prev, hit!.next].find((q) => Math.abs(q[1]) < 1e-6)!;
      // the reference edge runs along y = 0 to the left, the flank rises at theta
      expect(flat[0]).toBeLessThan(f.c);
      expect(angleDeg(sub(flat, hit!.v), sub(up, hit!.v))).toBeCloseTo(f.theta, 6);
      if (f.theta < 90) expect(up[1]).toBeCloseTo(L.H, 6);
      else expect(up[1]).toBeGreaterThanOrEqual(L.H - 1e-6);
      // the saw blade (4 mm) fits in the gap next to the flank
      expect(vertexAt(polys, f.c + 1, 0, 0.9)).toBeNull();
    }
    // left outer edge is square
    const corner = vertexAt(polys, 0, 0)!;
    const left = [corner.prev, corner.next].find((q) => q[1] > 1)!;
    expect(left[0]).toBeCloseTo(0, 9);
    collect();
  });

  it('zwaluwstaartmal: hellingen 1:n, lip haaks', () => {
    for (const [a, b] of [['6', '8'], ['5', '10'], ['7', '0']]) {
      const v = { kind: 'dovetail', dtA: a, dtB: b };
      const L = dovetailLayout(params(v));
      const polys = slice(solidOf(v), L.t / 2);
      const hit = vertexAt(polys, L.W / 2, 0)!;
      expect(hit).not.toBeNull();
      const far = [hit.prev, hit.next].find((q) => q[1] > 1)!;
      expect((far[0] - L.W / 2) / far[1]).toBeCloseTo(1 / L.nA, 9);
      if (L.nB) {
        const hb = vertexAt(polys, -L.W / 2, -L.t)!;
        const fb = [hb.prev, hb.next].find((q) => q[1] < -L.t - 1)!;
        expect((-L.W / 2 - fb[0]) / (-L.t - fb[1])).toBeCloseTo(1 / L.nB, 9);
      }
      // end leg: straight sides at ±W/2
      const lip = slice(solidOf(v), L.t + L.He / 2).flat();
      for (const [x] of lip) expect(Math.abs(Math.abs(x) - L.W / 2)).toBeLessThan(1e-6);
      collect();
    }
  });

  it('afschuinmal: haakse inkeping met vellingkant c', () => {
    const v = { kind: 'chamfer', chSizes: '1; 2,5; 6' };
    const L = chamferLayout(params(v));
    const polys = slice(solidOf(v), 1);
    for (const n of L.notches) {
      const yb = L.Hp - n.d + n.k;
      const l = vertexAt(polys, n.xc - n.k, yb)!;
      const r = vertexAt(polys, n.xc + n.k, yb)!;
      expect(l && r).toBeTruthy();
      const lw = [l.prev, l.next].find((q) => q[1] > yb + 0.5)!;
      const rw = [r.prev, r.next].find((q) => q[1] > yb + 0.5)!;
      expect(angleDeg(sub(lw, l.v), sub(rw, r.v))).toBeCloseTo(90, 6);
      // both flat ends are c from the virtual apex of the V
      const apex: [number, number] = [n.xc, L.Hp - n.d];
      expect(Math.hypot(...sub(l.v, apex))).toBeCloseTo(n.c, 6);
      expect(Math.hypot(...sub(r.v, apex))).toBeCloseTo(n.c, 6);
    }
    collect();
  });

  it('middelpuntzoeker: rechte kant deelt de 90°-V precies doormidden', () => {
    for (const crMax of [30, 80, 150]) {
      const v = { kind: 'centerRound', crMax };
      const L = centerRoundLayout(params(v));
      const solid = solidOf(v);
      const plate = slice(solid, L.t / 2);
      // blade edge on x = 0 from the apex to the end: material just left of it, open just right of it
      const top = vertexAt(plate, 0, L.Yb)!;
      expect([top.prev, top.next].some((q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[1]) < 1e-9)).toBe(true);
      const cs = solid.slice(L.t / 2);
      const strip = (x0: number, x1: number) => cs.intersect(M.CrossSection.square([x1 - x0, L.Yb - 2]).translate([x0, 1])).area();
      expect(strip(1e-4, 0.3)).toBeLessThan(1e-6);
      expect(strip(-0.3, -1e-4)).toBeCloseTo(0.2999 * (L.Yb - 2), 2);
      // round stock of any size touches both fences with its centre on the blade line
      const fences = solid.slice(L.t + L.hf / 2);
      for (const d of [8, crMax / 2, crMax]) {
        const r = d / 2;
        const c: [number, number] = [0, r * Math.SQRT2];
        const inside = M.CrossSection.circle(r - 0.02, 128).translate(c);
        const touch = M.CrossSection.circle(r + 0.05, 128).translate(c);
        expect(fences.intersect(inside).area()).toBeLessThan(1e-3);
        const hit = fences.intersect(touch);
        const b = hit.bounds();
        expect(b.min[0]).toBeLessThan(-r / 2);
        expect(b.max[0]).toBeGreaterThan(r / 2);
        expect(b.min[0] + b.max[0]).toBeCloseTo(0, 2);
      }
      collect();
    }
  });

  it('middenlijnmal: potloodgat precies tussen de pennen', () => {
    for (const cePin of ['printed', 'steel']) {
      const v = { kind: 'centerEdge', cePin, ceMax: 55 };
      const L = centerEdgeLayout(params(v));
      const solid = solidOf(v);
      const bar = holesOf(slice(solid, L.tb / 2));
      const pins = cePin === 'steel' ? bar.filter(([x]) => Math.abs(x) > 1) : slice(solid, L.tb + L.pinH / 2).map(centroid);
      const pencil = bar.find(([x]) => Math.abs(x) < 1)!;
      expect(pins).toHaveLength(2);
      expect(pencil[0]).toBeCloseTo((pins[0][0] + pins[1][0]) / 2, 6);
      expect(pencil[1]).toBeCloseTo((pins[0][1] + pins[1][1]) / 2, 6);
      expect(Math.abs(pins[0][0] - pins[1][0]) - L.pinD).toBeGreaterThanOrEqual(55);
      collect();
    }
  });

  it('lijmhoek: referentieranden staan exact op de hoek', () => {
    for (const sqAngle of [45, 60, 90, 120, 135]) {
      const v = { kind: 'square', sqAngle };
      const S = squareLayout(params(v));
      const pts = slice(solidOf(v), S.T / 2).flat();
      const d: [number, number] = [Math.cos((sqAngle * Math.PI) / 180), Math.sin((sqAngle * Math.PI) / 180)];
      for (const [x, y] of pts) {
        expect(y).toBeGreaterThan(-1e-9);
        expect(d[0] * y - d[1] * x).toBeLessThan(1e-7);
      }
      const onRay1 = pts.filter(([, y]) => Math.abs(y) < 1e-9).map(([x]) => x);
      const onRay2 = pts.filter(([x, y]) => Math.abs(d[0] * y - d[1] * x) < 1e-7).map(([x, y]) => x * d[0] + y * d[1]);
      expect(Math.max(...onRay1)).toBeCloseTo(S.A, 6);
      expect(Math.max(...onRay2)).toBeCloseTo(S.A, 6);
      expect(Math.min(...onRay1)).toBeLessThan(S.relief + 0.01);
      expect(Math.min(...onRay2)).toBeLessThan(S.relief + 0.01);
      collect();
    }
  });

  it('beitelhoekmeter: inkepingen hebben exact de hoek', () => {
    const v = { kind: 'chisel', cgAngles: '20; 25; 30; 35' };
    const C = chiselLayout(params(v));
    const polys = slice(solidOf(v), 1);
    for (const n of C.notches) {
      const hit = vertexAt(polys, n.x0, C.Hp - C.dn)!;
      expect(hit).not.toBeNull();
      expect(angleDeg(sub(hit.prev, hit.v), sub(hit.next, hit.v))).toBeCloseTo(n.theta, 6);
    }
    collect();
  });

  it.each([0, 15, 30, 45])('boorgeleider %s°: gaten lopen onder de juiste hoek en zijn rond genoeg', (dgAngle) => {
    const v = { kind: 'drill', dgAngle, dgSizes: '5; 8' };
    const G = drillLayout(params(v));
    const solid = solidOf(v);
    const lo = holesOf(slice(solid, 2)).sort((a, b) => a[0] - b[0]);
    const hi = holesOf(slice(solid, G.H - 2)).sort((a, b) => a[0] - b[0]);
    expect(lo).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const dy = hi[i][1] - lo[i][1];
      const tilt = (Math.atan2(Math.hypot(hi[i][0] - lo[i][0], dy), G.H - 4) * 180) / Math.PI;
      expect(tilt).toBeCloseTo(dgAngle, 4);
      expect(lo[i][0]).toBeCloseTo(G.holes[i].x, 4);
      // bottom exit on the sight line
      expect(lo[i][1] - 2 * Math.tan((dgAngle * Math.PI) / 180)).toBeCloseTo(G.yc, 4);
    }
    collect();
  });

  it('instelblokjes: elke trede heeft exact zijn hoogte', () => {
    const v = { kind: 'setup', suHeights: '0,5; 1; 2; 3,2; 12,5; 25' };
    const S = setupLayout(params(v));
    const solid = solidOf(v);
    for (const s of S.steps) {
      const probe = solid.intersect(M.Manifold.cube([0.4, 0.4, 200]).translate([s.x + 1, 1, -1]));
      expect(probe.boundingBox().max[2]).toBeCloseTo(s.h, 6);
    }
    collect();
  });

  it('deuvelmal: gaten in het midden tussen de wangen', () => {
    for (const dwBoard of [12, 18, 27.5]) {
      const v = { kind: 'dowel', dwBoard, dwD: '6', dwHoles: 3, dwStop: 25 };
      const J = dowelLayout(params(v));
      const solid = solidOf(v);
      const h = holesOf(slice(solid, J.Tg / 2));
      expect(h).toHaveLength(3);
      for (const [x, y] of h) {
        expect(y).toBeCloseTo(0, 6);
        expect(J.xs.some((xi) => Math.abs(xi - x) < 1e-4)).toBe(true);
      }
      const ys = slice(solid, J.Tg + J.He / 2).flat().map(([, y]) => y);
      const innerPos = Math.min(...ys.filter((y) => y > 0));
      const innerNeg = Math.max(...ys.filter((y) => y < 0));
      expect(innerPos).toBeCloseTo(J.inner, 6);
      expect(innerNeg).toBeCloseTo(-J.inner, 6);
      // the end stop sits `stop` mm before the first hole
      const xs = slice(solid, J.Tg + J.He / 2).flat().map(([x]) => x);
      expect(Math.max(...xs.filter((x) => x < 0))).toBeCloseTo(-J.stop, 6);
      collect();
    }
  });

  it('gaatjesmal en scharniermal: gaten op de maat vanaf de lip', () => {
    const sv = { kind: 'shelf', spOffset: 37, spPitch: 32, spHoles: 5 };
    const S = shelfLayout(params(sv));
    const sh = holesOf(slice(solidOf(sv), S.t / 2)).sort((a, b) => a[0] - b[0]);
    expect(sh).toHaveLength(5);
    sh.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(i * 32, 6);
      expect(y).toBeCloseTo(37, 6);
    });
    const hv = { kind: 'hinge', hgEdge: 4, hgCup: '35', hgPattern: '45' };
    const H = hingeLayout(params(hv));
    const hh = holesOf(slice(solidOf(hv), H.t / 2));
    const cup = hh.find(([x]) => Math.abs(x) < 1)!;
    expect(cup[1]).toBeCloseTo(4 + 17.5, 6);
    const screws = hh.filter(([x]) => Math.abs(x) > 1).sort((a, b) => a[0] - b[0]);
    expect(screws[1][0] - screws[0][0]).toBeCloseTo(45, 6);
    expect(screws[0][1] - cup[1]).toBeCloseTo(9.5, 6);
    collect();
  });

  it('kantlijnmal: gaatjes op afstand d van de lip', () => {
    const v = { kind: 'scribe', scMax: 30, scStep: 1.5 };
    const S = scribeLayout(params(v));
    const h = holesOf(slice(solidOf(v), S.t / 2)).sort((a, b) => a[0] - b[0]);
    expect(h).toHaveLength(S.holes.length);
    h.forEach(([x], i) => expect(x).toBeCloseTo(S.holes[i].d, 4));
    // inner face of the lip at x = 0
    const lip = slice(solidOf(v), S.t + S.fh / 2).flat().map(([x]) => x);
    expect(Math.max(...lip)).toBeCloseTo(0, 9);
    collect();
  });

  it('duwblok: greep, hak en zool sluiten aan in de samengestelde weergave', async () => {
    const res = await buildTool(M, tool, params({ kind: 'pushBlock', pbHeel: 'screw', pbPad: true, pbHeelH: 6 }));
    expect(res.parts.map((p) => p.name)).toEqual(['Duwblok', 'Handgreep', 'Hak (vervangbaar)', 'Antislipzool (TPU)']);
    expect(res.scene).toHaveLength(4);
  });
});
