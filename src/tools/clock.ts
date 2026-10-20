import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { Font } from 'opentype.js';
import type { AssetRef, AssetStore, BuildOutput, InfoBlock, ParamDef, Params, PartOut, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, bool, num, str } from '../core/types';
import { FONT_OPTIONS, fontKey } from '../core/fonts';
import { usable } from '../core/printer';
import { keep } from '../core/registry';
import { TAU, clamp, deg, identity, mul, rotX, rotZ, translation, type M4 } from '../geom/helpers';
import { sizeForHeight, textCross } from '../geom/text';
import { effectiveSpec, radialShape, shapeAssets, shapeCross, shapeParams, shapeSpecFrom, type ShapeSpec } from '../geom/shapes2d';
import {
  HAND_STYLES, MOVEMENTS, PLA_DENSITY, TICK_STYLES, areaStats, disc, edgeExtrude, fitStrip, handCross, holeCross, nl, polygon, polygonsOf, secondCross, tickCross,
  type FitItem,
} from './clockParts';

const DEFAULT_FONT = 'bundled:montserrat';
/** Labels on the fit-test strips always use this bundled font (works offline). */
const FIT_FONT = 'bundled:montserrat';

/** A typical quartz movement body (mm). */
const MOVEMENT = { size: 56, depth: 16, shaft: 8 };
/** Washer + hex nut on the front of the dial. */
const NUT_ALLOWANCE = 2.5;
/** Cap nut on the minute hand. */
const CAP_NUT_D = 7.5;
/** Hands are shown at 10:10:30 in the assembled view. */
const SHOW_TIME = { h: 10, m: 10, s: 30 };

// ---------------------------------------------------------------------------
// Parameter helpers

const mode = (p: Params) => str(p, 'mode');
const is = (...m: string[]) => (p: Params) => m.includes(mode(p));
const hasDialParams = is('clock', 'dial');
const usesShape = is('clock', 'dial', 'wall');
const makesHands = (p: Params) => is('clock', 'hands')(p) || (mode(p) === 'wall' && bool(p, 'wallHands'));
const usesNumerals = (p: Params) => usesShape(p) && str(p, 'numerals') !== 'none';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * Labels around the dial. Twelve labels run 1..12 like a normal clock; any
 * other number of labels is spread evenly starting at the top.
 */
function numeralLabels(p: Params): { labels: string[]; start: number } {
  switch (str(p, 'numerals')) {
    case 'arabic':
      return { labels: ROMAN.map((_, i) => String(i + 1)), start: 1 };
    case 'roman':
      return { labels: ROMAN.map((r) => (r === 'IV' && bool(p, 'romanFour') ? 'IIII' : r)), start: 1 };
    case 'quarters':
      return { labels: ['12', '3', '6', '9'], start: 0 };
    case 'quartersRoman':
      return { labels: ['XII', 'III', 'VI', 'IX'], start: 0 };
    case 'custom': {
      const labels = str(p, 'customLabels')
        .split(',')
        .map((s) => s.trim())
        .slice(0, 60);
      if (labels.every((l) => !l)) return { labels: [], start: 0 };
      return { labels, start: labels.length === 12 ? 1 : 0 };
    }
    default:
      return { labels: [], start: 0 };
  }
}

/** Angle (degrees, CCW from +X) of label i of n. */
const labelAngle = (i: number, n: number, start: number) => 90 - (360 * (i + start)) / n;

/** Whole millimetres for tables (no "-0"). */
const mm = (v: number) => Math.round(v) || 0;

function fontRef(p: Params): string {
  const f = str(p, 'font');
  if (f === 'google') return fontKey('google', str(p, 'googleFont'), Number(str(p, 'googleWeight')) || 400);
  if (f === 'upload') return p.fontFile ? str(p, 'fontFile') : DEFAULT_FONT;
  return f && f !== 'undefined' ? f : DEFAULT_FONT;
}

/** Does this build put any text on a part? */
function textInUse(p: Params) {
  const m = mode(p);
  if (m === 'fit') return true;
  if (m === 'hands') return false;
  const numerals = usesNumerals(p) && numeralLabels(p).labels.some(Boolean);
  if (m === 'wall') return numerals;
  return numerals || str(p, 'label').trim() !== '';
}

function assets(p: Params): AssetRef[] {
  const refs: AssetRef[] = [];
  if (textInUse(p)) refs.push({ kind: 'font', key: mode(p) === 'fit' ? FIT_FONT : fontRef(p) });
  if (usesShape(p)) refs.push(...shapeAssets(p, 'dial'));
  if (makesHands(p) && str(p, 'handStyle') === 'custom' && p.handFile) refs.push({ kind: 'shape', key: str(p, 'handFile') });
  return refs;
}

interface Holes {
  hour: number;
  minute: number;
  minuteFlat: number;
  second: number;
  center: number;
}

function holeSizes(p: Params): Holes {
  const mv = MOVEMENTS[str(p, 'movement')];
  const adj = num(p, 'holeAdjust');
  const base = mv ?? { hour: num(p, 'hourHole'), minute: num(p, 'minuteHole'), minuteFlat: num(p, 'minuteFlat'), second: num(p, 'secondHole') };
  const minute = Math.max(0.6, base.minute + adj);
  return {
    hour: Math.max(0.6, base.hour + adj),
    minute,
    minuteFlat: clamp(base.minuteFlat + adj, 0.4, minute),
    second: Math.max(0.3, base.second + adj),
    center: num(p, 'centerHole'),
  };
}

// ---------------------------------------------------------------------------
// Dial geometry

interface DialGeo {
  spec: ShapeSpec;
  D: number;
  R: number;
  outline: CrossSection;
  /** normalised radius of the outline (max 1) */
  rho: (th: number) => number;
  /** space taken by a raised rim at the edge */
  inset: number;
  /** usable radius inside the rim at angle th */
  ru: (th: number) => number;
  ruMin: number;
  ruMean: number;
}

/** Shapes with repeating lobes get a lobe on 12 o'clock, so the numerals land in the petals. */
const LOBED = ['petals', 'flower', 'scallop', 'star', 'gear', 'clover', 'cross'];

function dialGeo(M: ManifoldToplevel, p: Params, D: number, inset: number, assets: AssetStore): DialGeo {
  const spec = effectiveSpec(shapeSpecFrom(p, 'dial'));
  const f = radialShape(spec, assets);
  const N = 1024;
  const tab = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) tab[i] = f((TAU * i) / N);
  tab[N] = tab[0];
  let rot = p.dialRotate === undefined ? 0 : num(p, 'dialRotate');
  if (LOBED.includes(spec.shape)) {
    let max = 0;
    for (let i = 0; i < N; i++) max = Math.max(max, tab[i]);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (tab[i] < max - 1e-4) continue;
      const a = (360 * i) / N;
      const d = Math.abs(((((a - 90) % 360) + 540) % 360) - 180);
      if (d < bestD) {
        bestD = d;
        best = 90 - a;
      }
    }
    rot += best;
  }
  const rotRad = deg(rot);
  let outline = shapeCross(M, spec, D, assets, 360);
  if (Math.abs(rot) > 1e-6) outline = outline.rotate(rot);
  if (outline.isEmpty()) throw new UserError('De vorm van de wijzerplaat is leeg. Kies een andere vorm of upload een ander SVG-bestand.');
  const rho = (th: number) => {
    const u = (((((th - rotRad) / TAU) % 1) + 1) % 1) * N;
    const i = Math.min(N - 1, Math.floor(u));
    const fr = u - i;
    return tab[i] * (1 - fr) + tab[i + 1] * fr;
  };
  const R = D / 2;
  const ru = (th: number) => Math.max(2, R * rho(th) - inset);
  let ruMin = Infinity;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.max(2, R * tab[i] - inset);
    ruMin = Math.min(ruMin, v);
    sum += v;
  }
  return { spec, D, R, outline, rho, inset, ru, ruMin, ruMean: sum / N };
}

/** Closed curve r(θ) as a cross-section. */
function curveCross(M: ManifoldToplevel, r: (th: number) => number, segs = 720): CrossSection {
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const th = (TAU * i) / segs;
    const v = Math.max(0.5, r(th));
    pts.push([v * Math.cos(th), v * Math.sin(th)]);
  }
  return polygon(M, pts);
}

interface PlacedLabel {
  label: string;
  cs: CrossSection;
  /** degrees, CCW from +X */
  angle: number;
  r: number;
  x: number;
  y: number;
}

/**
 * Put the numerals around the dial, keeping them inside the outline: each
 * may move inward a little; when that is not enough all shrink together.
 */
