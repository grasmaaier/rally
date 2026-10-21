import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { strFromU8, unzipSync } from 'fflate';
import {
  DEFAULT_FILAMENT,
  FILAMENTS,
  FILAMENT_MAP,
  estimateGrams,
  gramsToMetres,
  isTranslucent,
  nearestColor,
  printedVolume,
  resolveFilament,
  shoppingList,
  shoppingText,
  type ResolvedFilament,
  type UsageItem,
} from '../src/core/filaments';
import { PRINTERS } from '../src/core/printer';
import { build3MF } from '../src/core/export';
import { defaultsOf } from '../src/core/types';
import { initManifold } from '../src/core/manifold';
import { lampTool } from '../src/tools/lamp';
import { vaseTool } from '../src/tools/vase';
import { buildTool } from './helpers';

const printer = (id: string) => PRINTERS.find((p) => p.id === id)!;
const fil = (line: string, color?: string): ResolvedFilament => resolveFilament({ line, color });
const item = (name: string, grams: number, f: ResolvedFilament, extra: Partial<UsageItem> = {}): UsageItem => ({ name, quantity: 1, grams, filament: f, estimate: 'solid', ...extra });

describe('filamentcatalogus', () => {
  it('unieke ids, geldige kleuren en zinnige dichtheden', () => {
    expect(new Set(FILAMENTS.map((f) => f.id)).size).toBe(FILAMENTS.length);
    expect(new Set(FILAMENTS.map((f) => f.name)).size).toBe(FILAMENTS.length);
    for (const f of FILAMENTS) {
      expect(f.density, f.name).toBeGreaterThan(0.95);
      expect(f.density, f.name).toBeLessThan(1.5);
      expect(f.spoolGrams).toBeGreaterThanOrEqual(500);
      expect(f.priceEur).toBeGreaterThan(5);
      expect(f.priceEur).toBeLessThan(150);
      expect(f.colors.length, f.name).toBeGreaterThan(0);
      expect(f.colors.length, f.name).toBeLessThanOrEqual(24);
      expect(f.uses.length).toBeGreaterThan(10);
      expect(new Set(f.colors.map((c) => c.code)).size, `${f.name} codes`).toBe(f.colors.length);
      expect(new Set(f.colors.map((c) => c.name)).size, `${f.name} namen`).toBe(f.colors.length);
      for (const c of f.colors) {
        expect(c.hex, `${f.name} ${c.name}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(c.code).toMatch(/^\d{5}$/);
      }
    }
  });

  it('bevat de gevraagde Bambu Lab-lijnen', () => {
    for (const id of ['pla-basic', 'pla-matte', 'pla-silk-plus', 'pla-translucent', 'pla-galaxy', 'pla-sparkle', 'pla-marble', 'pla-wood', 'petg-hf', 'petg-translucent', 'petg-cf', 'abs', 'asa', 'tpu-95a-hf', 'tpu-for-ams', 'pc', 'paht-cf', 'support-pla-petg'])
      expect(FILAMENT_MAP[id], id).toBeDefined();
    expect(DEFAULT_FILAMENT.id).toBe('pla-basic');
  });

  it('dichtheden uit de Bambu-datasheets', () => {
    expect(FILAMENT_MAP['pla-basic'].density).toBe(1.24);
    expect(FILAMENT_MAP['abs'].density).toBe(1.05);
    expect(FILAMENT_MAP['asa'].density).toBe(1.05);
    expect(FILAMENT_MAP['pc'].density).toBe(1.2);
  });

  it('doorschijnend: hele lijn of losse kleur', () => {
    expect(isTranslucent(fil('pla-translucent'))).toBe(true);
    expect(isTranslucent(fil('petg-translucent'))).toBe(true);
    expect(isTranslucent(fil('pla-basic'))).toBe(false);
    expect(isTranslucent(fil('pc', '60100'))).toBe(false);
    expect(isTranslucent(fil('pc', '60103'))).toBe(true);
    expect(fil('petg-translucent', '32101').color.clear).toBe(true);
  });

  it('onbekende keuze valt terug op een geldige rol', () => {
    expect(fil('bestaat-niet').line.id).toBe('pla-basic');
    expect(fil('pla-matte', 'xxx').color).toBe(FILAMENT_MAP['pla-matte'].colors[0]);
  });

  it('dichtstbijzijnde kleur', () => {
    expect(nearestColor(FILAMENT_MAP['pla-basic'], '#fefefe').name).toBe('Jadewit');
    expect(nearestColor(FILAMENT_MAP['pla-basic'], '#050505').name).toBe('Zwart');
    expect(nearestColor(FILAMENT_MAP['petg-translucent'], '#ff8800').name).toBe('Doorschijnend oranje');
  });
});

describe('filamentschatting', () => {
  // a 20 mm cube: 8000 mm³, 2400 mm²
  const cube = { volume: 8000, area: 2400, estimate: 'solid' as const };

  it('wanden plus 15% vulling, met de dichtheid van de rol', () => {
    const shell = 2400 * 0.84;
    const v = shell + (8000 - shell) * 0.15;
    expect(printedVolume(cube)).toBeCloseTo(v, 6);
    expect(estimateGrams(cube, 1.24)).toBeCloseTo((v * 1.24) / 1000, 6);
    // ABS is lighter than PLA for the same part
    expect(estimateGrams(cube, 1.05)).toBeLessThan(estimateGrams(cube, 1.24));
  });

  it('dunne delen zijn helemaal wand', () => {
    const plate = { volume: 100 * 100 * 1, area: 2 * 100 * 100 + 400, estimate: 'solid' as const };
    expect(printedVolume(plate)).toBe(plate.volume);
  });

  it('vase mode telt één wand', () => {
    expect(printedVolume({ ...cube, estimate: 'vase' })).toBeCloseTo(2400 * 0.45, 6);
  });

  it('gram naar meter (1,75 mm)', () => {
    // 1 kg PLA ≈ 330 m
    expect(gramsToMetres(1000, 1.24)).toBeGreaterThan(325);
    expect(gramsToMetres(1000, 1.24)).toBeLessThan(340);
    expect(gramsToMetres(1000, 1.05)).toBeGreaterThan(gramsToMetres(1000, 1.24));
  });
});

describe('boodschappenlijst', () => {
  const a2l = printer('a2l');

  it('groepeert per rol en kleur en rondt af op hele spoelen', () => {
    const white = fil('pla-basic', '10100');
    const black = fil('pla-basic', '10101');
    const list = shoppingList(
      [item('A', 300, white, { quantity: 3 }), item('B', 150, white), item('C', 40, black), item('D', 1200, fil('petg-hf', '33100'))],
      a2l,
    );
    expect(list.rows).toHaveLength(3);
    const w = list.rows.find((r) => r.color.code === '10100')!;
    expect(w.grams).toBe(1050);
    expect(w.spools).toBe(2);
    expect(w.used).toBeCloseTo(0.525, 6);
    expect(w.parts).toEqual(['3× A', 'B']);
    const k = list.rows.find((r) => r.color.code === '10101')!;
    expect(k.spools).toBe(1);
    expect(k.used).toBeCloseTo(0.04, 6);
    const petg = list.rows.find((r) => r.line.id === 'petg-hf')!;
    expect(petg.spools).toBe(2);
    // sorted by weight
    expect(list.rows[0].line.id).toBe('petg-hf');
    expect(list.totalGrams).toBe(2290);
    expect(list.totalCostEur).toBeCloseTo(2 * 22.99 + 22.99 + 2 * 22.99, 6);
    expect(list.slots).toBe(3);
  });

  it('precies één rol is één rol', () => {
    const list = shoppingList([item('A', 1000, fil('pla-basic'))], a2l);
    expect(list.rows[0].spools).toBe(1);
    expect(list.rows[0].used).toBe(1);
  });

  it('kleine rollen (support 500 g)', () => {
    const list = shoppingList([item('A', 600, fil('support-pla-petg'))], a2l);
    expect(list.rows[0].spools).toBe(2);
  });

  it('transparant: tip over wanden en vase mode', () => {
    const list = shoppingList([item('Kap', 80, fil('petg-translucent'))], a2l);
    expect(list.notes.join(' ')).toMatch(/2 wanden.*vase mode/);
    expect(shoppingList([item('Bak', 80, fil('pla-basic'))], a2l).notes.join(' ')).not.toMatch(/Transparant/);
  });

  it('waarschuwt voor PLA bij een lamp, niet voor PETG', () => {
    const pla = shoppingList([item('Kap', 80, fil('pla-translucent'), { purpose: 'lamp' })], a2l);
    expect(pla.warnings.join(' ')).toMatch(/LED/);
    const petg = shoppingList([item('Kap', 80, fil('petg-translucent'), { purpose: 'lamp' })], a2l);
    expect(petg.warnings).toEqual([]);
  });

  it('buiten → ASA, flexibel → TPU', () => {
    expect(shoppingList([item('Haak', 30, fil('pla-basic'), { purpose: 'outdoor' })], printer('p1s')).warnings.join(' ')).toMatch(/ASA/);
    expect(shoppingList([item('Haak', 30, fil('asa'), { purpose: 'outdoor' })], printer('p1s')).warnings).toEqual([]);
    expect(shoppingList([item('Voetje', 5, fil('pla-basic'), { purpose: 'flexible' })], a2l).warnings.join(' ')).toMatch(/TPU/);
  });

  it('ABS op een open printer', () => {
    expect(shoppingList([item('Bak', 50, fil('abs'))], a2l).warnings.join(' ')).toMatch(/open printer/);
    expect(shoppingList([item('Bak', 50, fil('abs'))], printer('p1s')).warnings).toEqual([]);
  });

  it('TPU 95A HF en PETG-CF niet door de AMS lite', () => {
    const multi = shoppingList([item('Hoes', 50, fil('tpu-95a-hf')), item('Kern', 50, fil('pla-basic'))], a2l);
    expect(multi.warnings.join(' ')).toMatch(/TPU 95A HF gaat niet door de AMS lite/);
    const cf = shoppingList([item('Beugel', 50, fil('petg-cf')), item('Kern', 50, fil('pla-basic'))], printer('a1'));
    expect(cf.warnings.join(' ')).toMatch(/PETG-CF gaat niet door de AMS lite/);
    expect(cf.notes.join(' ')).toMatch(/geharde/);
    // TPU for AMS is fine in the AMS lite
    const ok = shoppingList([item('Hoes', 50, fil('tpu-for-ams')), item('Kern', 50, fil('pla-basic'))], a2l);
    expect(ok.warnings).toEqual([]);
    // single colour: only a note, no colour changes are blocked
    const single = shoppingList([item('Hoes', 50, fil('tpu-95a-hf'))], a2l);
    expect(single.warnings).toEqual([]);
    expect(single.notes.join(' ')).toMatch(/externe spoelhouder/);
  });

  it('aantal kleuren tegen de AMS-slots van de printer', () => {
    const colors = FILAMENT_MAP['pla-basic'].colors;
    const n = (k: number, id: string) => shoppingList(colors.slice(0, k).map((c, i) => item(`D${i}`, 10, { line: FILAMENT_MAP['pla-basic'], color: c })), printer(id));
    expect(n(3, 'a2l').notes.join(' ')).toMatch(/passen in één AMS/);
    expect(n(6, 'a2l').notes.join(' ')).toMatch(/extra AMS/);
    expect(n(20, 'a2l').warnings.join(' ')).toMatch(/meer dan de 19/);
    expect(n(20, 'h2s').warnings).toEqual([]);
  });

  it('tekst om te kopiëren', () => {
    const list = shoppingList([item('Kap', 1500, fil('petg-translucent', '32300'))], a2l);
    const text = shoppingText(list, 'Lamp', a2l);
    expect(text).toContain('Boodschappenlijst — Lamp (Bambu Lab A2L)');
    expect(text).toContain('2× Bambu Lab PETG Translucent Doorschijnend oranje (32300), 1 kg');
    expect(text).toContain('75% van de rollen');
    expect(text).toMatch(/Tips:/);
  });
});

describe('3MF met kleuren', () => {
  const mesh = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('schrijft basismaterialen met displaycolor per object', () => {
    const data = build3MF(
      [
        { name: 'a', mesh, transforms: [I], color: '#ff6a13', material: 'PLA Basic Oranje' },
        { name: 'b', mesh, transforms: [I], color: '#ff6a13', material: 'PLA Basic Oranje' },
        { name: 'c', mesh, transforms: [I], color: '#e9eef040', material: 'PETG Translucent Helder' },
        { name: 'd', mesh, transforms: [I] },
      ],
      PRINTERS[0],
      't',
    );
    const model = strFromU8(unzipSync(data)['3D/3dmodel.model']);
    expect(model).toContain('<basematerials id="5">');
    expect(model.match(/<base /g)).toHaveLength(2);
    expect(model).toContain('<base name="PLA Basic Oranje" displaycolor="#FF6A13FF"/>');
    expect(model).toContain('displaycolor="#E9EEF040"');
    expect(model).toContain('<object id="1" name="a" type="model" pid="5" pindex="0">');
    expect(model).toContain('<object id="2" name="b" type="model" pid="5" pindex="0">');
    expect(model).toContain('<object id="3" name="c" type="model" pid="5" pindex="1">');
    expect(model).toContain('<object id="4" name="d" type="model">');
    // materials are declared before the objects that use them
    expect(model.indexOf('<basematerials')).toBeLessThan(model.indexOf('<object '));
  });

  it('zonder kleuren geen basismaterialen', () => {
    const model = strFromU8(unzipSync(build3MF([{ name: 'a', mesh, transforms: [I] }], PRINTERS[0], 't'))['3D/3dmodel.model']);
    expect(model).not.toContain('basematerials');
  });
});

describe('materiaalsuggesties van gereedschappen', () => {
  let M: ManifoldToplevel;
  beforeAll(async () => {
    M = await initManifold();
  });

  it('lampenkap van de vaas-tool: PETG Translucent, bij een lamp', async () => {
    const res = await buildTool(M, vaseTool, { ...defaultsOf(vaseTool.params), mode: 'lamp' });
    expect(res.parts[0].material).toBe('petg-translucent');
    expect(res.parts[0].purpose).toBe('lamp');
    expect(FILAMENT_MAP[res.parts[0].material!]).toBeDefined();
    const vase = await buildTool(M, vaseTool, defaultsOf(vaseTool.params));
    expect(vase.parts[0].material).toBeUndefined();
  });

  it('lamp: alleen kap en lamellen krijgen de suggestie', async () => {
    const p = defaultsOf(lampTool.params);
    const res = await buildTool(M, lampTool, p);
    for (const part of res.parts) if (part.material) expect(FILAMENT_MAP[part.material], part.name).toBeDefined();
    expect(res.parts.some((q) => q.name === 'Voet' && q.material)).toBe(false);
  });
});
