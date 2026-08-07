/**
 * Read-only scene projection shared by the Outliner and Inspector.
 *
 * Rust owns the canonical scene and publishes this serializable DTO.  The
 * browser-side data source keeps only the latest snapshot as a synchronous
 * render cache; it is not a second scene model.
 */
export type SceneNodeKind = "scene" | "light" | "mesh";

export interface SceneNodeSummary {
  id: string;
  parent: string | null;
  label: string;
  kind: SceneNodeKind;
  visible: boolean;
}

export interface SceneTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface SceneMaterial {
  color: [number, number, number, number];
  metallic: number;
  roughness: number;
}

export interface SelectedSceneNode {
  id: string;
  transform: SceneTransform;
  material: SceneMaterial | null;
}

export interface SceneProjection {
  revision: number;
  selectedNodeId: string | null;
  nodes: SceneNodeSummary[];
  selected: SelectedSceneNode | null;
  lastProcessedSequence: number;
  commandResults: SceneCommandResult[];
}

export interface SceneCommandResult {
  sequence: number;
  nodeId: string;
  property: SceneMaterialProperty;
  applied: boolean;
  error: string | null;
}

export type SceneMaterialProperty = "baseColor" | "metallic" | "roughness";

export type SceneCommand =
  | { type: "setBaseColor"; nodeId: string; color: [number, number, number, number] }
  | { type: "setMetallic"; nodeId: string; value: number }
  | { type: "setRoughness"; nodeId: string; value: number };

export interface SceneCommandEnvelope {
  sequence: number;
  command: SceneCommand;
}
