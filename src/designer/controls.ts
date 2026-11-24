/**
 * Styled controls for the inspector: tile buttons, thin sliders with a
 * numeric field, colour swatches and switches. Driven by the same ParamDefs
 * (and `show` rules) as the classic form.
 */
import type { NumberParam, ParamDef, Params, ParamValue, SelectParam } from '../core/types';
import { shapeIcon } from './icons';
import { SHAPE_SHORT } from './lampModel';

export type Change = (key: string, value: ParamValue, final: boolean) => void;

export interface InspectorHandle {
  sync(params: Params): void;
}

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));
const HEX = /^#[0-9a-f]{6}$/i;

/** Short tile label: "Bol (afgeplat)" → "Bol", "1 — gewone kap" → "1". */
export function shortLabel(label: string): string {
  return label.split(/ \(| — | – /)[0].trim();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function numberRow(d: NumberParam, onChange: Change) {
  const row = el('div', 'insp-row insp-num');
  const head = el('div', 'insp-head');
  const label = el('label', 'insp-label', d.label);
  const field = el('div', 'insp-field');
  const box = el('input');
  box.type = 'number';
  box.min = String(d.min);
  box.max = String(d.max);
  box.step = String(d.step ?? 1);
  box.inputMode = 'decimal';
  box.id = `i-${d.key}`;
  label.htmlFor = box.id;
  field.append(box);
  if (d.unit) field.append(el('span', 'insp-unit', d.unit));
  head.append(label, field);
  const range = el('input', 'thin');
  range.type = 'range';
  range.min = String(d.min);
  range.max = String(d.max);
  range.step = String(d.step ?? 1);
  range.setAttribute('aria-label', d.label);
  if (d.help) row.title = d.help;
  row.append(head, range);
  const fmt = (v: number) => String(+v.toFixed(decimals(d.step ?? 1)));
  const fill = () => {
    const t = (Number(range.value) - d.min) / (d.max - d.min || 1);
    range.style.setProperty('--fill', `${Math.round(Math.min(1, Math.max(0, t)) * 1000) / 10}%`);
  };
  range.addEventListener('input', () => {
    box.value = fmt(Number(range.value));
    fill();
    onChange(d.key, Number(range.value), false);
  });
  range.addEventListener('change', () => onChange(d.key, Number(range.value), true));
  box.addEventListener('change', () => {
    let v = Number(box.value.replace(',', '.'));
    if (!Number.isFinite(v)) v = d.default;
    v = Math.min(d.max, Math.max(d.min, v));
    box.value = fmt(v);
    range.value = String(v);
    fill();
    onChange(d.key, v, true);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') box.blur();
  });
  return {
    row,
    set: (v: ParamValue) => {
      range.value = String(v);
      fill();
      if (document.activeElement !== box) box.value = fmt(Number(v));
    },
  };
}

type TileKind = 'shape' | 'kap' | 'text';

function tileRow(d: SelectParam, kind: TileKind, onChange: Change) {
  const row = el('div', `insp-row insp-tiles tiles-${kind}`);
  const label = el('div', 'insp-label', d.label);
  const grid = el('div', 'tile-grid');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', d.label);
  if (d.help) row.title = d.help;
  const buttons = d.options.map((o) => {
    const b = el('button', 'tile');
    b.type = 'button';
    b.dataset.value = o.value;
    b.setAttribute('role', 'radio');
    b.title = o.label;
    const text = shortLabel(o.label);
    if (kind === 'shape') b.innerHTML = `${shapeIcon(o.value)}<span>${escapeHtml(SHAPE_SHORT[o.value] ?? text)}</span>`;
    else if (kind === 'kap') b.innerHTML = `${shapeIcon('kap', o.value)}<span>${escapeHtml(text)}</span>`;
    else b.innerHTML = `<span>${escapeHtml(text)}</span>`;
    b.addEventListener('click', () => onChange(d.key, o.value, true));
    grid.append(b);
    return b;
  });
  row.append(label, grid);
  return {
    row,
    set: (v: ParamValue) => {
      for (const b of buttons) {
        const on = b.dataset.value === String(v);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (!buttons.some((b) => b.dataset.value === String(v)) && buttons[0]) buttons[0].tabIndex = 0;
    },
  };
}

function swatchRow(d: SelectParam, onChange: Change) {
  const row = el('div', 'insp-row insp-swatches');
  const head = el('div', 'insp-head');
  const label = el('div', 'insp-label', d.label);
  const name = el('span', 'insp-value');
  head.append(label, name);
  const grid = el('div', 'swatch-grid');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', d.label);
  const buttons = d.options.map((o) => {
    const b = el('button', o.value === 'auto' ? 'sw sw-auto' : 'sw');
    b.type = 'button';
    b.dataset.value = o.value;
    b.setAttribute('role', 'radio');
    if (o.value !== 'auto') b.style.setProperty('--c', o.value);
    b.title = o.label;
    b.setAttribute('aria-label', o.label);
    b.addEventListener('click', () => onChange(d.key, o.value, true));
    grid.append(b);
    return b;
  });
  row.append(head, grid);
  return {
    row,
    set: (v: ParamValue) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(v)));
      name.textContent = shortLabel(d.options.find((o) => o.value === String(v))?.label ?? '');
    },
  };
}

