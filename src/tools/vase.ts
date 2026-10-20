import type { ToolDef, Params, BuildOutput, ParamDef, AssetRef, AssetStore } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { CLASSIC_SECTIONS, buildShape, solidOfSurface, shellOfSurface, insetSurface, type ShapeBuild, type ShapeOptions } from '../geom/surface';
import { TAU } from '../geom/helpers';
import { SHAPE_USES, effectiveSpec, radialShape, type ShapeSpec } from '../geom/shapes2d';

export const SECTION_OPTIONS = [
  { value: 'round', label: 'Rond' },
  { value: 'polygon', label: 'Veelhoek' },
  { value: 'flower', label: 'Bloem' },
  { value: 'star', label: 'Ster' },
  { value: 'scallop', label: 'Schelp' },
  { value: 'gear', label: 'Kantelen' },
  { value: 'petals', label: 'Bloemblaadjes' },
  { value: 'squircle', label: 'Zachte rechthoek' },
  { value: 'cross', label: 'Kruis' },
  { value: 'clover', label: 'Klaver' },
  { value: 'cloud', label: 'Wolk' },
  { value: 'blob', label: 'Blob (organisch)' },
  { value: 'heart', label: 'Hart' },
  { value: 'drop', label: 'Druppel' },
  { value: 'leaf', label: 'Blad' },
  { value: 'superformula', label: 'Superformule (abstract)' },
  { value: 'custom', label: 'Eigen vorm (SVG uploaden)' },
];

export const PROFILE_OPTIONS = [
  { value: 'smooth', label: 'Glad (vloeiend)' },
  { value: 'terraced', label: 'Getrapt (terrassen)' },
  { value: 'bubbles', label: 'Bollen (gestapeld)' },
  { value: 'wavy', label: 'Golvende ringen' },
  { value: 'facet', label: 'Facetten / kristal' },
];

type Use = 'count' | 'depth' | 'rounding' | 'seed' | 'sf' | 'file';
const CLASSIC_USES: Record<string, Use[]> = {
  round: [],
  polygon: ['count', 'rounding'],
  flower: ['count', 'depth'],
  star: ['count', 'depth'],
  scallop: ['count', 'depth'],
  gear: ['count', 'depth'],
};
const uses = (p: Params, what: Use) => (CLASSIC_USES[str(p, 'section')] ?? SHAPE_USES[str(p, 'section')] ?? []).includes(what);

/** Mesh segments around that the library sections need to stay crisp. */
const SECTION_SEGS: Record<string, (n: number) => number> = {
  petals: (n) => n * 18,
  squircle: () => 192,
  blob: () => 240,
  superformula: () => 540,
};

/** Periodic lookup table of a radial function: library shapes trace rays, so evaluate them once. */
function tabulate(fn: (th: number) => number, n = 4096): (th: number) => number {
  const t = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) t[i] = fn((TAU * i) / n);
  t[n] = t[0];
  return (th) => {
    let x = ((th / TAU) % 1) * n;
    if (x < 0) x += n;
    const i = Math.min(n - 1, Math.floor(x));
    return t[i] + (t[i + 1] - t[i]) * (x - i);
  };
}

