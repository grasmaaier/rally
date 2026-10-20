import type { ToolDef } from '../core/types';
import { vaseTool } from './vase';
import { gridfinityTool } from './gridfinity';
import { handlesTool } from './handles';
import { jointsTool } from './joints';
import { furnitureTool } from './furniture';
import { planterTool } from './planter';
import { clockTool } from './clock';
import { toothbrushTool } from './toothbrush';
import { lampTool } from './lamp';

export const TOOLS: ToolDef[] = [vaseTool, planterTool, clockTool, handlesTool, gridfinityTool, jointsTool, furnitureTool, toothbrushTool, lampTool];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
