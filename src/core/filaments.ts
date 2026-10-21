import type { PartPurpose, PrinterProfile } from './types';

/*
 * Bambu Lab filament catalogue.
 *
 * Colour names, codes and hex values come from Bambu Studio's own colour table
 * (resources/profiles/BBL/filament/filaments_color_codes.json, Dutch names where
 * it has them). Densities come from the Bambu technical data sheets (ISO 1183)
 * where `densityChecked` is true; the others are typical values for the polymer.
 * Heat resistance is the HDT at 0.45 MPa from the Bambu filament guide.
 * Prices are indicative EU store prices (1 kg with spool, incl. VAT) and change
 * often: always check the shop.
 */

export interface FilamentColor {
  /** Bambu colour code, e.g. '10100' (PLA Basic Jadewit). */
  code: string;
  name: string;
  /** '#rrggbb' as shown in Bambu Studio (for clear filament a light tint). */
  hex: string;
  /** See-through colour within an otherwise opaque line (e.g. PC Transparant). */
  translucent?: boolean;
  /** Water-clear (no tint). */
  clear?: boolean;
}

export type FilamentFamily = 'PLA' | 'PETG' | 'ABS' | 'ASA' | 'TPU' | 'PC' | 'PA' | 'Support';

export interface FilamentLine {
  id: string;
  name: string;
  family: FilamentFamily;
  /** g/cm³ */
  density: number;
  densityChecked: boolean;
  /** Net filament per spool in grams. */
  spoolGrams: number;
  /** Also sold as a refill (filament without the plastic spool, a few euros cheaper). */
  refill: boolean;
  /** Indicative price per spool in EUR. */
  priceEur: number;
  /** Every colour lets light through. */
  translucent: boolean;
  /** Heat deflection temperature (°C, 0.45 MPa); undefined for flexible filament. */
  heatC?: number;
  /** Fit for outdoor use (UV and weather). */
  uvStable: boolean;
  flexible: boolean;
  /** Needs an enclosed printer (warping, fumes). */
  enclosure: boolean;
  /** Abrasive (carbon fibre): hardened steel nozzle. */
  hardenedNozzle: boolean;
  /** Which feeders can handle it. */
  feed: { ams: boolean; lite: boolean; ht: boolean };
  uses: string;
  colors: FilamentColor[];
}

const c = (code: string, name: string, hex: string, clear = false): FilamentColor => (clear ? { code, name, hex, clear: true, translucent: true } : { code, name, hex });

const ALL_FEEDERS = { ams: true, lite: true, ht: true };

