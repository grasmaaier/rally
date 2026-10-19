import type { ToolDef, Params, BuildOutput, ParamDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { shapeSurface, solidOfSurface, shellOfSurface, insetSurface, limitWaves, resolutionFor, type Section, type ShapeOptions } from '../geom/surface';
import { TAU } from '../geom/helpers';

export const SECTION_OPTIONS = [
  { value: 'round', label: 'Rond' },
  { value: 'polygon', label: 'Veelhoek' },
  { value: 'flower', label: 'Bloem' },
  { value: 'star', label: 'Ster' },
  { value: 'scallop', label: 'Schelp' },
  { value: 'gear', label: 'Kantelen' },
];

/** Shared shape controls (also used by the plant pot tool). */
export function shapeParams(defaults: { section?: string; count?: number; depth?: number }): ParamDef[] {
  const patterned = (p: Params) => str(p, 'section') !== 'round';
  return [
    { type: 'group', label: 'Doorsnede' },
    { type: 'select', key: 'section', label: 'Vorm', options: SECTION_OPTIONS, default: defaults.section ?? 'round' },
    { type: 'number', key: 'count', label: 'Aantal zijden / lobben', min: 3, max: 48, step: 1, default: defaults.count ?? 6, show: patterned },
    {
      type: 'number', key: 'depth', label: 'Diepte patroon', min: 0, max: 60, step: 1, unit: '%', default: defaults.depth ?? 12,
      show: (p) => patterned(p) && str(p, 'section') !== 'polygon',
    },
    { type: 'number', key: 'rounding', label: 'Afronding hoeken', min: 0, max: 100, step: 1, unit: '%', default: 30, show: (p) => str(p, 'section') === 'polygon' },
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
  ];
}

export function shapeOptionsFrom(p: Params, height: number, radii: number[]): ShapeOptions {
  return {
    height,
    radii,
    section: str(p, 'section') as Section,
    count: num(p, 'count'),
    depth: num(p, 'depth') / 100,
    rounding: num(p, 'rounding') / 100,
    twist: num(p, 'twist'),
    twistMode: str(p, 'twistMode'),
    twistWaves: num(p, 'twistWaves'),
    waveAmp: num(p, 'waveAmp') / 100,
    waveFreq: num(p, 'waveFreq'),
  };
}

const FITTINGS: Record<string, { hole: number; bulb: number; label: string }> = {
  e27: { hole: 40.5, bulb: 60, label: 'E27' },
  e14: { hole: 28.5, bulb: 45, label: 'E14' },
};

const QUALITY: Record<string, number> = { draft: 0.6, normal: 1, fine: 1.5 };

function build(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const mode = str(p, 'mode');
  const H = num(p, 'height');
  const radii = ['d0', 'd1', 'd2', 'd3'].map((k) => num(p, k) / 2);
  const { opts, limited } = limitWaves(shapeOptionsFrom(p, H, radii));
  const S = shapeSurface(opts);
  let { segs, rings } = resolutionFor(opts, QUALITY[str(p, 'quality')] ?? 1);
  if (bool(p, 'lowPoly')) {
    segs = Math.round(num(p, 'facetsAround'));
    rings = Math.round(num(p, 'facetsUp')) + 1;
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
    solid = solidOfSurface(M, S, 0, H, segs, rings);
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
      solid = shellOfSurface(M, S, inner, { z0: 0, z1: H, floor: bottom, segs, rings });
      tips.push(`Wand ${wall} mm: zet "Wandlussen" op ${Math.max(2, Math.round(wall / 0.42))} en infill op 0% voor een volledig massieve wand.`);
    } else {
      const fit = FITTINGS[str(p, 'fitting')];
      const holeD = fit ? fit.hole : num(p, 'holeD');
      const ringW = num(p, 'ringWidth');
      const th = num(p, 'spiderThickness');
      const shell = shellOfSurface(M, S, inner, { z0: 0, z1: H, floor: null, segs, rings });
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
      const outerSolid = solidOfSurface(M, S, 0, H, segs, rings);
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

  if (limited) warnings.push(`Golven afgezwakt tot ${(opts.waveAmp * 100).toFixed(1)}%: steilere golven hangen te ver over om te printen. Gebruik minder golven voor meer diepte.`);
  const footprint = maxR * 2;
  info.push({
    kind: 'kv',
    title: 'Afmetingen',
    rows: [
      ['Hoogte', `${H.toFixed(0)} mm`],
      ['Grootste diameter', `${footprint.toFixed(0)} mm`],
      ['Opening boven', `Ø ${(minTopR * 2).toFixed(0)} mm`],
      ['Resolutie', `${segs} × ${rings}`],
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

export const vaseTool: ToolDef = {
  id: 'vaas',
  name: 'Vazen & lampenkappen',
  short: 'Vazen',
  icon: 'M8 3h8M9 3c0 3-4 5-4 10a7 7 0 0 0 14 0c0-5-4-7-4-10M7 21h10',
  description: 'Parametrische vazen en lampenkappen: profiel, doorsnede, draaiing en golven. Klaar voor vase mode of met echte wand en E27/E14-fitting.',
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
  ],
  randomize: () => {
    const sections = ['round', 'polygon', 'flower', 'star', 'scallop', 'gear'];
    const section = sections[Math.floor(Math.random() * sections.length)];
    const lowPoly = Math.random() < 0.15;
    const base = rnd(60, 130);
    return {
      height: rnd(120, 260),
      d0: base,
      d1: Math.min(300, base + rnd(-10, 70)),
      d2: Math.min(300, base + rnd(-20, 60)),
      d3: Math.max(40, base + rnd(-30, 40)),
      section,
      count: section === 'polygon' ? rnd(3, 10) : rnd(5, 24),
      depth: rnd(4, section === 'star' ? 25 : 16),
      rounding: rnd(0, 70),
      twist: Math.random() < 0.7 ? rnd(-240, 240, 5) : 0,
      twistMode: ['linear', 'ease', 'wave'][Math.floor(Math.random() * 3)],
      twistWaves: rnd(1, 4),
      waveAmp: Math.random() < 0.3 ? rnd(2, 8, 0.5) : 0,
      waveFreq: rnd(2, 8),
      lowPoly,
      facetsAround: rnd(7, 14),
      facetsUp: rnd(4, 9),
    };
  },
  build,
};
