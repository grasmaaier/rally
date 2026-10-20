import { strFromU8, unzipSync } from 'fflate';
import { UserError, type MeshAsset } from '../core/types';

/** Files above this size are refused before reading (the browser would struggle anyway). */
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
/** Raw triangle count a file may have before it is refused outright. */
export const MAX_INPUT_TRIANGLES = 5_000_000;
/** Uploads with more triangles are simplified (vertex clustering) down to this budget. */
export const MAX_TRIANGLES = 150_000;

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

interface Raw {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  unitKnown: boolean;
}

/**
 * Read an STL (binary or ASCII), OBJ or 3MF file into a welded triangle soup
 * in millimetres. Malformed input throws a UserError with a Dutch message.
 */
export function parseMeshFile(data: ArrayBuffer | Uint8Array, name: string): MeshAsset {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MAX_FILE_BYTES) throw new UserError(`Dit bestand is te groot (${Math.round(bytes.length / 1e6)} MB, maximaal ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  if (bytes.length < 15) throw new UserError('Dit bestand is leeg of te kort voor een 3D-model.');
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let raw: Raw;
  if (ext === '3mf' || zip) raw = parse3MF(bytes);
  else if (ext === 'obj') raw = parseOBJ(decode(bytes));
  else if (ext === 'stl' || ext === '') raw = parseSTL(bytes);
  else throw new UserError('Kies een 3D-model als STL, OBJ of 3MF.');
  const { positions, indices } = clean(raw.positions, raw.indices);
  const tris = indices.length / 3;
  if (tris < 4) throw new UserError('Er staan (bijna) geen driehoeken in dit bestand. Is het een geldig 3D-model?');
  const out: MeshAsset = { name, positions, indices, unitKnown: raw.unitKnown };
  if (tris > MAX_TRIANGLES) {
    const d = decimate(positions, indices, MAX_TRIANGLES);
    out.positions = d.positions;
    out.indices = d.indices;
    out.decimatedFrom = tris;
  }
  return out;
}

function decode(bytes: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// ---------------------------------------------------------------------------
// STL

function parseSTL(bytes: Uint8Array): Raw {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  const binarySize = 84 + 50 * n;
  const head = decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
  const looksAscii = head.startsWith('solid') && /facet|endsolid/.test(decode(bytes.subarray(0, Math.min(bytes.length, 4096))).toLowerCase());
  // Many binary files start their header with "solid" too: an exact size match wins.
  if (n > 0 && bytes.length === binarySize) return parseBinarySTL(view, n);
  if (looksAscii) return parseAsciiSTL(decode(bytes));
  if (n > 0 && bytes.length > binarySize) return parseBinarySTL(view, n);
  throw new UserError('Dit STL-bestand is beschadigd of onvolledig (de grootte klopt niet met het aantal driehoeken).');
}

function parseBinarySTL(view: DataView, n: number): Raw {
  if (n > MAX_INPUT_TRIANGLES) throw new UserError(`Dit model heeft te veel driehoeken (${n.toLocaleString('nl-NL')}). Maximaal ${MAX_INPUT_TRIANGLES.toLocaleString('nl-NL')}.`);
  const positions = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + k * 4, true);
  }
  return { positions, indices: identityIndices(n * 3), unitKnown: false };
}

function parseAsciiSTL(text: string): Raw {
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const pos: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pos.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (pos.length > MAX_INPUT_TRIANGLES * 9) throw new UserError('Dit model heeft te veel driehoeken.');
  }
  if (pos.length % 9 !== 0) throw new UserError('Dit STL-bestand is beschadigd: een vlak heeft geen drie hoekpunten.');
  if (!pos.length) throw new UserError('Geen driehoeken gevonden in dit STL-bestand.');
  return { positions: pos, indices: identityIndices(pos.length / 3), unitKnown: false };
}

function identityIndices(n: number) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return idx;
}

// ---------------------------------------------------------------------------
// OBJ

function parseOBJ(text: string): Raw {
  const pos: number[] = [];
  const idx: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line.startsWith('v ') || line.startsWith('v\t')) {
      const f = line.split(/\s+/);
      pos.push(Number(f[1]), Number(f[2]), Number(f[3]));
    } else if (line.startsWith('f ') || line.startsWith('f\t')) {
      const f = line.split(/\s+/).slice(1).filter(Boolean);
      const nv = pos.length / 3;
      const ids = f.map((tok) => {
        const v = parseInt(tok.split('/')[0], 10);
        const i = v < 0 ? nv + v : v - 1;
        if (!Number.isInteger(i) || i < 0 || i >= nv) throw new UserError(`Dit OBJ-bestand is beschadigd: vlak op regel ${li + 1} verwijst naar een hoekpunt dat niet bestaat.`);
        return i;
      });
      for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0], ids[k], ids[k + 1]);
      if (idx.length > MAX_INPUT_TRIANGLES * 3) throw new UserError('Dit model heeft te veel driehoeken.');
    }
  }
  if (!idx.length) throw new UserError('Geen vlakken gevonden in dit OBJ-bestand.');
  return { positions: pos, indices: idx, unitKnown: false };
}

// ---------------------------------------------------------------------------
// 3MF (zip with XML model parts; supports components and the production extension)

interface Obj3MF {
  pos: number[];
  idx: number[];
  comps: { id: string; path?: string; m: number[] }[];
}

const attrs = (s: string) => {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
};

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function parseTransform(s: string | undefined): number[] {
  if (!s) return IDENT;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return IDENT;
  return v;
}

/** 3MF matrices are row-vector style: p' = p · M (3 rows of rotation, then the translation). */
function compose(a: number[], b: number[]): number[] {
  // apply a first, then b
  const out = new Array(12).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      let s = r === 3 ? b[9 + c] : 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = s;
    }
  return out;
}

function parse3MF(bytes: Uint8Array): Raw {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => /\.model$/i.test(f.name) });
  } catch {
    throw new UserError('Dit 3MF-bestand kan niet worden uitgepakt (beschadigd zip-bestand).');
  }
  const names = Object.keys(files);
  if (!names.length) throw new UserError('Geen 3D-model gevonden in dit 3MF-bestand.');
  const norm = (p: string) => p.replace(/^\/+/, '').toLowerCase();
  const models = new Map<string, { objects: Map<string, Obj3MF>; items: { id: string; m: number[] }[]; unit: number }>();
  let total = 0;
  for (const n of names) {
    const xml = strFromU8(files[n]);
    const unit = UNIT_MM[/<model\b[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(xml)?.[1] ?? 'millimeter'] ?? 1;
    const objects = new Map<string, Obj3MF>();
    const objRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(xml))) {
      const id = attrs(om[1]).id;
      const body = om[2];
      const o: Obj3MF = { pos: [], idx: [], comps: [] };
      const vRe = /<(?:\w+:)?vertex\b([^>]*)\/?>/g;
      let m: RegExpExecArray | null;
      while ((m = vRe.exec(body))) {
        const a = attrs(m[1]);
        o.pos.push(Number(a.x), Number(a.y), Number(a.z));
      }
      const tRe = /<(?:\w+:)?triangle\b([^>]*)\/?>/g;
      const nv = o.pos.length / 3;
      while ((m = tRe.exec(body))) {
        const a = attrs(m[1]);
        const t = [Number(a.v1), Number(a.v2), Number(a.v3)];
        if (t.some((v) => !Number.isInteger(v) || v < 0 || v >= nv)) throw new UserError('Dit 3MF-bestand is beschadigd: een driehoek verwijst naar een hoekpunt dat niet bestaat.');
        o.idx.push(t[0], t[1], t[2]);
      }
      total += o.idx.length / 3;
      if (total > MAX_INPUT_TRIANGLES) throw new UserError('Dit model heeft te veel driehoeken.');
      const cRe = /<(?:\w+:)?component\b([^>]*)\/?>/g;
      while ((m = cRe.exec(body))) {
        const a = attrs(m[1]);
        o.comps.push({ id: a.objectid, path: a['p:path'] ?? a.path, m: parseTransform(a.transform) });
      }
      if (id) objects.set(id, o);
    }
    const items: { id: string; m: number[] }[] = [];
    const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml)?.[1] ?? '';
    const iRe = /<(?:\w+:)?item\b([^>]*)\/?>/g;
    let im: RegExpExecArray | null;
    while ((im = iRe.exec(build))) {
      const a = attrs(im[1]);
      if (a.printable === '0') continue;
      items.push({ id: a.objectid, m: parseTransform(a.transform) });
    }
    models.set(norm(n), { objects, items, unit });
  }
  const rootName = models.has('3d/3dmodel.model') ? '3d/3dmodel.model' : [...models.keys()].find((k) => models.get(k)!.items.length) ?? [...models.keys()][0];
  const root = models.get(rootName)!;
  const pos: number[] = [];
  const idx: number[] = [];
  const emit = (model: string, id: string, m: number[], depth: number) => {
    if (depth > 16) throw new UserError('Dit 3MF-bestand verwijst eindeloos naar zichzelf.');
    const o = models.get(model)?.objects.get(id);
    if (!o) return;
    const base = pos.length / 3;
    for (let i = 0; i < o.pos.length; i += 3) {
      const [x, y, z] = [o.pos[i], o.pos[i + 1], o.pos[i + 2]];
      pos.push(x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]);
    }
    for (const v of o.idx) idx.push(base + v);
    for (const c of o.comps) emit(c.path ? norm(c.path) : model, c.id, compose(c.m, m), depth + 1);
  };
  if (root.items.length) for (const it of root.items) emit(rootName, it.id, it.m, 0);
  else for (const id of root.objects.keys()) emit(rootName, id, IDENT, 0);
  if (!idx.length) throw new UserError('Geen driehoeken gevonden in dit 3MF-bestand.');
  if (root.unit !== 1) for (let i = 0; i < pos.length; i++) pos[i] *= root.unit;
  return { positions: pos, indices: idx, unitKnown: true };
}

// ---------------------------------------------------------------------------
// Cleaning and simplification

/** Weld identical vertices, drop degenerate triangles and check the coordinates. */
function clean(positions: ArrayLike<number>, indices: ArrayLike<number>) {
  const map = new Map<string, number>();
  const remap = new Uint32Array(positions.length / 3);
  const pos: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || Math.abs(z) > 1e7)
      throw new UserError('Dit model bevat ongeldige coördinaten (geen getal of veel te groot).');
    // compare as float32 so STL duplicates weld exactly
    const key = `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;
    let v = map.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      map.set(key, v);
      pos.push(x, y, z);
    }
    remap[i] = v;
  }
  const P = new Float32Array(pos);
  const idx: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]];
    const b = remap[indices[t + 1]];
    const c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    if (triArea2(P, a, b, c) < 1e-14) continue;
    idx.push(a, b, c);
  }
  return { positions: P, indices: new Uint32Array(idx) };
}