export const FILAMENTS: FilamentLine[] = [
  {
    id: 'pla-basic',
    name: 'PLA Basic',
    family: 'PLA',
    density: 1.24,
    densityChecked: true,
    spoolGrams: 1000,
    refill: true,
    priceEur: 22.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Alledaags: makkelijk, strak en goedkoop. Niet in de zon of bij warmte.',
    colors: [
      c('10100', 'Jadewit', '#ffffff'),
      c('10101', 'Zwart', '#000000'),
      c('10104', 'Lichtgrijs', '#d1d3d5'),
      c('10103', 'Grijs', '#8e9089'),
      c('10105', 'Donkergrijs', '#545454'),
      c('10201', 'Beige', '#f7e6de'),
      c('10200', 'Rood', '#c12e1f'),
      c('10205', 'Kastanjerood', '#9d2235'),
      c('10203', 'Roze', '#f55a74'),
      c('10202', 'Magenta', '#ec008c'),
      c('10300', 'Oranje', '#ff6a13'),
      c('10400', 'Geel', '#f4ee2a'),
      c('10402', 'Zonnebloemgeel', '#fec600'),
      c('10401', 'Goud', '#e4bd68'),
      c('10501', 'Bamboegroen', '#00ae42'),
      c('10502', 'Maretakgroen', '#3f8e43'),
      c('10603', 'Cyaan', '#0086d6'),
      c('10604', 'Kobaltblauw', '#0056b8'),
      c('10700', 'Paars', '#5e43b7'),
      c('10800', 'Bruin', '#9d432c'),
    ],
  },
  {
    id: 'pla-matte',
    name: 'PLA Matte',
    family: 'PLA',
    density: 1.31,
    densityChecked: true,
    spoolGrams: 1000,
    refill: true,
    priceEur: 22.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Mat oppervlak dat laaglijnen verbergt: vazen, potten, decoratie.',
    colors: [
      c('11100', 'Ivoorwit', '#ffffff'),
      c('11103', 'Beenwit', '#cbc6b8'),
      c('11101', 'Antraciet', '#000000'),
      c('11104', 'Nardogrijs', '#757575'),
      c('11102', 'Asgrijs', '#9b9ea0'),
      c('11401', 'Woestijnbruin', '#e8dbb7'),
      c('11800', 'Lattebruin', '#d3b7a7'),
      c('11803', 'Karamel', '#ae835b'),
      c('11801', 'Donkerbruin', '#7d6556'),
      c('11802', 'Donkerchocoladebruin', '#4d3324'),
      c('11203', 'Terracotta', '#b15533'),
      c('11300', 'Mandarijnoranje', '#f99963'),
      c('11400', 'Citroengeel', '#f7d959'),
      c('11200', 'Scharlakenrood', '#de4343'),
      c('11204', 'Pruim', '#950051'),
      c('11201', 'Sakura-roze', '#e8afcf'),
      c('11700', 'Lilapaars', '#ae96d4'),
      c('11502', 'Appelgroen', '#c2e189'),
      c('11500', 'Grasgroen', '#61c680'),
      c('11501', 'Donkergroen', '#68724d'),
      c('11601', 'IJsblauw', '#a3d8e1'),
      c('11603', 'Hemelsblauw', '#56b7e6'),
      c('11600', 'Marineblauw', '#0078bf'),
      c('11602', 'Donkerblauw', '#042f56'),
    ],
  },
  {
    id: 'pla-silk-plus',
    name: 'PLA Silk+',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 26.99,
    translucent: false,
    heatC: 55,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Zijdeglans: vazen en sierstukken. Iets minder sterk tussen de lagen.',
    colors: [
      c('13110', 'Wit', '#ffffff'),
      c('13109', 'Zilver', '#c8c8c8'),
      c('13108', 'Titaangrijs', '#5f6367'),
      c('13404', 'Champagne', '#f3cfb2'),
      c('13405', 'Goud', '#f4a925'),
      c('13206', 'Roségoud', '#ba9594'),
      c('13207', 'Roze', '#f7ada6'),
      c('13205', 'Snoeprood', '#d02727'),
      c('13702', 'Paars', '#8671cb'),
      c('13603', 'Babyblauw', '#a8c6ee'),
      c('13604', 'Blauw', '#008bda'),
      c('13507', 'Munt', '#96dcb9'),
      c('13506', 'Snoepgroen', '#018814'),
    ],
  },
  {
    id: 'pla-translucent',
    name: 'PLA Translucent',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 24.99,
    translucent: true,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Doorschijnend en makkelijk te printen: lampjes met LED, raamhangers.',
    colors: [
      c('13610', 'IJsblauw', '#b8cde9'),
      c('13611', 'Blauw', '#0047bb'),
      c('13612', 'Blauwgroen', '#009fa1'),
      c('13510', 'Lichtjade', '#96d8af'),
      c('13410', 'Zachtgeel', '#f5dbab'),
      c('13301', 'Oranje', '#f74e02'),
      c('13210', 'Rood', '#b50011'),
      c('13211', 'Kersenroze', '#f5b6cd'),
      c('13711', 'Lavendel', '#b8acd6'),
      c('13710', 'Paars', '#8344b0'),
    ],
  },
  {
    id: 'pla-galaxy',
    name: 'PLA Galaxy',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 24.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Glinsterende spikkels: decoratie, naambordjes.',
    colors: [c('13602', 'Paars', '#594177'), c('13503', 'Groen', '#3b665e'), c('13504', 'Nevelig', '#424379'), c('13203', 'Bruin', '#684a43')],
  },
  {
    id: 'pla-sparkle',
    name: 'PLA Sparkle',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 26.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Metallic glitter: sierstukken, cadeaus.',
    colors: [
      c('13101', 'Sprankelend onyxzwart', '#2d2b28'),
      c('13102', 'Sprankelend leigrijs', '#8e9089'),
      c('13402', 'Sprankelend klassiek goud', '#cea629'),
      c('13200', 'Sprankelend karmozijnrood', '#792b36'),
      c('13700', 'Sprankelend koningspaars', '#483d8b'),
      c('13501', 'Sprankelend alpengroen', '#3f5443'),
    ],
  },
  {
    id: 'pla-marble',
    name: 'PLA Marble',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 26.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Steenlook: vazen, plantenpotten, onderzetters.',
    colors: [c('13103', 'Wit marmer', '#f7f3f0'), c('13201', 'Rood graniet', '#ad4e38')],
  },
  {
    id: 'pla-wood',
    name: 'PLA Wood',
    family: 'PLA',
    density: 1.24,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 26.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Met houtvezels: grepen, klokken, meubelvoetjes met houtlook.',
    colors: [
      c('13106', 'Wit eiken', '#d6cca3'),
      c('13505', 'Klassieke berk', '#918669'),
      c('13403', 'Okergeel', '#c98935'),
      c('13801', 'Modderbruin', '#995f11'),
      c('13204', 'Rozenhout', '#4c241c'),
      c('13107', 'Walnootzwart', '#4f3f24'),
    ],
  },
  {
    id: 'petg-hf',
    name: 'PETG HF',
    family: 'PETG',
    density: 1.28,
    densityChecked: true,
    spoolGrams: 1000,
    refill: true,
    priceEur: 22.99,
    translucent: false,
    heatC: 69,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Taaier en hittebestendiger dan PLA: functionele delen, keuken, badkamer.',
    colors: [
      c('33100', 'Wit', '#ffffff'),
      c('33102', 'Zwart', '#000000'),
      c('33101', 'Grijs', '#adb1b2'),
      c('33103', 'Donkergrijs', '#515151'),
      c('33401', 'Roomkleurig', '#f9dfb9'),
      c('33400', 'Geel', '#ffd00b'),
      c('33300', 'Oranje', '#f75403'),
      c('33200', 'Rood', '#bc0900'),
      c('33801', 'Pindabruin', '#875718'),
      c('33501', 'Limoengroen', '#6ee53c'),
      c('33500', 'Groen', '#00ae42'),
      c('33502', 'Bosgroen', '#39541a'),
      c('33601', 'Meerblauw', '#1f79e5'),
      c('33600', 'Blauw', '#002e96'),
    ],
  },
  {
    id: 'petg-translucent',
    name: 'PETG Translucent',
    family: 'PETG',
    density: 1.25,
    densityChecked: true,
    spoolGrams: 1000,
    refill: false,
    priceEur: 22.99,
    translucent: true,
    heatC: 70,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Doorschijnend en hittebestendiger dan PLA: de beste keus voor lampenkappen.',
    colors: [
      c('32101', 'Helder', '#e9eef0', true),
      c('32100', 'Doorschijnend grijs', '#8e8e8e'),
      c('32800', 'Doorschijnend bruin', '#c9a381'),
      c('32300', 'Doorschijnend oranje', '#ff911a'),
      c('32200', 'Doorschijnend roze', '#f9c1bd'),
      c('32700', 'Doorschijnend paars', '#d6abff'),
      c('32600', 'Doorschijnend lichtblauw', '#61b0ff'),
      c('32501', 'Doorschijnend blauwgroen', '#77edd7'),
      c('32500', 'Doorschijnend olijf', '#748c45'),
    ],
  },
  {
    id: 'petg-cf',
    name: 'PETG-CF',
    family: 'PETG',
    density: 1.25,
    densityChecked: true,
    spoolGrams: 1000,
    refill: false,
    priceEur: 34.99,
    translucent: false,
    heatC: 74,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: true,
    feed: { ams: true, lite: false, ht: true },
    uses: 'Stijf met koolstofvezel en mat: beugels, grepen, technische delen.',
    colors: [
      c('31100', 'Zwart', '#000000'),
      c('31101', 'Titaangrijs', '#565656'),
      c('31600', 'Indigoblauw', '#324585'),
      c('31500', 'Malachietgroen', '#16b08e'),
      c('31700', 'Violetpaars', '#583061'),
      c('31200', 'Steenrood', '#9f332a'),
    ],
  },
  {
    id: 'abs',
    name: 'ABS',
    family: 'ABS',
    density: 1.05,
    densityChecked: true,
    spoolGrams: 1000,
    refill: true,
    priceEur: 22.99,
    translucent: false,
    heatC: 87,
    uvStable: false,
    flexible: false,
    enclosure: true,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Hittebestendig en schuurbaar: auto-interieur, behuizingen. Gesloten printer nodig.',
    colors: [
      c('40100', 'Wit', '#ffffff'),
      c('40101', 'Zwart', '#000000'),
      c('40102', 'Zilver', '#87909a'),
      c('40401', 'Beige', '#dfd1a7'),
      c('40400', 'Geel', '#fce900'),
      c('40402', 'Feloranjegeel', '#ffc72c'),
      c('40300', 'Oranje', '#ff6a13'),
      c('40200', 'Rood', '#d32941'),
      c('40700', 'Paars', '#af1685'),
      c('40701', 'Lavendel', '#7248bd'),
      c('40601', 'Azuurblauw', '#489fdf'),
      c('40600', 'Blauw', '#0a2ca5'),
      c('40602', 'Marineblauw', '#0c2340'),
      c('40501', 'Munt', '#7ae1bf'),
      c('40500', 'Bamboegroen', '#00ae42'),
      c('40502', 'Olijf', '#789d4a'),
    ],
  },
  {
    id: 'asa',
    name: 'ASA',
    family: 'ASA',
    density: 1.05,
    densityChecked: true,
    spoolGrams: 1000,
    refill: false,
    priceEur: 26.99,
    translucent: false,
    heatC: 100,
    uvStable: true,
    flexible: false,
    enclosure: true,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'UV- en weerbestendig: buiten, tuin, balkon, auto. Gesloten printer nodig.',
    colors: [
      c('45100', 'Wit', '#fffaf2'),
      c('45101', 'Zwart', '#000000'),
      c('45102', 'Grijs', '#8a949e'),
      c('45200', 'Rood', '#e02928'),
      c('45500', 'Groen', '#00a6a0'),
      c('45600', 'Blauw', '#2140b4'),
    ],
  },
  {
    id: 'tpu-95a-hf',
    name: 'TPU 95A HF',
    family: 'TPU',
    density: 1.22,
    densityChecked: true,
    spoolGrams: 1000,
    refill: false,
    priceEur: 39.99,
    translucent: false,
    uvStable: false,
    flexible: true,
    enclosure: false,
    hardenedNozzle: false,
    feed: { ams: false, lite: false, ht: true },
    uses: 'Flexibel en slijtvast: hoesjes, voetjes, dempers. Externe spoel (of AMS HT).',
    colors: [
      c('51100', 'Zwart', '#101820'),
      c('51102', 'Wit', '#ffffff'),
      c('51101', 'Grijs', '#898d8d'),
      c('51200', 'Rood', '#c8102e'),
      c('51400', 'Geel', '#f3e600'),
      c('51600', 'Blauw', '#0072ce'),
    ],
  },
  {
    id: 'tpu-for-ams',
    name: 'TPU for AMS',
    family: 'TPU',
    density: 1.22,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 41.99,
    translucent: false,
    uvStable: false,
    flexible: true,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Stuggere TPU die wel door de AMS (lite) gaat: meerkleurige flexibele delen.',
    colors: [
      c('53101', 'Zwart', '#000000'),
      c('53100', 'Wit', '#ffffff'),
      c('53102', 'Grijs', '#939393'),
      c('53200', 'Rood', '#ed0000'),
      c('53400', 'Geel', '#f9ef41'),
      c('53500', 'Neongroen', '#90ff1a'),
      c('53600', 'Blauw', '#5898dd'),
    ],
  },
  {
    id: 'pc',
    name: 'PC',
    family: 'PC',
    density: 1.2,
    densityChecked: true,
    spoolGrams: 1000,
    refill: false,
    priceEur: 34.99,
    translucent: false,
    heatC: 117,
    uvStable: false,
    flexible: false,
    enclosure: true,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Zeer sterk en hittebestendig, ook helder: technische delen. Gesloten printer nodig.',
    colors: [c('60100', 'Wit', '#ffffff'), c('60101', 'Zwart', '#000000'), { code: '60102', name: 'Helder zwart', hex: '#686865', translucent: true }, c('60103', 'Transparant', '#e9eef0', true)],
  },
  {
    id: 'paht-cf',
    name: 'PAHT-CF',
    family: 'PA',
    density: 1.06,
    densityChecked: false,
    spoolGrams: 1000,
    refill: false,
    priceEur: 79.99,
    translucent: false,
    heatC: 194,
    uvStable: true,
    flexible: false,
    enclosure: true,
    hardenedNozzle: true,
    feed: { ams: true, lite: false, ht: true },
    uses: 'Nylon met koolstofvezel: zeer sterk en heet (motorruimte). Eerst drogen.',
    colors: [c('70100', 'Zwart', '#000000')],
  },
  {
    id: 'support-pla-petg',
    name: 'Support for PLA/PETG',
    family: 'Support',
    density: 1.3,
    densityChecked: false,
    spoolGrams: 500,
    refill: false,
    priceEur: 34.99,
    translucent: false,
    heatC: 57,
    uvStable: false,
    flexible: false,
    enclosure: false,
    hardenedNozzle: false,
    feed: ALL_FEEDERS,
    uses: 'Alleen als scheidingslaag onder support: laat makkelijk los. Niet voor hele onderdelen.',
    colors: [c('65102', 'Natuurlijk', '#efe9d8'), c('65103', 'Zwart', '#000000')],
  },
];

