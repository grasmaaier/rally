/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from './manifold';
import { runBuild } from './engine';
import { AssetCache, browserSource } from './assets';
import { FONT_URLS } from './fontUrls';
import { TOOL_MAP } from '../tools';
import type { Params, PrinterProfile, ShapeAsset } from './types';

type Req =
  | { type: 'build'; id: number; tool: string; params: Params; printer: PrinterProfile }
  | { type: 'font'; key: string; bytes: ArrayBuffer }
  | { type: 'shape'; key: string; shape: ShapeAsset };

const ready = initManifold(wasmUrl);
const assets = new AssetCache(browserSource(FONT_URLS));
const scope = self as unknown as DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  if (msg.type === 'font') return assets.putFontBytes(msg.key, msg.bytes);
  if (msg.type === 'shape') return assets.putShape(msg.key, msg.shape);
  const { id, tool, params, printer } = msg;
  try {
    const M = await ready;
    const def = TOOL_MAP[tool];
    if (!def) throw new Error(`Onbekende tool: ${tool}`);
    await assets.ensure(def.assets?.(params) ?? []);
    const result = runBuild(M, def, params, printer, assets);
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.mesh.positions.buffer, p.mesh.indices.buffer);
    scope.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    // anything but a deliberate message means the WASM heap may be corrupt: ask for a fresh worker
    const fatal = !(err as { user?: boolean })?.user;
    scope.postMessage({ id, ok: false, fatal, error: String((err as Error)?.message ?? err) });
  }
};