/** Shared shape controls (also used by the plant pot tool). */
export function shapeParams(defaults: { section?: string; count?: number; depth?: number }): ParamDef[] {
  const shaped = (p: Params) => str(p, 'profile') !== 'smooth';
  return [
    { type: 'group', label: 'Doorsnede' },
    { type: 'select', key: 'section', label: 'Vorm', options: SECTION_OPTIONS, default: defaults.section ?? 'round' },
    { type: 'number', key: 'count', label: 'Aantal (zijden / lobben / armen)', min: 3, max: 48, step: 1, default: defaults.count ?? 6, show: (p) => uses(p, 'count') },
    { type: 'number', key: 'depth', label: 'Diepte patroon', min: 0, max: 90, step: 1, unit: '%', default: defaults.depth ?? 12, show: (p) => uses(p, 'depth') },
    { type: 'number', key: 'rounding', label: 'Afronding', min: 0, max: 100, step: 1, unit: '%', default: 30, show: (p) => uses(p, 'rounding') },
    { type: 'number', key: 'seed', label: 'Variant vorm', min: 1, max: 999, step: 1, default: 7, show: (p) => uses(p, 'seed') },
    { type: 'number', key: 'sfM', label: 'Superformule m (symmetrie)', min: 0, max: 24, step: 1, default: 6, show: (p) => uses(p, 'sf') },
    { type: 'number', key: 'sfN1', label: 'Superformule n1 (bolling)', min: 0.2, max: 20, step: 0.1, default: 1, show: (p) => uses(p, 'sf') },
    { type: 'number', key: 'sfN2', label: 'Superformule n2', min: 0.2, max: 20, step: 0.1, default: 1.7, show: (p) => uses(p, 'sf') },
    { type: 'number', key: 'sfN3', label: 'Superformule n3', min: 0.2, max: 20, step: 0.1, default: 1.7, show: (p) => uses(p, 'sf') },
    {
      type: 'file', key: 'sectionFile', label: 'SVG-bestand', asset: 'shape', accept: '.svg,image/svg+xml', default: '',
      help: 'Een gevulde vorm. De buitencontour (gezien vanuit het midden) wordt de doorsnede.', show: (p) => uses(p, 'file'),
    },
    { type: 'group', label: 'Draaiing & golven' },
    { type: 'number', key: 'twist', label: 'Draaiing', min: -720, max: 720, step: 5, unit: '°', default: 0 },
    {
      type: 'select', key: 'twistMode', label: 'Draaiverloop', default: 'linear', show: (p) => num(p, 'twist') !== 0,
      options: [
        { value: 'linear', label: 'Gelijkmatig' },
        { value: 'ease', label: 'Zacht in/uit' },
        { value: 'wave', label: 'Heen en weer' },
      ],
    },
    { type: 'number', key: 'twistWaves', label: 'Aantal keer heen-en-weer', min: 1, max: 8, step: 1, default: 2, show: (p) => num(p, 'twist') !== 0 && str(p, 'twistMode') === 'wave' },
    { type: 'number', key: 'waveAmp', label: 'Horizontale golven', min: 0, max: 20, step: 0.5, unit: '%', default: 0 },
    { type: 'number', key: 'waveFreq', label: 'Aantal golven', min: 1, max: 30, step: 1, default: 4, show: (p) => num(p, 'waveAmp') > 0 },
    { type: 'group', label: 'Abstract & organisch' },
    { type: 'select', key: 'profile', label: 'Profielstijl', options: PROFILE_OPTIONS, default: 'smooth' },
    { type: 'number', key: 'profileCount', label: 'Aantal treden / bollen / ringen / facetten', min: 1, max: 30, step: 1, default: 6, show: shaped },
    { type: 'number', key: 'profileDepth', label: 'Diepte profielstijl', min: 0, max: 90, step: 1, unit: '%', default: 35, show: shaped },
    {
      type: 'number', key: 'organic', label: 'Organische vervorming', min: 0, max: 40, step: 1, unit: '%', default: 0,
      help: 'Zachte, willekeurige deuken en bulten. Te steile stukken worden automatisch afgezwakt.',
    },
    { type: 'number', key: 'organicScale', label: 'Grootte van de bulten', min: 10, max: 150, step: 1, unit: 'mm', default: 45, show: (p) => num(p, 'organic') > 0 },
    { type: 'number', key: 'organicSeed', label: 'Variant', min: 1, max: 999, step: 1, default: 7, show: (p) => num(p, 'organic') > 0 || str(p, 'profile') === 'facet' },
  ];
}

const get = (p: Params, k: string, d: number) => (p[k] === undefined || p[k] === '' ? d : num(p, k));
const getS = (p: Params, k: string, d: string) => (p[k] === undefined ? d : str(p, k));

/** The cross-section as a shape-library spec (for sections beyond the classic six). */
function sectionSpec(p: Params): ShapeSpec {
  return {
    shape: str(p, 'section'),
    count: get(p, 'count', 6),
    depth: get(p, 'depth', 12) / 100,
    rounding: get(p, 'rounding', 30) / 100,
    seed: get(p, 'seed', 7),
    m: get(p, 'sfM', 6),
    n1: get(p, 'sfN1', 1),
    n2: get(p, 'sfN2', 1.7),
    n3: get(p, 'sfN3', 1.7),
    file: p.sectionFile ? str(p, 'sectionFile') : undefined,
  };
}

