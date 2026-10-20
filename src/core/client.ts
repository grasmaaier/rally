import type { BuildResult, Params, PrinterProfile, ShapeAsset } from './types';

type Pending = { resolve: (r: BuildResult) => void; reject: (e: Error) => void };
type Upload = { type: 'font'; key: string; bytes: ArrayBuffer } | { type: 'shape'; key: string; shape: ShapeAsset };
type Runner = (tool: string, params: Params, printer: PrinterProfile) => Promise<BuildResult>;

/**
 * Talks to the geometry worker. Falls back to building on the main thread
 * when workers (or module workers) are unavailable.
 */
export class GeometryClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private fallback: Promise<{ run: Runner; put: (u: Upload) => void }> | null = null;
  /** Uploaded fonts/shapes, re-sent to a fresh worker after a restart. */
  private uploads = new Map<string, Upload>();

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker | null {
    try {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, ok, result, error, fatal } = e.data;
        const p = this.pending.get(id);
        if (fatal) {
          // the geometry kernel crashed (e.g. out of memory): start over with a fresh one
          w.terminate();
          if (this.worker === w) this.worker = this.spawn();
        }
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(result as BuildResult);
        else p.reject(new Error(fatal ? `Dit ontwerp is te zwaar of ongeldig voor de rekenkern (${error}). Probeer minder detail of andere maten.` : error));
      };
      w.onerror = (e) => {
        console.warn('Geometry worker failed, falling back to main thread', e);
        w.terminate();
        if (this.worker === w) this.worker = null;
        for (const [, p] of this.pending) p.reject(new Error('worker-restart'));
        this.pending.clear();
      };
      for (const u of this.uploads.values()) this.send(w, u);
      return w;
    } catch (err) {
      console.warn('Workers unavailable, using main thread', err);
      return null;
    }
  }

  private send(w: Worker, u: Upload) {
    // copy font bytes: the worker may be replaced and needs them again
    if (u.type === 'font') w.postMessage({ type: 'font', key: u.key, bytes: u.bytes.slice(0) });
    else w.postMessage({ type: 'shape', key: u.key, shape: u.shape });
  }

  /** Make an uploaded font or shape available to builds under `key`. */
  put(u: Upload) {
    this.uploads.set(u.key, u);
    if (this.worker) this.send(this.worker, u);
    this.fallback?.then((f) => f.put(u));
  }

  private loadFallback() {
    if (!this.fallback) {
      this.fallback = (async () => {
        const [{ initManifold }, { runBuild }, { TOOL_MAP }, { AssetCache, browserSource }, { FONT_URLS }, wasm] = await Promise.all([
          import('./manifold'),
          import('./engine'),
          import('../tools'),
          import('./assets'),
          import('./fontUrls'),
          import('manifold-3d/manifold.wasm?url'),
        ]);
        const M = await initManifold(wasm.default);
        const cache = new AssetCache(browserSource(FONT_URLS));
        const put = (u: Upload) => (u.type === 'font' ? cache.putFontBytes(u.key, u.bytes.slice(0)) : cache.putShape(u.key, u.shape));
        for (const u of this.uploads.values()) put(u);
        const run: Runner = async (tool, params, printer) => {
          const def = TOOL_MAP[tool];
          await cache.ensure(def.assets?.(params) ?? []);
          // let the UI paint the "busy" state before blocking
          await new Promise((r) => setTimeout(r, 0));
          return runBuild(M, def, params, printer, cache);
        };
        return { run, put };
      })();
    }
    return this.fallback;
  }

  async build(tool: string, params: Params, printer: PrinterProfile): Promise<BuildResult> {
    if (this.worker) {
      const id = ++this.seq;
      const w = this.worker;
      try {
        return await new Promise<BuildResult>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          w.postMessage({ type: 'build', id, tool, params, printer });
        });
      } catch (err) {
        if ((err as Error).message !== 'worker-restart') throw err;
      }
    }
    const { run } = await this.loadFallback();
    return run(tool, params, printer);
  }
}
