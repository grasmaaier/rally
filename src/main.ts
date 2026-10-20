import './styles.css';
import { TOOLS, TOOL_MAP } from './tools';
import { defaultsOf, type BuildResult, type FileParam, type Params, type ParamValue, type PartResult, type PrinterProfile, type ShapeAsset, type ToolDef } from './core/types';
import { DEFAULT_PRINTER, PRINTERS, fitsOn } from './core/printer';
import { GeometryClient } from './core/client';
import { arrange, plateOffset } from './core/layout';
import { build3MF, buildSTL, download, slug, type ExportObject } from './core/export';
import { Viewer, type ViewMode } from './ui/viewer';
import { buildForm, type FileHooks, type FormHandle } from './ui/form';
import { svgToShape } from './ui/svg';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`rally:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`rally:${key}`, value);
    } catch {
      // storage unavailable (private mode): settings simply don't persist
    }
  },
};

const COLORS = [
  { name: 'Ivoor', hex: '#e8e4dc' },
  { name: 'Zwart', hex: '#2b2b2e' },
  { name: 'Grijs', hex: '#9aa0a6' },
  { name: 'Terracotta', hex: '#c8693f' },
  { name: 'Salie', hex: '#8fae8b' },
  { name: 'Oceaan', hex: '#3f7cac' },
  { name: 'Oker', hex: '#d9a441' },
  { name: 'Roze', hex: '#e7a3b0' },
];

interface State {
  tool: ToolDef;
  params: Params;
  printer: PrinterProfile;
  view: ViewMode;
  section: boolean;
  color: string;
  result: BuildResult | null;
}

const client = new GeometryClient();
const viewer = new Viewer($('#viewer'));

const state: State = {
  tool: TOOLS[0],
  params: defaultsOf(TOOLS[0].params),
  printer: PRINTERS.find((p) => p.id === store.get('printer')) ?? DEFAULT_PRINTER,
  view: 'assembly',
  section: false,
  color: store.get('color') ?? COLORS[0].hex,
  result: null,
};

// ---------------------------------------------------------------------------
// URL state: #tool?key=value (only values that differ from the defaults)

function encodeHash() {
  const defs = defaultsOf(state.tool.params);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(state.params)) if (defs[k] !== v) q.set(k, String(v));
  const s = q.toString();
  return `#${state.tool.id}${s ? `?${s}` : ''}`;
}

function decodeHash(): { tool: ToolDef; params: Params } | null {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return null;
  const [id, query] = h.split('?');
  const tool = TOOL_MAP[id];
  if (!tool) return null;
  const params = { ...defaultsOf(tool.params) };
  if (query) {
    const q = new URLSearchParams(query);
    for (const d of tool.params) {
      if (d.type === 'group' || !q.has(d.key)) continue;
      const raw = q.get(d.key)!;
      params[d.key] = d.type === 'number' ? Number(raw) : d.type === 'bool' ? raw === 'true' : raw;
    }
  } else {
    Object.assign(params, savedParams(tool));
  }
  return { tool, params };
}

function savedParams(tool: ToolDef): Params {
  try {
    const raw = store.get(`params:${tool.id}`);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Params;
    const defs = defaultsOf(tool.params);
    const out: Params = {};
    for (const k of Object.keys(defs)) if (k in saved && typeof saved[k] === typeof defs[k]) out[k] = saved[k];
    return out;
  } catch {
    return {};
  }
}

function persist() {
  try {
    history.replaceState(null, '', encodeHash());
  } catch {
    // sandboxed frames may refuse history updates; the design still works
  }
  store.set(`params:${state.tool.id}`, JSON.stringify(state.params));
}

// ---------------------------------------------------------------------------
// Building

let token = 0;
let inFlight = false;
let queued = false;
let debounce: number | undefined;

function scheduleBuild(delay = 0) {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(runBuild, delay);
}

async function runBuild() {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  const my = token;
  const tool = state.tool;
  const params = { ...state.params };
  $('#busy').hidden = false;
  try {
    const res = await client.build(tool.id, params, state.printer);
    if (my === token) {
      state.result = res;
      showError(null);
      render();
    }
  } catch (err) {
    if (my === token) showError((err as Error).message);
  } finally {
    inFlight = false;
    $('#busy').hidden = true;
    if (queued) {
      queued = false;
      runBuild();
    }
  }
}

function showError(msg: string | null) {
  const el = $('#error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

// ---------------------------------------------------------------------------
// Rendering results

const fmt = (v: number, d = 0) => v.toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });

