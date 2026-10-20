import type { AssetRef, AssetStore, BuildOutput, InfoBlock, Params, PartOut, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { fitsOn, usable } from '../core/printer';
import { applyM4, type M4 } from '../geom/helpers';
import { BODY_OPTIONS, builtinBody, type BodyMesh } from '../geom/bodies';
import { MIN_FEATURE, buildCage, buildLattice, buildStand, poseBody, type Body, type GenResult, type Quality, type UpAxis } from '../geom/generative';
import type { PatternKind, PatternOptions } from '../geom/patterns';

// ---------------------------------------------------------------------------
// Coordinates: the reference body stands on z = 0, centred in XY, front
// towards -Y (after the "which side is up" and turn settings). Covers and
// lattices are built around it in that pose; the stand leans it back by
// tilting the top towards +Y. Every part is turned into its print
// orientation afterwards and the assembled view shows it on the body.

const MODE_OPTIONS = [
  { value: 'cage', label: 'Hoes / kooi om het voorwerp' },
  { value: 'stand', label: 'Standaard / houder' },
  { value: 'lattice', label: 'Lattice van het model zelf' },
];

const PATTERN_OPTIONS = [
  { value: 'voronoi', label: 'Voronoi (cellen)' },
  { value: 'blobs', label: 'Organisch (blobs)' },
  { value: 'gyroid', label: 'Gyroid (TPMS)' },
];

const STAND_STYLES = [
  { value: 'takken', label: 'Takken (vertakte stutten)' },
  { value: 'voronoi', label: 'Botstructuur (Voronoi)' },
  { value: 'blobs', label: 'Spons (organisch)' },
  { value: 'gyroid', label: 'Gyroid' },
];

const UP_OPTIONS = [
  { value: 'z', label: '+Z (zoals in het bestand)' },
  { value: '-z', label: '−Z (ondersteboven)' },
  { value: 'y', label: '+Y' },
  { value: '-y', label: '−Y' },
  { value: 'x', label: '+X' },
  { value: '-x', label: '−X' },
];

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4 };

const isMode = (m: string) => (p: Params) => str(p, 'mode') === m;
const usesPattern = (p: Params) => str(p, 'mode') !== 'stand' || str(p, 'standStyle') !== 'takken';
const usesPorosity = (p: Params) => {
  const kind = str(p, 'mode') === 'stand' ? str(p, 'standStyle') : str(p, 'pattern');
  return kind === 'blobs' || kind === 'gyroid';
};

const get = (p: Params, k: string, d: number) => (p[k] === undefined || p[k] === '' || !Number.isFinite(num(p, k)) ? d : num(p, k));

function assets(p: Params): AssetRef[] {
  return str(p, 'body') === 'upload' && p.modelFile ? [{ kind: 'mesh', key: str(p, 'modelFile') }] : [];
}

/** The reference body in mm before posing, with a display name. */
function sourceBody(p: Params, store: AssetStore, tips: string[], warnings: string[]): { mesh: BodyMesh; name: string; factor: number } {
  const id = str(p, 'body');
  if (id === 'upload') {
    const key = p.modelFile ? str(p, 'modelFile') : '';
    if (!key) {
      tips.push('Upload een STL-, OBJ- of 3MF-bestand van je voorwerp; tot die tijd zie je de oordopjes-case.');
      return { mesh: builtinBody('earbuds'), name: 'Oordopjes-case', factor: 1 };
    }
    const m = store.mesh(key);
    if (m.decimatedFrom) warnings.push(`Het model had ${m.decimatedFrom.toLocaleString('nl-NL')} driehoeken en is vereenvoudigd tot ${(m.indices.length / 3).toLocaleString('nl-NL')} (genoeg voor de vorm).`);
    const factor = m.unitKnown ? 1 : (UNIT_MM[str(p, 'unit')] ?? 1);
    return { mesh: { positions: m.positions, indices: m.indices }, name: m.name, factor };
  }
  const label = BODY_OPTIONS.find((o) => o.value === id)?.label.replace(/ \(.*\)$/, '') ?? 'Voorwerp';
  return { mesh: builtinBody(id), name: label, factor: 1 };
}

