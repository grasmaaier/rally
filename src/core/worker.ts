/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from './manifold';
import { runBuild } from './engine';
import { AssetCache, browserSource } from './assets';
import { FONT_URLS } from './fontUrls';
import { TOOL_MAP } from '../tools';
import { fitToPrinter } from './fit';
import { UserError, type BuildResult, type MeshAsset, type Params, type PrinterProfile, type ShapeAsset } from './types';

type Req =
  | { type: 'build' | 'fit'; id: number; tool: string; params: Params; printer: PrinterProfile }
  | { type: 'font'; key: string; bytes: ArrayBuffer }
  | { type: 'shape'; key: string; shape: ShapeAsset }
  | { type: 'mesh'; key: string; mesh: MeshAsset };

const ready = initManifold(wasmUrl);
const assets = new AssetCache(browserSource(FONT_URLS));
const scope = self as unknown as DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  if (msg.type === 'font') return assets.putFontBytes(msg.key, msg.bytes);
  if (msg.type === 'shape') return assets.putShape(msg.key, msg.shape);
  if (msg.type === 'mesh') return assets.putMesh(msg.key, msg.mesh);
  const { id, tool, params, printer } = msg;
  try {
    const M = await ready;
    const def = TOOL_MAP[tool];
    if (!def) throw new Error(`Onbekende tool: ${tool}`);
    const build = async (p: Params) => {
      await assets.ensure(def.assets?.(p) ?? []);
      return runBuild(M, def, p, printer, assets);
    };
    const transfer: Transferable[] = [];
    const send = (result: BuildResult) => {
      for (const p of result.parts) transfer.push(p.mesh.positions.buffer, p.mesh.indices.buffer);
    };
    if (msg.type === 'fit') {
      const fit = await fitToPrinter(def.params, params, printer, async (p) => {
        try {
          return { ok: true, result: await build(p) };
        } catch (err) {
          if (!(err as { user?: boolean })?.user) throw err;
          return { ok: false, error: String((err as Error).message) };
        }
      });
      if (!fit.result) throw new UserError(fit.error ?? 'Dit ontwerp past niet op deze printer.');
      send(fit.result);
      scope.postMessage({ id, ok: true, result: fit.result, fit: { params: fit.params, factor: fit.factor, fits: fit.fits } }, transfer);
      return;
    }
    const result = await build(params);
    send(result);
    scope.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    // anything but a deliberate message means the WASM heap may be corrupt: ask for a fresh worker
    const fatal = !(err as { user?: boolean })?.user;
    scope.postMessage({ id, ok: false, fatal, error: String((err as Error)?.message ?? err) });
  }
};
