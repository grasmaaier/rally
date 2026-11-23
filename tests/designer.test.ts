import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { defaultsOf, type ParamDef, type Params } from '../src/core/types';
import { lampTool } from '../src/tools/lamp';
import { KAP_OPTIONS, SHAPE_OPTIONS } from '../src/tools/lampParts';
import {
  DesignError, LAMP, MANAGED_KEYS, MAX_SEGMENTS, SLOT_FIELDS, defsFor, deleteSegment, duplicateSegment, globalEntries, insertSegment, moveSegment, parseSel,
  permuteSegments, sameSel, segmentCount, selKey, selValid, slotKey, toggleFlip, type Sel,
} from '../src/designer/lampModel';
import { History } from '../src/designer/history';
import { decodeHash, decodeParams, encodeHash, encodeParams } from '../src/designer/share';
import { dragValue, elementProfile, handlesFor, numberDef, profilePoints } from '../src/designer/handles';
import { Library, type KV } from '../src/designer/library';
import { outlineOrder } from '../src/designer/designer';
import { dropSlot, nodeGraph } from '../src/designer/nodes';
import { shapeIconPath } from '../src/designer/icons';
import { selectKind } from '../src/designer/controls';
import { buildTool } from './helpers';

const defs = lampTool.params;
const base = defaultsOf(defs);
const lamp = (v: Partial<Params> = {}) => ({ ...base, ...v }) as Params;

/** The values of one slot, for comparing segments wherever they moved. */
const slotData = (p: Params, s: number) => SLOT_FIELDS.map((f) => p[slotKey(s, f)]).join('|');
const stack = (p: Params) => Array.from({ length: segmentCount(p) }, (_, i) => slotData(p, i + 1));

function permutations(n: number): number[][] {
  if (n === 1) return [[1]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) for (let i = 0; i <= rest.length; i++) out.push([...rest.slice(0, i), n, ...rest.slice(i)]);
  return out;
}

