/**
 * Icons of the designer. Shape icons are drawn from the real profile
 * functions of the lamp (side view; flowers, gears and lamellas from the top),
 * so an icon always looks like the shape it adds.
 */
import { kapRadius, shapeRadius, type SegSpec } from '../tools/lampParts';
import { SHAPE_DEFAULTS } from './lampModel';

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

function spec(shape: string, kap = 'koepel'): SegSpec {
  const d = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.cilinder;
  return { slot: 1, shape, kap, D: d.D, H: d.H, v: d.Var / 100, n: d.N ?? 3, flip: false, tex: 'glad', texN: 0, color: '' };
}

/** Closed outline from a radius function, fitted into a 24×24 box (y down). */
function sidePath(r: (z: number) => number, H: number, R: number): string {
  const s = Math.min(20 / (2 * R), 18 / H);
  // very flat shapes get a minimum height so they stay visible
  const h = Math.max(H * s, 4);
  const sz = h / H;
  const top = 12 - h / 2;
  const steps = 24;
  const right: string[] = [];
  const left: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const z = (H * k) / steps;
    const x = r(z) * s;
    const y = top + h - z * sz;
    right.push(`${f1(12 + x)} ${f1(y)}`);
    left.unshift(`${f1(12 - x)} ${f1(y)}`);
  }
  return `M${right.join('L')}L${left.join('L')}Z`;
}

function polarPath(f: (th: number) => number, R: number, n = 96): string {
  const pts: string[] = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    const r = f(th) * R;
    pts.push(`${f1(12 + r * Math.cos(th))} ${f1(12 + r * Math.sin(th))}`);
  }
  return `M${pts.join('L')}Z`;
}

const circle = (r: number, ccw = false) => `M${f1(12 - r)} 12a${r} ${r} 0 1 ${ccw ? 0 : 1} ${2 * r} 0a${r} ${r} 0 1 ${ccw ? 0 : 1} ${-2 * r} 0Z`;

const cache = new Map<string, string>();

/** SVG path (fill, even-odd) of a shape icon in a 24×24 view box. */
export function shapeIconPath(shape: string, kap = 'koepel'): string {
  const key = `${shape}|${kap}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let d: string;
  const s = spec(shape, kap);
  switch (shape) {
    case 'bloem':
      d = polarPath((th) => 1 - 0.28 * (0.5 - 0.5 * Math.cos(8 * th)), 10);
      break;
    case 'tandwiel':
      d = polarPath((th) => (Math.cos(14 * th) > 0 ? 1 : 0.82), 10, 168);
      break;
    case 'lamel':
      d = `${circle(10)}${circle(6.5, true)}`;
      break;
    case 'ribring': {
      // top view: round glass ribs with U-shaped grooves around a small hole
      const n = 14;
      d = `${polarPath((th) => {
        const u = ((((th * n) / (Math.PI * 2)) % 1) + 1) % 1;
        const x = Math.abs(u - 0.5) * 2;
        return x > 0.72 ? 1 - 0.2 * Math.sqrt(Math.max(0, 1 - ((1 - x) / 0.28) ** 2)) : 1;
      }, 10.5, 224)}${circle(3, true)}`;
      break;
    }
    case 'stijlen':
      d = 'M3 5h18v2.5H3zM3 16.5h18V19H3zM5.5 7.5h2v9h-2zM11 7.5h2v9h-2zM16.5 7.5h2v9h-2z';
      break;
    case 'kap': {
      if (kap === 'geribbeld') {
        // a straight fluted sleeve hanging from a plate, every other rib longer (scalloped rim)
        const ribs: string[] = [];
        for (let k = 0; k < 6; k++) {
          const x = 4 + k * 2.75;
          const long = k % 2 === 1;
          ribs.push(`M${f1(x)} 6.2h2.1v${long ? 12.2 : 10}a1.05 1.05 0 0 1-2.1 0z`);
        }
        d = `M3 3.5h18v2.7H3z${ribs.join('')}`;
        break;
      }
      const f = kapRadius(s, 22);
      // a shade: the outline of its wall, open at the rim (bottom)
      const R = Math.max(s.D / 2, 22);
      const sc = Math.min(20 / (2 * R), 18 / s.H);
      const h = s.H * sc;
      const top = 12 - h / 2;
      const outer: string[] = [];
      const inner: string[] = [];
      const w = 1.6;
      for (let k = 0; k <= 20; k++) {
        const z = (s.H * k) / 20;
        const x = f(z) * sc;
        const y = top + h - z * sc;
        outer.push(`${f1(12 + x)} ${f1(y)}`);
        inner.push(`${f1(12 + Math.max(0.5, x - w))} ${f1(Math.min(top + h, y + (k === 20 ? w : 0)))}`);
      }
      const mirror = (pts: string[]) => pts.map((q) => q.split(' ')).map(([x, y]) => `${f1(24 - Number(x))} ${y}`);
      d = `M${outer.join('L')}L${mirror(outer).reverse().join('L')}L${mirror(inner).join('L')}L${[...inner].reverse().join('L')}Z`;
      break;
    }
    default: {
      const f = shapeRadius(s);
      d = sidePath(f, s.H, s.D / 2);
    }
  }
  cache.set(key, d);
  return d;
}

export function shapeIcon(shape: string, kap?: string, cls = 'shape-ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${shapeIconPath(shape, kap)}"/></svg>`;
}

/** Line icons (24×24, stroked). */
export const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  flip: 'M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  library: 'M6 3h12v18l-6-4-6 4z',
  examples: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7',
  share: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  nodes: 'M4 5h6v4H4zM14 15h6v4h-6zM7 9v3a3 3 0 0 0 3 3h4',
  cube: 'm12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  chevron: 'm6 9 6 6 6-6',
  lamp: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3',
  socket: 'M8 3h8v5H8zM7 8h10l-1 6H8zM10 14v3h4v-3M11 17v4M13 17v4',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5',
  base: 'M5 20h14M7 20c0-3 2-5 5-5s5 2 5 5M12 15V4',
  canopy: 'M5 4h14M7 4c0 3 2 5 5 5s5-2 5-5M12 9v11',
  tube: 'M10 2h4v20h-4zM10 5l4 2M10 9l4 2M10 13l4 2M10 17l4 2',
  closed: 'M12 2v3M12 5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 1 0 0-15zM4.5 12.5h15',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  save: 'M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}
