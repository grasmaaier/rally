/**
 * Built-in reference bodies for the generative tool, so it works without an
 * upload: closed, outward-oriented triangle meshes in mm, standing upright
 * (front towards -Y), centred in XY with the bottom at z = 0.
 */

export interface BodyMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

const spow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

/**
 * Mesh of a surface of revolution-like shape given as a point function of
 * latitude t ∈ (0, π) (0 = bottom pole) and longitude a ∈ [0, 2π).
 */
function latLong(point: (t: number, a: number) => [number, number, number], rings: number, segs: number): BodyMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(...point(0, 0));
  for (let r = 1; r < rings; r++) {
    const t = (Math.PI * r) / rings;
    for (let s = 0; s < segs; s++) pos.push(...point(t, (2 * Math.PI * s) / segs));
  }
  pos.push(...point(Math.PI, 0));
  const top = pos.length / 3 - 1;
  const ring = (r: number, s: number) => 1 + (r - 1) * segs + (s % segs);
  for (let s = 0; s < segs; s++) idx.push(0, ring(1, s + 1), ring(1, s));
  for (let r = 1; r < rings - 1; r++)
    for (let s = 0; s < segs; s++) {
      idx.push(ring(r, s), ring(r, s + 1), ring(r + 1, s + 1));
      idx.push(ring(r, s), ring(r + 1, s + 1), ring(r + 1, s));
    }
  for (let s = 0; s < segs; s++) idx.push(top, ring(rings - 1, s), ring(rings - 1, s + 1));
  return orient(normalise({ positions: new Float32Array(pos), indices: new Uint32Array(idx) }));
}

/** Superellipsoid with half-sizes a, b, c; small exponents give flatter faces and tighter rounding. */
function superellipsoid(a: number, b: number, c: number, eV: number, eH: number, rings = 40, segs = 72): BodyMesh {
  return latLong(
    (t, w) => {
      const lat = t - Math.PI / 2;
      const cl = spow(Math.cos(lat), eV);
      return [a * cl * spow(Math.cos(w), eH), b * cl * spow(Math.sin(w), eH), c * spow(Math.sin(lat), eV)];
    },
    rings,
    segs,
  );
}

/** Centre in XY and put the bottom on z = 0. */
export function normalise(m: BodyMesh): BodyMesh {
  const P = m.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  const d = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) P[i + k] += d[k];
  return m;
}

export function signedVolume(m: BodyMesh) {
  const P = m.positions;
  const I = m.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/** Make the triangles face outwards (positive volume). */
function orient(m: BodyMesh): BodyMesh {
  if (signedVolume(m) < 0) {
    const I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const tmp = I[t + 1];
      I[t + 1] = I[t + 2];
      I[t + 2] = tmp;
    }
  }
  return m;
}

export const BODY_OPTIONS = [
  { value: 'phone', label: 'Telefoon (147 × 72 × 8 mm)' },
  { value: 'earbuds', label: 'Oordopjes-case (50 × 24 × 54 mm)' },
  { value: 'egg', label: 'Ei (44 × 58 mm)' },
  { value: 'sphere', label: 'Bol (60 mm)' },
  { value: 'upload', label: 'Eigen 3D-model (uploaden)' },
];

/** A built-in body with its overall size in mm (x, y, z). */
export function builtinBody(id: string, size?: { w: number; d: number; h: number }): BodyMesh {
  switch (id) {
    case 'phone': {
      const s = size ?? { w: 72, d: 8, h: 147 };
      // flat faces, rounded edges: tight around the thickness, softer in the outline
      return superellipsoid(s.w / 2, s.d / 2, s.h / 2, 0.12, 0.18, 48, 96);
    }
    case 'earbuds': {
      const s = size ?? { w: 50, d: 24, h: 54 };
      return superellipsoid(s.w / 2, s.d / 2, s.h / 2, 0.55, 0.6);
    }
    case 'egg': {
      const s = size ?? { w: 44, d: 44, h: 58 };
      return latLong(
        (t, a) => {
          // wider near the bottom, pointed at the top
          const r = Math.sin(t) * (1 + 0.1 * Math.cos(t));
          return [(s.w / 2) * r * Math.cos(a), (s.d / 2) * r * Math.sin(a), (-Math.cos(t) * s.h) / 2];
        },
        40,
        72,
      );
    }
    default: {
      const s = size ?? { w: 60, d: 60, h: 60 };
      return superellipsoid(s.w / 2, s.d / 2, s.h / 2, 1, 1);
    }
  }
}
