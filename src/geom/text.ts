import type { CrossSection, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { Font, PathCommand } from 'opentype.js';
import { keep } from '../core/registry';

/** Flatten opentype path commands into closed polygons (y up, in mm). */
function flatten(commands: PathCommand[], tol: number): Vec2[][] {
  const polys: Vec2[][] = [];
  let cur: Vec2[] = [];
  let x = 0;
  let y = 0;
  const push = (px: number, py: number) => {
    cur.push([px, -py]);
    x = px;
    y = py;
  };
  const close = () => {
    if (cur.length >= 3) polys.push(cur);
    cur = [];
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        close();
        push(c.x, c.y);
        break;
      case 'L':
        push(c.x, c.y);
        break;
      case 'Q': {
        const n = Math.max(2, Math.min(24, Math.ceil(Math.hypot(c.x - x, c.y - y) / tol)));
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const a = (1 - t) * (1 - t);
          const b = 2 * (1 - t) * t;
          const d = t * t;
          push(a * x0 + b * c.x1 + d * c.x, a * y0 + b * c.y1 + d * c.y);
        }
        break;
      }
      case 'C': {
        const n = Math.max(3, Math.min(32, Math.ceil(Math.hypot(c.x - x, c.y - y) / tol)));
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          push(
            u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          );
        }
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  // drop the duplicated closing point some fonts emit
  for (const p of polys) {
    const a = p[0];
    const b = p[p.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) p.pop();
  }
  return polys;
}

export interface TextOptions {
  /** extra space between letters, in mm */
  letterSpacing?: number;
  /** 'center' centres the text's bounding box on the origin; 'baseline' keeps x=0 at the start, y=0 on the baseline */
  anchor?: 'center' | 'baseline';
}

/** Outline polygons of a line of text at font size `size` (mm per em). */
export function textPolygons(font: Font, text: string, size: number, letterSpacing = 0): Vec2[][] {
  const polys: Vec2[][] = [];
  let i = 0;
  font.forEachGlyph(text, 0, 0, size, { kerning: true }, (glyph, gx, gy, gs) => {
    // glyph 0 is the font's "missing character" box: leave a gap instead of printing it
    if (glyph.index !== 0) {
      const path = glyph.getPath(gx + i * letterSpacing, gy, gs);
      polys.push(...flatten(path.commands, Math.max(0.15, size / 120)));
    }
    i++;
  });
  return polys;
}

/** Characters of `text` the font has no glyph for (whitespace ignored), each listed once. */
export function missingChars(font: Font, text: string): string[] {
  const out: string[] = [];
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch) || out.includes(ch)) continue;
    if (font.charToGlyphIndex(ch) === 0) out.push(ch);
  }
  return out;
}

/**
 * Text as a 2D cross-section. Overlapping contours (and counters such as the
 * hole in an "8") are resolved with the non-zero fill rule fonts use.
 */
export function textCross(M: ManifoldToplevel, font: Font, text: string, size: number, opts: TextOptions = {}): CrossSection {
  const polys = textPolygons(font, text, size, opts.letterSpacing ?? 0);
  let cs = keep(new M.CrossSection(polys.length ? polys : [[[0, 0], [0.01, 0], [0, 0.01]]], 'NonZero'));
  if ((opts.anchor ?? 'center') === 'center' && !cs.isEmpty()) {
    const b = cs.bounds();
    cs = cs.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]);
  }
  return cs;
}

/**
 * Font size (mm per em) at which the digits/capitals of `font` are `height` mm
 * tall — users think in visible letter height, not em size.
 */
export function sizeForHeight(font: Font, height: number, sample = '0123456789H') {
  const bb = font.getPath(sample, 0, 0, 100).getBoundingBox();
  const h = bb.y2 - bb.y1;
  return h > 0 ? (height * 100) / h : height * 1.4;
}
