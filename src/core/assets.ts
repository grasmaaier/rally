import { parse, type Font } from 'opentype.js';
import { googleFontInfoUrl, googleFontUrl } from './fonts';
import { UserError, type AssetRef, type AssetStore, type ShapeAsset } from './types';

/** Where asset bytes come from; differs between the browser and the test runner. */
export interface AssetSource {
  /** Bytes of a bundled font by id. */
  bundledFont(id: string): Promise<ArrayBuffer>;
  /** Any URL (Google Fonts via the Fontsource CDN). */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  fetchJson?(url: string): Promise<unknown>;
}

const FREE_LICENSES = /^(OFL|Apache|UFL|MIT|CC0)/i;

/**
 * Loads and caches fonts and shapes so builds (which are synchronous) can
 * read them. Uploads are pushed in with `put*`.
 */
export class AssetCache implements AssetStore {
  private fonts = new Map<string, Font>();
  private shapes = new Map<string, ShapeAsset>();
  private uploads = new Map<string, ArrayBuffer>();
  private failed = new Map<string, string>();

  constructor(private source: AssetSource) {}

  putFontBytes(key: string, bytes: ArrayBuffer) {
    this.uploads.set(key, bytes);
    this.fonts.delete(key);
    this.failed.delete(key);
  }

  putShape(key: string, shape: ShapeAsset) {
    this.shapes.set(key, shape);
  }

  async ensure(refs: AssetRef[]) {
    for (const ref of refs) {
      if (ref.kind === 'font') await this.loadFont(ref.key);
      else if (!this.shapes.has(ref.key)) throw new UserError('De geüploade vorm is niet meer beschikbaar. Upload het SVG-bestand opnieuw.');
    }
  }

  private async loadFont(key: string) {
    if (this.fonts.has(key)) return;
    const earlier = this.failed.get(key);
    if (earlier) throw new UserError(earlier);
    let bytes: ArrayBuffer;
    try {
      bytes = await this.fontBytes(key);
    } catch (err) {
      const msg = err instanceof UserError ? err.message : `Lettertype kon niet geladen worden (${key}). Controleer de naam of je internetverbinding.`;
      this.failed.set(key, msg);
      throw new UserError(msg);
    }
    try {
      this.fonts.set(key, parse(bytes));
    } catch {
      const msg = 'Dit lettertypebestand kan niet gelezen worden. Gebruik een TTF-, OTF- of WOFF-bestand (geen WOFF2).';
      this.failed.set(key, msg);
      throw new UserError(msg);
    }
  }

  private async fontBytes(key: string): Promise<ArrayBuffer> {
    const [kind, ...rest] = key.split(':');
    if (kind === 'bundled') return this.source.bundledFont(rest[0]);
    if (kind === 'upload') {
      const b = this.uploads.get(key);
      if (!b) throw new UserError('Het geüploade lettertype is niet meer beschikbaar. Upload het bestand opnieuw.');
      return b;
    }
    if (kind === 'google') {
      const family = rest[0];
      const weight = Number(rest[1] ?? 400);
      if (this.source.fetchJson) {
        // only free Google Fonts: check the license before downloading
        const info = (await this.source.fetchJson(googleFontInfoUrl(family)).catch(() => null)) as { type?: string; license?: string; weights?: number[] } | null;
        if (!info) throw new UserError(`Google Font "${family}" niet gevonden. Controleer de spelling (bijv. "Roboto Slab").`);
        if (info.type !== 'google' || !FREE_LICENSES.test(info.license ?? '')) throw new UserError(`"${family}" is geen vrij te gebruiken Google Font.`);
        if (info.weights && !info.weights.includes(weight)) {
          const nearest = [...info.weights].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight))[0];
          return this.source.fetchBytes(googleFontUrl(family, nearest));
        }
      }
      return this.source.fetchBytes(googleFontUrl(family, weight));
    }
    throw new UserError(`Onbekend lettertype: ${key}`);
  }

  font(key: string): Font {
    const f = this.fonts.get(key);
    if (!f) throw new UserError(`Lettertype niet geladen: ${key}`);
    return f;
  }

  shape(key: string): ShapeAsset {
    const s = this.shapes.get(key);
    if (!s) throw new UserError('De geüploade vorm is niet meer beschikbaar. Upload het SVG-bestand opnieuw.');
    return s;
  }
}

/** Asset source for browsers and workers. */
export function browserSource(bundledUrls: Record<string, string>): AssetSource {
  const get = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res;
  };
  return {
    bundledFont: async (id) => {
      const url = bundledUrls[id];
      if (!url) throw new UserError(`Onbekend lettertype: ${id}`);
      return (await get(url)).arrayBuffer();
    },
    fetchBytes: async (url) => (await get(url)).arrayBuffer(),
    fetchJson: async (url) => (await get(url)).json(),
  };
}
