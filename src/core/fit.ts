import { usable } from './printer';
import type { BuildResult, NumberParam, ParamDef, Params, PrinterProfile } from './types';

/*
 * Make a design fit the selected printer by shrinking its size parameters.
 *
 * Which parameters count as "size": a NumberParam with `scale: true`, or by
 * default one in millimetres with a large range (max > 60 mm) whose label does
 * not name hardware or a functional measure (wall thickness, screws, threads,
 * clearances, holes, fittings, boards, cables …). A tool can always override
 * this with `scale: false` / `scale: true` on the parameter.
 *
 * The search runs real builds: a design that does not fit (a part larger than
 * the plate, or a UserError from the tool) is retried with every size
 * parameter multiplied by a factor, found by shrinking with the measured
 * overshoot and a short bisection.
 */

const NOT_A_SIZE =
  /wand|dikte|speling|schroef|boor|draad|gat|fitting|led\b|kabel|naad|afronding|textuur|lip\b|insteek|plank|oplader|zuignap|speaker|lade\b|muur|uurwerk|uitsparing|aanslag|tussenruimte|stap\b/i;

/** True when the parameter is a size that may be scaled to fit the printer. */
export function isSizeParam(d: ParamDef): d is NumberParam {
  if (d.type !== 'number') return false;
  if (d.scale !== undefined) return d.scale;
  return d.unit === 'mm' && d.max > 60 && !NOT_A_SIZE.test(`${d.key} ${d.label}`);
}

export function sizeKeys(defs: ParamDef[]): string[] {
  return defs.filter(isSizeParam).map((d) => d.key);
}

/** Round down to the parameter's step (from its minimum), clamped to min/max. */
function snap(d: NumberParam, v: number): number {
  const step = d.step ?? 1;
  const k = Math.floor((v - d.min) / step + 1e-9);
  const out = d.min + k * step;
  // tidy floating point noise (0.1 steps)
  const dec = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)) + 1);
  return Math.min(d.max, Math.max(d.min, +out.toFixed(dec)));
}

/** Every size parameter multiplied by `factor` (rounded down to its step, kept within its range). */
export function scaleParams(defs: ParamDef[], params: Params, factor: number): Params {
  const out: Params = { ...params };
  if (factor === 1) return out;
  for (const d of defs) {
    if (!isSizeParam(d)) continue;
    const v = Number(params[d.key]);
    if (!Number.isFinite(v)) continue;
    // a value already below the range minimum stays as it is
    out[d.key] = v <= d.min ? v : snap(d, v * factor);
  }
  return out;
}

/**
 * How much every part would have to shrink to fit (1 = fits, < 1 = scale by
 * at most this). Parts may turn 90° on the plate, like `fitsOn`.
 */
export function fitRatio(printer: PrinterProfile, sizes: [number, number, number][]): number {
  const u = usable(printer);
  let r = Infinity;
  for (const [w, d, h] of sizes) {
    const xy = Math.max(Math.min(u.x / w, u.y / d), Math.min(u.x / d, u.y / w));
    r = Math.min(r, xy, u.z / h);
  }
  return r;
}

const MM = String.raw`(\d+(?:[.,]\d+)?)`;
const SIZE_IN_TEXT = new RegExp(String.raw`(Ø\s*)?${MM}\s*[×x]\s*${MM}(?:\s*[×x]\s*${MM})?\s*mm`, 'g');

/**
 * The fit ratio of the first size named in a tool's message ("De kap (180 × 85 × 110 mm)",
 * "Lamel (Ø200 × 8 mm)"), or 0 when the message names none. Lets a design that stops
 * with a size error shrink by the right amount at once.
 */
export function sizeHint(message: string, printer: PrinterProfile): number {
  SIZE_IN_TEXT.lastIndex = 0;
  const m = SIZE_IN_TEXT.exec(message);
  if (!m) return 0;
  const n = (v: string | undefined) => (v === undefined ? undefined : Number(v.replace(',', '.')));
  const a = n(m[2])!;
  const b = n(m[3])!;
  const c = n(m[4]);
  const size: [number, number, number] = m[1] ? [a, a, b] : c !== undefined ? [a, b, c] : [a, b, 0];
  if (!size.every((v) => Number.isFinite(v) && v >= 0) || size[0] <= 0 || size[1] <= 0) return 0;
  return fitRatio(printer, [size]);
}

export type Attempt = { ok: true; result: BuildResult } | { ok: false; error: string };