function placeNumerals(M: ManifoldToplevel, p: Params, font: Font, geo: DialGeo, clearR: number, band: TickBand | null, warnings: string[]) {
  const { labels, start } = numeralLabels(p);
  const n = labels.length;
  const H = (num(p, 'numSize') / 100) * geo.D;
  const fs = sizeForHeight(font, H);
  const radial = str(p, 'numOrient') === 'radial';
  const follow = bool(p, 'follow');
  const k = num(p, 'numPos') / 100;
  const margin = Math.max(1.5, 0.015 * geo.D);
  const missing: string[] = [];
  const items = labels.map((label, i) => {
    if (!label) return null;
    const cs = textCross(M, font, label, fs);
    if (cs.isEmpty() || cs.area() < 0.01) {
      missing.push(label);
      return null;
    }
    const angle = labelAngle(i, n, start);
    const th = deg(angle);
    const rot = radial ? angle - 90 : 0;
    const c = Math.cos(deg(rot));
    const s = Math.sin(deg(rot));
    // rotated outline points, ready for the inside test
    const pts = polygonsOf(cs).flat().map(([x, y]) => [x * c - y * s, x * s + y * c] as Vec2);
    return { label, cs, angle, th, rot, pts, r0: k * (follow ? geo.ru(th) : geo.ruMin) };
  });
  if (missing.length) warnings.push(`Dit lettertype heeft geen tekens voor: ${missing.join(' ')}`);
  type Item = NonNullable<(typeof items)[number]>;
  // keep clear of the tick ring: stay inside it, or outside when the ticks run inside the numerals
  const gap = Math.max(1.5, 0.012 * geo.D);
  const ticksOutside = band && band.k >= k;
  const fits = (it: Item, r: number, sc: number) => {
    const cx = r * Math.cos(it.th);
    const cy = r * Math.sin(it.th);
    for (const [x, y] of it.pts) {
      const px = cx + x * sc;
      const py = cy + y * sc;
      const d = Math.hypot(px, py);
      const phi = Math.atan2(py, px);
      if (d > geo.ru(phi) - margin || d < clearR + 1) return false;
      if (band && (ticksOutside ? d > band.inner(phi) - gap : d < band.outer(phi) + gap)) return false;
    }
    return true;
  };
  const steps = [1, 0.97, 1.03, 0.94, 1.06, 0.91, 0.88, 0.85];
  const solve = (it: Item, sc: number) => {
    for (const f of steps) if (fits(it, it.r0 * f, sc)) return it.r0 * f;
    return null;
  };
  const place = (sc: number, rs: (number | null)[]) => {
    const out: PlacedLabel[] = [];
    items.forEach((it, i) => {
      if (!it) return;
      const r = rs[i] ?? it.r0;
      const x = r * Math.cos(it.th);
      const y = r * Math.sin(it.th);
      out.push({ label: it.label, cs: it.cs.scale(sc).rotate(it.rot).translate([x, y]), angle: it.angle, r, x, y });
    });
    return out;
  };
  // neighbouring numerals keep a small gap
  const gapN = Math.max(1, 0.006 * geo.D);
  const touching = (list: PlacedLabel[]) => {
    for (let i = 0; i < list.length && list.length > 1; i++) {
      const b = list[(i + 1) % list.length];
      if (b !== list[i] && list[i].cs.offset(gapN / 2, 'Round').intersect(b.cs.offset(gapN / 2, 'Round')).area() > 0.01) return true;
    }
    return false;
  };
  let sc = 1;
  let rs: (number | null)[] = [];
  let placed: PlacedLabel[] = [];
  let touch = false;
  for (let iter = 0; iter < 30; iter++) {
    rs = items.map((it) => (it ? solve(it, sc) : 0));
    if (rs.every((r) => r !== null)) {
      placed = place(sc, rs);
      touch = touching(placed);
      if (!touch) break;
    }
    sc *= 0.95;
  }
  const failed = rs.some((r) => r === null);
  if (failed || !placed.length) placed = place(sc, rs);
  const moved = items.some((it, i) => it && rs[i] !== null && Math.abs((rs[i] as number) - it.r0) > 0.01 * it.r0);
  if (failed) warnings.push('De cijfers passen niet goed op deze vorm; wat buiten de rand valt is afgesneden. Maak ze kleiner of zet ze dichter bij het midden.');
  else if (touch) warnings.push('De cijfers raken elkaar: maak ze kleiner of zet ze verder naar buiten.');
  else if (sc < 0.99) warnings.push(`De cijfers zijn verkleind tot ${Math.round(sc * 100)}% zodat ze binnen de rand en tussen de streepjes passen.`);
  else if (moved) warnings.push('Een paar cijfers zijn iets verschoven zodat ze binnen de rand en los van de streepjes blijven.');
  let innerR = Infinity;
  items.forEach((it, i) => {
    if (!it) return;
    const r = rs[i] ?? it.r0;
    const x = r * Math.cos(it.th);
    const y = r * Math.sin(it.th);
    for (const [px, py] of it.pts) innerR = Math.min(innerR, Math.hypot(x + px * sc, y + py * sc));
  });
  return { placed, height: H * sc, innerR: Number.isFinite(innerR) ? innerR : geo.ruMin * k };
}

interface TickBand {
  /** outer edge as a fraction of the usable radius */
  k: number;
  outer: (th: number) => number;
  inner: (th: number) => number;
}

/** The ring the tick marks occupy, or null without ticks. */
function tickBand(p: Params, geo: DialGeo): TickBand | null {
  const hs = str(p, 'hourTicks');
  const ms = str(p, 'minuteTicks');
  const track = bool(p, 'track');
  if (hs === 'none' && ms === 'none' && !track) return null;
  const k = num(p, 'tickPos') / 100;
  const follow = bool(p, 'tickFollow');
  const len = (Math.max(hs !== 'none' ? num(p, 'hourTickL') : 0, ms !== 'none' || track ? num(p, 'minuteTickL') : 0) / 100) * geo.R;
  const outer = (th: number) => k * (follow ? geo.ru(th) : geo.ruMin);
  return { k, outer, inner: (th) => outer(th) - len };
}

function tickMarks(M: ManifoldToplevel, p: Params, geo: DialGeo, numeralAngles: number[]) {
  const k = num(p, 'tickPos') / 100;
  const follow = bool(p, 'tickFollow');
  const rOut = (th: number) => k * (follow ? geo.ru(th) : geo.ruMin);
  const R = geo.R;
  const hs = str(p, 'hourTicks');
  const ms = str(p, 'minuteTicks');
  const Lh = (num(p, 'hourTickL') / 100) * R;
  const Lm = (num(p, 'minuteTickL') / 100) * R;
  const hourTick = tickCross(M, hs, Lh, (num(p, 'hourTickW') / 100) * R);
  const minTick = tickCross(M, ms, Lm, (num(p, 'minuteTickW') / 100) * R);
  const skip = bool(p, 'skipTicks');
  const out: CrossSection[] = [];
  const margin = Math.max(1.2, 0.01 * geo.D);
  const corners = new Map<CrossSection, Vec2[]>();
  /** Pull a tick inward until all its corners are inside the outline (slanted edges of polygons). */
  const fitR = (tick: CrossSection, a: number, r0: number) => {
    let pts = corners.get(tick);
    if (!pts) corners.set(tick, (pts = polygonsOf(tick).flat()));
    const c = Math.cos(deg(a - 90));
    const s = Math.sin(deg(a - 90));
    const th = deg(a);
    let r = r0;
    for (let j = 0; j < 25; j++, r *= 0.985) {
      const cx = r * Math.cos(th);
      const cy = r * Math.sin(th);
      if (pts.every(([x, y]) => {
        const px = cx + x * c - y * s;
        const py = cy + x * s + y * c;
        return Math.hypot(px, py) <= geo.ru(Math.atan2(py, px)) - margin;
      })) return r;
    }
    return r0;
  };
  for (let i = 0; i < 60; i++) {
    const a = 90 - 6 * i;
    const th = deg(a);
    if (skip && numeralAngles.some((na) => Math.abs((((na - a) % 360) + 540) % 360 - 180) < 0.5)) continue;
    const tick = i % 5 === 0 && hourTick ? hourTick : i % 5 !== 0 || !hourTick ? minTick : null;
    if (!tick) continue;
    const r = fitR(tick, a, rOut(th));
    out.push(tick.rotate(a - 90).translate([r * Math.cos(th), r * Math.sin(th)]));
  }
  if (bool(p, 'track')) {
    const w = Math.max(0.8, (num(p, 'minuteTickW') / 100) * R);
    for (const d of [0, Lm]) {
      const c = curveCross(M, (th) => rOut(th) - d);
      out.push(c.subtract(c.offset(-w, 'Round')));
    }
  }
  const innerEdge = k * geo.ruMin - Math.max(hourTick ? Lh : 0, minTick || bool(p, 'track') ? Lm : 0);
  return { shapes: out, innerEdge: hourTick || minTick || bool(p, 'track') ? innerEdge : k * geo.ruMin };
}

// ---------------------------------------------------------------------------
// Hands

interface HandOut {
  kind: 'hour' | 'minute' | 'second';
  name: string;
  solid: Manifold;
  thickness: number;
  length: number;
  width: number;
  hole: string;
  mass: number;
  moment: number;
  /** extra rotation around Z applied for printing (to fit the bed diagonally) */
  printRot: number;
}

