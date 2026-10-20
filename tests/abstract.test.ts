import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect, keep } from '../src/core/registry';
import { buildTool } from './helpers';
import { handlesTool, DESIGN_STYLES } from '../src/tools/handles';
import { vaseTool, SECTION_OPTIONS, PROFILE_OPTIONS, shapeOptionsFrom } from '../src/tools/vase';
import { planterTool } from '../src/tools/planter';
import { buildShape, MAX_WALL_SLOPE, type Surface } from '../src/geom/surface';
import { defaultsOf, type Params, type ToolDef } from '../src/core/types';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const withDefaults = (tool: ToolDef, over: Partial<Params>): Params => ({ ...defaultsOf(tool.params), ...over }) as Params;
type Built = Awaited<ReturnType<typeof buildTool>>;
type PartRes = Built['parts'][number];

/** Area (mm²) of downward faces steeper than `maxDeg` from vertical that are not on the bed. */
function overhangArea(part: PartRes, maxDeg = 46, bedSkip = 0.3) {
  const { positions: P, indices: I } = part.mesh;
  let zMin = Infinity;
  for (let i = 2; i < P.length; i += 3) zMin = Math.min(zMin, P[i]);
  const lim = -Math.sin((maxDeg * Math.PI) / 180);
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    if (Math.max(P[a + 2], P[b + 2], P[c + 2]) < zMin + bedSkip) continue;
    if (nz / len < lim) area += len / 2;
  }
  return area;
}

/** Overlap volumes (> 2 mm³) between the items of the assembled view. */
function overlaps(res: Built) {
  if (!res.scene) return [];
  const base = res.parts.map((p) => keep(new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: p.mesh.positions, triVerts: p.mesh.indices }))));
  const solids: { label: string; m: Manifold }[] = [];
  res.scene.forEach((s, i) => {
    if (s.kind === 'part') solids.push({ label: `${res.parts[s.part].name}#${i}`, m: base[s.part].transform(s.matrix as unknown as Mat4) });
    else if (s.material !== 'ghost') solids.push({ label: `${s.label ?? 'plank'}#${i}`, m: M.Manifold.cube(s.size).translate(s.position) });
  });
  const out: string[] = [];
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++) {
      const v = solids[a].m.intersect(solids[b].m).volume();
      if (v > 2) out.push(`${solids[a].label} ∩ ${solids[b].label} = ${v.toFixed(1)} mm³`);
    }
  return out;
}

const timed = async (tool: ToolDef, p: Params) => {
  const t0 = performance.now();
  const res = await buildTool(M, tool, p);
  return { res, ms: performance.now() - t0 };
};

// ---------------------------------------------------------------------------
// Knobs

const knob = (over: Partial<Params>) => withDefaults(handlesTool, { type: 'knob', ...over });

describe('designknoppen: elke vorm × elke bevestiging', () => {
  const cases: [string, string][] = [];
  for (const s of DESIGN_STYLES) for (const mount of ['tap', 'nut', 'insert']) cases.push([s.value, mount]);
  it.each(cases)('%s / %s', async (style, mount) => {
    const { res, ms } = await timed(handlesTool, knob({ style, mount, screw: mount === 'nut' ? 'M5' : 'M4', headFile: style === 'custom' ? 'upload:test-star' : '' }));
    if (process.env.REPORT) console.log(style, mount, Math.round(ms), 'ms', res.parts[0].size.map((v) => v.toFixed(1)).join('x'), overhangArea(res.parts[0]).toFixed(0), res.warnings.join(' / '));
    const part = res.parts[0];
    expect(part.volume).toBeGreaterThan(1000);
    // no supports needed: only the small ceilings of the screw hole / nut pocket may bridge
    expect(overhangArea(part)).toBeLessThan(90);
    expect(ms).toBeLessThan(3000);
  });

  it('eigen SVG als kop gebruikt de vorm (geen ronde reservekop)', async () => {
    const custom = await buildTool(M, handlesTool, knob({ style: 'custom', headFile: 'upload:test-star', knobD: 40 }));
    const round = await buildTool(M, handlesTool, knob({ style: 'custom', headFile: '', knobD: 40 }));
    expect(custom.parts[0].volume).toBeLessThan(round.parts[0].volume * 0.9);
    expect(round.tips.some((t) => t.includes('SVG'))).toBe(true);
  });

  it.each([
    ['cross', { headCount: 8, headDepth: 90, knobD: 15 }],
    ['star', { headCount: 24, headDepth: 90, knobD: 15, headRounding: 0 }],
    ['bloom', { headCount: 12, headDepth: 90, knobD: 15, headH: 30, knobH: 12 }],
    ['gear', { headCount: 24, headDepth: 90, knobD: 80, knobH: 60, headH: 4 }],
    ['ring', { ringHole: 70, knobD: 80, knobH: 12, headH: 30, puff: 0 }],
    ['superformula', { headM: 16, headN1: 0.2, headN2: 20, headN3: 0.2, knobD: 15 }],
    ['pebble', { headDepth: 90, puff: 100, knobD: 80, knobH: 60, headH: 30 }],
  ])('extreem: %s', async (style, over) => {
    const { res, ms } = await timed(handlesTool, knob({ style, ...over }));
    expect(res.parts[0].volume).toBeGreaterThan(300);
    expect(ms).toBeLessThan(6000);
  });
});

