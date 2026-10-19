/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from './manifold';
import { runBuild } from './engine';
import { TOOL_MAP } from '../tools';
import type { Params, PrinterProfile } from './types';

interface Req {
  id: number;
  tool: string;
  params: Params;
  printer: PrinterProfile;
}

const ready = initManifold(wasmUrl);

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, tool, params, printer } = e.data;
  try {
    const M = await ready;
    const def = TOOL_MAP[tool];
    if (!def) throw new Error(`Onbekende tool: ${tool}`);
    const result = runBuild(M, def, params, printer);
    const transfer: Transferable[] = [];
    for (const p of result.parts) transfer.push(p.mesh.positions.buffer, p.mesh.indices.buffer);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    // anything but a deliberate message means the WASM heap may be corrupt: ask for a fresh worker
    const fatal = !(err as { user?: boolean })?.user;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, fatal, error: String((err as Error)?.message ?? err) });
  }
};
