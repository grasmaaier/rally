import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from '../src/core/printer';
import { defaultsOf, type Params } from '../src/core/types';
import { organizersTool as tool } from '../src/tools/organizers';
import { buildTool, overhangArea } from './helpers';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});

const base = defaultsOf(tool.params);
const params = (values: Partial<Params>) => ({ ...base, ...values }) as Params;

describe('opbergen & wonen', () => {
  it.each([
    ['zeepschaal', { type: 'soap' }],
    ['pennenorganizer', { type: 'pen' }],
    ['schermverhoger', { type: 'monitor' }],
    ['kabelkam', { type: 'cable' }],
    ['wandrek', { type: 'wallhook', hangStyle: 'rail', hangLook: 'tube' }],
    ['parelhaak', { type: 'wallhook', hangStyle: 'single', hangLook: 'beads' }],
    ['laptopdock', { type: 'laptop', laptopStyle: 'dock' }],
    ['laptopstandaard', { type: 'laptop', laptopStyle: 'stand' }],
    ['meanderpoot', { type: 'monitor', monitorStyle: 'meander' }],
    ['vakkenbeker', { type: 'pen', penLayout: 'cup', penCells: 3 }],
    ['pluspot', { type: 'pen', penLayout: 'plus' }],
    ['bureau-organiser', { type: 'desk' }],
    ['dienblad', { type: 'tray' }],
    ['sleutelbak', { type: 'keys' }],
  ] as const)('%s bouwt geldige, passende delen', async (_name, values) => {
    const res = await buildTool(M, tool, params(values));
    expect(res.parts.length).toBeGreaterThan(0);
    for (const part of res.parts) {
      expect(part.volume).toBeGreaterThan(0);
      expect(fitsOn(DEFAULT_PRINTER, part.size)).toBe(true);
    }
  });

  it.each([
    ['soap', { type: 'soap' }],
    ['soap wave', { type: 'soap', soapShape: 'wave' }],
    ['pen', { type: 'pen', penLook: 'flutes' }],
    ['pen cluster', { type: 'pen', penLayout: 'cluster', penCells: 5, penCavity: 'open' }],
    ['monitor', { type: 'monitor' }],
    ['cable', { type: 'cable', cableMount: 'screws' }],
    ['wallhook tube', { type: 'wallhook', hangStyle: 'rail', hangLook: 'tube' }],
    ['wallhook beads', { type: 'wallhook', hangStyle: 'single', hangLook: 'beads' }],
    ['laptop dock', { type: 'laptop', laptopStyle: 'dock', laptopSlots: 3 }],
    ['laptop stand', { type: 'laptop', laptopStyle: 'stand' }],
    ['monitor meander', { type: 'monitor', monitorStyle: 'meander' }],
    ['pen cup 4', { type: 'pen', penLayout: 'cup', penCells: 4, penLook: 'flutes' }],
    ['pen cup 3', { type: 'pen', penLayout: 'cup', penCells: 3 }],
    ['pen plus', { type: 'pen', penLayout: 'plus' }],
    ['desk round', { type: 'desk', deskTiers: 3 }],
    ['desk angled', { type: 'desk', deskShape: 'angled', deskInsert: 'square' }],
    ['tray 2', { type: 'tray' }],
    ['tray 3 cup', { type: 'tray', trayCount: 3, trayInserts: 'cup' }],
    ['keys', { type: 'keys' }],
    ['keys 4 cells 1 screw', { type: 'keys', keyCells: 4, keyScrews: '1' }],
    ['cup rings', { type: 'pen', penLayout: 'cup', penLook: 'rings' }],
    ['cup bubbles', { type: 'pen', penLayout: 'cup', penLook: 'bubbles' }],
    ['cup twist', { type: 'pen', penLayout: 'cup', penLook: 'twist' }],
    ['cup bulge', { type: 'pen', penLayout: 'cup', penLook: 'bulge' }],
    ['cup pills', { type: 'pen', penLayout: 'cup', penLook: 'pills' }],
  ] as const)('%s print zonder support', async (_name, values) => {
    const res = await buildTool(M, tool, params(values));
    for (const part of res.parts) expect(overhangArea(part)).toBeLessThan(30);
  });

  it('toont een eigen plank met de juiste hoeveelheid poten', async () => {
    const res = await buildTool(M, tool, params({ type: 'monitor', monitorFeet: '4', monitorFootD: 60 }));
    expect(res.parts[0].quantity).toBe(4);
    expect(res.scene?.filter((item) => item.kind === 'part')).toHaveLength(4);
    expect(res.scene?.some((item) => item.kind === 'box' && item.label === 'Je plank')).toBe(true);
  });

  it('maakt een kabelkam met de gevraagde clips', async () => {
    const res = await buildTool(M, tool, params({ type: 'cable', cableD: 8, cableCount: 8 }));
    const info = res.info.find((item) => item.title === 'Indeling') as { rows: [string, string][] };
    expect(info.rows[0][1]).toContain('8');
  });

  it('levert de sleutelbak met een los muurklik-plaatje in PETG', async () => {
    const res = await buildTool(M, tool, params({ type: 'keys' }));
    expect(res.parts.map((p) => p.name)).toEqual(['Sleutelbak', 'Muurklik-plaatje']);
    expect(res.parts[1].material).toBe('petg-hf');
    expect(res.parts[1].size[0]).toBeLessThan(res.parts[0].size[0]);
  });

  it('verkleint een dienblad met drie rondingen tot het op de X2D past', async () => {
    const x2d = PRINTERS.find((p) => p.id === 'x2d-dual')!;
    const res = await buildTool(M, tool, params({ type: 'tray', trayCount: 3, trayInserts: 'cup' }), x2d);
    for (const part of res.parts) expect(fitsOn(x2d, part.size)).toBe(true);
  });

  it('geeft dienblad-inzetjes als losse delen', async () => {
    const res = await buildTool(M, tool, params({ type: 'tray', trayCount: 3, trayInserts: 'dishes' }));
    expect(res.parts.length).toBeGreaterThan(1);
  });

  it.each(['soap', 'pen', 'monitor', 'laptop', 'cable', 'wallhook', 'desk', 'tray', 'keys'])('%s: past op de X2D met printinstellingen', async (type) => {
    const x2d = PRINTERS.find((p) => p.id === 'x2d')!;
    const res = await buildTool(M, tool, params({ type }), x2d);
    for (const part of res.parts) expect(fitsOn(x2d, part.size)).toBe(true);
    expect(res.info.some((b) => b.title === 'Printinstellingen (Bambu Lab X2D (1 nozzle))')).toBe(true);
    expect(res.tips.some((t) => t.includes('deur'))).toBe(true);
  });
});
