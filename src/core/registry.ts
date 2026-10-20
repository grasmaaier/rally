/**
 * Manifold objects live in WASM memory and must be freed explicitly. Every
 * constructor/operation that returns a new object is tracked here, so a whole
 * build can be freed at once with `collect()`.
 */
const registry: { delete(): void }[] = [];

export function track<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) track(v);
  } else if (value && typeof (value as { delete?: unknown }).delete === 'function') {
    registry.push(value as unknown as { delete(): void });
  }
  return value;
}

/** Register an object created with `new` so it is freed by `collect()`. */
export function keep<T>(value: T): T {
  return track(value);
}

/** Free every WASM object created since the last collect. */
export function collect() {
  for (const obj of registry) {
    try {
      obj.delete();
    } catch {
      // already deleted
    }
  }
  registry.length = 0;
}

interface WasmVec<T> {
  size(): number;
  get(i: number): T;
  delete(): void;
}
type RawCross = { _ToPolygons(): WasmVec<WasmVec<{ x: number; y: number }>> };
type RawManifold = { _Translate(v: { x: number; y: number; z: number }): RawManifold; delete(): void };

/**
 * manifold-3d 3.5 ships JS wrappers that leak WASM memory on every call:
 * `CrossSection.extrude` and `.revolve` never free the polygon vector they
 * hand to the kernel (the whole outline, ~2.8 kB for a 200-point circle), and
 * `.toPolygons` never frees its per-contour vectors. This swaps in leak-free
 * versions with the same behaviour. Call once on the real CrossSection
 * prototype, after `M.setup()` and before the methods are wrapped by `track`.
 */
export function fixLeakyWrappers(M: object, crossProto: Record<string, unknown>) {
  const mod = M as { _Extrude(...a: unknown[]): RawManifold; _Revolve(...a: unknown[]): RawManifold };
  crossProto.extrude = function (this: RawCross, height: number, nDivisions = 0, twistDegrees = 0, scaleTop: unknown = [1, 1], center = false) {
    const top = Array.isArray(scaleTop) ? { x: scaleTop[0], y: scaleTop[1] } : typeof scaleTop === 'number' ? { x: scaleTop, y: scaleTop } : scaleTop;
    const polys = this._ToPolygons();
    let man: RawManifold;
    try {
      man = mod._Extrude(polys, height, nDivisions, twistDegrees, top);
    } finally {
      polys.delete();
    }
    if (!center) return man;
    const moved = man._Translate({ x: 0, y: 0, z: -height / 2 });
    man.delete();
    return moved;
  };
  crossProto.revolve = function (this: RawCross, circularSegments = 0, revolveDegrees = 360) {
    const polys = this._ToPolygons();
    try {
      return mod._Revolve(polys, circularSegments, revolveDegrees);
    } finally {
      polys.delete();
    }
  };
  crossProto.toPolygons = function (this: RawCross) {
    const vec = this._ToPolygons();
    const out: [number, number][][] = [];
    for (let i = 0; i < vec.size(); i++) {
      const v = vec.get(i);
      const poly: [number, number][] = [];
      for (let j = 0; j < v.size(); j++) {
        const p = v.get(j);
        poly.push([p.x, p.y]);
      }
      v.delete();
      out.push(poly);
    }
    vec.delete();
    return out;
  };
}
