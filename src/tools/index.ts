import type { ToolDef } from '../core/types';
import { vaseTool } from './vase';
import { gridfinityTool } from './gridfinity';
import { handlesTool } from './handles';
import { jointsTool } from './joints';
import { furnitureTool } from './furniture';
import { planterTool } from './planter';

export const TOOLS: ToolDef[] = [vaseTool, gridfinityTool, handlesTool, jointsTool, furnitureTool, planterTool];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