// ---------------------------------------------------------------------------
// Abstract bars and arches

const handle = (over: Partial<Params>) => withDefaults(handlesTool, over);

describe('abstracte grepen', () => {
  const cases: [string, string, string][] = [];
  for (const barStyle of ['twisted', 'wavy', 'bone', 'branch']) for (const mount of ['tap', 'nut', 'insert']) cases.push([barStyle, mount, mount === 'nut' ? '256' : '64']);
  it.each(cases)('staaf %s / %s / %s mm', async (barStyle, mount, spacing) => {
    const { res, ms } = await timed(handlesTool, handle({ type: 'bar', barStyle, mount, spacing, overhang: spacing === '256' ? 30 : 18 }));
    for (const q of res.parts) expect(q.volume).toBeGreaterThan(500);
    expect(ms).toBeLessThan(3000);
    // every part fits on the bed in its print orientation
    for (const q of res.parts) expect(Math.max(...q.size)).toBeLessThanOrEqual(330);
    expect(overlaps(res)).toEqual([]);
  });

  it.each(['square', 'triangle', 'star', 'flower', 'cross'])('gedraaide staaf: %s', async (twistSection) => {
    const res = await buildTool(M, handlesTool, handle({ type: 'bar', barStyle: 'twisted', twistSection, barTwist: 720 }));
    expect(res.parts[0].volume).toBeGreaterThan(5000);
    expect(overlaps(res)).toEqual([]);
  });

  it.each(['wave', 'loop', 'arch', 'square'])('beugel %s', async (archShape) => {
    for (const [spacing, mount] of [['64', 'tap'], ['128', 'nut'], ['320', 'insert']]) {
      const { res, ms } = await timed(handlesTool, handle({ type: 'arch', archShape, spacing, mount }));
      expect(res.parts[0].volume).toBeGreaterThan(3000);
      // flat on the bed: the outline is extruded straight up (only the rounded bottom edge leans out)
      expect(overhangArea(res.parts[0], 46, 2.5), `${spacing} ${mount}`).toBeLessThan(40);
      expect(ms).toBeLessThan(3000);
    }
  });
});

// ---------------------------------------------------------------------------
// Vase and pot sections

const vase = (over: Partial<Params>) => withDefaults(vaseTool, over);
const sections = SECTION_OPTIONS.map((o) => o.value);
const sectionExtra = (section: string): Partial<Params> => (section === 'custom' ? { sectionFile: 'upload:test-star' } : {});

describe('vaas: elke doorsnede × elke modus', () => {
  const cases: [string, string][] = [];
  for (const s of sections) for (const mode of ['vase', 'walled', 'lamp']) cases.push([s, mode]);
  it.each(cases)('%s / %s', async (section, mode) => {
    const p = vase({ section, mode, ...sectionExtra(section), quality: 'draft', ...(mode === 'lamp' ? { d0: 220, d1: 240, d2: 250, d3: 260, wall: 1.2, fitting: 'e14' } : {}) });
    const { res, ms } = await timed(vaseTool, p);
    expect(res.parts[0].volume).toBeGreaterThan(mode === 'vase' ? 100000 : 10000);
    expect(ms).toBeLessThan(3000);
  });
});

