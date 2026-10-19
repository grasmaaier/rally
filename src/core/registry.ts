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
