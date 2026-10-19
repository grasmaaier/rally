import type { PrinterProfile } from './types';

export const PRINTERS: PrinterProfile[] = [
  { id: 'a2l', name: 'Bambu Lab A2L', x: 330, y: 320, z: 325 },
  { id: 'h2d', name: 'Bambu Lab H2D (1 nozzle)', x: 325, y: 320, z: 325 },
  { id: 'a1', name: 'Bambu Lab A1', x: 256, y: 256, z: 256 },
  { id: 'p1s', name: 'Bambu Lab P1S / X1C / P2S', x: 256, y: 256, z: 256 },
  { id: 'a1mini', name: 'Bambu Lab A1 mini', x: 180, y: 180, z: 180 },
];

export const DEFAULT_PRINTER = PRINTERS[0];

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
