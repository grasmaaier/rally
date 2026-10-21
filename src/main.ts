import './styles.css';
import { TOOLS, TOOL_MAP } from './tools';
import { defaultsOf, type BuildResult, type FileParam, type MeshAsset, type Params, type ParamValue, type PartResult, type PrinterProfile, type ShapeAsset, type ToolDef } from './core/types';
import { PRINTERS, fitsOn, printerById, volumeLabel } from './core/printer';
import {
  DEFAULT_FILAMENT,
  FILAMENTS,
  FILAMENT_MAP,
  estimateGrams,
  gramsToMetres,
  isTranslucent,
  nearestColor,
  resolveFilament,
  shoppingList,
  shoppingText,
  type FilamentChoice,
  type ResolvedFilament,
  type ShoppingList,
} from './core/filaments';
import { GeometryClient } from './core/client';
import { arrange, plateOffset } from './core/layout';
import { build3MF, buildSTL, download, slug, type ExportObject } from './core/export';
import { Viewer, type PartLook, type ViewMode } from './ui/viewer';
import { buildForm, type FileHooks, type FormHandle } from './ui/form';
import { svgToShape } from './ui/svg';
import { parseMeshFile } from './geom/meshfile';

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

function readJson<T>(key: string): T | null {
  try {
    const raw = store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function resolveChoice(c: Partial<FilamentChoice>): FilamentChoice {
  const r = resolveFilament(c);
  return { line: r.line.id, color: r.color.code };
}

/** The filament for "all parts": the saved choice, else the old preview colour mapped onto PLA Basic. */
function initialFilament(): FilamentChoice {
  const saved = readJson<FilamentChoice>('filament:all');
  if (saved && typeof saved === 'object' && FILAMENT_MAP[saved.line]) return resolveChoice(saved);
  const oldHex = store.get('color');
  const color = oldHex && /^#[0-9a-f]{6}$/i.test(oldHex) ? nearestColor(DEFAULT_FILAMENT, oldHex) : DEFAULT_FILAMENT.colors[0];
  return { line: DEFAULT_FILAMENT.id, color: color.code };
}

interface State {
  tool: ToolDef;
  params: Params;
  printer: PrinterProfile;
  view: ViewMode;
  section: boolean;
  /** Filament for every part without a choice of its own. */
  filament: FilamentChoice;
  /** Per-part filament choices for the current tool, by part name. */
  partFilament: Record<string, FilamentChoice>;
  result: BuildResult | null;
}

const client = new GeometryClient();
const viewer = new Viewer($('#viewer'));

const state: State = {
  tool: TOOLS[0],
  params: defaultsOf(TOOLS[0].params),
  printer: printerById(store.get('printer')),
  view: 'assembly',
  section: false,
  filament: initialFilament(),
  partFilament: {},
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

// ---------------------------------------------------------------------------
// Filament per part

type FilamentSource = 'part' | 'hint' | 'all';

/**
 * Filament of a part: the user's choice for that part, else the tool's
 * suggestion (material line and, for designs with differently coloured parts,
 * the nearest real colour), else the "all parts" filament.
 */
function filamentOf(p: PartResult, parts: PartResult[]): { f: ResolvedFilament; source: FilamentSource } {
  const own = state.partFilament[p.name];
  if (own) return { f: resolveFilament(own), source: 'part' };
  const all = resolveFilament(state.filament);
  const hinted = p.material ? FILAMENT_MAP[p.material] : undefined;
  const line = hinted ?? all.line;
  // part colours matter only when the design mixes colours (e.g. lamp segments)
  const mixed = !!p.color && new Set(parts.map((q) => q.color ?? '')).size > 1;
  const color = mixed ? nearestColor(line, p.color!) : line === all.line ? all.color : nearestColor(line, all.color.hex);
  return { f: { line, color }, source: hinted || mixed ? 'hint' : 'all' };
}

function lookOf(f: ResolvedFilament): PartLook {
  return { color: f.color.hex, translucent: isTranslucent(f), clear: !!f.color.clear };
}

function currentList(): ShoppingList | null {
  const res = state.result;
  if (!res) return null;
  return shoppingList(
    res.parts.map((p) => {
      const { f } = filamentOf(p, res.parts);
      return { name: p.name, quantity: p.quantity, grams: estimateGrams(p, f.line.density), filament: f, purpose: p.purpose, estimate: p.estimate };
    }),
    state.printer,
  );
}

function render() {
  const res = state.result;
  if (!res) return;
  const hasScene = !!res.scene && res.scene.length > 0;
  const mode: ViewMode = hasScene ? state.view : 'plate';
  const placements = arrange(res.parts, state.printer, true);
  const plates = Math.max(1, ...placements.map((p) => p.plate + 1));
  viewer.setSection(state.section);
  const looks = res.parts.map((p) => lookOf(filamentOf(p, res.parts).f));
  viewer.show(res, mode, state.printer, placements, `${state.tool.id}|${mode}|${state.printer.id}|${plates}`, looks);

  $('#view-toggle').hidden = !hasScene;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#view-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));

  const total = res.parts.reduce((s, p) => s + p.quantity, 0);

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
        <span>${p.size.map((v) => fmt(v, 1)).join(' × ')} mm</span>
        <span class="part-fil" data-part="${i}"></span>
        ${fits ? '' : `<span class="bad">Past niet op de ${escapeHtml(state.printer.name)}</span>`}
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
  renderFilament(plates);
}

let lastPlates = 1;

/** Everything that depends on the filament choice; cheap, so it runs on every colour change. */
function renderFilament(plates = lastPlates) {
  const res = state.result;
  if (!res) return;
  lastPlates = plates;
  const fils = res.parts.map((p) => filamentOf(p, res.parts));
  viewer.setLooks(fils.map(({ f }) => lookOf(f)));
  const list = currentList()!;

  // stats strip
  const total = res.parts.reduce((s, p) => s + p.quantity, 0);
  const allFit = res.parts.every((p) => fitsOn(state.printer, p.size));
  const main = res.parts[0];
  $('#stats').innerHTML = `
    <span class="chip ${allFit ? 'ok' : 'bad'}">${allFit ? '✓ Past op' : '✕ Te groot voor'} ${escapeHtml(state.printer.name)}</span>
    ${res.parts.length === 1 ? `<span class="chip">${main.size.map((v) => fmt(v, 1)).join(' × ')} mm</span>` : `<span class="chip">${total} printdelen · ${plates} ${plates === 1 ? 'plaat' : 'platen'}</span>`}
    <span class="chip" title="Schatting: 2 wanden + 15% vulling (vase mode: 1 wand)">≈ ${fmt(list.totalGrams)} g filament</span>
    <span class="chip subtle">${fmt(res.ms)} ms</span>`;

  // filament per part in the parts list
  for (const el of document.querySelectorAll<HTMLElement>('#parts .part-fil')) {
    const i = Number(el.dataset.part);
    const p = res.parts[i];
    const { f } = fils[i];
    const g = estimateGrams(p, f.line.density);
    el.innerHTML = `${dot(f)}${escapeHtml(f.line.name)} ${escapeHtml(f.color.name)} · ≈ ${fmt(g)} g / ${fmt(gramsToMetres(g, f.line.density), 1)} m${p.quantity > 1 ? ' per stuk' : ''}`;
  }

  renderFilamentPanel(res.parts, fils);
  renderShopping(list);
  // designs that colour every part themselves ignore the quick colour picks
  $('#swatches').hidden = res.parts.length > 1 && fils.every((x) => x.source !== 'all');
  renderSwatches();
}

function dot(f: ResolvedFilament, extra = '') {
  return `<i class="dot${extra}${isTranslucent(f) ? ' see' : ''}" style="--c:${f.color.hex}" aria-hidden="true"></i>`;
}

function lineOptions(selected: string) {
  const fams = [...new Set(FILAMENTS.map((f) => f.family))];
  return fams
    .map(
      (fam) =>
        `<optgroup label="${fam}">${FILAMENTS.filter((f) => f.family === fam)
          .map((f) => `<option value="${f.id}"${f.id === selected ? ' selected' : ''}>${escapeHtml(f.name)}${f.translucent ? ' (doorschijnend)' : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');
}

function colorOptions(f: ResolvedFilament) {
  return f.line.colors
    .map((k) => `<option value="${k.code}"${k.code === f.color.code ? ' selected' : ''}>${escapeHtml(k.name)}${k.clear ? ' (helder)' : k.translucent && !f.line.translucent ? ' (doorschijnend)' : ''}</option>`)
    .join('');
}

function setPartFilament(name: string, choice: FilamentChoice | null) {
  if (choice) state.partFilament[name] = choice;
  else delete state.partFilament[name];
  store.set(`filament:parts:${state.tool.id}`, JSON.stringify(state.partFilament));
  renderFilament();
}

function setAllFilament(choice: FilamentChoice) {
  state.filament = resolveChoice(choice);
  store.set('filament:all', JSON.stringify(state.filament));
  renderFilament();
}

function renderFilamentPanel(parts: PartResult[], fils: { f: ResolvedFilament; source: FilamentSource }[]) {
  const box = $('#filament');
  const all = resolveFilament(state.filament);
  const ams = state.printer.ams;
  const rows: string[] = [];
  rows.push(`
    <div class="fil-row fil-all">
      <span class="fil-name">${parts.length > 1 ? 'Alle onderdelen' : 'Filament'}</span>
      ${dot(all, ' big')}
      <select data-role="all-line" aria-label="Filamentsoort voor alle onderdelen">${lineOptions(all.line.id)}</select>
      <select data-role="all-color" aria-label="Kleur voor alle onderdelen">${colorOptions(all)}</select>
    </div>
    <p class="fil-use">${escapeHtml(all.line.uses)}</p>
    ${parts.length > 1 && fils.every((x) => x.source !== 'all') ? '<p class="fil-use">Dit ontwerp kiest zelf een kleur per onderdeel (de dichtstbijzijnde echte filamentkleur); hier kies je de filamentsoort, per onderdeel ook een andere kleur.</p>' : ''}`);
  if (parts.length > 1) {
    parts.forEach((p, i) => {
      const { f, source } = fils[i];
      const tag = source === 'hint' ? 'suggestie' : source === 'all' ? 'zoals alle' : 'eigen keus';
      rows.push(`
        <div class="fil-row" data-part="${i}">
          <span class="fil-name" title="${escapeHtml(p.name)}">${p.quantity > 1 ? `${p.quantity}× ` : ''}${escapeHtml(p.name)} <em>${tag}</em></span>
          ${dot(f)}
          <select data-role="line" aria-label="Filamentsoort voor ${escapeHtml(p.name)}">${lineOptions(f.line.id)}</select>
          <select data-role="color" aria-label="Kleur voor ${escapeHtml(p.name)}">${colorOptions(f)}</select>
          ${source === 'part' ? '<button type="button" class="ghost small" data-role="reset" title="Eigen keus wissen">↺</button>' : ''}
        </div>`);
    });
  }
  rows.push(`<p class="fil-printer">${escapeHtml(state.printer.name)} · ${volumeLabel(state.printer)} mm${ams ? ` · ${escapeHtml(ams.units.join(' / '))}, max. ${ams.maxSlots} kleuren` : ''}</p>`);
  box.innerHTML = rows.join('');

  const allLine = box.querySelector<HTMLSelectElement>('[data-role="all-line"]')!;
  allLine.addEventListener('change', () => {
    const line = FILAMENT_MAP[allLine.value];
    setAllFilament({ line: line.id, color: nearestColor(line, all.color.hex).code });
  });
  const allColor = box.querySelector<HTMLSelectElement>('[data-role="all-color"]')!;
  allColor.addEventListener('change', () => setAllFilament({ line: all.line.id, color: allColor.value }));
  for (const row of box.querySelectorAll<HTMLElement>('.fil-row[data-part]')) {
    const i = Number(row.dataset.part);
    const name = parts[i].name;
    const cur = fils[i].f;
    const lineSel = row.querySelector<HTMLSelectElement>('[data-role="line"]')!;
    lineSel.addEventListener('change', () => {
      const line = FILAMENT_MAP[lineSel.value];
      setPartFilament(name, { line: line.id, color: nearestColor(line, cur.color.hex).code });
    });
    const colSel = row.querySelector<HTMLSelectElement>('[data-role="color"]')!;
    colSel.addEventListener('change', () => setPartFilament(name, { line: cur.line.id, color: colSel.value }));
    row.querySelector('[data-role="reset"]')?.addEventListener('click', () => setPartFilament(name, null));
  }
}

function renderShopping(list: ShoppingList) {
  const box = $('#shopping-list');
  const spools = list.rows.reduce((s, r) => s + r.spools, 0);
  const kg = (g: number) => `${fmt(g / 1000, g % 1000 ? 1 : 0)} kg`;
  box.innerHTML = `
    <div class="table-wrap"><table class="shop">
      <thead><tr><th>Rol</th><th>Nodig</th><th>Koop</th><th>€</th></tr></thead>
      <tbody>${list.rows
        .map(
          (r) => `<tr>
            <td class="shop-name">${dot({ line: r.line, color: r.color })}<b>${escapeHtml(r.line.name)}</b> ${escapeHtml(r.color.name)} <span class="muted">${r.color.code}</span><br><span class="muted small">${escapeHtml(r.parts.join(', '))}</span></td>
            <td>≈ ${fmt(r.grams)} g<br><span class="muted small">${fmt(r.metres)} m</span></td>
            <td>${r.spools}× ${kg(r.line.spoolGrams)}<br><span class="muted small">${fmt(r.used * 100)}% gebruikt</span></td>
            <td>${fmt(r.costEur, 2)}</td>
          </tr>`,
        )
        .join('')}</tbody>
      <tfoot><tr><th>Totaal</th><th>≈ ${fmt(list.totalGrams)} g</th><th>${spools} ${spools === 1 ? 'rol' : 'rollen'}</th><th>${fmt(list.totalCostEur, 2)}</th></tr></tfoot>
    </table></div>
    <p class="muted small">Prijzen indicatief (Bambu Lab EU-shop, rol met spoel); refills zijn een paar euro goedkoper. Gewicht geschat met 2 wanden + 15% vulling (vase mode: 1 wand).</p>
    ${list.warnings.map((w) => `<div class="callout warn">${escapeHtml(w)}</div>`).join('')}
    ${list.notes.length ? `<ul class="shop-notes">${list.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}`;
}

/** Quick colour picks under the viewer: colours of the "all parts" filament line. */
function renderSwatches() {
  const swatches = $('#swatches');
  const all = resolveFilament(state.filament);
  const key = `${all.line.id}|${all.color.code}`;
  if (swatches.dataset.key === key) return;
  swatches.dataset.key = key;
  swatches.innerHTML = '';
  const shown = all.line.colors.slice(0, 10);
  if (!shown.includes(all.color)) shown[shown.length - 1] = all.color;
  for (const k of shown) {
    const b = document.createElement('button');
    b.className = `swatch${all.line.translucent || k.translucent ? ' see' : ''}`;
    b.type = 'button';
    b.style.setProperty('--c', k.hex);
    b.title = `${all.line.name} ${k.name}`;
    b.setAttribute('aria-label', `Kleur ${k.name}`);
    b.setAttribute('aria-pressed', String(k.code === all.color.code));
    b.addEventListener('click', () => setAllFilament({ line: all.line.id, color: k.code }));
    swatches.append(b);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Export

function objectsFor(plate: number | null): ExportObject[] {
  const res = state.result!;
  const placements = arrange(res.parts, state.printer, true);
  return res.parts.map((p, i) => {
    const { f } = filamentOf(p, res.parts);
    return {
    name: p.name,
    mesh: p.mesh,
    // alpha hints at see-through filament for 3MF viewers
    color: f.color.clear ? `${f.color.hex}40` : isTranslucent(f) ? `${f.color.hex}99` : f.color.hex,
    material: `${f.line.name} ${f.color.name}`,
    transforms: placements
      .filter((pl) => pl.part === i && (plate === null || pl.plate === plate))
      .map((pl) => {
        const x = pl.x + (plate === null ? plateOffset(state.printer, pl.plate) : 0);
        const c = pl.rotated ? 0 : 1;
        const s = pl.rotated ? 1 : 0;
        return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, pl.y, 0, 1];
      }),
    };
  }).filter((o) => o.transforms.length > 0);
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

/** An uploaded 3D model as stored: base64 of the float/index arrays. */
interface StoredMesh {
  positions: string;
  indices: string;
  unitKnown: boolean;
  decimatedFrom?: number;
}

interface StoredUpload {
  name: string;
  kind: 'font' | 'shape' | 'mesh';
  /** base64 font bytes, the converted outline or the triangles */
  data: string | ShapeAsset | StoredMesh;
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
      else if (u.kind === 'mesh') client.put({ type: 'mesh', key, mesh: meshFromStore(u.name, u.data as StoredMesh) });
      else client.put({ type: 'shape', key, shape: u.data as ShapeAsset });
    }
  } catch {
    // corrupt or unavailable storage: start without earlier uploads
  }
}

function meshFromStore(name: string, m: StoredMesh): MeshAsset {
  const p = base64ToBytes(m.positions);
  const i = base64ToBytes(m.indices);
  return { name, positions: new Float32Array(p.buffer, 0, p.length / 4), indices: new Uint32Array(i.buffer, 0, i.length / 4), unitKnown: m.unitKnown, decimatedFrom: m.decimatedFrom };
}

function hashBytes(b: Uint8Array) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}${b.length.toString(36)}`;
}

const fileHooks: FileHooks = {
  async upload(def: FileParam, file: File) {
    if (def.asset === 'mesh') {
      if (!/\.(stl|obj|3mf)$/i.test(file.name)) throw new Error('Kies een 3D-model (.stl, .obj of .3mf).');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mesh = parseMeshFile(bytes, file.name);
      const key = `upload:m${hashBytes(bytes)}`;
      client.put({ type: 'mesh', key, mesh });
      const b64 = (a: Float32Array | Uint32Array) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      rememberUpload(key, { name: file.name, kind: 'mesh', data: { positions: b64(mesh.positions), indices: b64(mesh.indices), unitKnown: mesh.unitKnown, decimatedFrom: mesh.decimatedFrom } });
      return key;
    }
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
  state.partFilament = loadPartFilament(tool.id);
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

function loadPartFilament(toolId: string): Record<string, FilamentChoice> {
  const saved = readJson<Record<string, FilamentChoice>>(`filament:parts:${toolId}`);
  const out: Record<string, FilamentChoice> = {};
  if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) if (v && FILAMENT_MAP[v.line]) out[k] = resolveChoice(v);
  return out;
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
  const series = [...new Set(PRINTERS.map((p) => p.series ?? 'Overig'))];
  printer.innerHTML = series
    .map(
      (s) =>
        `<optgroup label="${escapeHtml(s)}">${PRINTERS.filter((p) => (p.series ?? 'Overig') === s)
          .map((p) => `<option value="${p.id}">${escapeHtml(p.name.replace(/^Bambu Lab /, ''))} · ${volumeLabel(p)} mm${p.discontinued ? ' · uit productie' : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');
  printer.value = state.printer.id;
  const printerTitle = () =>
    (printer.title = `${state.printer.name}: ${volumeLabel(state.printer)} mm${state.printer.ams ? ` · ${state.printer.ams.units.join(' / ')}` : ''}${state.printer.note ? ` · ${state.printer.note}` : ''}`);
  printerTitle();
  printer.addEventListener('change', () => {
    state.printer = printerById(printer.value);
    store.set('printer', state.printer.id);
    printerTitle();
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

  $('#shop-copy').addEventListener('click', async () => {
    const list = currentList();
    if (!list) return;
    const btn = $('#shop-copy');
    try {
      await navigator.clipboard.writeText(shoppingText(list, state.tool.name, state.printer));
      btn.textContent = 'Gekopieerd ✓';
    } catch {
      btn.textContent = 'Kopiëren lukte niet';
    }
    setTimeout(() => (btn.textContent = 'Kopieer lijst'), 1800);
  });
  $('#shop-print').addEventListener('click', () => {
    if (!currentList()) return;
    $('#print-area').innerHTML = `<h1>Boodschappenlijst</h1><p>${escapeHtml(state.tool.name)} · ${escapeHtml(state.printer.name)}</p>${$('#shopping-list').innerHTML}`;
    window.print();
  });

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
