import type { BuildResult, Params, PrinterProfile } from './types';

type Pending = { resolve: (r: BuildResult) => void; reject: (e: Error) => void };

/**
 * Talks to the geometry worker. Falls back to building on the main thread
 * when workers (or module workers) are unavailable.
 */
export class GeometryClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private fallback: Promise<(tool: string, params: Params, printer: PrinterProfile) => BuildResult> | null = null;

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
      return w;
    } catch (err) {
      console.warn('Workers unavailable, using main thread', err);
      return null;
    }
  }

  private loadFallback() {
    if (!this.fallback) {
      this.fallback = (async () => {
        const [{ initManifold }, { runBuild }, { TOOL_MAP }, wasm] = await Promise.all([
          import('./manifold'),
          import('./engine'),
          import('../tools'),
          import('manifold-3d/manifold.wasm?url'),
        ]);
        const M = await initManifold(wasm.default);
        return (tool: string, params: Params, printer: PrinterProfile) => runBuild(M, TOOL_MAP[tool], params, printer);
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
          w.postMessage({ id, tool, params, printer });
        });
      } catch (err) {
        if ((err as Error).message !== 'worker-restart') throw err;
      }
    }
    const run = await this.loadFallback();
    // let the UI paint the "busy" state before blocking
    await new Promise((r) => setTimeout(r, 0));
    return run(tool, params, printer);
  }
}
