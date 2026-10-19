import type { Manifold, ManifoldToplevel } from 'manifold-3d';

export type ParamValue = number | string | boolean;

/** An error with a message meant for the user (e.g. "the drawer is too small"). */
export class UserError extends Error {
  readonly user = true;
}
export type Params = Record<string, ParamValue>;

interface ParamBase {
  key: string;
  label: string;
  help?: string;
  /** Hide the control when this returns false. */
  show?: (p: Params) => boolean;
}

export interface NumberParam extends ParamBase {
  type: 'number';
  min: number;
  max: number;
  step?: number;
  default: number;
  unit?: string;
}

export interface SelectParam extends ParamBase {
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}

export interface BoolParam extends ParamBase {
  type: 'bool';
  default: boolean;
}

export interface GroupHeader {
  type: 'group';
  label: string;
  show?: (p: Params) => boolean;
}

export type ParamDef = NumberParam | SelectParam | BoolParam | GroupHeader;

export interface Preset {
  name: string;
  values: Partial<Params>;
}

export interface PrinterProfile {
  id: string;
  name: string;
  /** Build volume in mm. */
  x: number;
  y: number;
  z: number;
}

export interface BuildContext {
  M: ManifoldToplevel;
  printer: PrinterProfile;
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface PartOut {
  name: string;
  solid: Manifold;
  quantity?: number;
  color?: string;
  /** 'vase' = printed in spiral vase mode (single wall) for the filament estimate. */
  estimate?: 'solid' | 'vase';
}

/** Display-only items for the assembled view (wood boards, ghost outlines, placed parts). */
export type SceneItem =
  | {
      kind: 'box';
      size: [number, number, number];
      /** Position of the box minimum corner. */
      position: [number, number, number];
      color: string;
      material?: 'wood' | 'ghost' | 'solid';
      label?: string;
    }
  | {
      kind: 'part';
      part: number;
      /** Column-major 4x4 matrix mapping the part's original coordinates into the scene. */
      matrix: number[];
    };

export type InfoBlock =
  | { kind: 'table'; title: string; headers: string[]; rows: (string | number)[][]; csv?: string }
  | { kind: 'kv'; title: string; rows: [string, string][] }
  | { kind: 'text'; title: string; text: string };

export interface BuildOutput {
  parts: PartOut[];
  scene?: SceneItem[];
  info?: InfoBlock[];
  tips?: string[];
  warnings?: string[];
  defaultView?: 'plate' | 'assembly';
}

export interface ToolDef {
  id: string;
  name: string;
  short: string;
  icon: string;
  description: string;
  params: ParamDef[];
  presets?: Preset[];
  randomize?: (p: Params) => Partial<Params>;
  build(p: Params, ctx: BuildContext): BuildOutput;
}

// ---- Data sent from the geometry engine to the UI ----

export interface PartResult {
  name: string;
  mesh: MeshData;
  quantity: number;
  color?: string;
  /** Bounding box size after placing the part on the bed. */
  size: [number, number, number];
  volume: number;
  /** Surface area in mm², used for the filament estimate. */
  area: number;
  estimate: 'solid' | 'vase';
  triangles: number;
}

export type SceneResult =
  | Extract<SceneItem, { kind: 'box' }>
  | { kind: 'part'; part: number; matrix: number[] };

export interface BuildResult {
  parts: PartResult[];
  scene?: SceneResult[];
  info: InfoBlock[];
  tips: string[];
  warnings: string[];
  defaultView: 'plate' | 'assembly';
  ms: number;
}

export function defaultsOf(defs: ParamDef[]): Params {
  const out: Params = {};
  for (const d of defs) if (d.type !== 'group') out[d.key] = d.default;
  return out;
}

export const num = (p: Params, k: string): number => Number(p[k]);
export const str = (p: Params, k: string): string => String(p[k]);
export const bool = (p: Params, k: string): boolean => p[k] === true || p[k] === 'true';
