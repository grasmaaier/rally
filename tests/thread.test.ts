import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { collect } from '../src/core/registry';
import { TAU, mul, rotX, rotZ, translation } from '../src/geom/helpers';
import { externalR, helixU, internalR, leadOf, selfLocking, wallSolid, type ThreadSpec } from '../src/geom/thread';
import {
  DISC, FIT_GUIDE, clickOf, discSolid, hubSolid, jointTurn, meshTurn, pieceHeight, splitTube, topCapLayout, topCapSolid, tubePieceSolid, tubeSys, validLen,
  type TubePiece,
} from '../src/tools/lampTube';
import type { Params } from '../src/core/types';

let M: ManifoldToplevel;
beforeAll(async () => {
  M = await initManifold();
});
afterEach(() => collect());

const T: ThreadSpec = { pitch: 4, starts: 2, depth: 1.5 };
const sysOf = (v: Partial<Params> = {}) => tubeSys({ tubeD: '24', threadPlay: 0.3, ...v } as Params);

/** Downward faces flatter than ~41° (not on the bed), in mm². */
function overhang(m: Manifold, limit = -0.75) {
  const mesh = m.getMesh();
  const P = mesh.vertProperties;
  const n = mesh.numProp;
  const I = mesh.triVerts;
  let minZ = Infinity;
  for (let i = 2; i < P.length; i += n) minZ = Math.min(minZ, P[i]);
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * n;
    const b = I[t + 1] * n;
    const c = I[t + 2] * n;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    if (Math.min(P[a + 2], P[b + 2], P[c + 2]) < minZ + 0.3) continue;
    if (nz / len < limit) area += len / 2;
  }
  return area;
}

const place = (m: Manifold, z: number, rot: number, flip = false) => {
  let mat = mul(translation(0, 0, z), rotZ((rot * 180) / Math.PI));
  if (flip) mat = mul(mat, rotX(180));
  return m.transform(mat as unknown as Mat4);
};

describe('schroefdraad: profiel en speling', () => {
  it('45° flanks, flats on crest and root, nut at the clearance everywhere', () => {
    const R = 12;
    for (const c of [0.15, 0.3, 0.6]) {
      let minGap = Infinity;
      let maxGap = 0;
      for (let u = -8; u <= 8; u += 0.01) {
        const e = externalR(T, R, u);
        const i = internalR(T, R, c, u);
        minGap = Math.min(minGap, i - e);
        maxGap = Math.max(maxGap, i - e);
        // slope of the profile never more than 45°
        expect(Math.abs(externalR(T, R, u + 0.01) - e)).toBeLessThanOrEqual(0.01 + 1e-9);
        expect(Math.abs(internalR(T, R, c, u + 0.01) - i)).toBeLessThanOrEqual(0.01 + 1e-9);
      }
      expect(minGap).toBeCloseTo(c, 6);
      expect(maxGap).toBeLessThanOrEqual(c * Math.SQRT2 + 1e-9);
    }
    expect(externalR(T, R, 0)).toBe(R);
    expect(externalR(T, R, 2)).toBe(R - 1.5);
    // two starts: half a turn later the profile repeats
    expect(helixU(T, 3, Math.PI) + leadOf(T) / 2).toBeCloseTo(3, 9);
  });

  it('holds by itself (lead angle well below the friction angle)', () => {
    const l = selfLocking(T, 12);
    expect(l.lead).toBeLessThan(8);
    expect(l.locks).toBe(true);
    expect(l.friction - l.lead).toBeGreaterThan(10);
  });
});