export const FILAMENT_MAP: Record<string, FilamentLine> = Object.fromEntries(FILAMENTS.map((f) => [f.id, f]));

export const DEFAULT_FILAMENT = FILAMENT_MAP['pla-basic'];

/** A filament line plus one of its colours. */
export interface FilamentChoice {
  line: string;
  color: string;
}

export interface ResolvedFilament {
  line: FilamentLine;
  color: FilamentColor;
}

export function resolveFilament(choice: Partial<FilamentChoice> | null | undefined): ResolvedFilament {
  const line = FILAMENT_MAP[choice?.line ?? ''] ?? DEFAULT_FILAMENT;
  const color = line.colors.find((k) => k.code === choice?.color) ?? line.colors[0];
  return { line, color };
}

export function isTranslucent(f: ResolvedFilament): boolean {
  return f.line.translucent || !!f.color.translucent;
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB hex → CIE L*a*b* (D65), for colour distances that match what people see. */
function lab(hex: string): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex).map(lin);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The colour of a line closest to a hex colour (e.g. a tool's suggested part colour). */
export function nearestColor(line: FilamentLine, hex: string): FilamentColor {
  const [l, a, b] = lab(hex);
  let best = line.colors[0];
  let bestD = Infinity;
  for (const k of line.colors) {
    const [l2, a2, b2] = lab(k.hex);
    const d = (l - l2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Estimate

/** What the estimate needs from a built part. */
export interface EstimateInput {
  /** mm³ */
  volume: number;
  /** mm² */
  area: number;
  estimate: 'solid' | 'vase';
}

/** Shell thickness for 2 walls / top and bottom of a 0.4 mm nozzle (mm). */
export const SHELL_MM = 0.84;
/** Single spiral wall in vase mode (mm). */
export const VASE_WALL_MM = 0.45;
export const INFILL = 0.15;
export const FILAMENT_DIAMETER_MM = 1.75;

/** Printed plastic volume (mm³): shell plus 15% infill, or the single wall of a spiral vase. */
export function printedVolume(p: EstimateInput): number {
  if (p.estimate === 'vase') return p.area * VASE_WALL_MM;
  const shell = Math.min(p.volume, p.area * SHELL_MM);
  return shell + (p.volume - shell) * INFILL;
}

/** Filament weight in grams for one copy. */
export function estimateGrams(p: EstimateInput, density: number): number {
  return (printedVolume(p) * density) / 1000;
}

/** Filament length in metres for a weight in grams (1.75 mm filament). */
export function gramsToMetres(grams: number, density: number): number {
  const volMm3 = (grams / density) * 1000;
  const section = Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2;
  return volMm3 / section / 1000;
}

// ---------------------------------------------------------------------------
// Shopping list

export interface UsageItem {
  name: string;
  quantity: number;
  /** grams per copy */
  grams: number;
  filament: ResolvedFilament;
  purpose?: PartPurpose;
  estimate: 'solid' | 'vase';
}

export interface ShoppingRow {
  line: FilamentLine;
  color: FilamentColor;
  grams: number;
  metres: number;
  spools: number;
  /** Share of the bought spools that this design uses (0..1). */
  used: number;
  costEur: number;
  parts: string[];
}

export interface ShoppingList {
  rows: ShoppingRow[];
  totalGrams: number;
  totalCostEur: number;
  /** Distinct filament colours (= AMS slots for a single multi-colour print). */
  slots: number;
  notes: string[];
  warnings: string[];
}

/** Group parts per filament colour, round up to whole spools and check the choices against the printer. */
export function shoppingList(items: UsageItem[], printer: PrinterProfile): ShoppingList {
  const byKey = new Map<string, ShoppingRow>();
  for (const it of items) {
    const key = `${it.filament.line.id}|${it.filament.color.code}`;
    let row = byKey.get(key);
    if (!row) {
      row = { line: it.filament.line, color: it.filament.color, grams: 0, metres: 0, spools: 0, used: 0, costEur: 0, parts: [] };
      byKey.set(key, row);
    }
    row.grams += it.grams * it.quantity;
    row.parts.push(it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name);
  }
  const rows = [...byKey.values()];
  for (const r of rows) {
    r.metres = gramsToMetres(r.grams, r.line.density);
    r.spools = Math.max(1, Math.ceil(r.grams / r.line.spoolGrams - 1e-9));
    r.used = r.grams / (r.spools * r.line.spoolGrams);
    r.costEur = r.spools * r.line.priceEur;
  }
  rows.sort((a, b) => b.grams - a.grams);

  const notes: string[] = [];
  const warnings: string[] = [];
  const lines = new Map<string, FilamentLine>();
  for (const r of rows) lines.set(r.line.id, r.line);
  const ams = printer.ams;

  if (items.some((it) => isTranslucent(it.filament))) {
    notes.push('Transparant: print met 2 wanden of in vase mode (spiraal) voor de mooiste lichtdoorlaat; infill en dikke wanden geven vlekken.');
    if (items.some((it) => isTranslucent(it.filament) && it.estimate !== 'vase')) notes.push('Doorschijnend filament wordt helderder met minder koeling en iets hogere temperatuur; vulling zie je door de wand heen.');
  }
  for (const line of lines.values()) {
    const used = items.filter((it) => it.filament.line.id === line.id);
    const names = [...new Set(used.map((it) => it.name))];
    const label = names.length > 2 ? `${names.slice(0, 2).join(', ')} …` : names.join(', ');
    if (line.enclosure && printer.enclosed === false) warnings.push(`${line.name} (${label}) kromt en geeft dampen op een open printer als de ${printer.name}: kies PLA/PETG of een gesloten printer.`);
    if (line.hardenedNozzle) notes.push(`${line.name} is schurend: gebruik een geharde stalen nozzle.`);
    if (line.family === 'Support') warnings.push(`${line.name} is alleen bedoeld als scheidingslaag onder support, niet voor hele onderdelen (${label}).`);
    if (ams && (ams.lite ? !line.feed.lite : !line.feed.ams)) {
      const msg = `${line.name} gaat niet door de ${ams.lite ? 'AMS lite' : 'AMS'} van de ${printer.name}: voer het via de externe spoelhouder${line.feed.ht ? ' of een AMS HT' : ''}.`;
      // in a multi-colour job this blocks automatic colour changes
      (rows.length > 1 ? warnings : notes).push(msg);
    }
  }
  for (const it of items) {
    const f = it.filament.line;
    if (it.purpose === 'lamp' && (f.heatC ?? 0) < 65) warnings.push(`${it.name}: ${f.name} wordt bij ~${f.heatC ?? 50} °C zacht. Alleen met een LED-lamp en genoeg afstand; PETG (Translucent) is veiliger bij een lamp.`);
    if (it.purpose === 'outdoor' && !f.uvStable) warnings.push(`${it.name}: ${f.name} verbleekt en verzwakt buiten; ASA is UV-bestendig.`);
    if (it.purpose === 'flexible' && !f.flexible) warnings.push(`${it.name} is bedoeld om te buigen: kies TPU.`);
  }

  const slots = rows.length;
  if (slots > 1 && ams) {
    if (slots > ams.maxSlots) warnings.push(`${slots} kleuren is meer dan de ${ams.maxSlots} AMS-slots die de ${printer.name} maximaal aankan: print in delen en wissel spoelen.`);
    else if (slots > ams.typicalSlots) notes.push(`${slots} kleuren: met één AMS (${ams.typicalSlots} slots) moet je tussendoor spoelen wisselen of een extra AMS koppelen (max. ${ams.maxSlots} op de ${printer.name}).`);
    else notes.push(`${slots} kleuren passen in één AMS (${ams.typicalSlots} slots) van de ${printer.name}.`);
    notes.push('Elk onderdeel heeft één kleur: per plaat of per onderdeel printen en de spoel wisselen kan ook zonder AMS (en spaart spoelafval).');
  }
  if (rows.some((r) => r.used > 0.85)) notes.push('Een rol is bijna helemaal nodig: reken op ~5-10% extra voor de purge-lijn, brim en een mislukte poging.');

  return {
    rows,
    totalGrams: rows.reduce((s, r) => s + r.grams, 0),
    totalCostEur: rows.reduce((s, r) => s + r.costEur, 0),
    slots,
    notes: [...new Set(notes)],
    warnings: [...new Set(warnings)],
  };
}

/** Plain-text shopping list for the clipboard. */
export function shoppingText(list: ShoppingList, title: string, printer: PrinterProfile): string {
  const nl = (v: number, d = 0) => v.toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });
  const out = [`Boodschappenlijst — ${title} (${printer.name})`, ''];
  for (const r of list.rows) {
    out.push(`- ${r.spools}× Bambu Lab ${r.line.name} ${r.color.name} (${r.color.code}), ${nl(r.line.spoolGrams / 1000, r.line.spoolGrams % 1000 ? 1 : 0)} kg — nodig ≈ ${nl(r.grams)} g / ${nl(r.metres)} m (${nl(r.used * 100)}% van de rol${r.spools > 1 ? 'len' : ''}) — ca. € ${nl(r.costEur, 2)}`);
  }
  out.push('', `Totaal ≈ ${nl(list.totalGrams)} g, indicatief € ${nl(list.totalCostEur, 2)} (prijzen wisselen, check de shop).`);
  if (list.warnings.length) out.push('', 'Let op:', ...list.warnings.map((w) => `- ${w}`));
  if (list.notes.length) out.push('', 'Tips:', ...list.notes.map((w) => `- ${w}`));
  return out.join('\n');
}