/** Assets the section needs (an uploaded SVG). */
export function sectionAssets(p: Params): AssetRef[] {
  return str(p, 'section') === 'custom' && p.sectionFile ? [{ kind: 'shape', key: str(p, 'sectionFile') }] : [];
}

export function shapeOptionsFrom(p: Params, height: number, radii: number[], assets?: AssetStore): ShapeOptions {
  const section = str(p, 'section');
  const o: ShapeOptions = {
    height,
    radii,
    section,
    count: num(p, 'count'),
    depth: num(p, 'depth') / 100,
    rounding: num(p, 'rounding') / 100,
    twist: num(p, 'twist'),
    twistMode: str(p, 'twistMode'),
    twistWaves: num(p, 'twistWaves'),
    waveAmp: num(p, 'waveAmp') / 100,
    waveFreq: num(p, 'waveFreq'),
    profile: getS(p, 'profile', 'smooth'),
    profileCount: get(p, 'profileCount', 6),
    profileDepth: get(p, 'profileDepth', 35) / 100,
    organic: get(p, 'organic', 0) / 100,
    organicScale: get(p, 'organicScale', 45),
    seed: get(p, 'organicSeed', 7),
  };
  if (!CLASSIC_SECTIONS.includes(section)) {
    const spec = effectiveSpec(sectionSpec(p));
    o.sectionR = tabulate(radialShape(spec, assets));
    o.sectionSegs = SECTION_SEGS[spec.shape]?.(Math.round(spec.count)) ?? 360;
  }
  return o;
}

/** Warnings about what was toned down to keep the walls printable. */
export function shapeNotes(b: ShapeBuild): string[] {
  const out: string[] = [];
  if (b.limited) out.push(`Golven afgezwakt tot ${(b.opts.waveAmp * 100).toFixed(1)}%: steilere golven hangen te ver over om te printen. Gebruik minder golven voor meer diepte.`);
  if (b.kept < 1) {
    const what = (b.opts.organic ?? 0) > 0 ? (b.opts.profile === 'wavy' ? 'Organische vervorming en golvende ringen' : 'Organische vervorming') : 'Golvende ringen';
    out.push(`${what} afgezwakt tot ${Math.round(b.kept * 100)}% zodat de wand nergens verder dan ~55° overhangt. Kies grotere bulten of minder ringen voor meer diepte.`);
  }
  if (b.steepest > 1.75) out.push('Let op: het profiel loopt op sommige plekken steiler uit dan 60°. Maak de diameters geleidelijker of print met support.');
  return out;
}

const FITTINGS: Record<string, { hole: number; bulb: number; label: string }> = {
  e27: { hole: 40.5, bulb: 60, label: 'E27' },
  e14: { hole: 28.5, bulb: 45, label: 'E14' },
};

const QUALITY: Record<string, number> = { draft: 0.6, normal: 1, fine: 1.5 };

