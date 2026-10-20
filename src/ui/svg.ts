import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { ShapeAsset } from '../core/types';

type P = [number, number];

const area = (pts: P[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

/**
 * Turn an SVG file into filled outline polygons: y up, outer contours CCW and
 * holes CW (so a non-zero fill rule gives the drawn shape), scaled to fit a
 * unit square centred on the origin. Strokes without a fill are ignored.
 */
export function svgToShape(text: string, name: string): ShapeAsset {
  const data = new SVGLoader().parse(text);
  const raw: P[][] = [];
  for (const path of data.paths) {
    const fill = (path.userData as { style?: { fill?: string } } | undefined)?.style?.fill;
    if (fill === 'none' || fill === 'transparent') continue;
    for (const shape of SVGLoader.createShapes(path)) {
      const { shape: outer, holes } = shape.extractPoints(12);
      const toP = (v: { x: number; y: number }): P => [v.x, -v.y];
      const o = outer.map(toP);
      if (o.length >= 3 && Math.abs(area(o)) > 1e-9) raw.push(area(o) > 0 ? o : o.reverse());
      for (const h of holes) {
        const hp = h.map(toP);
        if (hp.length >= 3 && Math.abs(area(hp)) > 1e-9) raw.push(area(hp) < 0 ? hp : hp.reverse());
      }
    }
  }
  if (!raw.length) throw new Error('Geen gevulde vormen gevonden in dit SVG-bestand. Gebruik vlakken met een vulkleur (geen losse lijnen).');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of raw)
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const w = maxX - minX;
  const h = maxY - minY;
  const s = 1 / Math.max(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const polygons = raw.map((poly) => poly.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as P));
  return { name, polygons, aspect: w / h };
}