function buildHands(M: ManifoldToplevel, p: Params, Rref: number, holes: Holes, assets: AssetStore, printer: PrinterProfile, warnings: string[]): HandOut[] {
  const T = num(p, 'handT');
  const w = num(p, 'handW');
  const tailK = num(p, 'tail') / 100;
  const hubD = num(p, 'hubD');
  const style = str(p, 'handStyle');
  const custom = style === 'custom' && p.handFile ? { polygons: assets.shape(str(p, 'handFile')).polygons, pivot: num(p, 'pivot') / 100 } : undefined;
  const u = usable(printer);
  const out: HandOut[] = [];
  const notes = new Set<string>();
  const tooLong: string[] = [];

  const finish =(kind: HandOut['kind'], name: string, cs: CrossSection, length: number, width: number, cutters: Manifold[], holeCs: CrossSection, hole: string, extra?: Manifold) => {
    const flat = cs.subtract(holeCs);
    const st = areaStats(flat);
    let solid = flat.extrude(T);
    if (extra) solid = solid.add(extra);
    if (cutters.length) solid = solid.subtract(M.Manifold.union(cutters));
    const k = (T * PLA_DENSITY) / 1000;
    // fit on the bed: straight, or along the diagonal for very long hands
    const b = cs.bounds();
    const along = b.max[1] - b.min[1];
    const across = b.max[0] - b.min[0];
    let printRot = 0;
    if (along > Math.max(u.x, u.y) || across > Math.min(u.x, u.y)) {
      const diag = Math.hypot(u.x, u.y);
      if (along + across > diag * 0.97) {
        tooLong.push(`${name.toLowerCase()} (${Math.round(along)} mm)`);
        return;
      }
      printRot = (Math.atan2(u.y, u.x) * 180) / Math.PI - 90;
      solid = solid.rotate([0, 0, printRot]);
    }
    out.push({ kind, name, solid, thickness: T, length, width, hole, mass: st.area * k, moment: st.momentY * k, printRot });
  };

  // hour hand
  {
    const L = (num(p, 'hourLen') / 100) * Rref;
    const hub = Math.max(hubD, holes.hour + 3.2);
    const { cs, note } = handCross(M, style, { length: L, width: w, tail: L * tailK * 0.6, hub }, custom);
    if (note) notes.add(note);
    finish('hour', 'Uurwijzer', cs, L, w, [], holeCross(M, holes.hour), `Ø ${nl(holes.hour)} mm rond`);
  }
  // minute hand: optional counterbore so the cap nut still reaches the thread
  {
    const L = (num(p, 'minLen') / 100) * Rref;
    const hubT = Math.min(T, num(p, 'minHubT'));
    const bore = T - hubT >= 0.2;
    const capD = Math.max(CAP_NUT_D, holes.minute + 3.5);
    const hub = Math.max(hubD, holes.minute + 3.2, bore ? capD + 2.4 : 0);
    const mw = w * 0.78;
    const { cs, note } = handCross(M, style, { length: L, width: mw, tail: L * tailK, hub }, custom);
    if (note) notes.add(note);
    const cutters = bore ? [M.Manifold.cylinder(T - hubT + 0.02, capD / 2, capD / 2, 48).translate([0, 0, hubT])] : [];
    finish('minute', 'Minutenwijzer', cs, L, mw, cutters, holeCross(M, holes.minute, holes.minuteFlat), `Ø ${nl(holes.minute)} mm, ${nl(holes.minuteFlat)} mm tussen de platte kanten`);
  }
  if (bool(p, 'seconds')) {
    const L = (num(p, 'secLen') / 100) * Rref;
    const sw = clamp(w * 0.22, 1.0, 2.4);
    const boss = Math.max(2.1, (holes.second + 2.6) / 2);
    const hub = Math.max(5, holes.second + 3.2, boss * 2 + 1);
    const cs = secondCross(M, str(p, 'secStyle'), L, sw, hub);
    const hole = holeCross(M, holes.second);
    // a short collar gives the push-on pin more grip
    const collar = disc(M, boss, 0, 0, 32).subtract(hole).extrude(1.5).translate([0, 0, T - 0.01]);
    finish('second', 'Secondewijzer', cs, L, sw, [], hole, `Ø ${nl(holes.second)} mm (drukpen)`, collar);
  }
  for (const n of notes) warnings.push(n);
  if (tooLong.length) {
    const list = tooLong.join(' en ');
    warnings.push(`De ${list} ${tooLong.length > 1 ? 'passen' : 'past'} niet op het printbed en ${tooLong.length > 1 ? 'zijn' : 'is'} weggelaten. Maak de wijzers korter, of koop lange wijzers bij een high-torque uurwerk.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scene helpers: the clock hangs upright, its face towards the viewer (-Y)

/** Box given in clock coordinates (face up = +Z, 12 o'clock = +Y) as a world box. */
function sceneBox(min: [number, number, number], max: [number, number, number], lift: number, color: string, material: 'ghost' | 'solid' | 'wood', label?: string): SceneItem {
  return {
    kind: 'box',
    size: [max[0] - min[0], max[2] - min[2], max[1] - min[1]],
    position: [min[0], -max[2], min[1] + lift],
    color,
    material,
    label,
  };
}

const clockToWorld = (lift: number): M4 => mul(translation(0, 0, lift), rotX(90));

/** Hand angles at SHOW_TIME, in degrees clockwise from 12. */
function handAngles() {
  const { h, m, s } = SHOW_TIME;
  return { hour: ((h % 12) + m / 60 + s / 3600) * 30, minute: (m + s / 60) * 6, second: s * 6 };
}

function placeHands(scene: SceneItem[], hands: HandOut[], firstPart: number, world: M4, z: Record<HandOut['kind'], number>) {
  const ang = handAngles();
  hands.forEach((h, i) => {
    scene.push({ kind: 'part', part: firstPart + i, matrix: mul(world, mul(translation(0, 0, z[h.kind]), mul(rotZ(-ang[h.kind]), rotZ(-h.printRot)))) });
  });
}

function handZ(hands: HandOut[], base: number) {
  const T = hands[0]?.thickness ?? 1.6;
  const hour = base;
  const minute = hour + T + 1.0;
  const second = minute + T + 2.0;
  return { hour, minute, second, top: second + T + 1.5 };
}

function handInfo(hands: HandOut[]): InfoBlock {
  return {
    kind: 'table',
    title: 'Wijzers',
    headers: ['Wijzer', 'Lengte', 'Gat', 'Gewicht', 'Onbalans'],
    rows: hands.map((h) => [h.name, `${Math.round(h.length)} mm`, h.hole, `${nl(h.mass, 1)} g`, `${Math.round(Math.abs(h.moment))} g·mm`]),
  };
}

/** Quartz movements have little torque: warn about heavy or unbalanced hands. */
function torqueWarnings(hands: HandOut[], warnings: string[], tips: string[]) {
  const minute = hands.find((h) => h.kind === 'minute');
  const second = hands.find((h) => h.kind === 'second');
  if (minute && minute.moment > 400) {
    warnings.push(`De minutenwijzer is te zwaar (onbalans ${Math.round(minute.moment)} g·mm), zelfs voor een high-torque uurwerk. Maak hem smaller, dunner of korter, kies 'Skelet' of geef hem een langer staartje.`);
  } else if (minute && minute.moment > 120) {
    warnings.push(`De minutenwijzer is zwaar (onbalans ${Math.round(minute.moment)} g·mm): gebruik een high-torque uurwerk, of maak de wijzer smaller/dunner.`);
  } else if (minute && minute.length > 150) {
    tips.push('Lange wijzers: een high-torque uurwerk loopt betrouwbaarder.');
  }
  if (second && second.moment > 15) {
    warnings.push('De secondewijzer is vrij zwaar voor een gewoon uurwerk; maak hem korter of laat hem weg als de klok stil blijft staan rond 9 uur.');
  }
}

// ---------------------------------------------------------------------------
// Modes

interface Ctx {
  M: ManifoldToplevel;
  p: Params;
  assets: AssetStore;
  printer: PrinterProfile;
  warnings: string[];
  tips: string[];
  info: InfoBlock[];
}

function checkBed(ctx: Ctx, cs: CrossSection, what: string) {
  const b = cs.bounds();
  const w = b.max[0] - b.min[0];
  const h = b.max[1] - b.min[1];
  const u = usable(ctx.printer);
  if ((w <= u.x && h <= u.y) || (h <= u.x && w <= u.y)) return;
  throw new UserError(`${what} is ${Math.round(w)} × ${Math.round(h)} mm en past niet op het printbed van de ${ctx.printer.name} (${u.x} × ${u.y} mm bruikbaar). Maak hem kleiner of kies "Losse cijfers voor aan de muur".`);
}

interface DialPart {
  solid: Manifold;
  faceDown: boolean;
  T: number;
  /** thickness at the shaft */
  Tc: number;
  pocketDepth: number;
  raisedTop: number;
  rimTop: number;
}

/** Dial body with rim, back pocket, centre hole and the decoration (raised or engraved). */
function dialSolid(ctx: Ctx, geo: DialGeo, decor: CrossSection | null, rimOn: boolean, raised: boolean, reliefH: number): DialPart {
  const { M, p, warnings, tips } = ctx;
  const T = num(ctx.p, 'dialT');
  const edge = num(p, 'edge');
  const hasDecor = !!decor && !decor.isEmpty();
  // print face down for a smooth, plate-textured face unless something sticks out of it
  const faceDown = !rimOn && !(hasDecor && raised);
  const pocketKind = str(p, 'pocket');
  let pd = pocketKind === 'none' ? 0 : num(p, 'pocketDepth');
  if (pd > T - 1.6) {
    pd = Math.max(0, T - 1.6);
    warnings.push(`De uitsparing is ondieper gemaakt (${nl(pd, 1)} mm) zodat er bij de as nog 1,6 mm plaat overblijft.`);
  }
  const body = edgeExtrude(M, geo.outline, T, faceDown ? { r: 0, kind: 'round' } : { r: 0.4, kind: 'chamfer' }, rimOn ? { r: 0, kind: 'round' } : { r: edge, kind: faceDown ? 'chamfer' : 'round' });
  const add: Manifold[] = [body];
  const cut: Manifold[] = [];
  let rimTop = T;
  if (rimOn) {
    const rimW = num(p, 'rimW');
    const rimH = num(p, 'rimH');
    const inner = geo.outline.offset(-rimW, 'Round');
    const ring = inner.isEmpty() ? geo.outline : geo.outline.subtract(inner);
    add.push(edgeExtrude(M, ring, rimH + 0.01, { r: 0, kind: 'round' }, { r: Math.min(Math.max(edge, 0.4), rimH * 0.8, rimW * 0.4), kind: 'round' }).translate([0, 0, T - 0.01]));
    rimTop = T + rimH;
  }
  let depth = 0;
  if (hasDecor && decor) {
    if (raised) {
      add.push(decor.extrude(reliefH + 0.01).translate([0, 0, T - 0.01]));
    } else {
      depth = Math.min(reliefH, T - pd - 1.0, T - 0.8);
      if (depth < reliefH - 0.01) warnings.push(`De gravure is ${nl(depth, 1)} mm diep gemaakt zodat de plaat niet doorbreekt.`);
      if (depth > 0.1) cut.push(decor.extrude(depth + 0.02).translate([0, 0, T - depth]));
    }
  }
  const topZ = Math.max(rimTop, T + (raised && hasDecor ? reliefH : 0));
  cut.push(M.Manifold.cylinder(topZ + 2, num(p, 'centerHole') / 2, num(p, 'centerHole') / 2, 64).translate([0, 0, -1]));
  if (pd > 0) {
    const s = num(p, 'pocketSize');
    const pocket = pocketKind === 'round' ? M.CrossSection.circle(s / 2, 96) : M.CrossSection.square([s, s], true).offset(-1.5, 'Round').offset(1.5, 'Round');
    if (pocket.subtract(geo.outline.offset(-1.2, 'Round')).area() > 1) warnings.push('De uitsparing voor het uurwerk komt aan de rand naar buiten: maak de wijzerplaat groter of de uitsparing kleiner.');
    cut.push(pocket.extrude(pd + 0.01).translate([0, 0, -0.01]));
    if (!faceDown) tips.push(`De uitsparing aan de achterkant ligt op het bed en wordt overbrugd (${Math.round(s)} mm). Bambu Studio doet dat vanzelf; support is niet nodig.`);
  }
  const solid = (add.length > 1 ? M.Manifold.union(add) : add[0]).subtract(M.Manifold.union(cut));
  return { solid, faceDown, T, Tc: T - pd, pocketDepth: pd, raisedTop: raised && hasDecor ? T + reliefH : T, rimTop };
}

/** Dial info rows shared by the dial modes and the wall centre plate. */
function shaftInfo(ctx: Ctx, d: DialPart): [string, string][] {
  const need = d.Tc + NUT_ALLOWANCE;
  const rows: [string, string][] = [
    ['Dikte bij de as', `${nl(d.Tc, 1)} mm`],
    ['Schroefdraad uurwerk', `minstens ${nl(need, 1)} mm (plaat + ring + moer)`],
  ];
  const have = num(ctx.p, 'shaftThread');
  if (have > 0 && have < need) {
    const pocket = d.T - (have - NUT_ALLOWANCE);
    ctx.warnings.push(
      pocket <= d.T - 1.6
        ? `De schroefdraad van je uurwerk (${nl(have, 1)} mm) is te kort voor ${nl(d.Tc, 1)} mm plaat. Zet "Uitsparing achterkant" aan met een diepte van minstens ${nl(Math.ceil(pocket * 5) / 5, 1)} mm, of maak de plaat dunner.`
        : `De schroefdraad van je uurwerk (${nl(have, 1)} mm) is te kort voor deze plaat, ook met een uitsparing. Maak de plaat dunner of gebruik een uurwerk met een langere as.`,
    );
  }
  return rows;
}

function colourTips(ctx: Ctx, d: DialPart, raised: boolean, depth: number) {
  const layer = (z: number) => Math.round(z / 0.2);
  if (raised && d.raisedTop > d.T) {
    ctx.tips.push(
      `Twee kleuren zonder AMS: zet in Bambu Studio een filamentwissel op ${nl(d.T, 1)} mm (laag ${layer(d.T) + 1} bij 0,2 mm lagen): rechtsklik op de laagschuif → "Filamentwissel toevoegen" (of "Pauze"). Cijfers, streepjes${d.rimTop > d.T ? ' en rand' : ''} krijgen dan de tweede kleur.`,
    );
  } else if (!raised && depth > 0) {
    ctx.tips.push(
      d.faceDown
        ? `De gegraveerde plaat print met de voorkant op het bed: een strak, getextureerd gezicht. Twee kleuren: print de eerste ${nl(depth, 1)} mm (de gravure) in de plaatkleur en wissel dan van filament; de cijfers krijgen zo de tweede kleur.`
        : `Twee kleuren: wissel van filament op ${nl(d.T - depth, 1)} mm hoogte; de bodem van de gravure heeft dan een andere kleur dan het gezicht.`,
    );
  } else if (d.faceDown) {
    ctx.tips.push('De plaat print met de voorkant op het bed: een strak, getextureerd gezicht zonder support.');
  }
}

/** Mode "Complete klok" and "Alleen wijzerplaat". */
function buildDialModes(ctx: Ctx, withHands: boolean): BuildOutput {
  const { M, p, warnings, tips, info } = ctx;
  const D = num(p, 'diameter');
  const rimOn = bool(p, 'rim');
  const geo = dialGeo(M, p, D, rimOn ? num(p, 'rimW') : 0, ctx.assets);
  checkBed(ctx, geo.outline, 'De wijzerplaat');
  const clearR = Math.max(8, num(p, 'centerHole') / 2 + 4);
  const raised = str(p, 'relief') === 'raised';
  const reliefH = num(p, 'reliefH');
  const shapes: CrossSection[] = [];
  let font: Font | null = null;
  let numInfo: [string, string][] = [];
  const { labels } = numeralLabels(p);
  const wantNumerals = usesNumerals(p) && labels.some(Boolean);
  const labelText = str(p, 'label').trim();
  if (wantNumerals || labelText) font = ctx.assets.font(fontRef(p));
  let numeralAngles: number[] = [];
  let innerR = geo.ruMin * 0.8;
  if (wantNumerals && font) {
    const nums = placeNumerals(M, p, font, geo, clearR, tickBand(p, geo), warnings);
    shapes.push(...nums.placed.map((n) => n.cs));
    numeralAngles = nums.placed.map((n) => n.angle);
    innerR = nums.innerR;
    if (nums.placed.length) {
      const rs = nums.placed.map((n) => n.r);
      const lo = Math.round(Math.min(...rs));
      const hi = Math.round(Math.max(...rs));
      numInfo = [
        ['Cijferhoogte', `${nl(nums.height, 1)} mm`],
        ['Cijfers op', `${lo === hi ? lo : `${lo}–${hi}`} mm van het midden`],
      ];
    }
  }
  const ticks = tickMarks(M, p, geo, numeralAngles);
  if (ticks.shapes.length) {
    shapes.push(...ticks.shapes);
    if (shapes.length > ticks.shapes.length) {
      const numU = M.CrossSection.union(shapes.slice(0, shapes.length - ticks.shapes.length));
      const overlap = numU.intersect(M.CrossSection.union(ticks.shapes)).area();
      if (overlap > 0.03 * numU.area()) warnings.push('Cijfers en streepjes overlappen: maak de cijfers kleiner of zet ze dichter bij het midden.');
    } else innerR = Math.min(innerR, ticks.innerEdge - 2);
  }
  if (labelText && font) {
    const H = (num(p, 'labelSize') / 100) * D;
    let cs = textCross(M, font, labelText, sizeForHeight(font, H));
    if (cs.isEmpty()) warnings.push('Dit lettertype heeft geen tekens voor de tekst op de wijzerplaat.');
    else {
      const b = cs.bounds();
      let w = b.max[0] - b.min[0];
      let h = b.max[1] - b.min[1];
      const lim = Math.max(clearR + 4, innerR - 2);
      let y = Math.max(clearR + h / 2 + 1.5, 0.42 * lim);
      const half = Math.sqrt(Math.max(1, lim * lim - (y + h / 2) ** 2));
      if (w / 2 > half) {
        const s = Math.max(0.25, half / (w / 2));
        cs = cs.scale(s);
        w *= s;
        h *= s;
        y = Math.max(clearR + h / 2 + 1.5, 0.42 * lim);
        if (s < 0.95) warnings.push(`De tekst "${labelText}" is verkleind tot ${Math.round(s * 100)}% zodat hij tussen de cijfers past.`);
      }
      shapes.push(cs.translate([0, str(p, 'labelPos') === 'bottom' ? -y : y]));
    }
  }
  let decor: CrossSection | null = null;
  if (shapes.length) {
    decor = M.CrossSection.union(shapes)
      .intersect(geo.outline.offset(-(geo.inset + 0.6), 'Round'))
      .subtract(M.CrossSection.circle(clearR, 48));
    if (decor.isEmpty()) decor = null;
  }
  const dial = dialSolid(ctx, geo, decor, rimOn, raised, reliefH);
  const depth = !raised && decor ? Math.min(reliefH, dial.T - dial.pocketDepth - 1.0, dial.T - 0.8) : 0;
  const parts: PartOut[] = [{ name: 'Wijzerplaat', solid: dial.faceDown ? dial.solid.rotate([180, 0, 0]) : dial.solid }];
  const b = geo.outline.bounds();
  const dialRows: [string, string][] = [
    ['Maat', `${Math.round(b.max[0] - b.min[0])} × ${Math.round(b.max[1] - b.min[1])} mm`],
    ['Dikte', `${nl(dial.T, 1)} mm${dial.raisedTop > dial.T ? ` + ${nl(reliefH, 1)} mm reliëf` : ''}`],
    ...shaftInfo(ctx, dial),
    ['Gat in het midden', `Ø ${nl(num(p, 'centerHole'))} mm`],
    ...numInfo,
    ['Printstand', dial.faceDown ? 'voorkant op het bed' : 'achterkant op het bed'],
  ];
  info.push({ kind: 'kv', title: 'Wijzerplaat', rows: dialRows });
  colourTips(ctx, dial, raised, depth);

  // assembled view
  const lift = geo.R + 20;
  const world = clockToWorld(lift);
  const scene: SceneItem[] = [{ kind: 'part', part: 0, matrix: dial.faceDown ? mul(world, rotX(180)) : world }];
  const mz = dial.pocketDepth;
  scene.push(sceneBox([-MOVEMENT.size / 2, -MOVEMENT.size / 2, mz - MOVEMENT.depth], [MOVEMENT.size / 2, MOVEMENT.size / 2, mz], lift, '#8aa0b8', 'ghost', 'Uurwerk'));
  let top = dial.T + 6;
  if (withHands) {
    const Rref = geo.ruMean;
    const hands = buildHands(M, p, Rref, holeSizes(p), ctx.assets, ctx.printer, warnings);
    const z = handZ(hands, dial.T + Math.max(NUT_ALLOWANCE, dial.raisedTop - dial.T + 1));
    placeHands(scene, hands, parts.length, world, z);
    for (const h of hands) parts.push({ name: h.name, solid: h.solid });
    top = z.top;
    if (rimOn) {
      for (const h of hands) {
        if (h.kind === 'hour') continue;
        if (h.length > geo.ruMin - 1 && z[h.kind] < dial.rimTop) {
          warnings.push(`De ${h.name.toLowerCase()} raakt de opstaande rand: maak hem korter, de rand lager of smaller.`);
        }
      }
    }
    if (hands.some((h) => h.kind === 'minute' && h.length > geo.ruMin + geo.inset + 2)) warnings.push('De minutenwijzer steekt buiten de wijzerplaat uit.');
    info.push(handInfo(hands));
    torqueWarnings(hands, warnings, tips);
  }
  scene.push(sceneBox([-MOVEMENT.shaft / 2, -MOVEMENT.shaft / 2, mz], [MOVEMENT.shaft / 2, MOVEMENT.shaft / 2, top], lift, '#8aa0b8', 'ghost', 'As'));
  return { parts, scene, defaultView: 'assembly' };
}

/** Mode "Alleen wijzers": replacement hands for an existing clock. */
function buildHandsMode(ctx: Ctx): BuildOutput {
  const { M, p, warnings, tips, info } = ctx;
  const D = num(p, 'diameter');
  const R = D / 2;
  const hands = buildHands(M, p, R, holeSizes(p), ctx.assets, ctx.printer, warnings);
  if (!hands.length) throw new UserError('Deze wijzers zijn te lang voor het printbed. Maak ze korter of kies een kleinere diameter.');
  const lift = R + 20;
  const world = clockToWorld(lift);
  const T = 3;
  const scene: SceneItem[] = [sceneBox([-R, -R, 0], [R, R, T], lift, '#8aa0b8', 'ghost', 'Je wijzerplaat')];
  const z = handZ(hands, T + NUT_ALLOWANCE);
  placeHands(scene, hands, 0, world, z);
  scene.push(sceneBox([-MOVEMENT.size / 2, -MOVEMENT.size / 2, -MOVEMENT.depth], [MOVEMENT.size / 2, MOVEMENT.size / 2, 0], lift, '#8aa0b8', 'ghost', 'Uurwerk'));
  info.push(handInfo(hands));
  torqueWarnings(hands, warnings, tips);
  return { parts: hands.map((h) => ({ name: h.name, solid: h.solid })), scene, defaultView: 'assembly' };
}

/** Keyhole slot on the back of a wall part (z = 0 is the wall side). */
function keyhole(M: ManifoldToplevel, x: number, y: number, T: number): Manifold {
  const lip = 1.6;
  const top = Math.min(T - 1.0, lip + 2.8);
  const len = 7;
  const narrow = M.CrossSection.hull([disc(M, 2.1, x, y, 24), disc(M, 2.1, x, y + len, 24)]);
  const wide = M.CrossSection.hull([disc(M, 4.25, x, y, 32), disc(M, 4.25, x, y + len, 32)]);
  return M.Manifold.union([
    disc(M, 4.25, x, y, 32).extrude(top + 0.01).translate([0, 0, -0.01]),
    narrow.extrude(lip + 0.02).translate([0, 0, -0.01]),
    wide.extrude(top - lip).translate([0, 0, lip]),
  ]);
}

/** Point-in-polygons (even-odd) for the keyhole search. */
function inside(polys: Vec2[][], x: number, y: number) {
  let c = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  return c;
}

/** Highest spot on a back face where a keyhole fits, or null. */
function keyholeSpot(back: CrossSection): [number, number] | null {
  const room = back.offset(-(4.25 + 1.4), 'Round');
  if (room.isEmpty()) return null;
  const polys = polygonsOf(room);
  const b = room.bounds();
  const cx = (b.min[0] + b.max[0]) / 2;
  const w = b.max[0] - b.min[0];
  for (let yy = b.max[1] - 7; yy >= b.min[1]; yy -= 0.5) {
    for (const dx of [0, -0.15, 0.15, -0.3, 0.3, -0.45, 0.45]) {
      const x = cx + dx * w;
      let ok = true;
      for (let s = 0; s <= 4 && ok; s++) ok = inside(polys, x, yy + (7 * s) / 4);
      if (ok) return [x, yy];
    }
  }
  return null;
}

/** Bars joining the separate glyphs of a multi-digit numeral at the back (kept out of the counters). */
function bridges(M: ManifoldToplevel, cs: CrossSection, H: number): CrossSection | null {
  const islands = cs.decompose().filter((c) => c.area() > 0.5);
  if (islands.length < 2) return null;
  const info = islands.map((c) => {
    const b = c.bounds();
    // the island with its counters filled (outer contours are counter-clockwise)
    const outer = polygonsOf(c).filter((poly) => signedArea(poly) > 0);
    const filled = outer.length ? keep(new M.CrossSection(outer, 'Positive')) : c;
    return { c: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] as Vec2, counters: filled.subtract(c) };
  });
  info.sort((a, b) => a.c[0] - b.c[0]);
  const w = Math.max(2.4, 0.12 * H);
  const bars: CrossSection[] = [];
  for (let i = 0; i < info.length - 1; i++) {
    const [ax, ay] = info[i].c;
    const [bx, by] = info[i + 1].c;
    const y = (ay + by) / 2;
    bars.push(M.CrossSection.hull([disc(M, w / 2, ax, y, 16), disc(M, w / 2, bx, y, 16)]));
  }
  return M.CrossSection.union(bars).subtract(M.CrossSection.union(info.map((i) => i.counters)));
}

function signedArea(poly: Vec2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Mode "Losse cijfers voor aan de muur". */
function buildWallMode(ctx: Ctx): BuildOutput {
  const { M, p, warnings, tips, info } = ctx;
  const wallD = num(p, 'wallD');
  const H = num(p, 'wallNumH');
  const T = num(p, 'wallT');
  const Rc = wallD / 2 - H / 2;
  if (Rc < 60) throw new UserError('De cijfers zijn te groot voor deze diameter: maak de klok op de muur groter of de cijfers kleiner.');
  const backing = str(p, 'wallBacking');
  const mount = str(p, 'wallMount');
  const radial = str(p, 'numOrient') === 'radial';
  const u = usable(ctx.printer);
  const parts: PartOut[] = [];
  const scene: SceneItem[] = [];
  const S = wallD + 160;
  const lift = S / 2;
  const world = clockToWorld(lift);
  const rows: (string | number)[][] = [];
  const noKeyhole: string[] = [];
  if (mount === 'keyhole' && T < 4.5) warnings.push('Voor een sleutelgat moeten de cijfers minstens 4,5 mm dik zijn; ze krijgen nu een vlakke achterkant voor tape.');

  /** One wall piece: glyph (or marker) with the chosen backing and mounting. */
  const piece = (cs: CrossSection, name: string) => {
    let back = cs;
    const solids: Manifold[] = [cs.extrude(T)];
    if (backing === 'plate') {
      back = cs.offset(num(p, 'wallOutline'), 'Round');
      solids.push(back.extrude(clamp(T * 0.4, 1.6, 3)));
    } else if (backing === 'bridge') {
      const br = bridges(M, cs, H);
      if (br) {
        solids.push(br.extrude(Math.min(2, T * 0.5)));
        back = cs.add(br);
      }
    }
    let solid = solids.length > 1 ? M.Manifold.union(solids) : solids[0];
    if (mount === 'keyhole' && T >= 4.5) {
      // only where the part has its full thickness
      const spot = keyholeSpot(cs);
      if (spot) solid = solid.subtract(keyhole(M, spot[0], spot[1], T));
      else noKeyhole.push(name);
    }
    const b = back.bounds();
    const w = b.max[0] - b.min[0];
    const h = b.max[1] - b.min[1];
    if (!((w <= u.x && h <= u.y) || (h <= u.x && w <= u.y))) throw new UserError(`${name} is ${Math.round(w)} × ${Math.round(h)} mm en past niet op het printbed. Maak de cijfers kleiner.`);
    return { solid, back };
  };

  const placeOnWall = (part: number, angle: number, x: number, y: number) => {
    const rot = radial ? angle - 90 : 0;
    scene.push({ kind: 'part', part, matrix: mul(world, mul(translation(x, y, 0), rotZ(rot))) });
  };

  const { labels, start } = numeralLabels(p);
  const n = labels.length;
  const used: number[] = [];
  const backs: { a: number; cs: CrossSection }[] = [];
  if (usesNumerals(p) && labels.some(Boolean)) {
    const font = ctx.assets.font(fontRef(p));
    const fs = sizeForHeight(font, H);
    labels.forEach((label, i) => {
      if (!label) return;
      const cs = textCross(M, font, label, fs);
      if (cs.isEmpty() || cs.area() < 0.01) return;
      const angle = labelAngle(i, n, start);
      const th = deg(angle);
      const x = Rc * Math.cos(th);
      const y = Rc * Math.sin(th);
      const name = `Cijfer ${label}`;
      const { solid, back } = piece(cs, name);
      backs.push({ a: (90 - angle + 720) % 360, cs: back.rotate(radial ? angle - 90 : 0).translate([x, y]) });
      used.push(angle);
      placeOnWall(parts.length, angle, x, y);
      parts.push({ name, solid });
      rows.push([label, Math.round((((90 - angle) % 360) + 360) % 360), mm(x), mm(y)]);
    });
  }
  // hour markers where there is no numeral
  const style = str(p, 'hourTicks');
  const marker = tickCross(M, style, H * 0.55, Math.max(4, H * 0.12));
  if (marker) {
    const mb = marker.bounds();
    const centred = marker.translate([0, -(mb.min[1] + mb.max[1]) / 2]);
    const free: number[] = [];
    for (let h = 0; h < 12; h++) {
      const a = 90 - 30 * h;
      if (!used.some((ua) => Math.abs((((ua - a) % 360) + 540) % 360 - 180) < 0.5)) free.push(a);
    }
    if (free.length) {
      const name = 'Uurmarkering';
      const { solid } = piece(centred, name);
      const part = parts.length;
      parts.push({ name, solid, quantity: free.length });
      for (const a of free) {
        const th = deg(a);
        const x = Rc * Math.cos(th);
        const y = Rc * Math.sin(th);
        // markers always point at the centre
        scene.push({ kind: 'part', part, matrix: mul(world, mul(translation(x, y, 0), rotZ(a - 90))) });
        backs.push({ a: (90 - a + 720) % 360, cs: centred.rotate(a - 90).translate([x, y]) });
        rows.push(['•', Math.round((((90 - a) % 360) + 360) % 360), mm(x), mm(y)]);
      }
    }
  }
  if (noKeyhole.length) warnings.push(`Te smal voor een sleutelgat (gebruik tape): ${noKeyhole.join(', ')}.`);
  // neighbours on the wall must not touch
  backs.sort((a, b) => a.a - b.a);
  for (let i = 0; i < backs.length && backs.length > 1; i++) {
    const nb = backs[(i + 1) % backs.length];
    if (nb !== backs[i] && backs[i].cs.intersect(nb.cs).area() > 0.5) {
      warnings.push('Cijfers raken elkaar op de muur: maak de klok groter of de cijfers kleiner.');
      break;
    }
  }

  // centre plate that covers the movement
  const cd = num(p, 'centerD');
  const geo = dialGeo(M, p, cd, 0, ctx.assets);
  checkBed(ctx, geo.outline, 'De middenplaat');
  if (geo.ruMin * 2 < MOVEMENT.size * 1.2) tips.push(`Tip: maak de middenplaat minstens ${Math.ceil(MOVEMENT.size * 1.45)} mm zodat het uurwerk (${MOVEMENT.size} mm) er niet achter uitsteekt.`);
  const plate = dialSolid(ctx, geo, null, false, true, 0);
  const plateIdx = parts.length;
  parts.push({ name: 'Middenplaat', solid: plate.faceDown ? plate.solid.rotate([180, 0, 0]) : plate.solid });
  const plateZ = MOVEMENT.depth - plate.pocketDepth;
  scene.push({ kind: 'part', part: plateIdx, matrix: mul(world, mul(translation(0, 0, plateZ), plate.faceDown ? rotX(180) : identity())) });
  scene.push(sceneBox([-MOVEMENT.size / 2, -MOVEMENT.size / 2, 0], [MOVEMENT.size / 2, MOVEMENT.size / 2, MOVEMENT.depth], lift, '#8aa0b8', 'ghost', 'Uurwerk'));
  scene.push(sceneBox([-S / 2, -S / 2, -10], [S / 2, S / 2, 0], lift, '#c9c3b8', 'ghost', 'Muur'));
  let top = plateZ + plate.T + 6;
  if (bool(p, 'wallHands')) {
    const hands = buildHands(M, p, Rc, holeSizes(p), ctx.assets, ctx.printer, warnings);
    const z = handZ(hands, plateZ + plate.T + NUT_ALLOWANCE);
    placeHands(scene, hands, parts.length, world, z);
    for (const h of hands) parts.push({ name: h.name, solid: h.solid });
    top = z.top;
    info.push(handInfo(hands));
    torqueWarnings(hands, warnings, tips);
  }
  scene.push(sceneBox([-MOVEMENT.shaft / 2, -MOVEMENT.shaft / 2, MOVEMENT.depth], [MOVEMENT.shaft / 2, MOVEMENT.shaft / 2, top], lift, '#8aa0b8', 'ghost', 'As'));

  info.push({
    kind: 'kv',
    title: 'Op de muur',
    rows: [
      ['Middelpunt cijfers op', `${Math.round(Rc)} mm van het midden`],
      ['Totale diameter', `ca. ${Math.round(wallD)} mm`],
      ['Middenplaat', `Ø ${Math.round(cd)} mm, ${nl(plate.T, 1)} mm dik`],
      ...shaftInfo(ctx, plate),
    ],
  });
  if (rows.length) {
    info.push({
      kind: 'table',
      title: 'Plaats van de cijfers (vanaf het midden, in mm)',
      headers: ['Cijfer', 'Hoek (°)', 'Rechts (+) / links (−)', 'Omhoog (+) / omlaag (−)'],
      rows,
      csv: [['Cijfer', 'Hoek', 'x (mm)', 'y (mm)'], ...rows].map((r) => r.join(';')).join('\n'),
    });
  }
  tips.push(
    'Ophangen: hang het uurwerk aan een spijker of schroef, zet de middenplaat erop en zet daarna de wijzers vast.',
    `Cijfers plaatsen: teken met een waterpas een kruis door het midden en meet per cijfer de afstanden uit de tabel af. Of gebruik een touwtje van ${Math.round(Rc)} mm vanaf het midden.`,
    mount === 'keyhole' ? 'Sleutelgat: sla een spijkertje met een kop schuin in de muur, haak het cijfer erover en schuif het omlaag.' : 'Plak de cijfers met dubbelzijdig montagetape op de vlakke achterkant.',
  );
  return { parts, scene, defaultView: 'assembly' };
}

/** Mode "Pasproef": small strips with each hole size in a few variants. */
function buildFitMode(ctx: Ctx): BuildOutput {
  const { M, p, info, tips } = ctx;
  const font = ctx.assets.font(FIT_FONT);
  const holes = holeSizes(p);
  const step = num(p, 'fitStep');
  const count = Math.round(num(p, 'fitCount'));
  const deltas = Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * step);
  const T = num(p, 'handT');
  const parts: PartOut[] = [];
  const rows: (string | number)[][] = [];
  const strip = (name: string, title: string, make: (d: number) => FitItem, thickness: number) => {
    const items = deltas.map(make);
    parts.push({ name, solid: fitStrip(M, font, title, items, thickness) });
    rows.push([name, items.map((i) => i.label).join(' · ')]);
  };
  strip('Pasproef uurwijzer', 'UUR', (d) => {
    const v = Math.max(0.6, holes.hour + d);
    return { label: nl(v), hole: holeCross(M, v), size: v };
  }, T);
  strip('Pasproef minutenwijzer', 'MIN', (d) => {
    const v = Math.max(0.6, holes.minute + d);
    return { label: nl(v), hole: holeCross(M, v, clamp(holes.minuteFlat + d, 0.4, v)), size: v };
  }, T);
  if (bool(p, 'seconds')) {
    strip('Pasproef secondewijzer', 'SEC', (d) => {
      const v = Math.max(0.3, holes.second + d);
      return { label: nl(v), hole: holeCross(M, v), size: v };
    }, T);
  }
  if (bool(p, 'fitCenter')) {
    strip('Pasproef middengat', 'AS', (d) => {
      const v = Math.max(2, holes.center + 2 * d);
      return { label: nl(v), hole: holeCross(M, v), size: v };
    }, Math.min(3, num(p, 'dialT')));
  }
  info.push({ kind: 'table', title: 'Pasproef (gatmaten in mm)', headers: ['Strip', 'Gaten'], rows });
  tips.push(
    'Druk elke strip op het uurwerk: kies het gat dat strak maar zonder forceren past (uurwijzer op de uurbuis, minutenwijzer op het asje met de platte kanten).',
    `Past een ander gat beter dan het middelste? Zet "Correctie wijzergaten" op het verschil (stap ${nl(step)} mm), of kies "Eigen maat" en vul de maat in.`,
    'Print de pasproef met dezelfde instellingen en hetzelfde filament als de echte wijzers.',
  );
  return { parts, defaultView: 'plate' };
}

function build(p: Params, { M, assets, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const ctx: Ctx = { M, p, assets, printer, warnings: [], tips: [], info: [] };
  const m = mode(p);
  if (str(p, 'font') === 'upload' && !p.fontFile && textInUse(p) && m !== 'fit') ctx.warnings.push('Upload een lettertypebestand (TTF, OTF of WOFF); tot dan wordt Montserrat gebruikt.');
  const out = m === 'fit' ? buildFitMode(ctx) : m === 'hands' ? buildHandsMode(ctx) : m === 'wall' ? buildWallMode(ctx) : buildDialModes(ctx, m === 'clock');
  const holes = holeSizes(p);
  if (m !== 'dial') {
    ctx.info.unshift({
      kind: 'kv',
      title: 'Uurwerk',
      rows: [
        ['Type', MOVEMENTS[str(p, 'movement')]?.label ?? 'Eigen maat'],
        ['Gat uurwijzer', `Ø ${nl(holes.hour)} mm`],
        ['Gat minutenwijzer', `Ø ${nl(holes.minute)} mm, plat ${nl(holes.minuteFlat)} mm`],
        ['Gat secondewijzer', `Ø ${nl(holes.second)} mm`],
        ...(num(p, 'holeAdjust') !== 0 ? [['Correctie', `${num(p, 'holeAdjust') > 0 ? '+' : ''}${nl(num(p, 'holeAdjust'))} mm`] as [string, string]] : []),
      ],
    });
  }
  if (makesHands(p)) {
    ctx.tips.push(
      'Wijzers: print plat met 0,12–0,16 mm lagen en 100% infill; geen brim. PLA is stijf en licht genoeg.',
      'Monteren: uurwerk achter de plaat, ringetje en zeskantmoer voor. Druk de uurwijzer op 12 uur op de buis, dan de minutenwijzer ook op 12 uur, draai het dopmoertje erop en druk als laatste de secondewijzer op het pinnetje.',
    );
  }
  if (m !== 'hands' && m !== 'fit') ctx.tips.push('Wijzerplaat: PLA, 0,2 mm lagen, 3 wanden en 15% infill is genoeg.');
  if (m === 'clock' || m === 'hands') {
    ctx.tips.push('Oude klok uit elkaar: trek de secondewijzer recht van het pinnetje, draai het dopmoertje los, trek minuten- en uurwijzer eraf en draai de zeskantmoer los. Bewaar het uurwerk, de ring en de moertjes.');
  }
  if (m !== 'dial') ctx.tips.push('Meet de gaten van je oude wijzers met een schuifmaat (uurwijzer rond, minutenwijzer met twee platte kanten), of print eerst de Pasproef.');
  return { ...out, info: [...ctx.info, ...(out.info ?? [])], tips: [...ctx.tips, ...(out.tips ?? [])], warnings: [...ctx.warnings, ...(out.warnings ?? [])] };
}

// ---------------------------------------------------------------------------
// Parameters

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }));
const handsShown = (p: Params) => makesHands(p);
const customMovement = (p: Params) => mode(p) !== 'dial' && str(p, 'movement') === 'custom';

const params: ParamDef[] = [
  {
    type: 'select', key: 'mode', label: 'Wat maak je?', default: 'clock',
    options: [
      { value: 'clock', label: 'Complete klok' },
      { value: 'dial', label: 'Alleen wijzerplaat' },
      { value: 'hands', label: 'Alleen wijzers' },
      { value: 'wall', label: 'Losse cijfers voor aan de muur' },
      { value: 'fit', label: 'Pasproef wijzergaten' },
    ],
  },

  { type: 'group', label: 'Uurwerk' },
  {
    type: 'select', key: 'movement', label: 'Soort uurwerk', default: 'eu', show: (p) => mode(p) !== 'dial',
    help: 'Bepaalt de gaten in de wijzers. Meet je oude wijzers na als je twijfelt.',
    options: [...Object.entries(MOVEMENTS).map(([value, m]) => ({ value, label: m.label })), { value: 'custom', label: 'Eigen maat' }],
  },
  { type: 'number', key: 'hourHole', label: 'Gat uurwijzer', min: 2, max: 10, step: 0.05, unit: 'mm', default: 5.5, show: customMovement },
  { type: 'number', key: 'minuteHole', label: 'Gat minutenwijzer', min: 1.5, max: 8, step: 0.05, unit: 'mm', default: 3.6, show: customMovement },
  { type: 'number', key: 'minuteFlat', label: 'Minutengat tussen de platte kanten', min: 1, max: 8, step: 0.05, unit: 'mm', default: 2.8, show: customMovement },
  { type: 'number', key: 'secondHole', label: 'Gat secondewijzer', min: 0.5, max: 3, step: 0.05, unit: 'mm', default: 1.0, show: customMovement },
  { type: 'number', key: 'holeAdjust', label: 'Correctie wijzergaten', min: -0.4, max: 0.4, step: 0.05, unit: 'mm', default: 0, show: (p) => mode(p) !== 'dial', help: 'Uit de pasproef: + maakt alle wijzergaten ruimer.' },
  { type: 'number', key: 'centerHole', label: 'Gat voor de as (midden)', min: 4, max: 14, step: 0.1, unit: 'mm', default: 8.2, show: (p) => mode(p) !== 'hands', help: 'De schroefdraad van de meeste uurwerken is 7,9 mm (5/16").' },
  { type: 'number', key: 'shaftThread', label: 'Lengte schroefdraad van je uurwerk', min: 0, max: 30, step: 0.5, unit: 'mm', default: 0, show: is('clock', 'dial', 'wall'), help: '0 = weet ik niet. Meet vanaf de voorkant van het uurwerkhuisje.' },

  { type: 'group', label: 'Wijzerplaat', show: (p) => mode(p) !== 'fit' },
  { type: 'number', key: 'diameter', label: 'Diameter', min: 80, max: 320, step: 1, unit: 'mm', default: 220, show: is('clock', 'dial', 'hands'), help: 'Bij "Alleen wijzers": de maat van je bestaande wijzerplaat.' },
  { type: 'number', key: 'centerD', label: 'Diameter middenplaat', min: 60, max: 250, step: 1, unit: 'mm', default: 100, show: is('wall'), help: 'Het plaatje voor het uurwerk, midden op de muur.' },
  ...shapeParams('dial', { shape: 'circle', count: 12, depth: 20, rounding: 50 }, { label: 'Vorm', custom: true, show: usesShape }),
  { type: 'number', key: 'dialRotate', label: 'Vorm draaien', min: -180, max: 180, step: 1, unit: '°', default: 0, show: (p) => usesShape(p) && str(p, 'dialShape') !== 'circle', help: 'Bloemen en sterren staan vanzelf met een blad of punt op 12 uur.' },
  { type: 'number', key: 'dialT', label: 'Dikte plaat', min: 2, max: 12, step: 0.2, unit: 'mm', default: 4, show: usesShape },
  { type: 'number', key: 'edge', label: 'Afronding voorrand', min: 0, max: 3, step: 0.2, unit: 'mm', default: 1, show: usesShape },
  { type: 'bool', key: 'rim', label: 'Opstaande rand', default: false, show: hasDialParams },
  { type: 'number', key: 'rimW', label: 'Breedte rand', min: 1.2, max: 25, step: 0.2, unit: 'mm', default: 5, show: (p) => hasDialParams(p) && bool(p, 'rim') },
  { type: 'number', key: 'rimH', label: 'Hoogte rand', min: 0.4, max: 8, step: 0.2, unit: 'mm', default: 2, show: (p) => hasDialParams(p) && bool(p, 'rim') },
  {
    type: 'select', key: 'pocket', label: 'Uitsparing achterkant', default: 'none', show: usesShape,
    help: 'Voor uurwerken met een korte as: de plaat wordt dunner waar het uurwerk zit.',
    options: [
      { value: 'none', label: 'Geen' },
      { value: 'square', label: 'Vierkant (vorm van het uurwerk)' },
      { value: 'round', label: 'Rond' },
    ],
  },
  { type: 'number', key: 'pocketSize', label: 'Maat uitsparing', min: 30, max: 90, step: 0.5, unit: 'mm', default: 57, show: (p) => usesShape(p) && str(p, 'pocket') !== 'none', help: 'Uurwerken zijn meestal 56 × 56 mm.' },
  { type: 'number', key: 'pocketDepth', label: 'Diepte uitsparing', min: 0.4, max: 10, step: 0.2, unit: 'mm', default: 2, show: (p) => usesShape(p) && str(p, 'pocket') !== 'none' },

  { type: 'group', label: 'Cijfers', show: usesShape },
  {
    type: 'select', key: 'numerals', label: 'Cijfers', default: 'arabic', show: usesShape,
    options: [
      { value: 'arabic', label: '1 – 12' },
      { value: 'roman', label: 'Romeins (I – XII)' },
      { value: 'quarters', label: 'Alleen 12 · 3 · 6 · 9' },
      { value: 'quartersRoman', label: 'Alleen XII · III · VI · IX' },
      { value: 'custom', label: 'Eigen tekst' },
      { value: 'none', label: 'Geen cijfers' },
    ],
  },
  {
    type: 'text', key: 'customLabels', label: 'Eigen labels (met komma\'s)', default: '1,2,3,4,5,6,7,8,9,10,11,12', maxLength: 160,
    placeholder: 'bijv. ☾,2,3,…', help: '12 labels lopen van 1 tot 12; bij een ander aantal staat het eerste label bovenaan. Leeg laten = overslaan.',
    show: (p) => usesShape(p) && str(p, 'numerals') === 'custom',
  },
  { type: 'bool', key: 'romanFour', label: 'IIII in plaats van IV (klassiek)', default: true, show: (p) => usesShape(p) && str(p, 'numerals') === 'roman' },
  {
    type: 'select', key: 'font', label: 'Lettertype', default: DEFAULT_FONT, show: usesNumeralsOrText,
    options: [...FONT_OPTIONS, { value: 'google', label: 'Andere Google Font (typ de naam)' }, { value: 'upload', label: 'Eigen lettertype uploaden' }],
  },
  { type: 'text', key: 'googleFont', label: 'Naam Google Font', default: 'Roboto Slab', maxLength: 60, placeholder: 'bijv. Roboto Slab', help: 'Alle gratis Google Fonts (fonts.google.com). Wordt via internet geladen.', show: (p) => usesNumeralsOrText(p) && str(p, 'font') === 'google' },
  { type: 'select', key: 'googleWeight', label: 'Dikte letter', default: '700', options: WEIGHTS, show: (p) => usesNumeralsOrText(p) && str(p, 'font') === 'google' },
  { type: 'file', key: 'fontFile', label: 'Lettertypebestand', asset: 'font', accept: '.ttf,.otf,.woff', default: '', help: 'TTF, OTF of WOFF.', show: (p) => usesNumeralsOrText(p) && str(p, 'font') === 'upload' },
  { type: 'number', key: 'numSize', label: 'Hoogte cijfers', min: 2, max: 25, step: 0.5, unit: '%', default: 9, show: (p) => hasDialParams(p) && usesNumerals(p), help: 'In procenten van de diameter.' },
  { type: 'number', key: 'numPos', label: 'Afstand tot het midden', min: 30, max: 100, step: 1, unit: '%', default: 76, show: (p) => hasDialParams(p) && usesNumerals(p), help: 'In procenten van de straal (tot het midden van het cijfer).' },
  {
    type: 'select', key: 'numOrient', label: 'Stand van de cijfers', default: 'upright', show: usesNumerals,
    options: [
      { value: 'upright', label: 'Rechtop' },
      { value: 'radial', label: 'Mee met de cirkel' },
    ],
  },
  { type: 'bool', key: 'follow', label: 'Cijfers volgen de vorm', default: true, show: (p) => hasDialParams(p) && usesNumerals(p) && str(p, 'dialShape') !== 'circle', help: 'Uit: de cijfers staan in een cirkel.' },
  {
    type: 'select', key: 'relief', label: 'Cijfers en streepjes', default: 'raised', show: hasDialParams,
    options: [
      { value: 'raised', label: 'Verhoogd (reliëf)' },
      { value: 'engraved', label: 'Verdiept (gegraveerd)' },
    ],
  },
  { type: 'number', key: 'reliefH', label: 'Hoogte / diepte', min: 0.4, max: 4, step: 0.2, unit: 'mm', default: 1.2, show: hasDialParams },

  { type: 'group', label: 'Streepjes', show: (p) => hasDialParams(p) || mode(p) === 'wall' },
  { type: 'select', key: 'hourTicks', label: 'Bij de uren', default: 'line', options: TICK_STYLES, show: (p) => hasDialParams(p) || mode(p) === 'wall', help: 'Bij losse cijfers: markering op de uren zonder cijfer.' },
  { type: 'number', key: 'hourTickL', label: 'Lengte uurstreepjes', min: 1, max: 20, step: 0.5, unit: '%', default: 7, show: (p) => hasDialParams(p) && str(p, 'hourTicks') !== 'none', help: 'In procenten van de straal.' },
  { type: 'number', key: 'hourTickW', label: 'Breedte uurstreepjes', min: 0.4, max: 8, step: 0.1, unit: '%', default: 2.2, show: (p) => hasDialParams(p) && str(p, 'hourTicks') === 'line' },
  { type: 'select', key: 'minuteTicks', label: 'Bij de minuten', default: 'line', options: TICK_STYLES, show: hasDialParams },
  { type: 'number', key: 'minuteTickL', label: 'Lengte minuutstreepjes', min: 0.5, max: 10, step: 0.25, unit: '%', default: 3.5, show: (p) => hasDialParams(p) && (str(p, 'minuteTicks') !== 'none' || bool(p, 'track')) },
  { type: 'number', key: 'minuteTickW', label: 'Breedte minuutstreepjes', min: 0.2, max: 4, step: 0.1, unit: '%', default: 0.8, show: (p) => hasDialParams(p) && (str(p, 'minuteTicks') === 'line' || bool(p, 'track')) },
  { type: 'number', key: 'tickPos', label: 'Buitenkant streepjes', min: 50, max: 100, step: 1, unit: '%', default: 96, show: hasDialParams, help: 'In procenten van de straal.' },
  { type: 'bool', key: 'track', label: 'Minutenspoor (twee ringen)', default: false, show: hasDialParams },
  { type: 'bool', key: 'tickFollow', label: 'Streepjes volgen de vorm', default: true, show: (p) => hasDialParams(p) && str(p, 'dialShape') !== 'circle', help: 'Uit: de streepjes staan in een cirkel.' },
  { type: 'bool', key: 'skipTicks', label: 'Geen streepje bij een cijfer', default: false, show: (p) => hasDialParams(p) && usesNumerals(p) },

  { type: 'group', label: 'Tekst op de wijzerplaat', show: hasDialParams },
  { type: 'text', key: 'label', label: 'Tekst', default: '', maxLength: 40, placeholder: 'bijv. een naam of merk', show: hasDialParams },
  {
    type: 'select', key: 'labelPos', label: 'Plaats', default: 'top', show: (p) => hasDialParams(p) && str(p, 'label').trim() !== '',
    options: [
      { value: 'top', label: 'Boven het midden' },
      { value: 'bottom', label: 'Onder het midden' },
    ],
  },
  { type: 'number', key: 'labelSize', label: 'Hoogte tekst', min: 1, max: 12, step: 0.5, unit: '%', default: 4, show: (p) => hasDialParams(p) && str(p, 'label').trim() !== '', help: 'In procenten van de diameter.' },

  { type: 'group', label: 'Wijzers', show: handsShown },
  { type: 'select', key: 'handStyle', label: 'Model', default: 'spade', options: HAND_STYLES, show: handsShown },
  { type: 'file', key: 'handFile', label: 'SVG van de wijzer', asset: 'shape', accept: '.svg,image/svg+xml', default: '', help: 'Teken de wijzer naar boven wijzend; het draaipunt zit onderaan in het midden.', show: (p) => handsShown(p) && str(p, 'handStyle') === 'custom' },
  { type: 'number', key: 'pivot', label: 'Draaipunt boven de onderkant', min: 0, max: 60, step: 1, unit: '%', default: 0, show: (p) => handsShown(p) && str(p, 'handStyle') === 'custom', help: 'Schuif het draaipunt omhoog als je tekening een staartje heeft.' },
  { type: 'number', key: 'hourLen', label: 'Lengte uurwijzer', min: 20, max: 100, step: 1, unit: '%', default: 55, show: handsShown, help: 'In procenten van de straal.' },
  { type: 'number', key: 'minLen', label: 'Lengte minutenwijzer', min: 30, max: 110, step: 1, unit: '%', default: 85, show: handsShown },
  { type: 'number', key: 'handW', label: 'Breedte', min: 1.5, max: 20, step: 0.5, unit: 'mm', default: 6, show: handsShown, help: 'Van de uurwijzer; de minutenwijzer is iets smaller.' },
  { type: 'number', key: 'tail', label: 'Staartje (tegengewicht)', min: 0, max: 40, step: 1, unit: '%', default: 16, show: (p) => handsShown(p) && str(p, 'handStyle') !== 'custom' },
  { type: 'number', key: 'hubD', label: 'Diameter naaf', min: 6, max: 30, step: 0.5, unit: 'mm', default: 11, show: handsShown },
  { type: 'number', key: 'handT', label: 'Dikte', min: 0.8, max: 3, step: 0.1, unit: 'mm', default: 1.6, show: (p) => handsShown(p) || mode(p) === 'fit' },
  { type: 'number', key: 'minHubT', label: 'Dikte bij het minutenasje', min: 0.6, max: 3, step: 0.1, unit: 'mm', default: 1.2, show: handsShown, help: 'Verzonken rond het gat, zodat het dopmoertje nog op de schroefdraad past.' },
  { type: 'bool', key: 'seconds', label: 'Secondewijzer', default: true, show: (p) => handsShown(p) || mode(p) === 'fit' },
  { type: 'number', key: 'secLen', label: 'Lengte secondewijzer', min: 30, max: 110, step: 1, unit: '%', default: 90, show: (p) => handsShown(p) && bool(p, 'seconds') },
  {
    type: 'select', key: 'secStyle', label: 'Model secondewijzer', default: 'needle', show: (p) => handsShown(p) && bool(p, 'seconds'),
    options: [
      { value: 'needle', label: 'Naald' },
      { value: 'lolly', label: 'Met bolletje' },
      { value: 'ring', label: 'Met ringetje' },
    ],
  },

  { type: 'group', label: 'Op de muur', show: is('wall') },
  { type: 'number', key: 'wallD', label: 'Diameter klok op de muur', min: 250, max: 2000, step: 10, unit: 'mm', default: 600, show: is('wall'), help: 'Tot de buitenkant van de cijfers.' },
  { type: 'number', key: 'wallNumH', label: 'Hoogte cijfers', min: 15, max: 200, step: 1, unit: 'mm', default: 60, show: is('wall') },
  { type: 'number', key: 'wallT', label: 'Dikte cijfers', min: 2, max: 20, step: 0.5, unit: 'mm', default: 6, show: is('wall') },
  {
    type: 'select', key: 'wallBacking', label: 'Achterkant', default: 'bridge', show: is('wall'),
    options: [
      { value: 'none', label: 'Alleen het cijfer' },
      { value: 'bridge', label: 'Cijfers als één stuk (bruggetje achter)' },
      { value: 'plate', label: 'Op een plaatje met rand' },
    ],
  },
  { type: 'number', key: 'wallOutline', label: 'Rand rond het cijfer', min: 1, max: 15, step: 0.5, unit: 'mm', default: 4, show: (p) => mode(p) === 'wall' && str(p, 'wallBacking') === 'plate' },
  {
    type: 'select', key: 'wallMount', label: 'Ophangen', default: 'tape', show: is('wall'),
    options: [
      { value: 'tape', label: 'Vlakke achterkant (dubbelzijdig tape)' },
      { value: 'keyhole', label: 'Sleutelgat (spijkertje)' },
    ],
  },
  { type: 'bool', key: 'wallHands', label: 'Wijzers erbij', default: true, show: is('wall') },

  { type: 'group', label: 'Pasproef', show: is('fit') },
  { type: 'number', key: 'fitStep', label: 'Stap tussen de gaten', min: 0.05, max: 0.3, step: 0.05, unit: 'mm', default: 0.1, show: is('fit') },
  { type: 'number', key: 'fitCount', label: 'Aantal maten per gat', min: 3, max: 7, step: 2, default: 5, show: is('fit') },
  { type: 'bool', key: 'fitCenter', label: 'Ook het middengat (as)', default: true, show: is('fit') },
];

function usesNumeralsOrText(p: Params) {
  return usesNumerals(p) || (hasDialParams(p) && str(p, 'label').trim() !== '');
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rnd = (a: number, b: number, step = 1) => Math.round((a + Math.random() * (b - a)) / step) * step;

export const clockTool: ToolDef = {
  id: 'klok',
  name: 'Klokken',
  short: 'Klokken',
  icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  description: 'Eigen wijzerplaten, cijfers en wijzers voor standaard quartz-uurwerken: haal een oude klok uit elkaar en geef hem een nieuw gezicht.',
  params,
  presets: [
    {
      name: 'Klassiek Romeins',
      values: {
        mode: 'clock', diameter: 260, font: 'bundled:cinzel', numerals: 'roman', romanFour: true, numOrient: 'radial', numSize: 9, numPos: 76,
        rim: true, rimW: 6, rimH: 2.4, hourTicks: 'line', hourTickL: 6, hourTickW: 1.6, minuteTicks: 'line', minuteTickL: 3.5, tickPos: 97, track: true,
        handStyle: 'breguet', handW: 6, hourLen: 52, minLen: 82, secStyle: 'ring', secLen: 86,
      },
    },
    {
      name: 'Modern minimal',
      values: {
        mode: 'clock', diameter: 220, font: 'bundled:montserrat', numerals: 'quarters', numSize: 11, numPos: 74, hourTicks: 'line', hourTickL: 9, hourTickW: 2.4,
        minuteTicks: 'none', skipTicks: true, handStyle: 'baton', handW: 5, tail: 14, edge: 1.6, secStyle: 'needle',
      },
    },
    {
      name: 'Bloemklok',
      values: {
        mode: 'clock', diameter: 240, dialShape: 'petals', dialCount: 12, dialDepth: 18, dialRounding: 60, font: 'bundled:comfortaa', numerals: 'arabic',
        numSize: 9, numPos: 80, follow: true, tickFollow: false, hourTicks: 'none', minuteTicks: 'dot', minuteTickL: 2.5, tickPos: 66, handStyle: 'leaf', handW: 7, secStyle: 'lolly',
      },
    },
    {
      name: 'Kinderkamer blob klok',
      values: {
        mode: 'clock', diameter: 230, dialShape: 'blob', dialCount: 3, dialDepth: 14, dialSeed: 12, font: 'bundled:fredoka', numerals: 'arabic', numSize: 11,
        numPos: 74, hourTicks: 'dot', hourTickL: 8, tickPos: 95, minuteTicks: 'none', handStyle: 'lolly', handW: 8, hourLen: 50, minLen: 78,
        label: 'TIK TAK', labelPos: 'bottom', labelSize: 6, reliefH: 1.6, seconds: false,
      },
    },
    {
      name: 'Art deco (gegraveerd)',
      values: {
        mode: 'clock', diameter: 240, dialShape: 'polygon', dialCount: 8, dialRounding: 25, font: 'bundled:righteous', numerals: 'arabic', numSize: 10, numPos: 74,
        relief: 'engraved', reliefH: 1.0, hourTicks: 'diamond', hourTickL: 7, minuteTicks: 'none', handStyle: 'diamond', handW: 7, tail: 10, secStyle: 'needle',
      },
    },
    {
      name: 'Losse cijfers wandklok',
      values: {
        mode: 'wall', font: 'bundled:dm-serif-display', numerals: 'quarters', wallD: 600, wallNumH: 70, wallT: 6, wallBacking: 'bridge', wallMount: 'tape',
        hourTicks: 'dot', centerD: 100, dialT: 4, handStyle: 'baton', handW: 7, tail: 12, hourLen: 55, minLen: 82, seconds: false,
      },
    },
    {
      name: 'Alleen wijzers (vervanging)',
      values: { mode: 'hands', diameter: 250, movement: 'eu', handStyle: 'spade', handW: 6, hourLen: 55, minLen: 85, seconds: true, secStyle: 'needle' },
    },
    {
      name: 'Pasproef wijzergaten',
      values: { mode: 'fit', movement: 'eu', fitStep: 0.1, fitCount: 5, fitCenter: true, seconds: true },
    },
  ],
  randomize: () => {
    const shape = pick(['circle', 'circle', 'squircle', 'polygon', 'petals', 'flower', 'scallop', 'cloud', 'blob', 'gear', 'clover']);
    const numerals = pick(['arabic', 'arabic', 'roman', 'quarters', 'quartersRoman', 'none']);
    return {
      dialShape: shape,
      dialCount: shape === 'polygon' ? pick([6, 8, 12]) : shape === 'blob' || shape === 'cloud' ? rnd(3, 7) : pick([6, 8, 12, 12, 24]),
      dialDepth: rnd(8, 30),
      dialRounding: rnd(20, 90),
      dialSeed: rnd(1, 999),
      font: pick(FONT_OPTIONS).value,
      numerals,
      numOrient: pick(['upright', 'upright', 'radial']),
      numSize: rnd(7, 13, 0.5),
      numPos: rnd(70, 80),
      hourTicks: pick(['line', 'dot', 'triangle', 'diamond', 'none']),
      minuteTicks: pick(['none', 'line', 'dot']),
      track: Math.random() < 0.25,
      relief: Math.random() < 0.75 ? 'raised' : 'engraved',
      rim: Math.random() < 0.3,
      handStyle: pick(HAND_STYLES.filter((s) => s.value !== 'custom')).value,
      handW: rnd(4, 9, 0.5),
      secStyle: pick(['needle', 'lolly', 'ring']),
    };
  },
  assets,
  build,
};