function patternOf(p: Params, kind: PatternKind): PatternOptions {
  return {
    kind,
    cell: get(p, 'cell', 9),
    strut: Math.max(MIN_FEATURE, get(p, 'strut', 2)),
    smooth: Math.min(1, Math.max(0, get(p, 'smooth', 60) / 100)),
    porosity: Math.min(0.85, Math.max(0.1, get(p, 'porosity', 55) / 100)),
    seed: Math.round(get(p, 'seed', 7)),
  };
}

/** Inverse of a rotation (+ translation) matrix. */
function invRigid(m: M4): M4 {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = applyM4(r, [m[12], m[13], m[14]]);
  r[12] = -t[0];
  r[13] = -t[1];
  r[14] = -t[2];
  return r;
}

function ghost(body: Body, matrix?: M4): SceneItem {
  const P = new Float32Array(body.positions.length);
  for (let i = 0; i < P.length; i += 3) {
    const v = matrix ? applyM4(matrix, [body.positions[i], body.positions[i + 1], body.positions[i + 2]]) : [body.positions[i], body.positions[i + 1], body.positions[i + 2]];
    P[i] = v[0];
    P[i + 1] = v[1];
    P[i + 2] = v[2];
  }
  return { kind: 'mesh', mesh: { positions: P, indices: new Uint32Array(body.indices) }, color: '#8aa0b8', material: 'ghost', label: 'Voorwerp' };
}

const fmt = (v: number) => v.toFixed(1).replace('.', ',');

function build(p: Params, ctx: Parameters<ToolDef['build']>[1]): BuildOutput {
  const { M, printer } = ctx;
  const tips: string[] = [];
  const warnings: string[] = [];
  const src = sourceBody(p, ctx.assets, tips, warnings);
  const scale = (get(p, 'scale', 100) / 100) * src.factor;
  const body = poseBody(src.mesh, scale, (str(p, 'up') || 'z') as UpAxis, get(p, 'turn', 0));
  const [W, D, H] = body.size;
  if (!(Math.max(W, D, H) >= 10) || !(Math.min(W, D, H) >= 2))
    throw new UserError(`Het voorwerp is te klein (${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm). Controleer de eenheid of vergroot de schaal.`);
  const u = usable(printer);
  if (!fitsOn(printer, [W, D, H]) && !fitsOn(printer, [W, H, D]))
    throw new UserError(`Het voorwerp is te groot voor de ${printer.name} (${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm, bed ${u.x} × ${u.y} × ${u.z} mm). Verklein de schaal of controleer de eenheid.`);
  const quality = (str(p, 'quality') || 'normal') as Quality;
  const mode = str(p, 'mode');
  let res: GenResult;
  const scene: SceneItem[] = [];
  let bodyMatrix: M4 | undefined;
  if (mode === 'stand') {
    const style = str(p, 'standStyle') as 'takken' | 'voronoi' | 'blobs' | 'gyroid';
    const s = buildStand(M, body, {
      angle: get(p, 'angle', 70),
      lift: get(p, 'lift', 12),
      lip: get(p, 'lip', 10),
      wall: get(p, 'standWall', 2.8),
      clearance: get(p, 'standClearance', 0.5),
      strut: Math.max(MIN_FEATURE, get(p, 'strutD', 6)) / 2,
      support: get(p, 'support', 60) / 100,
      cable: bool(p, 'cable'),
      cableWidth: get(p, 'cableWidth', 12),
      branches: Math.round(get(p, 'branches', 3)),
      smooth: Math.min(1, Math.max(0, get(p, 'smooth', 60) / 100)),
      seed: Math.round(get(p, 'seed', 7)),
      style: STAND_STYLES.some((o) => o.value === style) ? style : 'takken',
      cell: get(p, 'cell', 9),
      quality,
    });
    res = s;
    bodyMatrix = s.bodyMatrix;
  } else if (mode === 'lattice') {
    const structure = str(p, 'structure') as 'skin' | 'lattice' | 'both';
    res = buildLattice(M, body, {
      structure: ['skin', 'lattice', 'both'].includes(structure) ? structure : 'skin',
      skin: get(p, 'skin', 2),
      base: get(p, 'base', 3),
      pattern: patternOf(p, str(p, 'pattern') as PatternKind),
      quality,
    });
  } else {
    const opening = str(p, 'opening') as 'top' | 'bottom' | 'halves';
    res = buildCage(M, body, {
      clearance: get(p, 'clearance', 0.3),
      wall: get(p, 'wall', 2),
      pattern: patternOf(p, str(p, 'pattern') as PatternKind),
      opening: ['top', 'bottom', 'halves'].includes(opening) ? opening : 'top',
      cut: get(p, 'cut', 70) / 100,
      quality,
    });
  }
  const parts: PartOut[] = [];
  res.parts.forEach((g, i) => {
    const solid = g.solid.transform(g.print as unknown as Parameters<typeof g.solid.transform>[0]);
    const b = solid.boundingBox();
    const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if (!fitsOn(printer, size))
      throw new UserError(`"${g.name}" wordt ${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm en past niet op de ${printer.name}. Verklein de schaal.`);
    parts.push({ name: g.name, solid, color: '#d8a24a' });
    if (mode !== 'lattice') scene.push({ kind: 'part', part: i, matrix: invRigid(g.print) });
  });
  if (mode !== 'lattice') scene.push(ghost(body, bodyMatrix));
  const info: InfoBlock[] = [
    {
      kind: 'kv',
      title: 'Generatief ontwerp',
      rows: [
        ['Voorwerp', `${src.name}: ${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm`],
        ['Modus', MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode],
        ...res.info,
        ['Detail', `${res.edge.toFixed(2).replace('.', ',')} mm rekenraster`],
      ],
    },
  ];
  tips.push(...res.tips);
  if (quality === 'draft') tips.push('Kwaliteit staat op snel: kies "Normaal" of "Fijn" voor een gladder resultaat voordat je exporteert.');
  return { parts, scene: scene.length ? scene : undefined, info, tips, warnings: [...warnings, ...res.warnings], defaultView: scene.length ? 'assembly' : 'plate' };
}