describe('plantenpot: elke doorsnede × staand / hangend / muur, zelfwaterend', () => {
  const cases: [string, string][] = [];
  for (const s of sections) for (const mount of ['stand', 'hang', 'wall']) cases.push([s, mount]);
  it.each(cases)('%s / %s', async (section, mount) => {
    const p = withDefaults(planterTool, { section, mount, water: 'self', count: section === 'polygon' ? 5 : 6, depth: 25, ...sectionExtra(section) });
    const { res, ms } = await timed(planterTool, p);
    const names = res.parts.map((q) => q.name);
    expect(names).toContain('Pot');
    expect(names.some((n) => n.startsWith('Binnenpot'))).toBe(true);
    for (const q of res.parts) expect(q.volume).toBeGreaterThan(1000);
    expect(overlaps(res)).toEqual([]);
    expect(ms).toBeLessThan(4000);
  });

  it.each(PROFILE_OPTIONS.map((o) => o.value))('profiel %s met organische vervorming (hangend, zelfwaterend)', async (profile) => {
    const p = withDefaults(planterTool, { section: 'blob', mount: 'hang', water: 'self', profile, profileCount: 8, profileDepth: 60, organic: 25, organicScale: 20 });
    const { res, ms } = await timed(planterTool, p);
    expect(res.parts.length).toBeGreaterThanOrEqual(2);
    expect(overlaps(res)).toEqual([]);
    expect(ms).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Printable walls: the outer surface never overhangs more than the limit

/** Steepest outward lean of the wall at fixed world angles (radius change per mm going up). */
function steepestOverhang(S: Surface, H: number) {
  let worst = 0;
  const h = 0.25;
  for (let ia = 0; ia < 180; ia++) {
    const a = (2 * Math.PI * ia) / 180;
    let prev = S.r(0, a - S.phi(0));
    for (let z = h; z <= H + 1e-9; z += h) {
      const r = S.r(z, a - S.phi(z));
      worst = Math.max(worst, (r - prev) / h);
      prev = r;
    }
  }
  return worst;
}

describe('profielstijlen en organische vervorming blijven printbaar', () => {
  const H = 200;
  const extremes: [string, Partial<Params>][] = [];
  for (const profile of PROFILE_OPTIONS.map((o) => o.value)) {
    extremes.push([`${profile} diep`, { profile, profileCount: 30, profileDepth: 90 }]);
    extremes.push([`${profile} weinig`, { profile, profileCount: 1, profileDepth: 90 }]);
    extremes.push([`${profile} + organisch max`, { profile, profileCount: 12, profileDepth: 70, organic: 40, organicScale: 10, organicSeed: 999 }]);
  }
  extremes.push(['organisch groot', { organic: 40, organicScale: 150 }]);
  it.each(extremes)('%s', async (_name, over) => {
    // straight cylinder: every bit of overhang comes from the style itself
    const p = vase({ section: 'round', height: H, d0: 120, d1: 120, d2: 120, d3: 120, twist: 0, waveAmp: 0, ...over });
    const t0 = performance.now();
    const b = buildShape(shapeOptionsFrom(p, H, [60, 60, 60, 60]), 1);
    const slope = steepestOverhang(b.S, H);
    // tan 55° plus a little for sampling
    expect(slope).toBeLessThan(MAX_WALL_SLOPE + 0.1);
    // within the mesh budget
    expect(b.segs * (b.rings + (b.zs?.length ?? 0))).toBeLessThanOrEqual(90000 * 1.4);
    const res = await buildTool(M, vaseTool, p);
    expect(res.parts[0].volume).toBeGreaterThan(100000);
    expect(performance.now() - t0).toBeLessThan(6000);
  });

  it.each(['terraced', 'facet'])('%s: treden hangen niet verder over dan 45°', (profile) => {
    // a vase that widens a lot: the terraces step outward and must be chamfered at 45°
    const p = vase({ section: 'round', profile, profileCount: 6, profileDepth: 90, twist: 0, waveAmp: 0 });
    const b = buildShape(shapeOptionsFrom(p, 200, [40, 80, 100, 110]), 1);
    expect(steepestOverhang(b.S, 200)).toBeLessThan(1.25);
  });

  it('te veel vervorming wordt afgezwakt met een waarschuwing', async () => {
    const res = await buildTool(M, vaseTool, vase({ section: 'round', organic: 40, organicScale: 10, twist: 0, waveAmp: 0 }));
    expect(res.warnings.some((w) => w.includes('afgezwakt'))).toBe(true);
  });

  it('organisch is periodiek rond: geen naad op 0°/360°', () => {
    const p = vase({ section: 'blob', organic: 30, organicScale: 30, twist: 90 });
    const b = buildShape(shapeOptionsFrom(p, 200, [50, 60, 55, 45]), 1);
    for (let z = 0; z <= 200; z += 10) expect(Math.abs(b.S.r(z, 0) - b.S.r(z, 2 * Math.PI))).toBeLessThan(0.05);
  });
});

describe('eigen SVG als doorsnede', () => {
  it('vaas en pot volgen de SVG-vorm', async () => {
    const star = await buildTool(M, vaseTool, vase({ section: 'custom', sectionFile: 'upload:test-star', twist: 0, waveAmp: 0 }));
    const round = await buildTool(M, vaseTool, vase({ section: 'round', twist: 0, waveAmp: 0 }));
    expect(star.parts[0].volume).toBeLessThan(round.parts[0].volume * 0.8);
    const pot = await buildTool(M, planterTool, withDefaults(planterTool, { section: 'custom', sectionFile: 'upload:test-star', water: 'self', mount: 'hang' }));
    expect(overlaps(pot)).toEqual([]);
  });

  it('zonder bestand: ronde vorm, geen fout', async () => {
    const res = await buildTool(M, vaseTool, vase({ section: 'custom', sectionFile: '' }));
    expect(res.parts[0].volume).toBeGreaterThan(100000);
  });
});

describe('verras me', () => {
  it('vaas: 12 willekeurige ontwerpen bouwen', async () => {
    for (let i = 0; i < 12; i++) {
      const p = vase(vaseTool.randomize!({} as Params) as Partial<Params>);
      const { res, ms } = await timed(vaseTool, p);
      expect(res.parts[0].volume, JSON.stringify(p)).toBeGreaterThan(1000);
      expect(ms, JSON.stringify(p)).toBeLessThan(4000);
    }
  });
  it('grepen: 12 willekeurige ontwerpen bouwen', async () => {
    for (let i = 0; i < 12; i++) {
      const p = handle(handlesTool.randomize!({} as Params) as Partial<Params>);
      const res = await buildTool(M, handlesTool, p);
      expect(res.parts[0].volume, JSON.stringify(p)).toBeGreaterThan(500);
    }
  });
});