function build(p: Params, { M, printer, assets }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const mode = str(p, 'mode');
  const H = num(p, 'height');
  const radii = ['d0', 'd1', 'd2', 'd3'].map((k) => num(p, k) / 2);
  const shape = buildShape(shapeOptionsFrom(p, H, radii, assets), QUALITY[str(p, 'quality')] ?? 1);
  const { S } = shape;
  let { segs, rings, zs } = shape;
  if (bool(p, 'lowPoly')) {
    segs = Math.round(num(p, 'facetsAround'));
    rings = Math.round(num(p, 'facetsUp')) + 1;
    zs = undefined;
  }
  const tips: string[] = [];
  const warnings: string[] = [];
  const info: BuildOutput['info'] = [];

  // sample the outline to report sizes and check the bed
  let maxR = 0;
  let minTopR = Infinity;
  let minBottomR = Infinity;
  for (let k = 0; k < 360; k++) {
    const th = (TAU * k) / 360;
    for (let i = 0; i <= 40; i++) maxR = Math.max(maxR, S.r((H * i) / 40, th));
    minTopR = Math.min(minTopR, S.r(H, th));
    minBottomR = Math.min(minBottomR, S.r(0, th));
  }

  let solid;
  if (mode === 'vase') {
    solid = solidOfSurface(M, S, 0, H, segs, rings, zs);
    tips.push(
      'Bambu Studio: zet bij "Overige" de optie "Spiraalvaas" (vase mode) aan. De slicer maakt dan zelf één doorlopende wand.',
      'Voor een stevigere vaas: gebruik een 0.6 mm nozzle of zet de lijnbreedte op ~0.8 mm.',
      'Vase-mode prints zijn niet altijd waterdicht — zet er een glazen potje in voor verse bloemen.',
    );
  } else {
    const wall = num(p, 'wall');
    const inner = insetSurface(S, wall);
    if (mode === 'walled') {
      const bottom = num(p, 'bottom');
      solid = shellOfSurface(M, S, inner, { z0: 0, z1: H, floor: bottom, segs, rings, zs });
      tips.push(`Wand ${wall} mm: zet "Wandlussen" op ${Math.max(2, Math.round(wall / 0.42))} en infill op 0% voor een volledig massieve wand.`);
    } else {
      const fit = FITTINGS[str(p, 'fitting')];
      const holeD = fit ? fit.hole : num(p, 'holeD');
      const ringW = num(p, 'ringWidth');
      const th = num(p, 'spiderThickness');
      const shell = shellOfSurface(M, S, inner, { z0: 0, z1: H, floor: null, segs, rings, zs });
      const ringR = holeD / 2 + ringW;
      if (ringR > minBottomR - wall - 2) {
        throw new UserError(`De lampring (Ø${(ringR * 2).toFixed(0)} mm) past niet in de onderopening — maak de onderkant breder of de ring smaller.`);
      }
      const n = Math.round(num(p, 'spokes'));
      const sw = num(p, 'spokeWidth');
      const reach = maxR + 5;
      const pieces = [M.Manifold.cylinder(th, ringR, ringR, 96)];
      for (let i = 0; i < n; i++) {
        pieces.push(M.Manifold.cube([reach, sw, th]).translate([0, -sw / 2, 0]).rotate([0, 0, (360 * i) / n]));
      }
      const outerSolid = solidOfSurface(M, S, 0, H, segs, rings, zs);
      const spider = M.Manifold.union(pieces)
        .intersect(outerSolid)
        .subtract(M.Manifold.cylinder(th + 2, holeD / 2, holeD / 2, 96).translate([0, 0, -1]));
      solid = M.Manifold.union([shell, spider]);
      const bulb = fit?.bulb ?? holeD + 20;
      if (minTopR * 2 < bulb + 10) {
        warnings.push(`De bovenopening (Ø${(minTopR * 2).toFixed(0)} mm) is krap voor een ${fit?.label ?? ''} lamp (Ø${bulb} mm). Maak de bovenkant breder.`);
      }
      let minNear = Infinity;
      for (let k = 0; k < 72; k++) for (let z = 0; z <= Math.min(H, 120); z += 10) minNear = Math.min(minNear, S.r(z, (TAU * k) / 72));
      if (minNear - bulb / 2 < 30) {
        warnings.push('Minder dan 3 cm tussen lamp en kap: gebruik alleen een LED-lamp (geen gloei- of halogeenlamp).');
      }
      tips.push(
        'Gebruik altijd een LED-lamp: PLA wordt zacht vanaf ~55 °C. PETG is hittebestendiger.',
        'De spin (ring met spaken) ligt plat op het bed. Hang de kap ondersteboven op (spin boven) als hanglamp.',
        `Ringgat Ø${holeD} mm past over een standaard ${fit?.label ?? 'fitting'} met kapring.`,
        `Voor mooi doorschijnend licht: ${Math.max(1, Math.round(wall / 0.42))} wandlus(sen), wit of naturel PLA.`,
      );
    }
  }

  warnings.push(...shapeNotes(shape));
  if (str(p, 'profile') === 'terraced' || str(p, 'profile') === 'facet') tips.push('De treden en facetten lopen schuin af onder 45° of steiler: ze printen zonder support, ook in vase mode.');
  const footprint = maxR * 2;
  info.push({
    kind: 'kv',
    title: 'Afmetingen',
    rows: [
      ['Hoogte', `${H.toFixed(0)} mm`],
      ['Grootste diameter', `${footprint.toFixed(0)} mm`],
      ['Opening boven', `Ø ${(minTopR * 2).toFixed(0)} mm`],
      ['Resolutie', `${segs} × ${zs ? rings + zs.length : rings}`],
    ],
  });
  if (footprint > Math.min(printer.x, printer.y) - 10) warnings.push(`Te breed voor de ${printer.name}.`);

  return {
    parts: [{ name: mode === 'lamp' ? 'Lampenkap' : 'Vaas', solid, estimate: mode === 'vase' ? 'vase' : 'solid' }],
    info,
    tips,
    warnings,
  };
}

