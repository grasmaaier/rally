import { describe, expect, it, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { PRINTERS, fitsOn } from '../src/core/printer';
import { fitToPrinter } from '../src/core/fit';
import { defaultsOf, type Params, type PrinterProfile, type ToolDef } from '../src/core/types';
import { buildTool } from './helpers';

/**
 * Presets that cannot fit a printer even shrunk: hardware (a bulb, a toothbrush, a
 * board) sets a minimum size. 'tool|preset|printer'. The app shows the tool's message.
 */
export const IMPOSSIBLE = new Set<string>([
  // the E27 lamp ring needs a wider bottom opening than a 170 mm ball allows
  'vaas|Hanglamp bol|a1mini',
  // an electric toothbrush on its charger is taller than 180 mm; three brushes side by side are wider than 170 mm
  'tandenborstel|Oral-B met oplader|a1mini',
  'tandenborstel|Gezin (3 borstels)|a1mini',
  // 160 mm between the screw holes of the cabinet: the handle is longer than 170 mm
  'grepen|Platte greep 160|a1mini',
  'grepen|Gedraaide ster 160|a1mini',
  'grepen|Takgreep 160|a1mini',
  // the G95 globe bulb needs lamellae wider than the A1 mini's plate
  'lamp|Lagenkoepel (louvre)|a1mini',
]);

/** One printer per build volume, smallest first. */
const sizes = new Map<string, PrinterProfile>();
for (const p of [...PRINTERS].sort((a, b) => a.x * a.y * a.z - b.x * b.y * b.z)) sizes.set(`${p.x}×${p.y}×${p.z}`, p);
const PRINTER_SIZES = [...sizes.values()];
const covers = (big: PrinterProfile, small: PrinterProfile) => big.x >= small.x && big.y >= small.y && big.z >= small.z;

/**
 * Every preset builds and fits on every printer after adaptation. A preset that fits a
 * printer unchanged is not checked again on printers that are larger in every direction
 * (FIT_ALL=1 checks them all).
 */
export function checkPresets(tools: ToolDef[]) {
  let M: ManifoldToplevel;
  beforeAll(async () => {
    M = await initManifold();
  });
  for (const tool of tools) {
    describe(tool.id, () => {
      for (const preset of tool.presets ?? []) {
        it(`past op elke printer: ${preset.name}`, async () => {
          const params = { ...defaultsOf(tool.params), ...preset.values } as Params;
          const fitUnchanged: PrinterProfile[] = [];
          const report: string[] = [];
          for (const printer of PRINTER_SIZES) {
            if (!process.env.FIT_ALL && fitUnchanged.some((s) => covers(printer, s))) continue;
            const out = await fitToPrinter(tool.params, params, printer, async (p) => {
              try {
                return { ok: true, result: await buildTool(M, tool, p, printer) };
              } catch (err) {
                if (!(err as { user?: boolean }).user) throw err;
                return { ok: false, error: (err as Error).message };
              }
            });
            const key = `${tool.id}|${preset.name}|${printer.id}`;
            if (out.fits && out.result) {
              for (const part of out.result.parts) expect(fitsOn(printer, part.size), `${key}: ${part.name}`).toBe(true);
              if (out.factor === 1) fitUnchanged.push(printer);
              else report.push(`${printer.id} ${Math.floor(out.factor * 100)}%`);
              expect(IMPOSSIBLE.has(key), `${key} past nu wel: haal hem uit IMPOSSIBLE`).toBe(false);
            } else {
              expect(IMPOSSIBLE.has(key), `${key} past niet: ${out.error ?? 'te groot'}`).toBe(true);
              expect(out.error ?? 'te groot').toBeTruthy();
            }
          }
          if (process.env.REPORT && report.length) console.log(`${tool.id} / ${preset.name}: ${report.join(', ')}`);
        });
      }
    });
  }
}
