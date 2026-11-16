/**
 * Personal design library in browser storage. Every storage call is guarded:
 * private mode, a full quota or corrupt data must never break the app.
 */
import type { Params } from '../core/types';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Design {
  id: string;
  name: string;
  tool: string;
  params: Params;
  /** Small JPEG data URL of the viewer. */
  thumb?: string;
  created: number;
  updated: number;
}

export type SaveResult = { ok: true; design: Design; withoutThumb?: boolean } | { ok: false; error: string };

const isParams = (v: unknown): v is Params =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean');

function valid(d: unknown): d is Design {
  if (!d || typeof d !== 'object') return false;
  const x = d as Design;
  return typeof x.id === 'string' && typeof x.name === 'string' && typeof x.tool === 'string' && isParams(x.params) && typeof x.updated === 'number';
}

export class Library {
  constructor(
    private kv: KV | null,
    private key = 'rally:library',
    private now: () => number = () => Date.now(),
  ) {}

  private read(): Design[] {
    try {
      const raw = this.kv?.getItem(this.key);
      if (!raw) return [];
      const data = JSON.parse(raw) as unknown;
      return Array.isArray(data) ? data.filter(valid) : [];
    } catch {
      return [];
    }
  }

  private write(list: Design[]): string | null {
    if (!this.kv) return 'Opslaan is niet beschikbaar in deze browser (privévenster?).';
    try {
      this.kv.setItem(this.key, JSON.stringify(list));
      return null;
    } catch (err) {
      return (err as Error)?.name === 'QuotaExceededError' || /quota/i.test(String(err)) ? 'De opslag van de browser is vol. Verwijder een paar ontwerpen.' : 'Opslaan lukte niet.';
    }
  }

  /** Newest first; optionally only one tool's designs. */
  list(tool?: string): Design[] {
    return this.read()
      .filter((d) => !tool || d.tool === tool)
      .sort((a, b) => b.updated - a.updated);
  }

  get(id: string): Design | null {
    return this.read().find((d) => d.id === id) ?? null;
  }

  /** Save a new design (or overwrite `id`). Retries without the thumbnail when storage is full. */
  save(input: { id?: string; name: string; tool: string; params: Params; thumb?: string }): SaveResult {
    const list = this.read();
    const t = this.now();
    const name = input.name.trim().slice(0, 80) || 'Naamloos ontwerp';
    const old = input.id ? list.find((d) => d.id === input.id) : undefined;
    const design: Design = {
      id: old?.id ?? `d${t.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name,
      tool: input.tool,
      params: { ...input.params },
      thumb: input.thumb,
      created: old?.created ?? t,
      updated: t,
    };
    const rest = list.filter((d) => d.id !== design.id);
    let err = this.write([design, ...rest]);
    if (!err) return { ok: true, design };
    if (design.thumb) {
      delete design.thumb;
      err = this.write([design, ...rest]);
      if (!err) return { ok: true, design, withoutThumb: true };
    }
    return { ok: false, error: err };
  }

  rename(id: string, name: string): boolean {
    const list = this.read();
    const d = list.find((x) => x.id === id);
    if (!d) return false;
    d.name = name.trim().slice(0, 80) || d.name;
    d.updated = this.now();
    return this.write(list) === null;
  }

  remove(id: string): boolean {
    const list = this.read();
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    return this.write(next) === null;
  }
}

/** localStorage when it works, else null. */
export function browserKV(): KV | null {
  try {
    const s = window.localStorage;
    const probe = 'rally:probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
