/**
 * Distance fields for generative designs: a bounding-volume hierarchy for
 * fast point-to-mesh distances, a sampled signed-distance grid of a triangle
 * mesh (sign by ray parity voted over three axes, so small holes in an
 * uploaded mesh do not flip whole regions) and smooth blending operators.
 *
 * Convention: negative inside, positive outside, in millimetres.
 */

// ---------------------------------------------------------------------------
// Smooth operators (polynomial, radius k in mm)

export function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k);
}

// ---------------------------------------------------------------------------
// Point-triangle distance (Ericson, Real-Time Collision Detection 5.1.5)

/** Squared distance from p to triangle (a, b, c), coordinates passed flat for speed. */
export function pointTriDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx; qy = cy; qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------
// BVH

const LEAF = 4;

/** Axis-aligned bounding-box tree over the triangles of a mesh for closest-distance queries. */
export class TriangleBVH {
  /** Triangle corners in leaf order: 9 numbers per triangle. */
  private tri: Float64Array;
  private box: Float64Array;
  private left: Int32Array;
  private right: Int32Array;
  private start: Int32Array;
  private count: Int32Array;
  private nodes = 0;
  readonly triangles: number;
  private stack = new Int32Array(128);

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const n = Math.floor(indices.length / 3);
    this.triangles = n;
    const cen = new Float64Array(n * 3);
    const order = new Int32Array(n);
    for (let t = 0; t < n; t++) {
      order[t] = t;
      for (let k = 0; k < 3; k++) {
        cen[t * 3 + k] = (positions[indices[t * 3] * 3 + k] + positions[indices[t * 3 + 1] * 3 + k] + positions[indices[t * 3 + 2] * 3 + k]) / 3;
      }
    }
    const maxNodes = Math.max(1, 2 * Math.ceil(n / LEAF) * 2);
    this.box = new Float64Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes);
    this.right = new Int32Array(maxNodes);
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    const corner = (t: number, c: number, k: number) => positions[indices[t * 3 + c] * 3 + k];
    const build = (lo: number, hi: number): number => {
      const node = this.nodes++;
      const b = node * 6;
      let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
      let cmn0 = Infinity, cmn1 = Infinity, cmn2 = Infinity, cmx0 = -Infinity, cmx1 = -Infinity, cmx2 = -Infinity;
      for (let i = lo; i < hi; i++) {
        const t = order[i];
        for (let c = 0; c < 3; c++) {
          const x = corner(t, c, 0), y = corner(t, c, 1), z = corner(t, c, 2);
          if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
          if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
          if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
        }
        const x = cen[t * 3], y = cen[t * 3 + 1], z = cen[t * 3 + 2];
        if (x < cmn0) cmn0 = x; if (x > cmx0) cmx0 = x;
        if (y < cmn1) cmn1 = y; if (y > cmx1) cmx1 = y;
        if (z < cmn2) cmn2 = z; if (z > cmx2) cmx2 = z;
      }
      this.box[b] = mn0; this.box[b + 1] = mn1; this.box[b + 2] = mn2;
      this.box[b + 3] = mx0; this.box[b + 4] = mx1; this.box[b + 5] = mx2;
      this.left[node] = -1;
      this.right[node] = -1;
      this.start[node] = lo;
      this.count[node] = hi - lo;
      if (hi - lo <= LEAF) return node;
      const ext = [cmx0 - cmn0, cmx1 - cmn1, cmx2 - cmn2];
      const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      const mid = ([cmn0, cmn1, cmn2][axis] + [cmx0, cmx1, cmx2][axis]) / 2;
      let i = lo;
      let j = hi - 1;
      while (i <= j) {
        if (cen[order[i] * 3 + axis] < mid) i++;
        else {
          const tmp = order[i];
          order[i] = order[j];
          order[j] = tmp;
          j--;
        }
      }
      // all centroids equal along the axis: split in the middle
      if (i === lo || i === hi) i = (lo + hi) >> 1;
      this.left[node] = build(lo, i);
      this.right[node] = build(i, hi);
      return node;
    };
    if (n > 0) build(0, n);
    this.tri = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) {
      const t = order[i];
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) this.tri[i * 9 + c * 3 + k] = corner(t, c, k);
    }
  }

  private boxDist2(node: number, px: number, py: number, pz: number) {
    const b = node * 6;
    const B = this.box;
    const dx = px < B[b] ? B[b] - px : px > B[b + 3] ? px - B[b + 3] : 0;
    const dy = py < B[b + 1] ? B[b + 1] - py : py > B[b + 4] ? py - B[b + 4] : 0;
    const dz = pz < B[b + 2] ? B[b + 2] - pz : pz > B[b + 5] ? pz - B[b + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Distance from p to the closest triangle, or `maxDist` when nothing is closer. */
  distance(px: number, py: number, pz: number, maxDist = Infinity): number {
    if (this.triangles === 0) return maxDist;
    let best = maxDist === Infinity ? Infinity : maxDist * maxDist;
    const st = this.stack;
    let sp = 0;
    st[sp++] = 0;
    const T = this.tri;
    while (sp > 0) {
      const node = st[--sp];
      if (this.boxDist2(node, px, py, pz) >= best) continue;
      const l = this.left[node];
      if (l < 0) {
        const s = this.start[node];
        const e = s + this.count[node];
        for (let i = s; i < e; i++) {
          const o = i * 9;
          const d = pointTriDist2(px, py, pz, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
          if (d < best) best = d;
        }
      } else {
        const r = this.right[node];
        const dl = this.boxDist2(l, px, py, pz);
        const dr = this.boxDist2(r, px, py, pz);
        // visit the nearer child first (pushed last)
        if (sp + 2 > st.length) {
          const bigger = new Int32Array(st.length * 2);
          bigger.set(st);
          this.stack = bigger;
          return this.distance(px, py, pz, maxDist);
        }
        if (dl < dr) {
          if (dr < best) st[sp++] = r;
          if (dl < best) st[sp++] = l;
        } else {
          if (dl < best) st[sp++] = l;
          if (dr < best) st[sp++] = r;
        }
      }
    }
    return Math.sqrt(best);
  }
}

/** Brute-force distance (for tests). */
export function bruteDistance(positions: ArrayLike<number>, indices: ArrayLike<number>, px: number, py: number, pz: number) {
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    best = Math.min(best, pointTriDist2(px, py, pz, positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2], positions[c], positions[c + 1], positions[c + 2]));
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Signed distance grid

export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Signed distance of a mesh sampled on a regular grid (spacing h), clamped to
 * ±cap. Sampling between nodes is trilinear; outside the grid it reads +cap.
 */
export class DistanceGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly data: Float32Array;
  /** Odd number of crossings per node, voted over the three axes. */
  readonly inside: Uint8Array;

  private constructor(
    readonly ox: number, readonly oy: number, readonly oz: number,
    readonly h: number, readonly cap: number,
    n: [number, number, number],
  ) {
    [this.nx, this.ny, this.nz] = n;
    this.data = new Float32Array(this.nx * this.ny * this.nz);
    this.inside = new Uint8Array(this.nx * this.ny * this.nz);
  }

  static nodesFor(bounds: Box3, h: number) {
    let n = 1;
    for (let k = 0; k < 3; k++) n *= Math.floor((bounds.max[k] - bounds.min[k]) / h) + 2;
    return n;
  }

  /** Sample the mesh on a grid covering `bounds`. `cap` must be at least ~3h. */
  static build(positions: ArrayLike<number>, indices: ArrayLike<number>, bounds: Box3, h: number, cap: number, bvh?: TriangleBVH): DistanceGrid {
    const n: [number, number, number] = [0, 1, 2].map((k) => Math.floor((bounds.max[k] - bounds.min[k]) / h) + 2) as [number, number, number];
    const g = new DistanceGrid(bounds.min[0], bounds.min[1], bounds.min[2], h, cap, n);
    const tree = bvh ?? new TriangleBVH(positions, indices);
    const votes = new Uint8Array(g.data.length);
    const valid = new Uint8Array(g.data.length);
    for (let axis = 0; axis < 3; axis++) g.parity(positions, indices, axis, votes, valid);
    const { nx, ny, nz } = g;
    let idx = 0;
    for (let k = 0; k < nz; k++) {
      const z = g.oz + k * h;
      for (let j = 0; j < ny; j++) {
        const y = g.oy + j * h;
        for (let i = 0; i < nx; i++, idx++) {
          const d = tree.distance(g.ox + i * h, y, z, cap);
          // majority of the axes whose ray saw a consistent (even) number of crossings
          const inside = votes[idx] * 2 > valid[idx];
          g.inside[idx] = inside ? 1 : 0;
          g.data[idx] = inside ? -d : d;
        }
      }
    }
    return g;
  }

  /**
   * Cast rays along `axis` through every grid row and count crossings: a node
   * is inside when an odd number of surfaces lie before it. Adds one vote per
   * inside node; rows with an odd total (a hole in the mesh) do not count.
   */
  private parity(positions: ArrayLike<number>, indices: ArrayLike<number>, axis: number, votes: Uint8Array, valid: Uint8Array) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const o = [this.ox, this.oy, this.oz];
    const dims = [this.nx, this.ny, this.nz];
    const h = this.h;
    // tiny offsets so rays never pass exactly through vertices or edges
    const eu = h * 1.37e-4;
    const ev = h * 2.71e-4;
    const nu = dims[u];
    const nv = dims[v];
    const hits: (number[] | undefined)[] = new Array(nu * nv);
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const au = positions[a + u], av = positions[a + v], aw = positions[a + axis];
      const bu = positions[b + u], bv = positions[b + v], bw = positions[b + axis];
      const cu = positions[c + u], cv = positions[c + v], cw = positions[c + axis];
      const det = (bu - au) * (cv - av) - (cu - au) * (bv - av);
      if (Math.abs(det) < 1e-18) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - o[u] - eu) / h));
      const i1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - o[u] - eu) / h));
      const j0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - o[v] - ev) / h));
      const j1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - o[v] - ev) / h));
      for (let j = j0; j <= j1; j++) {
        const pv = o[v] + j * h + ev;
        for (let i = i0; i <= i1; i++) {
          const pu = o[u] + i * h + eu;
          // barycentric coordinates in the projected triangle
          const l1 = ((pu - au) * (cv - av) - (cu - au) * (pv - av)) / det;
          const l2 = ((bu - au) * (pv - av) - (pu - au) * (bv - av)) / det;
          if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
          const w = aw + l1 * (bw - aw) + l2 * (cw - aw);
          const row = j * nu + i;
          (hits[row] ??= []).push(w);
        }
      }
    }
    const stride = [1, this.nx, this.nx * this.ny];
    const n = dims[axis];
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const list = hits[j * nu + i];
        const base = i * stride[u] + j * stride[v];
        if (list && list.length % 2 === 1) continue;
        for (let s = 0; s < n; s++) valid[base + s * stride[axis]]++;
        if (!list) continue;
        list.sort((x, y) => x - y);
        let hi = 0;
        for (let s = 0; s < n; s++) {
          const w = o[axis] + s * h;
          while (hi < list.length && list[hi] < w) hi++;
          if (hi % 2 === 1) votes[base + s * stride[axis]]++;
        }
      }
  }

  /** Trilinear sample; +cap outside the grid. */
  sample(x: number, y: number, z: number): number {
    const fx = (x - this.ox) / this.h;
    const fy = (y - this.oy) / this.h;
    const fz = (z - this.oz) / this.h;
    const { nx, ny, nz } = this;
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return this.cap;
    const i = Math.min(nx - 2, Math.floor(fx));
    const j = Math.min(ny - 2, Math.floor(fy));
    const k = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const D = this.data;
    const sy = nx;
    const sz = nx * ny;
    const o = i + j * sy + k * sz;
    const c00 = D[o] + (D[o + 1] - D[o]) * tx;
    const c10 = D[o + sy] + (D[o + sy + 1] - D[o + sy]) * tx;
    const c01 = D[o + sz] + (D[o + sz + 1] - D[o + sz]) * tx;
    const c11 = D[o + sy + sz] + (D[o + sy + sz + 1] - D[o + sy + sz]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  /** Volume and centroid of the inside nodes (each node stands for an h³ cube). */
  massProperties() {
    let n = 0, sx = 0, sy = 0, sz = 0;
    let idx = 0;
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++, idx++) {
          if (!this.inside[idx]) continue;
          n++;
          sx += i;
          sy += j;
          sz += k;
        }
    const h = this.h;
    if (!n) return { volume: 0, centroid: [0, 0, 0] as [number, number, number] };
    return { volume: n * h * h * h, centroid: [this.ox + (sx / n) * h, this.oy + (sy / n) * h, this.oz + (sz / n) * h] as [number, number, number] };
  }
}
