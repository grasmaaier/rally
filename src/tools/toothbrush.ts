import type { BuildOutput, Params, ToolDef } from '../core/types';
import { num } from '../core/types';

// Placeholder: the full toothbrush-holder designer is built on top of this.
function build(p: Params, { M }: Parameters<ToolDef['build']>[1]): BuildOutput {
  const w = num(p, 'width');
  const plate = M.Manifold.cube([w, 4, 60]).translate([-w / 2, 0, 0]);
  return { parts: [{ name: 'Houder', solid: plate }] };
}

export const toothbrushTool: ToolDef = {
  id: 'tandenborstel',
  name: 'Tandenborstelhouders',
  short: 'Tandenborstels',
  icon: 'M9 3h2v6H9zM8 9h4l-.5 12h-3zM15 4v16M13 8h4M13 12h4',
  description: 'Houders voor elektrische tandenborstels met zuignappen.',
  params: [{ type: 'number', key: 'width', label: 'Breedte', min: 40, max: 200, step: 1, unit: 'mm', default: 80 }],
  build,
};
