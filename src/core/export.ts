import { strToU8, zipSync } from 'fflate';
import type { MeshData, PrinterProfile } from './types';
import { plateCenter } from './printer';

export interface ExportObject {
  name: string;
  mesh: MeshData;
  /** One entry per copy: column-major 4x4 transforms into plate coordinates (origin = plate centre). */
  transforms: number[][];
  /** Filament colour shown by 3MF viewers ('#rrggbb' or '#rrggbbaa'). */
  color?: string;
  /** Name of that colour/material, e.g. "PLA Basic Jadewit". */
  material?: string;
}

function fmt(v: number) {
  // compact but precise enough (0.1 µm)
  const s = v.toFixed(4);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * 3MF (core spec) that Bambu Studio, OrcaSlicer and PrusaSlicer open directly.
 * Object colours are written as core-spec base materials (displaycolor): 3MF
 * viewers show them; slicers keep their own filament assignment.
 */
export function build3MF(objects: ExportObject[], printer: PrinterProfile, title: string): Uint8Array {
  const parts: string[] = [];
  parts.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="nl-NL" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    `<metadata name="Title">${escapeXml(title)}</metadata>\n`,
    '<metadata name="Application">Rally Printstudio</metadata>\n',
    '<resources>\n',
  );
  // one base material per distinct colour, declared before the objects that use it
  const matId = objects.length + 1;
  const mats: { color: string; name: string }[] = [];
  const matIndex = objects.map((o) => {
    if (!o.color) return -1;
    const color = displayColor(o.color);
    const name = o.material ?? color;
    let k = mats.findIndex((m) => m.color === color && m.name === name);
    if (k < 0) k = mats.push({ color, name }) - 1;
    return k;
  });
  if (mats.length) {
    parts.push(`<basematerials id="${matId}">\n`);
    for (const m of mats) parts.push(`<base name="${escapeXml(m.name)}" displaycolor="${m.color}"/>\n`);
    parts.push('</basematerials>\n');
  }
  objects.forEach((o, i) => {
    const mat = matIndex[i] >= 0 ? ` pid="${matId}" pindex="${matIndex[i]}"` : '';
    parts.push(`<object id="${i + 1}" name="${escapeXml(o.name)}" type="model"${mat}><mesh><vertices>\n`);
    const p = o.mesh.positions;
    const chunk: string[] = [];
    for (let v = 0; v < p.length; v += 3) chunk.push(`<vertex x="${fmt(p[v])}" y="${fmt(p[v + 1])}" z="${fmt(p[v + 2])}"/>`);
    parts.push(chunk.join('\n'), '\n</vertices><triangles>\n');
    const t = o.mesh.indices;
    const tri: string[] = [];
    for (let k = 0; k < t.length; k += 3) tri.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>`);
    parts.push(tri.join('\n'), '\n</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n');
  const [cx, cy] = plateCenter(printer);
  objects.forEach((o, i) => {
    for (const m of o.transforms) {
      const tr = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12] + cx, m[13] + cy, m[14]];
      parts.push(`<item objectid="${i + 1}" transform="${tr.map(fmt).join(' ')}"/>\n`);
    }
  });
  parts.push('</build>\n</model>\n');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

  return zipSync(
    {
      // flat paths: no separate directory entries, which strict OPC readers dislike
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(parts.join('')),
    },
    { level: 6 },
  );
}

/** '#rgb'/'#rrggbb'/'#rrggbbaa' → '#RRGGBBAA' as the 3MF spec wants it. */
function displayColor(hex: string): string {
  let h = hex.replace('#', '').toUpperCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(h)) return '#FFFFFFFF';
  return `#${h.length === 6 ? `${h}FF` : h}`;
}

/** Binary STL of all copies merged into one file. */
export function buildSTL(objects: ExportObject[]): Uint8Array {
  let triCount = 0;
  for (const o of objects) triCount += (o.mesh.indices.length / 3) * o.transforms.length;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = 'Rally Printstudio STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const o of objects) {
    const p = o.mesh.positions;
    const t = o.mesh.indices;
    for (const m of o.transforms) {
      for (let k = 0; k < t.length; k += 3) {
        for (let c = 0; c < 3; c++) {
          const i = t[k + c] * 3;
          const x = p[i];
          const y = p[i + 1];
          const z = p[i + 2];
          v[c * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          v[c * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          v[c * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
        const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        dv.setFloat32(off, nx, true);
        dv.setFloat32(off + 4, ny, true);
        dv.setFloat32(off + 8, nz, true);
        for (let q = 0; q < 9; q++) dv.setFloat32(off + 12 + q * 4, v[q], true);
        dv.setUint16(off + 48, 0, true);
        off += 50;
      }
    }
  }
  return new Uint8Array(buf);
}

interface HostDownloads {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}

/** Hosts that only allow plain archive downloads (e.g. a sandboxed preview frame). */
function hostDownloads(): Promise<HostDownloads | null> | null {
  const host = (window as unknown as { claude?: { use?: (n: string) => Promise<HostDownloads | null> } }).claude;
  return typeof host?.use === 'function' ? host.use('downloads') : null;
}

export async function download(data: Uint8Array | string, filename: string, mime: string) {
  const host = hostDownloads();
  if (host) {
    const dl = await host;
    if (!dl) throw new Error('Downloaden is hier niet beschikbaar.');
    // 3MF/STL are not on such hosts' allowlist: hand them over inside a ZIP
    const isModel = /\.(3mf|stl)$/i.test(filename);
    const bytes = typeof data === 'string' ? strToU8(data) : data;
    const blob = isModel
      ? new Blob([zipSync({ [filename]: bytes }, { level: 0 }) as BlobPart])
      : new Blob([bytes as BlobPart], { type: mime });
    await dl.save({ filename: isModel ? `${filename}.zip` : filename, data: blob });
    return;
  }
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'model'
  );
}