function selectRow(d: SelectParam, onChange: Change) {
  const row = el('div', 'insp-row insp-select');
  const label = el('label', 'insp-label', d.label);
  const sel = el('select', 'insp-dropdown');
  sel.id = `i-${d.key}`;
  label.htmlFor = sel.id;
  for (const o of d.options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    sel.append(opt);
  }
  if (d.help) row.title = d.help;
  sel.addEventListener('change', () => onChange(d.key, sel.value, true));
  row.append(label, sel);
  return { row, set: (v: ParamValue) => (sel.value = String(v)) };
}

function boolRow(d: ParamDef & { type: 'bool' }, onChange: Change) {
  const row = el('div', 'insp-row insp-bool');
  const label = el('label', 'insp-label', d.label);
  const sw = el('input', 'switch');
  sw.type = 'checkbox';
  sw.id = `i-${d.key}`;
  label.htmlFor = sw.id;
  if (d.help) row.title = d.help;
  sw.addEventListener('change', () => onChange(d.key, sw.checked, true));
  row.append(label, sw);
  return { row, set: (v: ParamValue) => (sw.checked = v === true || v === 'true') };
}

function textRow(d: ParamDef & { type: 'text' }, onChange: Change) {
  const row = el('div', 'insp-row insp-select');
  const label = el('label', 'insp-label', d.label);
  const input = el('input', 'text-input');
  input.type = 'text';
  input.id = `i-${d.key}`;
  input.maxLength = d.maxLength ?? 120;
  label.htmlFor = input.id;
  input.addEventListener('change', () => onChange(d.key, input.value, true));
  row.append(label, input);
  return {
    row,
    set: (v: ParamValue) => {
      if (document.activeElement !== input) input.value = String(v ?? '');
    },
  };
}

/** How a select is shown. */
export function selectKind(d: SelectParam): 'swatch' | TileKind | 'dropdown' {
  // colours, optionally with an "auto" swatch first
  if (d.options.some((o) => HEX.test(o.value)) && d.options.every((o) => HEX.test(o.value) || o.value === 'auto')) return 'swatch';
  if (/^s\dShape$/.test(d.key)) return 'shape';
  if (/^s\dKap$/.test(d.key)) return 'kap';
  if (d.options.length <= 4 && d.options.every((o) => shortLabel(o.label).length <= 14)) return 'text';
  return 'dropdown';
}

export function buildInspector(host: HTMLElement, defs: ParamDef[], params: Params, onChange: Change): InspectorHandle {
  host.innerHTML = '';
  const rows: { def: ParamDef; el: HTMLElement; set?: (v: ParamValue) => void }[] = [];
  let section: HTMLElement = host;
  for (const def of defs) {
    if (def.type === 'group') {
      const sec = el('section', 'insp-group');
      sec.append(el('h4', undefined, def.label));
      host.append(sec);
      section = sec;
      rows.push({ def, el: sec });
      continue;
    }
    let c: { row: HTMLElement; set: (v: ParamValue) => void } | null = null;
    if (def.type === 'number') c = numberRow(def, onChange);
    else if (def.type === 'select') {
      const k = selectKind(def);
      c = k === 'swatch' ? swatchRow(def, onChange) : k === 'dropdown' ? selectRow(def, onChange) : tileRow(def, k, onChange);
    } else if (def.type === 'bool') c = boolRow(def, onChange);
    else if (def.type === 'text') c = textRow(def, onChange);
    if (!c) continue;
    section.append(c.row);
    rows.push({ def, el: c.row, set: c.set });
  }
  const sync = (p: Params) => {
    for (const r of rows) {
      let visible = true;
      try {
        visible = r.def.show ? r.def.show(p) : true;
      } catch {
        visible = true;
      }
      r.el.hidden = !visible;
      if (r.set && r.def.type !== 'group') r.set(p[r.def.key]);
    }
    for (const r of rows) {
      if (r.def.type !== 'group' || r.el.hidden) continue;
      r.el.hidden = ![...r.el.querySelectorAll<HTMLElement>('.insp-row')].some((x) => !x.hidden);
    }
  };
  sync(params);
  return { sync };
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
