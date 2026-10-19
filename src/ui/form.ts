import type { NumberParam, ParamDef, Params, ParamValue } from '../core/types';

export interface FormHandle {
  /** Re-evaluate visibility and push values into the controls. */
  sync(params: Params): void;
}

type Change = (key: string, value: ParamValue, final: boolean) => void;

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));

function numberControl(d: NumberParam, onChange: Change) {
  const wrap = document.createElement('div');
  wrap.className = 'num';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(d.min);
  range.max = String(d.max);
  range.step = String(d.step ?? 1);
  range.setAttribute('aria-label', d.label);
  const box = document.createElement('input');
  box.type = 'number';
  box.min = String(d.min);
  box.max = String(d.max);
  box.step = String(d.step ?? 1);
  box.inputMode = 'decimal';
  box.id = `p-${d.key}`;
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = d.unit ?? '';
  const field = document.createElement('div');
  field.className = 'num-field';
  field.append(box, unit);
  wrap.append(range, field);
  const fmt = (v: number) => String(+v.toFixed(decimals(d.step ?? 1)));
  range.addEventListener('input', () => {
    box.value = fmt(Number(range.value));
    onChange(d.key, Number(range.value), false);
  });
  range.addEventListener('change', () => onChange(d.key, Number(range.value), true));
  box.addEventListener('change', () => {
    let v = Number(box.value.replace(',', '.'));
    if (!Number.isFinite(v)) v = d.default;
    // typed values may go beyond the slider for power users, within sane bounds
    v = Math.min(d.max, Math.max(d.min, v));
    box.value = fmt(v);
    range.value = String(v);
    onChange(d.key, v, true);
  });
  return {
    el: wrap,
    set: (v: ParamValue) => {
      range.value = String(v);
      if (document.activeElement !== box) box.value = fmt(Number(v));
    },
    id: box.id,
  };
}

export function buildForm(host: HTMLElement, defs: ParamDef[], params: Params, onChange: Change): FormHandle {
  host.innerHTML = '';
  const rows: { def: ParamDef; el: HTMLElement; set?: (v: ParamValue) => void }[] = [];
  let section: HTMLElement = host;
  for (const def of defs) {
    if (def.type === 'group') {
      const fs = document.createElement('section');
      fs.className = 'group';
      const h = document.createElement('h3');
      h.textContent = def.label;
      fs.append(h);
      host.append(fs);
      section = fs;
      rows.push({ def, el: fs });
      continue;
    }
    const row = document.createElement('div');
    row.className = `row row-${def.type}`;
    const label = document.createElement('label');
    label.textContent = def.label;
    if (def.help) {
      const hint = document.createElement('small');
      hint.textContent = def.help;
      label.append(hint);
    }
    let set: (v: ParamValue) => void;
    if (def.type === 'number') {
      const c = numberControl(def, onChange);
      label.htmlFor = c.id;
      row.append(label, c.el);
      set = c.set;
    } else if (def.type === 'select') {
      const sel = document.createElement('select');
      sel.id = `p-${def.key}`;
      label.htmlFor = sel.id;
      for (const o of def.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.append(opt);
      }
      sel.addEventListener('change', () => onChange(def.key, sel.value, true));
      row.append(label, sel);
      set = (v) => (sel.value = String(v));
    } else {
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'switch';
      sw.id = `p-${def.key}`;
      label.htmlFor = sw.id;
      sw.addEventListener('change', () => onChange(def.key, sw.checked, true));
      row.append(sw, label);
      set = (v) => (sw.checked = v === true || v === 'true');
    }
    section.append(row);
    rows.push({ def, el: row, set });
  }
  const sync = (p: Params) => {
    for (const r of rows) {
      const visible = r.def.show ? r.def.show(p) : true;
      r.el.hidden = !visible;
      if (r.set && r.def.type !== 'group') r.set(p[r.def.key]);
    }
    // hide groups whose controls are all hidden
    for (const r of rows) {
      if (r.def.type !== 'group' || r.el.hidden) continue;
      const anyVisible = [...r.el.querySelectorAll<HTMLElement>('.row')].some((x) => !x.hidden);
      r.el.hidden = !anyVisible;
    }
  };
  sync(params);
  return { sync };
}
