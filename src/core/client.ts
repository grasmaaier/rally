import { UserError, type BuildResult, type MeshAsset, type Params, type PrinterProfile, type ShapeAsset } from './types';

/** A build adapted to the printer: the (possibly shrunk) parameters it was built with. */
export interface FitInfo {
  params: Params;
  factor: number;
  fits: boolean;
}
export type FitBuild = BuildResult & { fit?: FitInfo };

type Pending = { resolve: (r: FitBuild) => void; reject: (e: Error) => void };
type Upload = { type: 'font'; key: string; bytes: ArrayBuffer } | { type: 'shape'; key: string; shape: ShapeAsset } | { type: 'mesh'; key: string; mesh: MeshAsset };
type Runner = (tool: string, params: Params, printer: PrinterProfile, fit: boolean) => Promise<FitBuild>;

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
        const { id, ok, result, fit, error, fatal } = e.data;
        const p = this.pending.get(id);
        if (fatal) {
          // the geometry kernel crashed (e.g. out of memory): start over with a fresh one
          w.terminate();
          if (this.worker === w) this.worker = this.spawn();
        }
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(fit ? { ...(result as BuildResult), fit: fit as FitInfo } : (result as BuildResult));
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
    else if (u.type === 'mesh') w.postMessage({ type: 'mesh', key: u.key, mesh: u.mesh });
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
        const [{ initManifold }, { runBuild }, { TOOL_MAP }, { AssetCache, browserSource }, { FONT_URLS }, { fitToPrinter }, wasm] = await Promise.all([
          import('./manifold'),
          import('./engine'),
          import('../tools'),
          import('./assets'),
          import('./fontUrls'),
          import('./fit'),
          import('manifold-3d/manifold.wasm?url'),
        ]);
        const M = await initManifold(wasm.default);
        const cache = new AssetCache(browserSource(FONT_URLS));
        const put = (u: Upload) => (u.type === 'font' ? cache.putFontBytes(u.key, u.bytes.slice(0)) : u.type === 'mesh' ? cache.putMesh(u.key, u.mesh) : cache.putShape(u.key, u.shape));
        for (const u of this.uploads.values()) put(u);
        const run: Runner = async (tool, params, printer, fit) => {
          const def = TOOL_MAP[tool];
          const build = async (p: Params) => {
            await cache.ensure(def.assets?.(p) ?? []);
            // let the UI paint the "busy" state before blocking
            await new Promise((r) => setTimeout(r, 0));
            return runBuild(M, def, p, printer, cache);
          };
          if (!fit) return build(params);
          const out = await fitToPrinter(def.params, params, printer, async (p) => {
            try {
              return { ok: true, result: await build(p) };
            } catch (err) {
              if (!(err as { user?: boolean })?.user) throw err;
              return { ok: false, error: String((err as Error).message) };
            }
          });
          if (!out.result) throw new UserError(out.error ?? 'Dit ontwerp past niet op deze printer.');
          return { ...out.result, fit: { params: out.params, factor: out.factor, fits: out.fits } };
        };
        return { run, put };
      })();
    }
    return this.fallback;
  }

  build(tool: string, params: Params, printer: PrinterProfile): Promise<BuildResult> {
    return this.request(tool, params, printer, false);
  }

  /** Build, shrinking the design's size parameters when it does not fit the printer (see core/fit.ts). */
  fit(tool: string, params: Params, printer: PrinterProfile): Promise<FitBuild> {
    return this.request(tool, params, printer, true);
  }

  private async request(tool: string, params: Params, printer: PrinterProfile, fit: boolean): Promise<FitBuild> {
    if (this.worker) {
      const id = ++this.seq;
      const w = this.worker;
      try {
        return await new Promise<FitBuild>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          w.postMessage({ type: fit ? 'fit' : 'build', id, tool, params, printer });
        });
      } catch (err) {
        if ((err as Error).message !== 'worker-restart') throw err;
      }
    }
    const { run } = await this.loadFallback();
    return run(tool, params, printer, fit);
  }
}