describe('buisstukken en moeren', () => {
  const s = sysOf();
  const click = clickOf(FIT_GUIDE.e27, s);

  it('builds a watertight piece with the click cup, not too heavy, support-free', () => {
    const pc: TubePiece = { index: 1, len: validLen(s, 40), cup: click, female: false, stub: true };
    const m = tubePieceSolid(M, s, pc);
    expect(m.status()).toBe('NoError');
    expect(m.numVert()).toBeLessThan(160000);
    const b = m.boundingBox();
    expect(b.max[2] - b.min[2]).toBeCloseTo(pieceHeight(s, pc), 1);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2 * click.Rc, 0);
    expect(overhang(m)).toBeLessThan(25);
    // eight fingers: the slots make one body with handles
    expect(m.genus()).toBeGreaterThanOrEqual(0);
  });

  it('female coupling and plain tube pieces are support-free', () => {
    const pc: TubePiece = { index: 2, len: validLen(s, 30), cup: null, female: true, stub: true };
    const m = tubePieceSolid(M, s, pc);
    expect(m.status()).toBe('NoError');
    expect(overhang(m)).toBeLessThan(25);
  });

  it('a disc screws on the tube without touching it (gap ≈ clearance)', () => {
    for (const c of [0.15, 0.3, 0.6]) {
      const sc = sysOf({ threadPlay: c });
      const tube = tubePieceSolid(M, sc, { index: 2, len: validLen(sc, 12), cup: null, female: false, stub: false });
      const disc = discSolid(M, sc, { R: 30, t: DISC.t, hub: DISC.nut - DISC.t, grooves: [] });
      expect(overhang(disc)).toBeLessThan(25);
      for (const z of [8, 13.7, 21.3]) {
        for (const flip of [false, true]) {
          const dz = flip ? z + DISC.nut : z;
          const rot = meshTurn(sc.thread, { z: 0, rot: 0, flip: false }, { z: dz, flip });
          const d = place(disc, dz, rot, flip);
          expect(tube.intersect(d).volume(), `c=${c} z=${z} flip=${flip}`).toBeLessThan(0.05);
          // turned past the play it collides: the threads really interlock
          const off = place(disc, dz, rot + (TAU * (sc.play + 0.3)) / 8, flip);
          expect(tube.intersect(off).volume()).toBeGreaterThan(1);
        }
      }
      // smallest gap: a nut with a little less clearance than the design still fits, with more it does not
      const rot = meshTurn(sc.thread, { z: 0, rot: 0, flip: false }, { z: 15, flip: false });
      const grown = tubePieceSolid(M, { ...sc, R: sc.R + c * 0.4 }, { index: 2, len: validLen(sc, 12), cup: null, female: false, stub: false });
      expect(grown.intersect(place(discSolid(M, sc, { R: 30, t: DISC.t, hub: 0, grooves: [] }), 15, rot)).volume()).toBeLessThan(0.05);
      const grown2 = tubePieceSolid(M, { ...sc, R: sc.R + c * 1.3 }, { index: 2, len: validLen(sc, 12), cup: null, female: false, stub: false });
      expect(grown2.intersect(place(discSolid(M, sc, { R: 30, t: DISC.t, hub: 0, grooves: [] }), 15, rot)).volume()).toBeGreaterThan(0.05);
    }
  });

  it('the outer thread continues across a tight joint, so a disc screws over it', () => {
    for (const D of ['20', '24', '32']) {
      const sc = sysOf({ tubeD: D });
      const a: TubePiece = { index: 1, len: validLen(sc, 10), cup: null, female: false, stub: true };
      const b: TubePiece = { index: 2, len: validLen(sc, 9), cup: null, female: true, stub: false };
      const A = tubePieceSolid(M, sc, a);
      const B = place(tubePieceSolid(M, sc, b), a.len, jointTurn(sc));
      // stub and female bore do not collide at the tight position, but do when turned back past the play
      expect(A.intersect(B).volume(), `D${D} joint`).toBeLessThan(0.05);
      const tooFar = place(tubePieceSolid(M, sc, b), a.len, jointTurn(sc) - 0.25);
      expect(A.intersect(tooFar).volume()).toBeGreaterThan(0.05);
      // a disc across the joint, meshed with the lower piece, does not touch either piece
      const disc = discSolid(M, sc, { R: 30, t: DISC.t, hub: DISC.nut - DISC.t, grooves: [] });
      for (const z of [a.len - 6, a.len - 4.5, a.len - 2]) {
        const rot = meshTurn(sc.thread, { z: 0, rot: 0, flip: false }, { z, flip: false });
        const d = place(disc, z, rot);
        expect(A.intersect(d).volume(), `D${D} z=${z} lower`).toBeLessThan(0.05);
        expect(B.intersect(d).volume(), `D${D} z=${z} upper`).toBeLessThan(0.05);
      }
    }
  });

  it('top cap and base hub are nuts too, support-free', () => {
    const tube = tubePieceSolid(M, s, { index: 2, len: validLen(s, 8), cup: null, female: false, stub: true });
    const cap = topCapSolid(M, s, { R: 20, grooves: [{ face: 0, r: 16, hw: 1 }] });
    expect(cap.status()).toBe('NoError');
    expect(overhang(cap)).toBeLessThan(25);
    const L = topCapLayout(s);
    const z = validLen(s, 8) - s.nut - 2;
    const rot = meshTurn(s.thread, { z: 0, rot: 0, flip: false }, { z, flip: false });
    expect(tube.intersect(place(cap, z, rot)).volume()).toBeLessThan(0.05);
    expect(L.H).toBeGreaterThan(s.nut + s.stub.len + 10);
    const hub = hubSolid(M, s, s.hubR + 1);
    expect(overhang(hub)).toBeLessThan(25);
  });
});

describe('opsplitsen', () => {
  const s = sysOf();
  it('splits into pieces that fit the printer, with valid lengths', () => {
    for (const [need, maxZ] of [[120, 325], [400, 325], [700, 256], [520, 180]] as const) {
      const ls = splitTube(s, need, maxZ, 51);
      const sum = ls.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(need);
      expect(sum).toBeLessThan(need + ls.length * s.thread.pitch + 0.01);
      for (const l of ls) {
        expect(l + s.stub.len).toBeLessThanOrEqual(maxZ);
        // continuity: every length ≡ −play (mod pitch)
        const k = (l + s.take) / s.thread.pitch;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      }
      expect(ls[0]).toBeGreaterThanOrEqual(51 + 8);
      if (need > maxZ) expect(ls.length).toBeGreaterThan(1);
    }
  });
});

describe('wallSolid', () => {
  it('closed floor and open top', () => {
    const outer = { segs: 32, rings: [{ z: 0, r: () => 10 }, { z: 10, r: () => 10 }] };
    const inner = { segs: 24, rings: [{ z: 2, r: () => 8 }, { z: 10, r: () => 8 }] };
    const m = wallSolid(M, outer, inner);
    expect(m.status()).toBe('NoError');
    expect(m.volume()).toBeGreaterThan(Math.PI * 100 * 10 - Math.PI * 64 * 8 - 40);
    expect(m.genus()).toBe(0);
  });
});
