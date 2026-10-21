import type { AmsSupport, PrinterProfile } from './types';

/*
 * Bambu Lab line-up (checked against bambulab.com spec pages / store / wiki, October 2026).
 * x/y/z is the usable build volume for the nozzle mode of the profile. Dual-nozzle
 * printers get two profiles: one nozzle (largest volume) and both nozzles (the area
 * both nozzles reach, needed for two-material prints).
 */

const LITE_OR_HUB = ['AMS lite', 'AMS / AMS 2 Pro / AMS HT (via AMS Hub)'];

const A_SERIES: AmsSupport = {
  units: LITE_OR_HUB,
  typicalSlots: 4,
  maxSlots: 16,
  lite: true,
  note: 'Combo met AMS lite (4 kleuren). Met de AMS Hub tot 4 AMS-eenheden; AMS lite en AMS niet tegelijk.',
};

const AMS_CLASSIC: AmsSupport = {
  units: ['AMS', 'AMS 2 Pro', 'AMS HT'],
  typicalSlots: 4,
  maxSlots: 16,
  lite: false,
  note: 'Tot 4 AMS-eenheden (16 kleuren).',
};

const AMS_H2: AmsSupport = {
  units: ['AMS 2 Pro', 'AMS', 'AMS HT'],
  typicalSlots: 4,
  maxSlots: 24,
  lite: false,
  note: 'Tot 4 AMS 2 Pro + 8 AMS HT (24 slots). Geen AMS lite.',
};

export const PRINTERS: PrinterProfile[] = [
  {
    id: 'a2l',
    name: 'Bambu Lab A2L',
    series: 'A-serie',
    x: 330,
    y: 320,
    z: 325,
    enclosed: false,
    ams: {
      units: ['AMS lite', 'AMS 2 Pro', 'AMS HT'],
      typicalSlots: 4,
      maxSlots: 19,
      lite: true,
      note: 'Combo met AMS lite; tot 4 AMS 2 Pro + 1 AMS lite tegelijk (19 kleuren).',
    },
  },
  { id: 'a1', name: 'Bambu Lab A1', series: 'A-serie', x: 256, y: 256, z: 256, enclosed: false, ams: A_SERIES },
  { id: 'a1mini', name: 'Bambu Lab A1 mini', series: 'A-serie', x: 180, y: 180, z: 180, enclosed: false, ams: A_SERIES },
  {
    id: 'p2s',
    name: 'Bambu Lab P2S',
    series: 'P-serie',
    x: 256,
    y: 256,
    z: 256,
    enclosed: true,
    ams: { units: ['AMS 2 Pro', 'AMS HT', 'AMS'], typicalSlots: 4, maxSlots: 20, lite: false, note: 'Tot 4 AMS 2 Pro + 4 AMS HT (20 slots).' },
  },
  { id: 'p1s', name: 'Bambu Lab P1S', series: 'P-serie', x: 256, y: 256, z: 256, enclosed: true, ams: AMS_CLASSIC },
  { id: 'p1p', name: 'Bambu Lab P1P', series: 'P-serie', x: 256, y: 256, z: 256, enclosed: false, ams: AMS_CLASSIC, discontinued: true },
  { id: 'x2d', name: 'Bambu Lab X2D (1 nozzle)', series: 'X-serie', x: 256, y: 256, z: 260, nozzles: 1, enclosed: true, ams: AMS_H2 },
  {
    id: 'x2d-dual',
    name: 'Bambu Lab X2D (2 nozzles)',
    series: 'X-serie',
    x: 235.5,
    y: 256,
    z: 256,
    nozzles: 2,
    enclosed: true,
    ams: AMS_H2,
    note: 'Bereik van beide nozzles samen; de 3MF centreert op dit gebied, controleer de plaatsing in Bambu Studio.',
  },
  { id: 'x1c', name: 'Bambu Lab X1 Carbon', series: 'X-serie', x: 256, y: 256, z: 256, enclosed: true, ams: AMS_CLASSIC, discontinued: true },
  { id: 'x1e', name: 'Bambu Lab X1E', series: 'X-serie', x: 256, y: 256, z: 256, enclosed: true, ams: AMS_CLASSIC, discontinued: true },
  { id: 'h2s', name: 'Bambu Lab H2S', series: 'H-serie', x: 340, y: 320, z: 340, nozzles: 1, enclosed: true, ams: AMS_H2 },
  { id: 'h2d', name: 'Bambu Lab H2D (1 nozzle)', series: 'H-serie', x: 325, y: 320, z: 325, nozzles: 1, enclosed: true, ams: AMS_H2 },
  {
    id: 'h2d-dual',
    name: 'Bambu Lab H2D (2 nozzles)',
    series: 'H-serie',
    x: 300,
    y: 320,
    z: 325,
    nozzles: 2,
    enclosed: true,
    ams: AMS_H2,
    // 350 mm total, 325 mm per nozzle: both reach x = 25…325, centred on the 350 mm bed
    center: [175, 160],
  },
  { id: 'h2c', name: 'Bambu Lab H2C (1 nozzle)', series: 'H-serie', x: 305, y: 320, z: 325, nozzles: 1, enclosed: true, ams: AMS_H2, note: 'Vortek: tot 7 nozzles wisselen, minder spoelafval.' },
  {
    id: 'h2c-dual',
    name: 'Bambu Lab H2C (2 nozzles)',
    series: 'H-serie',
    x: 300,
    y: 320,
    z: 325,
    nozzles: 2,
    enclosed: true,
    ams: AMS_H2,
    note: 'Bereik van beide nozzles samen; de 3MF centreert op dit gebied, controleer de plaatsing in Bambu Studio.',
  },
];

export const DEFAULT_PRINTER = PRINTERS[0];

export function printerById(id: string | null | undefined): PrinterProfile {
  return PRINTERS.find((p) => p.id === id) ?? DEFAULT_PRINTER;
}

/** Keep a small margin from the plate edges (skirt/brim, purge line). */
export const PLATE_MARGIN = 5;

export function usable(p: PrinterProfile) {
  return { x: p.x - 2 * PLATE_MARGIN, y: p.y - 2 * PLATE_MARGIN, z: p.z };
}

/** True when a part with the given bounding box fits on the plate (optionally rotated 90°). */
export function fitsOn(p: PrinterProfile, size: [number, number, number]): boolean {
  const u = usable(p);
  if (size[2] > u.z) return false;
  return (size[0] <= u.x && size[1] <= u.y) || (size[1] <= u.x && size[0] <= u.y);
}

/** Centre of the usable area in slicer bed coordinates (origin at the front-left corner). */
export function plateCenter(p: PrinterProfile): [number, number] {
  return p.center ?? [p.x / 2, p.y / 2];
}

/** "330 × 320 × 325" with Dutch decimals. */
export function volumeLabel(p: PrinterProfile): string {
  return [p.x, p.y, p.z].map((v) => v.toLocaleString('nl-NL')).join(' × ');
}