const rnd = (lo: number, hi: number, step = 1) => Math.round((lo + Math.random() * (hi - lo)) / step) * step;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export const generativeTool: ToolDef = {
  id: 'generatief',
  name: 'Generatief',
  short: 'Generatief',
  icon: 'M12 21v-7M12 14c-3.5 0-6-2.5-6-6M12 14c3.5 0 6-2.5 6-6M6 8V4M6 8l-3-2M18 8V4M18 8l3-2M8 21h8',
  description:
    'Organische, generatieve prints van een 3D-model: upload een STL/OBJ/3MF (of kies een telefoon, oordopjes-case of ei) en maak er een geperforeerde hoes, een vertakte standaard of een lattice-versie van. Voronoi-, blob- en gyroidpatronen, glad afgerond en altijd waterdicht.',
  params: [
    { type: 'group', label: 'Voorwerp' },
    { type: 'select', key: 'body', label: 'Voorwerp', options: BODY_OPTIONS, default: 'earbuds' },
    {
      type: 'file', key: 'modelFile', label: '3D-model', asset: 'mesh', accept: '.stl,.obj,.3mf,model/stl,model/3mf', default: '',
      help: 'STL (binair of tekst), OBJ of 3MF. Grote modellen worden vereenvoudigd. Gaten in het model zijn geen probleem.', show: (p) => str(p, 'body') === 'upload',
    },
    {
      type: 'select', key: 'unit', label: 'Eenheid van het bestand', default: 'mm', show: (p) => str(p, 'body') === 'upload',
      help: '3MF-bestanden geven hun eenheid zelf aan; dit geldt voor STL en OBJ.',
      options: [
        { value: 'mm', label: 'Millimeter' },
        { value: 'cm', label: 'Centimeter' },
        { value: 'm', label: 'Meter' },
        { value: 'inch', label: 'Inch' },
      ],
    },
    { type: 'number', key: 'scale', label: 'Schaal', min: 10, max: 400, step: 1, unit: '%', default: 100 },
    { type: 'select', key: 'up', label: 'Welke kant is boven', options: UP_OPTIONS, default: 'z', help: 'Voor de standaard: zet het voorwerp rechtop met de voorkant (scherm) naar voren.' },
    { type: 'number', key: 'turn', label: 'Draaien om de hoogte-as', min: 0, max: 345, step: 15, unit: '°', default: 0 },

    { type: 'group', label: 'Ontwerp' },
    { type: 'select', key: 'mode', label: 'Wat maken', options: MODE_OPTIONS, default: 'cage' },

    { type: 'group', label: 'Hoes', show: isMode('cage') },
    {
      type: 'select', key: 'opening', label: 'Opening', default: 'top', show: isMode('cage'),
      options: [
        { value: 'top', label: 'Open aan de bovenkant (hoes om het onderste deel)' },
        { value: 'bottom', label: 'Open aan de onderkant (kap over het bovenste deel)' },
        { value: 'halves', label: 'Twee helften (sluit het voorwerp helemaal in)' },
      ],
    },
    { type: 'number', key: 'cut', label: 'Snijhoogte', min: 20, max: 95, step: 1, unit: '%', default: 70, show: isMode('cage'), help: 'Tot waar de hoes reikt, gemeten vanaf de onderkant van het voorwerp.' },
    { type: 'number', key: 'clearance', label: 'Speling', min: 0.1, max: 1.5, step: 0.05, unit: 'mm', default: 0.3, show: isMode('cage') },
    { type: 'number', key: 'wall', label: 'Wanddikte', min: 1.6, max: 4, step: 0.1, unit: 'mm', default: 2, show: isMode('cage') },

    { type: 'group', label: 'Standaard', show: isMode('stand') },
    { type: 'select', key: 'standStyle', label: 'Stijl', options: STAND_STYLES, default: 'takken', show: isMode('stand') },
    { type: 'number', key: 'angle', label: 'Hoek met de tafel', min: 50, max: 88, step: 1, unit: '°', default: 70, show: isMode('stand') },
    { type: 'number', key: 'lift', label: 'Hoogte boven de tafel', min: 4, max: 40, step: 1, unit: 'mm', default: 14, show: isMode('stand') },
    { type: 'number', key: 'lip', label: 'Hoogte van de rand', min: 4, max: 25, step: 1, unit: 'mm', default: 10, show: isMode('stand'), help: 'Hoe ver de houder aan de onderkant om het voorwerp heen reikt.' },
    { type: 'number', key: 'support', label: 'Hoogte rugsteun', min: 30, max: 90, step: 1, unit: '%', default: 60, show: isMode('stand') },
    { type: 'number', key: 'strutD', label: 'Takdikte', min: 3.2, max: 12, step: 0.2, unit: 'mm', default: 6, show: isMode('stand') },
    { type: 'number', key: 'branches', label: 'Extra takken', min: 0, max: 8, step: 1, default: 3, show: isMode('stand') },
    { type: 'number', key: 'standWall', label: 'Dikte houder', min: 2, max: 5, step: 0.1, unit: 'mm', default: 2.8, show: isMode('stand') },
    { type: 'number', key: 'standClearance', label: 'Speling', min: 0.2, max: 1.5, step: 0.05, unit: 'mm', default: 0.5, show: isMode('stand') },
    { type: 'bool', key: 'cable', label: 'Kabelsleuf onderin', default: true, show: isMode('stand') },
    { type: 'number', key: 'cableWidth', label: 'Breedte kabelsleuf', min: 6, max: 20, step: 0.5, unit: 'mm', default: 12, show: (p) => isMode('stand')(p) && bool(p, 'cable') },

    { type: 'group', label: 'Lattice', show: isMode('lattice') },
    {
      type: 'select', key: 'structure', label: 'Opbouw', default: 'skin', show: isMode('lattice'),
      options: [
        { value: 'skin', label: 'Holle, geperforeerde huid' },
        { value: 'lattice', label: '3D-vakwerk in de vorm van het model' },
        { value: 'both', label: 'Huid met vakwerk erin' },
      ],
    },
    { type: 'number', key: 'skin', label: 'Huiddikte', min: 1.6, max: 4, step: 0.1, unit: 'mm', default: 2, show: (p) => isMode('lattice')(p) && str(p, 'structure') !== 'lattice' },
    { type: 'number', key: 'base', label: 'Vlakke onderkant', min: 0, max: 30, step: 0.5, unit: 'mm', default: 3, show: isMode('lattice'), help: 'Zoveel wordt er onderaf afgesneden, zodat het stevig op het bed staat.' },

    { type: 'group', label: 'Patroon', show: usesPattern },
    { type: 'select', key: 'pattern', label: 'Patroon', options: PATTERN_OPTIONS, default: 'blobs', show: (p) => str(p, 'mode') !== 'stand' },
    { type: 'number', key: 'cell', label: 'Celgrootte', min: 4, max: 30, step: 0.5, unit: 'mm', default: 9, show: usesPattern },
    { type: 'number', key: 'strut', label: 'Stutdikte', min: 1.2, max: 6, step: 0.1, unit: 'mm', default: 2, show: (p) => str(p, 'mode') !== 'stand' },
    { type: 'number', key: 'porosity', label: 'Openheid', min: 20, max: 80, step: 1, unit: '%', default: 55, show: usesPorosity },
    { type: 'number', key: 'smooth', label: 'Afronding', min: 0, max: 100, step: 1, unit: '%', default: 60 },
    { type: 'number', key: 'seed', label: 'Variant', min: 1, max: 999, step: 1, default: 7 },

    { type: 'group', label: 'Rekenen' },
    {
      type: 'select', key: 'quality', label: 'Kwaliteit', default: 'normal',
      help: 'Fijner is gladder maar rekent langer. Grote modellen krijgen automatisch een grover raster.',
      options: [
        { value: 'draft', label: 'Snel (grof)' },
        { value: 'normal', label: 'Normaal' },
        { value: 'fine', label: 'Fijn (langzaam)' },
      ],
    },
  ],
  presets: [
    { name: 'Organische oordopjes-hoes', values: { body: 'earbuds', mode: 'cage', opening: 'top', cut: 62, pattern: 'blobs', cell: 9, strut: 2, porosity: 55, smooth: 70, wall: 2, clearance: 0.3, up: 'z', turn: 0, scale: 100 } },
    { name: 'Telefoonhoes Voronoi', values: { body: 'phone', mode: 'cage', up: '-y', opening: 'top', cut: 80, pattern: 'voronoi', cell: 12, strut: 2.2, smooth: 60, wall: 1.8, clearance: 0.35, turn: 0, scale: 100 } },
    { name: 'Telefoonstandaard met takken', values: { body: 'phone', mode: 'stand', up: 'z', turn: 0, standStyle: 'takken', angle: 70, lift: 14, lip: 10, support: 60, strutD: 6, branches: 3, cable: true, scale: 100 } },
    { name: 'Telefoonstandaard liggend', values: { body: 'phone', mode: 'stand', up: 'x', turn: 0, standStyle: 'takken', angle: 65, lift: 10, lip: 9, support: 65, strutD: 6, branches: 4, cable: false, scale: 100 } },
    { name: 'Botstandaard (Voronoi)', values: { body: 'phone', mode: 'stand', up: 'z', turn: 0, standStyle: 'voronoi', cell: 11, angle: 72, lift: 14, strutD: 6, branches: 2, cable: true, scale: 100, quality: 'draft' } },
    { name: 'Gyroid-ei in twee helften', values: { body: 'egg', mode: 'cage', opening: 'halves', cut: 45, pattern: 'gyroid', cell: 12, strut: 1.6, porosity: 60, wall: 1.8, clearance: 0.4, up: 'z', turn: 0, scale: 100 } },
    { name: 'Geperforeerd ei (sculptuur)', values: { body: 'egg', mode: 'lattice', structure: 'skin', skin: 2, base: 3, pattern: 'voronoi', cell: 8, strut: 1.8, smooth: 70, scale: 160, up: 'z', turn: 0 } },
    { name: 'Lattice-bol', values: { body: 'sphere', mode: 'lattice', structure: 'lattice', base: 4, pattern: 'voronoi', cell: 10, strut: 2.4, smooth: 60, scale: 100, up: 'z', turn: 0, quality: 'draft' } },
  ],
  randomize: (p) => {
    const mode = str(p, 'mode') || 'cage';
    return {
      pattern: pick(['voronoi', 'blobs', 'gyroid']),
      standStyle: mode === 'stand' ? pick(['takken', 'takken', 'voronoi', 'blobs', 'gyroid']) : str(p, 'standStyle') || 'takken',
      cell: rnd(6, 16, 0.5),
      strut: rnd(1.6, 3, 0.1),
      porosity: rnd(35, 70),
      smooth: rnd(30, 90),
      seed: rnd(1, 999),
      branches: rnd(1, 6),
      strutD: rnd(4.4, 8, 0.2),
    };
  },
  assets,
  build,
};