function triArea2(P: Float32Array, a: number, b: number, c: number) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

/**
 * Vertex clustering: snap vertices to a grid and merge each cell into its
 * average. Crude but robust (the result only feeds a distance field, so it
 * does not need to stay watertight). The cell grows until the budget is met.
 */
export function decimate(positions: Float32Array, indices: Uint32Array, budget: number) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  let cell = diag / Math.sqrt(budget) / 1.5;
  for (let iter = 0; iter < 30; iter++, cell *= 1.25) {
    const cells = new Map<number, number>();
    const sum: number[] = [];
    const remap = new Uint32Array(positions.length / 3);
    const nx = Math.ceil((maxX - minX) / cell) + 1;
    const ny = Math.ceil((maxY - minY) / cell) + 1;
    for (let v = 0; v < remap.length; v++) {
      const i = Math.floor((positions[v * 3] - minX) / cell);
      const j = Math.floor((positions[v * 3 + 1] - minY) / cell);
      const k = Math.floor((positions[v * 3 + 2] - minZ) / cell);
      const key = (k * ny + j) * nx + i;
      let c = cells.get(key);
      if (c === undefined) {
        c = sum.length / 4;
        cells.set(key, c);
        sum.push(0, 0, 0, 0);
      }
      sum[c * 4] += positions[v * 3];
      sum[c * 4 + 1] += positions[v * 3 + 1];
      sum[c * 4 + 2] += positions[v * 3 + 2];
      sum[c * 4 + 3]++;
      remap[v] = c;
    }
    const idx: number[] = [];
    const seen = new Set<string>();
    for (let t = 0; t < indices.length; t += 3) {
      const a = remap[indices[t]];
      const b = remap[indices[t + 1]];
      const c = remap[indices[t + 2]];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      idx.push(a, b, c);
    }
    if (idx.length / 3 > budget) continue;
    const P = new Float32Array((sum.length / 4) * 3);
    for (let c = 0; c < sum.length / 4; c++) {
      P[c * 3] = sum[c * 4] / sum[c * 4 + 3];
      P[c * 3 + 1] = sum[c * 4 + 1] / sum[c * 4 + 3];
      P[c * 3 + 2] = sum[c * 4 + 2] / sum[c * 4 + 3];
    }
    return { positions: P, indices: new Uint32Array(idx) };
  }
  throw new UserError('Dit model kon niet genoeg vereenvoudigd worden. Exporteer het met minder detail.');
}
