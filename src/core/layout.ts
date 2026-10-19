import { usable } from './printer';
import type { PartResult, PrinterProfile } from './types';

export interface Placement {
  part: number;
  copy: number;
  /** Offset of the part centre from the plate centre (mm). */
  x: number;
  y: number;
  /** Rotated 90° around Z to fit. */
  rotated: boolean;
  /** Index of the plate (0 = first build plate). */
  plate: number;
}

const GAP = 6;

/**
 * Shelf-pack every copy of every part onto build plates. Parts that are too
 * large still get a spot (alone on a plate) so the user can see them.
 */
export function arrange(parts: PartResult[], printer: PrinterProfile, expandCopies: boolean): Placement[] {
  const u = usable(printer);
  type Item = { part: number; copy: number; w: number; d: number; rotated: boolean };
  const items: Item[] = [];
  parts.forEach((p, i) => {
    const n = expandCopies ? p.quantity : 1;
    let [w, d] = p.size;
    let rotated = false;
    // prefer the orientation that fits; otherwise longest side along X
    const fitsStraight = w <= u.x && d <= u.y;
    const fitsRotated = d <= u.x && w <= u.y;
    if ((!fitsStraight && fitsRotated) || (!fitsStraight && !fitsRotated && d > w)) {
      [w, d] = [d, w];
      rotated = true;
    }
    for (let c = 0; c < n; c++) items.push({ part: i, copy: c, w, d, rotated });
  });
  // tallest-first shelf packing on depth
  const order = items.map((_, i) => i).sort((a, b) => items[b].d - items[a].d || items[b].w - items[a].w);
  const out: Placement[] = [];
  let plate = 0;
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;
  const rows: { plate: number; items: { idx: number; x: number }[]; y: number; h: number }[] = [];
  let row = { plate, items: [] as { idx: number; x: number }[], y: 0, h: 0 };
  rows.push(row);
  for (const idx of order) {
    const it = items[idx];
    if (cursorX > 0 && cursorX + it.w > u.x) {
      shelfY += shelfH + GAP;
      cursorX = 0;
      shelfH = 0;
      row = { plate, items: [], y: shelfY, h: 0 };
      rows.push(row);
    }
    if (shelfY > 0 && shelfY + it.d > u.y) {
      plate++;
      shelfY = 0;
      cursorX = 0;
      shelfH = 0;
      row = { plate, items: [], y: 0, h: 0 };
      rows.push(row);
    }
    row.items.push({ idx, x: cursorX });
    cursorX += it.w + GAP;
    shelfH = Math.max(shelfH, it.d);
    row.h = shelfH;
  }
  // centre the content of each plate
  const byPlate = new Map<number, typeof rows>();
  for (const r of rows) if (r.items.length) byPlate.set(r.plate, [...(byPlate.get(r.plate) ?? []), r]);
  for (const [pl, rs] of byPlate) {
    const totalH = rs.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    for (const r of rs) {
      const last = r.items[r.items.length - 1];
      const rowW = last.x + items[last.idx].w;
      for (const { idx, x } of r.items) {
        const it = items[idx];
        out.push({
          part: it.part,
          copy: it.copy,
          rotated: it.rotated,
          plate: pl,
          x: x + it.w / 2 - rowW / 2,
          y: totalH / 2 - (r.y + it.d / 2),
        });
      }
    }
  }
  return out;
}

/** World offset of a plate (plates are laid out side by side along X). */
export function plateOffset(printer: PrinterProfile, plate: number): number {
  return plate * (printer.x + 40);
}