describe('lamp model: reorder, insert, delete', () => {
  it('applies every permutation of four segments and its inverse', () => {
    const p = lamp({ count: 4 });
    const before = stack(p);
    for (const order of permutations(4)) {
      const q = permuteSegments(p, order);
      expect(stack(q)).toEqual(order.map((from) => before[from - 1]));
      const inverse = order.map((_, k) => order.indexOf(k + 1) + 1);
      expect(stack(permuteSegments(q, inverse))).toEqual(before);
    }
    expect(() => permuteSegments(p, [1, 1, 2, 3])).toThrow();
    expect(() => permuteSegments(p, [1, 2, 3])).toThrow();
  });

  it('moves a segment to every position and back', () => {
    for (let n = 1; n <= MAX_SEGMENTS; n++) {
      const p = lamp({ count: n });
      const before = stack(p);
      for (let from = 1; from <= n; from++)
        for (let to = 1; to <= n; to++) {
          const q = moveSegment(p, from, to);
          const want = [...before];
          const [x] = want.splice(from - 1, 1);
          want.splice(to - 1, 0, x);
          expect(stack(q)).toEqual(want);
          expect(stack(moveSegment(q, to, from))).toEqual(before);
          expect(segmentCount(q)).toBe(n);
        }
      // out of range: clamped or ignored, never broken
      expect(stack(moveSegment(p, 0, 2))).toEqual(before);
      expect(stack(moveSegment(p, 1, 99)).length).toBe(n);
    }
  });

  it('inserts at every position and deletes back to the original', () => {
    for (let n = 1; n < MAX_SEGMENTS; n++) {
      const p = lamp({ count: n });
      const before = stack(p);
      for (let at = 1; at <= n + 1; at++) {
        const q = insertSegment(p, at, 'kegel');
        expect(segmentCount(q)).toBe(n + 1);
        expect(q[slotKey(at, 'Shape')]).toBe('kegel');
        const rest = stack(q);
        rest.splice(at - 1, 1);
        expect(rest).toEqual(before);
        expect(stack(deleteSegment(q, at))).toEqual(before);
      }
    }
  });

  it('enforces 1..8 segments with DesignErrors', () => {
    const full = lamp({ count: MAX_SEGMENTS });
    expect(() => insertSegment(full, 1, 'bol')).toThrow(DesignError);
    expect(() => duplicateSegment(full, 2)).toThrow(DesignError);
    expect(() => deleteSegment(lamp({ count: 1 }), 1)).toThrow(DesignError);
    // unknown shapes fall back to a cylinder instead of breaking the build
    expect(insertSegment(lamp({ count: 2 }), 1, 'nope')[slotKey(1, 'Shape')]).toBe('cilinder');
  });

  it('duplicates below itself and flips', () => {
    const p = lamp({ count: 3 });
    const q = duplicateSegment(p, 2);
    expect(segmentCount(q)).toBe(4);
    expect(slotData(q, 3)).toBe(slotData(p, 2));
    expect(slotData(q, 4)).toBe(slotData(p, 3));
    expect(toggleFlip(p, 1)[slotKey(1, 'Flip')]).toBe(!p[slotKey(1, 'Flip')]);
  });

  it('gives every lamp parameter (but the count) to exactly one inspector', () => {
    const sels: Sel[] = [LAMP, { kind: 'tube' }, { kind: 'socket' }, { kind: 'layers' }, { kind: 'closed' }, { kind: 'base' }, { kind: 'canopy' }, ...Array.from({ length: MAX_SEGMENTS }, (_, i) => ({ kind: 'seg', slot: i + 1 }) as Sel)];
    for (const d of defs) {
      if (d.type === 'group' || MANAGED_KEYS.has(d.key)) continue;
      const owners = sels.filter((s) => defsFor(s, defs).some((x) => x.type !== 'group' && x.key === d.key));
      expect(owners.map(selKey), d.key).toHaveLength(1);
    }
  });

  it('parses selection ids safely', () => {
    expect(parseSel('seg:3')).toEqual({ kind: 'seg', slot: 3 });
    for (const bad of ['seg:0', 'seg:9', 'seg:x', 'foo', '', null, undefined]) expect(parseSel(bad)).toEqual(LAMP);
    expect(sameSel(parseSel('base'), { kind: 'base' })).toBe(true);
    expect(selValid({ kind: 'base' }, lamp({ lampType: 'pendant' }))).toBe(false);
    expect(selValid({ kind: 'canopy' }, lamp({ lampType: 'pendant' }))).toBe(true);
    expect(selValid({ kind: 'seg', slot: 5 }, lamp({ count: 4 }))).toBe(false);
  });

  it('lists every element once in the outliner and the node graph', () => {
    for (const v of [{}, { lampType: 'pendant' }, { count: 8 }, { count: 1 }, { s1Shape: 'kap', lampType: 'pendant', layers: '2' }] as Partial<Params>[]) {
      const p = lamp(v);
      const keys = outlineOrder(p).map(selKey);
      expect(new Set(keys).size).toBe(keys.length);
      for (let s = 1; s <= segmentCount(p); s++) expect(keys).toContain(`seg:${s}`);
      for (const g of globalEntries(p)) expect(keys).toContain(g);
      const g = nodeGraph(p);
      const ids = new Set(g.nodes.map((n) => n.id));
      expect(ids.size).toBe(g.nodes.length);
      for (const e of g.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    }
    const p = lamp({ count: 4 });
    expect(dropSlot(p, 1, -100)).toBe(1);
    expect(dropSlot(p, 1, 10000)).toBe(4);
    expect(dropSlot(p, 4, 0)).toBe(1);
  });
});

describe('undo history', () => {
  it('coalesces a drag into one step and seals it', () => {
    const h = new History<number>(0);
    h.record(1, 'a');
    h.record(2, 'a');
    h.record(3, 'a');
    h.seal();
    h.record(4, 'a');
    expect(h.current).toBe(4);
    expect(h.undo()).toBe(3);
    expect(h.undo()).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe(3);
    expect(h.redo()).toBe(4);
    expect(h.canRedo).toBe(false);
  });

  it('does not merge different keys or keyless changes, and drops the redo branch', () => {
    const h = new History<string>('x');
    h.record('a', 'k1');
    h.record('b', 'k2');
    h.record('c', null);
    h.record('d', null);
    expect(h.undo()).toBe('c');
    h.record('e', null);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBe('x');
    expect(h.undo()).toBeNull();
  });

  it('keeps at most `limit` steps and resets', () => {
    const h = new History<number>(0, 5);
    for (let i = 1; i <= 20; i++) h.record(i);
    let n = 0;
    while (h.undo() !== null) n++;
    expect(n).toBe(5);
    h.reset(42);
    expect(h.current).toBe(42);
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});

describe('share links', () => {
  it('round-trips designs through the URL', () => {
    const designs = [base, lamp({ lampType: 'pendant', count: 6, s1Shape: 'kap', s1D: 222, s3Flip: true, shadeWall: 1.6 }), ...lampTool.presets!.map((p) => lamp(p.values))];
    for (const p of designs) {
      const hash = encodeHash('lamp', defs, p);
      const d = decodeHash(hash, { lamp: lampTool });
      expect(d?.toolId).toBe('lamp');
      const back = d!.params ?? base;
      for (const def of defs) if (def.type !== 'group') expect(back[def.key], def.key).toEqual(p[def.key]);
    }
    expect(encodeParams(defs, base)).toBe('');
    expect(decodeHash('#lamp', { lamp: lampTool })).toEqual({ toolId: 'lamp', params: null });
  });

  it('ignores bad values, unknown keys and unknown tools', () => {
    const p = decodeParams(defs, 's1Shape=raket&s1D=abc&s2Flip=misschien&count=1e9&evil=1&s3Color=%23123456');
    expect(p.s1Shape).toBe(base.s1Shape);
    expect(p.s1D).toBe(base.s1D);
    expect(p.s2Flip).toBe(base.s2Flip);
    expect(Number(p.count)).toBeLessThanOrEqual(2 * MAX_SEGMENTS);
    expect('evil' in p).toBe(false);
    expect(p.s3Color).toBe(base.s3Color);
    expect(decodeHash('#nope?x=1', { lamp: lampTool })).toBeNull();
    expect(decodeHash('', { lamp: lampTool })).toBeNull();
  });
});

describe('drag handles', () => {
  const def = { min: 4, max: 300, step: 1 };

  it('maps pointer travel to clamped, stepped values; Shift snaps', () => {
    expect(dragValue(def, 40, 10, 1)).toBe(50);
    expect(dragValue(def, 40, 10.4, 1)).toBe(50);
    expect(dragValue(def, 40, -1000, 1)).toBe(4);
    expect(dragValue(def, 40, 1000, 1)).toBe(300);
    expect(dragValue(def, 40, 7, 1, 5)).toBe(45);
    expect(dragValue(def, 40, 3, 2, 5)).toBe(45);
    expect(dragValue({ min: 0.8, max: 3, step: 0.1 }, 1.2, 0.33, 1)).toBe(1.5);
    expect(dragValue(def, 40, Number.NaN, 1)).toBe(40);
  });

  it('has height and diameter handles for every shape, inside the parameter range', () => {
    for (const lampType of ['table', 'pendant']) {
      for (const o of SHAPE_OPTIONS) {
        const kaps = o.value === 'kap' ? KAP_OPTIONS.map((k) => k.value) : ['koepel'];
        for (const kap of kaps)
          for (const v of [0, 50, 100]) {
            const p = lamp({ lampType, count: 1, s1Shape: o.value, s1Kap: kap, s1Var: v, s1Flip: v === 50 });
            const eh = handlesFor({ kind: 'seg', slot: 1 }, p)!;
            const ids = eh.handles.map((h) => h.id);
            expect(ids).toContain('height');
            expect(ids).toContain('diameter');
            for (const h of eh.handles) {
              expect(numberDef(defs, h.key), h.key).not.toBeNull();
              expect(Number.isFinite(h.r) && Number.isFinite(h.z) && Number.isFinite(h.perMm)).toBe(true);
              expect(h.z).toBeGreaterThanOrEqual(-1e-6);
              expect(h.z).toBeLessThanOrEqual(eh.H + 1e-6);
              expect(h.r).toBeGreaterThanOrEqual(0);
            }
            const prof = elementProfile(p, 1);
            if (o.value === 'stijlen') expect(prof).toBeNull();
            else for (const [r, z] of profilePoints(prof!)) expect(Number.isFinite(r) && Number.isFinite(z) && r >= 0).toBe(true);
          }
      }
    }
  });

  it('moves the variant handle outward when the variant grows (where it means a radius)', () => {
    for (const shape of ['bol', 'kegel', 'koepel', 'tol', 'diabolo', 'trap']) {
      const at = (v: number) => handlesFor({ kind: 'seg', slot: 1 }, lamp({ count: 1, s1Shape: shape, s1Var: v }))!.handles.find((h) => h.id === 'variant')!;
      expect(at(80).r, shape).toBeGreaterThan(at(20).r);
      expect(at(20).perMm, shape).toBeGreaterThan(0);
    }
    for (const shape of ['cilinder', 'kussen', 'bloem', 'tandwiel', 'lamel']) {
      const at = (v: number) => handlesFor({ kind: 'seg', slot: 1 }, lamp({ count: 1, s1Shape: shape, s1Var: v }))!.handles.find((h) => h.id === 'variant')!;
      expect(at(80).r, shape).toBeLessThan(at(20).r);
      expect(at(20).perMm, shape).toBeLessThan(0);
    }
  });

  it('offers base and canopy handles only where they exist', () => {
    expect(handlesFor({ kind: 'base' }, lamp())!.handles.map((h) => h.key)).toEqual(['baseH', 'baseD']);
    expect(handlesFor({ kind: 'base' }, lamp({ lampType: 'pendant' }))).toBeNull();
    expect(handlesFor({ kind: 'canopy' }, lamp({ lampType: 'pendant' }))!.handles.map((h) => h.key)).toEqual(['canopyH', 'canopyD']);
    expect(handlesFor({ kind: 'canopy' }, lamp({ lampType: 'pendant', canopy: false }))).toBeNull();
    expect(handlesFor(LAMP, lamp())).toBeNull();
  });
});

describe('library', () => {
  class MemKV implements KV {
    data = new Map<string, string>();
    full = false;
    getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      if (this.full && v.includes('data:image')) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      this.data.set(k, v);
    }
    removeItem(k: string) {
      this.data.delete(k);
    }
  }

  it('saves, lists newest first, renames and removes', () => {
    let t = 1000;
    const lib = new Library(new MemKV(), 'lib', () => t++);
    const a = lib.save({ name: ' Eerste ', tool: 'lamp', params: base });
    const b = lib.save({ name: '', tool: 'lamp', params: lamp({ count: 2 }) });
    lib.save({ name: 'Vaas', tool: 'vase', params: { h: 1 } });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.design.name).toBe('Eerste');
    expect(b.design.name).toBe('Naamloos ontwerp');
    expect(lib.list('lamp').map((d) => d.id)).toEqual([b.design.id, a.design.id]);
    expect(lib.list().length).toBe(3);
    expect(lib.rename(a.design.id, 'Nieuw')).toBe(true);
    expect(lib.get(a.design.id)?.name).toBe('Nieuw');
    expect(lib.list('lamp')[0].id).toBe(a.design.id);
    expect(lib.remove(b.design.id)).toBe(true);
    expect(lib.remove(b.design.id)).toBe(false);
    expect(lib.get(b.design.id)).toBeNull();
  });

  it('survives a full quota, corrupt data and missing storage', () => {
    const kv = new MemKV();
    const lib = new Library(kv, 'lib');
    kv.full = true;
    const r = lib.save({ name: 'x', tool: 'lamp', params: base, thumb: 'data:image/jpeg;base64,AAAA' });
    expect(r.ok && r.withoutThumb).toBe(true);
    kv.data.set('lib', '{not json');
    expect(lib.list()).toEqual([]);
    kv.data.set('lib', JSON.stringify([{ id: 1 }, { id: 'a', name: 'ok', tool: 'lamp', params: { a: 1 }, updated: 1 }]));
    expect(lib.list().map((d) => d.id)).toEqual(['a']);
    const none = new Library(null);
    expect(none.list()).toEqual([]);
    expect(none.save({ name: 'x', tool: 'lamp', params: base }).ok).toBe(false);
  });
});

describe('icons and controls', () => {
  it('draws a finite icon for every shape and shade', () => {
    for (const o of SHAPE_OPTIONS) {
      const d = shapeIconPath(o.value);
      expect(d.startsWith('M') && d.length > 20, o.value).toBe(true);
      expect(d).not.toMatch(/NaN|Infinity|undefined/);
    }
    for (const k of KAP_OPTIONS) expect(shapeIconPath('kap', k.value)).not.toMatch(/NaN|Infinity/);
  });

  it('shows colours as swatches and shapes as tiles', () => {
    const sel = (key: string) => defs.find((d): d is Extract<ParamDef, { type: 'select' }> => d.type === 'select' && d.key === key)!;
    expect(selectKind(sel('s1Color'))).toBe('swatch');
    // colours with an "automatic" choice first
    expect(selectKind(sel('capColor'))).toBe('swatch');
    expect(selectKind(sel('cupColor'))).toBe('swatch');
    expect(selectKind(sel('kl2Color'))).toBe('swatch');
    expect(selectKind(sel('s1Shape'))).toBe('shape');
    expect(selectKind(sel('s1Kap'))).toBe('kap');
    expect(selectKind(sel('lampType'))).toBe('text');
    expect(selectKind(sel('bulb27'))).toBe('dropdown');
  });
});

describe('click-to-select mapping', () => {
  let M: ManifoldToplevel;
  beforeAll(async () => {
    M = await initManifold();
  });
  afterEach(() => collect());

  it('maps every part of every lamp preset to a valid element', async () => {
    const designs: [string, Params][] = [
      ['standaard', base],
      ['hanglamp', lamp({ lampType: 'pendant' })],
      ['pasproef', lamp({ fitTest: true })],
      ['M10', lamp({ connection: 'm10', lampType: 'pendant' })],
      ['dichte tafellamp', lamp({ count: 2, s1Shape: 'kap', s1Kap: 'koepel', s1D: 220, s1H: 110, closed: true, socket: 'e14', bulb14: 'g45' })],
      ['dichte tafellamp met opening', lamp({ count: 2, s1Shape: 'kap', s1Kap: 'koepel', s1D: 220, s1H: 110, closed: true, closedShape: 'binnen', socket: 'e14', bulb14: 'g45' })],
      ['dichte hanglamp, gaatjes, M10', lamp({ connection: 'm10', lampType: 'pendant', count: 2, s1Shape: 'cilinder', s1D: 50, s1H: 30, s2Shape: 'kap', s2Kap: 'koepel', s2D: 220, s2H: 110, closed: true, vent: 'gaatjes' })],
      ['geribbelde koker in lagen (tafel)', lamp({ count: 2, s1Shape: 'kap', s1Kap: 'geribbeld', s1D: 180, s1H: 120, s1Scallop: 15, s2Shape: 'hals', s2D: 26, layers: '2', kl2Mat: 'mat', socket: 'e14', bulb14: 'g45' })],
      ['hoge ribbelring', lamp({ lampType: 'pendant', count: 2, s1Shape: 'ribring', s1D: 140, s1H: 60, s1Mat: 'mat', s2Shape: 'schijf', capColor: '#c8352e', cupColor: '#2f5aa8' })],
      ...lampTool.presets!.map((p) => [p.name, lamp(p.values)] as [string, Params]),
    ];
    for (const [name, p] of designs) {
      const res = await buildTool(M, lampTool, p);
      expect(res.parts.length, name).toBeGreaterThan(0);
      for (const part of res.parts) {
        expect(part.select, `${name}: ${part.name}`).toBeTruthy();
        const s = parseSel(part.select);
        expect(selKey(s), `${name}: ${part.name} → ${part.select}`).toBe(part.select);
        expect(selValid(s, p), `${name}: ${part.name} → ${part.select}`).toBe(true);
      }
      // every segment can be picked in the viewport (the fit test has no segments)
      if (p.fitTest !== true) for (let i = 1; i <= segmentCount(p); i++) expect(res.parts.some((q) => q.select === `seg:${i}`), `${name}: segment ${i}`).toBe(true);
    }
  });
});