export interface FitOutcome {
  params: Params;
  /** 1 when nothing changed. */
  factor: number;
  /** The build of `params`; absent when nothing fits. */
  result?: BuildResult;
  /** Every part of `result` fits on the printer. */
  fits: boolean;
  /** The tool's message when even the smallest attempt failed. */
  error?: string;
}

const MIN_FACTOR = 0.2;

/**
 * Find the largest factor (≤ 1) at which the design builds and every part
 * fits. `build` runs one attempt; only deliberate (user) errors should come
 * back as `{ ok: false }`, anything else should throw.
 */
export async function fitToPrinter(defs: ParamDef[], params: Params, printer: PrinterProfile, build: (p: Params) => Promise<Attempt>): Promise<FitOutcome> {
  const keys = sizeKeys(defs);
  const tried = new Map<string, { a: Attempt; ratio: number; p: Params }>();
  const tryAt = async (f: number) => {
    const p = scaleParams(defs, params, f);
    const key = keys.map((k) => p[k]).join('|');
    let t = tried.get(key);
    if (!t) {
      const a = await build(p);
      t = { a, ratio: a.ok ? fitRatio(printer, a.result.parts.map((x) => x.size)) : 0, p };
      tried.set(key, t);
    }
    return t;
  };
  const good = (t: { a: Attempt; ratio: number }) => t.a.ok && t.ratio >= 1;

  const first = await tryAt(1);
  if (good(first)) return { params: first.p, factor: 1, fits: true, result: (first.a as { result: BuildResult }).result };
  const firstError = first.a.ok ? undefined : first.a.error;
  if (!keys.length) return { params, factor: 1, fits: false, result: first.a.ok ? first.a.result : undefined, error: firstError };

  // 1. shrink until something fits: by the measured overshoot when the build worked, else in steps
  let hi = 1;
  let lo = 0;
  let loT: Awaited<ReturnType<typeof tryAt>> | null = null;
  let f = 1;
  let t = first;
  let estimated = false;
  for (let i = 0; i < 12 && f > MIN_FACTOR; i++) {
    // how much too big: measured on the parts, else read from the tool's message ("… (Ø200 × 8 mm) past niet …")
    const over = t.a.ok ? t.ratio : sizeHint(t.a.error, printer);
    estimated = over > 0 && over < 1;
    const next = estimated ? f * Math.min(0.97, over * 0.995) : f * 0.85;
    f = Math.max(MIN_FACTOR, next);
    t = await tryAt(f);
    if (good(t)) {
      lo = f;
      loT = t;
      break;
    }
    hi = f;
  }
  if (!loT) return { params, factor: 1, fits: false, result: first.a.ok ? first.a.result : undefined, error: firstError ?? (t.a.ok ? undefined : t.a.error) };

  // 2. grow back towards the limit
  if (estimated) {
    // the overshoot estimate is usually close: one small step up is enough
    if (hi > lo * 1.04) {
      const up = await tryAt(lo * 1.04);
      if (good(up)) {
        lo *= 1.04;
        loT = up;
        // the estimate was cautious (e.g. a part the tool turns on the bed): look a little further
        for (let i = 0; i < 2 && (hi - lo) / hi > 0.045; i++) {
          const mid = (lo + hi) / 2;
          const m = await tryAt(mid);
          if (good(m)) {
            lo = mid;
            loT = m;
          } else hi = mid;
        }
      } else hi = lo * 1.04;
    }
  } else {
    // shrunk in blind steps after an error: grow by the room left on the plate, then bisect a little
    for (let i = 0; i < 2 && loT.ratio > 1.005; i++) {
      const probe = Math.min(lo * loT.ratio * 0.995, hi - 0.002);
      if (probe <= lo * 1.01) break;
      const m = await tryAt(probe);
      if (!good(m)) {
        hi = probe;
        break;
      }
      lo = probe;
      loT = m;
    }
    for (let i = 0; i < 2 && (hi - lo) / hi > 0.045; i++) {
      const mid = (lo + hi) / 2;
      const m = await tryAt(mid);
      if (good(m)) {
        lo = mid;
        loT = m;
      } else hi = mid;
    }
  }
  return { params: loT.p, factor: lo, fits: true, result: (loT.a as { result: BuildResult }).result };
}

/** "87%" for the note shown in the app. */
export function percent(factor: number): string {
  return `${Math.floor(factor * 100)}%`;
}