const rnd = (a: number, b: number, step = 1) => Math.round((a + Math.random() * (b - a)) / step) * step;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export const vaseTool: ToolDef = {
  id: 'vaas',
  name: 'Vazen & lampenkappen',
  short: 'Vazen',
  icon: 'M8 3h8M9 3c0 3-4 5-4 10a7 7 0 0 0 14 0c0-5-4-7-4-10M7 21h10',
  description: 'Parametrische vazen en lampenkappen: profiel, doorsnede (ook wolk, blob, superformule of je eigen SVG), draaiing, golven en organische vervormingen. Klaar voor vase mode of met echte wand en E27/E14-fitting.',
  params: [
    { type: 'group', label: 'Type' },
    {
      type: 'select', key: 'mode', label: 'Wat maak je?', default: 'vase',
      options: [
        { value: 'vase', label: 'Vaas — spiraalvaas (vase mode)' },
        { value: 'walled', label: 'Vaas / bak met wand' },
        { value: 'lamp', label: 'Lampenkap met fitting' },
      ],
    },
    { type: 'group', label: 'Profiel' },
    { type: 'number', key: 'height', label: 'Hoogte', min: 30, max: 320, step: 1, unit: 'mm', default: 180 },
    { type: 'number', key: 'd0', label: 'Diameter onder', min: 20, max: 320, step: 1, unit: 'mm', default: 80 },
    { type: 'number', key: 'd1', label: 'Diameter op 1/3', min: 20, max: 320, step: 1, unit: 'mm', default: 120 },
    { type: 'number', key: 'd2', label: 'Diameter op 2/3', min: 20, max: 320, step: 1, unit: 'mm', default: 105 },
    { type: 'number', key: 'd3', label: 'Diameter boven', min: 20, max: 320, step: 1, unit: 'mm', default: 75 },
    ...shapeParams({ section: 'flower', count: 8, depth: 10 }),
    { type: 'group', label: 'Wand', show: (p) => str(p, 'mode') !== 'vase' },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 0.8, max: 6, step: 0.1, unit: 'mm', default: 1.6, show: (p) => str(p, 'mode') !== 'vase' },
    { type: 'number', key: 'bottom', label: 'Bodemdikte', min: 0.8, max: 10, step: 0.1, unit: 'mm', default: 2, show: (p) => str(p, 'mode') === 'walled' },
    { type: 'group', label: 'Lampfitting', show: (p) => str(p, 'mode') === 'lamp' },
    {
      type: 'select', key: 'fitting', label: 'Fitting', default: 'e27', show: (p) => str(p, 'mode') === 'lamp',
      options: [
        { value: 'e27', label: 'E27 (gat Ø40.5 mm)' },
        { value: 'e14', label: 'E14 (gat Ø28.5 mm)' },
        { value: 'custom', label: 'Eigen maat' },
      ],
    },
    { type: 'number', key: 'holeD', label: 'Gatdiameter', min: 15, max: 80, step: 0.5, unit: 'mm', default: 40, show: (p) => str(p, 'mode') === 'lamp' && str(p, 'fitting') === 'custom' },
    { type: 'number', key: 'ringWidth', label: 'Breedte ring', min: 5, max: 30, step: 1, unit: 'mm', default: 10, show: (p) => str(p, 'mode') === 'lamp' },
    { type: 'number', key: 'spokes', label: 'Aantal spaken', min: 2, max: 8, step: 1, default: 3, show: (p) => str(p, 'mode') === 'lamp' },
    { type: 'number', key: 'spokeWidth', label: 'Breedte spaak', min: 4, max: 20, step: 1, unit: 'mm', default: 8, show: (p) => str(p, 'mode') === 'lamp' },
    { type: 'number', key: 'spiderThickness', label: 'Dikte spin', min: 2, max: 6, step: 0.2, unit: 'mm', default: 3, show: (p) => str(p, 'mode') === 'lamp' },
    { type: 'group', label: 'Afwerking' },
    { type: 'bool', key: 'lowPoly', label: 'Low-poly facetten', default: false },
    { type: 'number', key: 'facetsAround', label: 'Facetten rondom', min: 5, max: 48, step: 1, default: 12, show: (p) => bool(p, 'lowPoly') },
    { type: 'number', key: 'facetsUp', label: 'Facetten in hoogte', min: 2, max: 40, step: 1, default: 7, show: (p) => bool(p, 'lowPoly') },
    {
      type: 'select', key: 'quality', label: 'Detail', default: 'normal', show: (p) => !bool(p, 'lowPoly'),
      options: [
        { value: 'draft', label: 'Snel (schets)' },
        { value: 'normal', label: 'Normaal' },
        { value: 'fine', label: 'Fijn (export)' },
      ],
    },
  ],
  presets: [
    { name: 'Bloemvaas', values: { mode: 'vase', height: 180, d0: 80, d1: 120, d2: 105, d3: 75, section: 'flower', count: 8, depth: 10, twist: 0, waveAmp: 0, lowPoly: false } },
    { name: 'Gedraaide ster', values: { mode: 'vase', height: 220, d0: 90, d1: 110, d2: 100, d3: 85, section: 'star', count: 6, depth: 18, twist: 180, twistMode: 'linear', waveAmp: 0, lowPoly: false } },
    { name: 'Spiraal schelp', values: { mode: 'vase', height: 200, d0: 70, d1: 115, d2: 120, d3: 80, section: 'scallop', count: 12, depth: 12, twist: 120, twistMode: 'ease', waveAmp: 0, lowPoly: false } },
    { name: 'Low-poly kristal', values: { mode: 'vase', height: 190, d0: 70, d1: 125, d2: 110, d3: 70, section: 'round', twist: 60, lowPoly: true, facetsAround: 10, facetsUp: 6 } },
    { name: 'Golvende cilinder', values: { mode: 'vase', height: 160, d0: 90, d1: 90, d2: 90, d3: 90, section: 'flower', count: 24, depth: 6, twist: 0, waveAmp: 6, waveFreq: 5, lowPoly: false } },
    { name: 'Heen-en-weer kantelen', values: { mode: 'vase', height: 200, d0: 85, d1: 100, d2: 100, d3: 85, section: 'gear', count: 16, depth: 10, twist: 25, twistMode: 'wave', twistWaves: 3, waveAmp: 0, lowPoly: false } },
    { name: 'Hanglamp bol', values: { mode: 'lamp', height: 190, d0: 110, d1: 250, d2: 270, d3: 160, section: 'flower', count: 18, depth: 7, twist: 90, twistMode: 'ease', wall: 1.2, fitting: 'e27', lowPoly: false } },
    { name: 'Lampenkap kegel', values: { mode: 'lamp', height: 170, d0: 120, d1: 170, d2: 220, d3: 270, section: 'polygon', count: 9, rounding: 40, twist: 40, wall: 1.2, fitting: 'e27', lowPoly: false } },
    { name: 'Pennenbak', values: { mode: 'walled', height: 100, d0: 80, d1: 82, d2: 84, d3: 86, section: 'polygon', count: 6, rounding: 25, twist: 30, wall: 2, bottom: 2.4, lowPoly: false } },
    { name: 'Wolkvaas', values: { mode: 'vase', height: 190, d0: 100, d1: 145, d2: 135, d3: 105, section: 'cloud', count: 7, depth: 50, seed: 4, twist: 40, twistMode: 'ease', waveAmp: 0, lowPoly: false } },
    { name: 'Superformule vaas', values: { mode: 'vase', height: 210, d0: 90, d1: 130, d2: 120, d3: 95, section: 'superformula', sfM: 5, sfN1: 2, sfN2: 7, sfN3: 7, twist: 72, twistMode: 'linear', waveAmp: 0, lowPoly: false } },
    { name: 'Getrapte vaas', values: { mode: 'vase', height: 200, d0: 85, d1: 135, d2: 120, d3: 80, section: 'polygon', count: 8, rounding: 45, twist: 0, waveAmp: 0, profile: 'terraced', profileCount: 7, profileDepth: 45, lowPoly: false } },
    { name: 'Organische blob vaas', values: { mode: 'vase', height: 200, d0: 95, d1: 135, d2: 125, d3: 90, section: 'blob', count: 4, depth: 35, seed: 11, twist: 0, waveAmp: 0, organic: 14, organicScale: 55, organicSeed: 3, lowPoly: false } },
    { name: 'Bollenvaas', values: { mode: 'vase', height: 210, d0: 95, d1: 120, d2: 115, d3: 90, section: 'flower', count: 10, depth: 6, twist: 30, twistMode: 'linear', waveAmp: 0, profile: 'bubbles', profileCount: 4, profileDepth: 30, lowPoly: false } },
    { name: 'Kristalvaas', values: { mode: 'vase', height: 200, d0: 90, d1: 130, d2: 125, d3: 95, section: 'polygon', count: 7, rounding: 0, twist: 35, twistMode: 'linear', waveAmp: 0, profile: 'facet', profileCount: 5, profileDepth: 30, organicSeed: 5, lowPoly: false } },
    { name: 'Golvende ringen', values: { mode: 'vase', height: 190, d0: 100, d1: 120, d2: 120, d3: 100, section: 'round', twist: 0, waveAmp: 0, profile: 'wavy', profileCount: 9, profileDepth: 55, lowPoly: false } },
  ],
  randomize: () => {
    const section = Math.random() < 0.45 ? pick(['round', 'polygon', 'flower', 'star', 'scallop', 'gear']) : pick(['petals', 'squircle', 'cross', 'clover', 'cloud', 'blob', 'heart', 'drop', 'leaf', 'superformula']);
    const lowPoly = Math.random() < 0.12;
    const base = rnd(60, 130);
    const profile = Math.random() < 0.55 ? 'smooth' : pick(['terraced', 'bubbles', 'wavy', 'facet']);
    const depthMax: Record<string, number> = { star: 25, cross: 60, clover: 60, cloud: 70, blob: 60, petals: 40, leaf: 50 };
    return {
      height: rnd(120, 260),
      d0: base,
      d1: Math.min(300, base + rnd(-10, 70)),
      d2: Math.min(300, base + rnd(-20, 60)),
      d3: Math.max(40, base + rnd(-30, 40)),
      section,
      count: section === 'polygon' ? rnd(3, 10) : section === 'cross' ? rnd(3, 6) : section === 'blob' ? rnd(3, 6) : rnd(5, 16),
      depth: rnd(4, depthMax[section] ?? 16),
      rounding: rnd(0, 70),
      seed: rnd(1, 999),
      sfM: rnd(3, 9),
      sfN1: pick([0.5, 1, 2, 4]),
      sfN2: rnd(1, 8, 0.5),
      sfN3: rnd(1, 8, 0.5),
      twist: Math.random() < 0.6 ? rnd(-240, 240, 5) : 0,
      twistMode: pick(['linear', 'ease', 'wave']),
      twistWaves: rnd(1, 4),
      waveAmp: profile === 'smooth' && Math.random() < 0.25 ? rnd(2, 8, 0.5) : 0,
      waveFreq: rnd(2, 8),
      profile,
      profileCount: rnd(3, 9),
      profileDepth: rnd(20, 60),
      organic: Math.random() < 0.3 ? rnd(5, 20) : 0,
      organicScale: rnd(30, 80),
      organicSeed: rnd(1, 999),
      lowPoly,
      facetsAround: rnd(7, 14),
      facetsUp: rnd(4, 9),
    };
  },
  assets: sectionAssets,
  build,
};