/**
 * Rough filament estimate in grams (PLA 1.24 g/cm³): 2 walls (~0.84 mm shell)
 * plus 15% infill, or a single ~0.45 mm wall for spiral vase mode.
 */
function grams(p: PartResult) {
  if (p.estimate === 'vase') return (p.area * 0.45 * 1.24) / 1000;
  const shell = Math.min(p.volume, p.area * 0.84);
  return ((shell + (p.volume - shell) * 0.15) * 1.24) / 1000;
}

function render() {
  const res = state.result;
  if (!res) return;
  const hasScene = !!res.scene && res.scene.length > 0;
  const mode: ViewMode = hasScene ? state.view : 'plate';
  const placements = arrange(res.parts, state.printer, true);
  const plates = Math.max(1, ...placements.map((p) => p.plate + 1));
  viewer.setSection(state.section);
  viewer.show(res, mode, state.printer, placements, `${state.tool.id}|${mode}|${state.printer.id}|${plates}`);
  viewer.setColor(state.color);

  $('#view-toggle').hidden = !hasScene;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#view-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));

  // stats strip
  const total = res.parts.reduce((s, p) => s + p.quantity, 0);
  const g = res.parts.reduce((s, p) => s + grams(p) * p.quantity, 0);
  const allFit = res.parts.every((p) => fitsOn(state.printer, p.size));
  const main = res.parts[0];
  $('#stats').innerHTML = `
    <span class="chip ${allFit ? 'ok' : 'bad'}">${allFit ? '✓ Past op' : '✕ Te groot voor'} ${state.printer.name}</span>
    ${res.parts.length === 1 ? `<span class="chip">${main.size.map((v) => fmt(v, 1)).join(' × ')} mm</span>` : `<span class="chip">${total} printdelen · ${plates} ${plates === 1 ? 'plaat' : 'platen'}</span>`}
    <span class="chip">≈ ${fmt(g)} g filament</span>
    <span class="chip subtle">${fmt(res.ms)} ms</span>`;

  // parts list
  const parts = $('#parts');
  parts.innerHTML = '';
  res.parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'part';
    const fits = fitsOn(state.printer, p.size);
    row.innerHTML = `
      <div class="part-main">
        <strong>${p.quantity > 1 ? `${p.quantity}× ` : ''}${escapeHtml(p.name)}</strong>
        <span>${p.size.map((v) => fmt(v, 1)).join(' × ')} mm · ≈ ${fmt(grams(p))} g${p.quantity > 1 ? ' per stuk' : ''}</span>
        ${fits ? '' : '<span class="bad">Past niet op het bed</span>'}
      </div>`;
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'STL';
    btn.title = `Download ${p.name} als STL`;
    btn.addEventListener('click', () => exportPart(i));
    row.append(btn);
    parts.append(row);
  });

  // multi-plate export buttons
  const plateBtns = $('#plate-exports');
  plateBtns.innerHTML = '';
  if (plates > 1) {
    for (let i = 0; i < plates; i++) {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = `Plaat ${i + 1}`;
      b.addEventListener('click', () => export3MF(i));
      plateBtns.append(b);
    }
  }
  $('#export-3mf').textContent = plates > 1 ? `Download 3MF (alle ${total} delen)` : 'Download 3MF voor Bambu Studio';

  // warnings, info, tips
  $('#warnings').innerHTML = res.warnings.map((w) => `<div class="callout warn">${escapeHtml(w)}</div>`).join('');
  const info = $('#info');
  info.innerHTML = '';
  for (const block of res.info) {
    const sec = document.createElement('section');
    sec.className = 'info-block';
    const h = document.createElement('h3');
    h.textContent = block.title;
    sec.append(h);
    if (block.kind === 'kv') {
      const dl = document.createElement('dl');
      for (const [k, v] of block.rows) dl.insertAdjacentHTML('beforeend', `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`);
      sec.append(dl);
    } else if (block.kind === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.innerHTML = `<table><thead><tr>${block.headers.map((x) => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${block.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
      sec.append(wrap);
      if (block.csv) {
        const b = document.createElement('button');
        b.className = 'ghost small';
        b.textContent = 'Download als CSV';
        const csv = block.csv;
        b.addEventListener('click', () => save('﻿' + csv, `${slug(state.tool.name)}-zaaglijst.csv`, 'text/csv;charset=utf-8'));
        sec.append(b);
      }
    } else {
      const pEl = document.createElement('p');
      pEl.textContent = block.text;
      sec.append(pEl);
    }
    info.append(sec);
  }
  $('#tips').innerHTML = res.tips.length ? `<h3>Printtips</h3><ul>${res.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Export

function objectsFor(plate: number | null): ExportObject[] {
  const res = state.result!;
  const placements = arrange(res.parts, state.printer, true);
  return res.parts.map((p, i) => ({
    name: p.name,
    mesh: p.mesh,
    transforms: placements
      .filter((pl) => pl.part === i && (plate === null || pl.plate === plate))
      .map((pl) => {
        const x = pl.x + (plate === null ? plateOffset(state.printer, pl.plate) : 0);
        const c = pl.rotated ? 0 : 1;
        const s = pl.rotated ? 1 : 0;
        return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, pl.y, 0, 1];
      }),
  })).filter((o) => o.transforms.length > 0);
}

function save(data: Uint8Array | string, filename: string, mime: string) {
  download(data, filename, mime).catch((err: { code?: string; message?: string }) => {
    // the viewer declining a save prompt is a choice, not an error
    if (err?.code !== 'declined') showError(`Downloaden lukte niet: ${err?.message ?? err}`);
  });
}

function baseName() {
  const res = state.result!;
  return slug(res.parts.length === 1 ? res.parts[0].name : state.tool.name);
}

function export3MF(plate: number | null) {
  if (!state.result) return;
  const data = build3MF(objectsFor(plate), state.printer, state.tool.name);
  save(data, `${baseName()}${plate !== null ? `-plaat-${plate + 1}` : ''}.3mf`, 'model/3mf');
}

function exportPart(i: number) {
  const p = state.result!.parts[i];
  const data = buildSTL([{ name: p.name, mesh: p.mesh, transforms: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]] }]);
  save(data, `${slug(p.name)}.stl`, 'model/stl');
}

