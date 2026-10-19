import type { BuildOutput, Params, ToolDef } from '../core/types';
import { num, str } from '../core/types';
import { FONT_OPTIONS } from '../core/fonts';
import { sizeForHeight, textCross } from '../geom/text';
import { TAU } from '../geom/helpers';
import { effectiveSpec, shapeAssets, shapeCross, shapeParams, shapeSpecFrom } from '../geom/shapes2d';

// Placeholder: the full clock designer is built on top of this.
function build(p: Params, { M, assets }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const D = num(p, 'diameter');
  const T = 4;
  const font = assets.font(str(p, 'font'));
  let dial = shapeCross(M, effectiveSpec(shapeSpecFrom(p, 'dial')), D, assets).extrude(T).subtract(M.Manifold.cylinder(T + 2, 4.1, 4.1, 48).translate([0, 0, -1]));
  const size = sizeForHeight(font, D * 0.09);
  const nums = [];
  for (let h = 1; h <= 12; h++) {
    const a = Math.PI / 2 - (TAU * h) / 12;
    const r = D * 0.38;
    nums.push(textCross(M, font, String(h), size).extrude(1.2).translate([r * Math.cos(a), r * Math.sin(a), T]));
  }
  dial = dial.add(M.Manifold.union(nums));
  return { parts: [{ name: 'Wijzerplaat', solid: dial }] };
}

export const clockTool: ToolDef = {
  id: 'klok',
  name: 'Klokken',
  short: 'Klokken',
  icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  description: 'Wijzerplaten, cijfers en wijzers voor standaard quartz-uurwerken.',
  params: [
    { type: 'number', key: 'diameter', label: 'Diameter', min: 80, max: 310, step: 1, unit: 'mm', default: 200 },
    { type: 'select', key: 'font', label: 'Lettertype', options: FONT_OPTIONS, default: 'bundled:montserrat' },
    ...shapeParams('dial', { shape: 'circle' }, { label: 'Vorm wijzerplaat', custom: true }),
  ],
  assets: (p) => [{ kind: 'font', key: str(p, 'font') }, ...shapeAssets(p, 'dial')],
  build,
};
