/**
 * Designs in the URL hash: `#tool?key=value&…` with only the values that
 * differ from the defaults. Decoding validates every value against the
 * schema, so a hand-edited or old link never breaks the app.
 */
import { defaultsOf, type ParamDef, type Params, type ParamValue } from '../core/types';

export function encodeParams(defs: ParamDef[], params: Params): string {
  const base = defaultsOf(defs);
  const q = new URLSearchParams();
  for (const d of defs) {
    if (d.type === 'group') continue;
    const v = params[d.key];
    if (v !== undefined && v !== base[d.key]) q.set(d.key, String(v));
  }
  return q.toString();
}

export function encodeHash(toolId: string, defs: ParamDef[], params: Params): string {
  const s = encodeParams(defs, params);
  return `#${toolId}${s ? `?${s}` : ''}`;
}

/** One raw value from a link, checked against its definition (null = use the default). */
export function parseValue(d: ParamDef, raw: string): ParamValue | null {
  switch (d.type) {
    case 'number': {
      const v = Number(raw);
      // typed values may go past the slider; keep them, within twice the range
      if (!Number.isFinite(v)) return null;
      const span = d.max - d.min;
      return Math.min(d.max + span, Math.max(d.min - span, v));
    }
    case 'bool':
      return raw === 'true' ? true : raw === 'false' ? false : null;
    case 'select':
      return d.options.some((o) => o.value === raw) ? raw : null;
    case 'text':
      return raw.slice(0, d.maxLength ?? 120);
    case 'file':
      return /^upload:[\w-]+$/.test(raw) ? raw : '';
    default:
      return null;
  }
}

export function decodeParams(defs: ParamDef[], query: string): Params {
  const params = defaultsOf(defs);
  const q = new URLSearchParams(query);
  for (const d of defs) {
    if (d.type === 'group' || !q.has(d.key)) continue;
    const v = parseValue(d, q.get(d.key)!);
    if (v !== null) params[d.key] = v;
  }
  return params;
}

export interface DecodedHash {
  toolId: string;
  /** Null when the link names only the tool (no values). */
  params: Params | null;
}

export function decodeHash(hash: string, tools: Record<string, { params: ParamDef[] }>): DecodedHash | null {
  const h = hash.replace(/^#\/?/, '');
  if (!h) return null;
  const i = h.indexOf('?');
  const id = i < 0 ? h : h.slice(0, i);
  const tool = tools[id];
  if (!tool) return null;
  const query = i < 0 ? '' : h.slice(i + 1);
  return { toolId: id, params: query ? decodeParams(tool.params, query) : null };
}