// ---------------------------------------------------------------------------
// Uploaded fonts and SVG outlines (kept in this browser so a reload keeps them)

interface StoredUpload {
  name: string;
  kind: 'font' | 'shape';
  /** base64 font bytes, or the converted outline */
  data: string | ShapeAsset;
}

const uploadNames = new Map<string, string>();

function hashText(s: string) {
  // FNV-1a, enough to recognise the same file again
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rememberUpload(key: string, u: StoredUpload) {
  uploadNames.set(key, u.name);
  try {
    const raw = JSON.stringify(u);
    if (raw.length > 1_500_000) return; // too big for browser storage: kept for this visit only
    store.set(`upload:${key}`, raw);
    const index = new Set(JSON.parse(store.get('uploads') ?? '[]') as string[]);
    index.add(key);
    store.set('uploads', JSON.stringify([...index]));
  } catch {
    // storage full or unavailable
  }
}

function restoreUploads() {
  try {
    for (const key of JSON.parse(store.get('uploads') ?? '[]') as string[]) {
      const raw = store.get(`upload:${key}`);
      if (!raw) continue;
      const u = JSON.parse(raw) as StoredUpload;
      uploadNames.set(key, u.name);
      if (u.kind === 'font') client.put({ type: 'font', key, bytes: base64ToBytes(u.data as string).buffer });
      else client.put({ type: 'shape', key, shape: u.data as ShapeAsset });
    }
  } catch {
    // corrupt or unavailable storage: start without earlier uploads
  }
}

const fileHooks: FileHooks = {
  async upload(def: FileParam, file: File) {
    if (def.asset === 'font') {
      if (/\.woff2$/i.test(file.name)) throw new Error('WOFF2 wordt niet ondersteund: gebruik TTF, OTF of WOFF.');
      if (!/\.(ttf|otf|woff)$/i.test(file.name)) throw new Error('Kies een lettertype (.ttf, .otf of .woff).');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const b64 = bytesToBase64(bytes);
      const key = `upload:${hashText(b64)}`;
      client.put({ type: 'font', key, bytes: bytes.buffer.slice(0) });
      rememberUpload(key, { name: file.name, kind: 'font', data: b64 });
      return key;
    }
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new Error('Kies een SVG-bestand.');
    const text = await file.text();
    const shape = svgToShape(text, file.name);
    const key = `upload:${hashText(text)}`;
    client.put({ type: 'shape', key, shape });
    rememberUpload(key, { name: file.name, kind: 'shape', data: shape });
    return key;
  },
  label: (key) => uploadNames.get(key) ?? 'Geüpload bestand (niet meer beschikbaar)',
};

// ---------------------------------------------------------------------------
// Tool switching & controls

let form: FormHandle | null = null;

function onParam(key: string, value: ParamValue, final: boolean) {
  state.params[key] = value;
  form?.sync(state.params);
  persist();
  scheduleBuild(final ? 0 : 90);
}

function selectTool(tool: ToolDef, params?: Params) {
  token++;
  state.tool = tool;
  state.params = params ?? { ...defaultsOf(tool.params), ...savedParams(tool) };
  state.result = null;
  state.view = 'assembly';
  document.title = `${tool.name} · Rally Printstudio`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.setAttribute('aria-current', String(b.dataset.tool === tool.id));
  $('#tool-title').textContent = tool.name;
  $('#tool-desc').textContent = tool.description;
  const presets = $<HTMLSelectElement>('#presets');
  presets.innerHTML = '<option value="">Voorbeelden…</option>' + (tool.presets ?? []).map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
  $('#random').hidden = !tool.randomize;
  form = buildForm($('#form'), tool.params, state.params, onParam, fileHooks);
  persist();
  showError(null);
  scheduleBuild();
}

function setupChrome() {
  const nav = $('#tools');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.dataset.tool = t.id;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${t.short}</span>`;
    b.title = t.name;
    b.addEventListener('click', () => {
      if (state.tool.id !== t.id) selectTool(t);
    });
    nav.append(b);
  }
  const printer = $<HTMLSelectElement>('#printer');
  printer.innerHTML = PRINTERS.map((p) => `<option value="${p.id}">${p.name} (${p.x}×${p.y}×${p.z})</option>`).join('');
  printer.value = state.printer.id;
  printer.addEventListener('change', () => {
    state.printer = PRINTERS.find((p) => p.id === printer.value) ?? DEFAULT_PRINTER;
    store.set('printer', state.printer.id);
    scheduleBuild();
  });

  $<HTMLSelectElement>('#presets').addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    const preset = state.tool.presets?.[Number(sel.value)];
    sel.value = '';
    if (!preset) return;
    state.params = { ...defaultsOf(state.tool.params), ...preset.values } as Params;
    form?.sync(state.params);
    persist();
    scheduleBuild();
  });
  $('#random').addEventListener('click', () => {
    if (!state.tool.randomize) return;
    Object.assign(state.params, state.tool.randomize(state.params));
    form?.sync(state.params);
    persist();
    scheduleBuild();
  });
  $('#reset').addEventListener('click', () => {
    state.params = defaultsOf(state.tool.params);
    form?.sync(state.params);
    persist();
    scheduleBuild();
  });
  $('#share').addEventListener('click', async () => {
    const btn = $('#share');
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Link gekopieerd ✓';
    } catch {
      btn.textContent = 'Kopieer de adresbalk';
    }
    setTimeout(() => (btn.textContent = 'Deel ontwerp'), 1800);
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('#view-toggle button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view as ViewMode;
      render();
    });
  }
  const section = $<HTMLInputElement>('#section');
  section.addEventListener('change', () => {
    state.section = section.checked;
    render();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cam]')) b.addEventListener('click', () => (b.dataset.cam === 'fit' ? viewer.fit() : viewer.view(b.dataset.cam as 'front' | 'top' | 'iso')));

  const swatches = $('#swatches');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c.hex);
    b.title = c.name;
    b.setAttribute('aria-label', `Kleur ${c.name}`);
    b.setAttribute('aria-pressed', String(c.hex === state.color));
    b.addEventListener('click', () => {
      state.color = c.hex;
      store.set('color', c.hex);
      viewer.setColor(c.hex);
      for (const s of swatches.querySelectorAll('button')) s.setAttribute('aria-pressed', String(s === b));
    });
    swatches.append(b);
  }

  $('#export-3mf').addEventListener('click', () => export3MF(null));
  $('#export-stl').addEventListener('click', () => {
    if (!state.result) return;
    save(buildSTL(objectsFor(null)), `${baseName()}.stl`, 'model/stl');
  });

  // theme
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  // an explicit choice (ours, or one set by an embedding host) wins over the OS setting
  const applyTheme = () => {
    const pref = store.get('theme');
    if (pref) root.dataset.theme = pref;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : media.matches;
    viewer.setTheme(dark);
    $('#theme').setAttribute('aria-label', dark ? 'Licht thema' : 'Donker thema');
    $('#theme').textContent = dark ? '☀' : '☾';
    if (state.result) render();
  };
  media.addEventListener('change', applyTheme);
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : media.matches;
    store.set('theme', dark ? 'light' : 'dark');
    applyTheme();
  });
  applyTheme();

  window.addEventListener('hashchange', () => {
    const d = decodeHash();
    if (d && (d.tool.id !== state.tool.id || encodeHash() !== location.hash)) selectTool(d.tool, d.params);
  });
}

setupChrome();
restoreUploads();
const initial = decodeHash();
selectTool(initial?.tool ?? TOOLS[0], initial?.params);
