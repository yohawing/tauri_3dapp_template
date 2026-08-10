/**
 * Read-only scene projection shared by the Outliner and Inspector.
 *
 * Rust owns the canonical scene and publishes this serializable DTO.  The
 * browser-side data source keeps only the latest snapshot as a synchronous
 * render cache; it is not a second scene model.
 */
export type SceneNodeKind = "scene" | "light" | "mesh" | "bone";

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

export type SceneLightType = "point" | "directional" | "spot";

export interface SceneLight {
  lightType: SceneLightType;
  direction: [number, number, number] | null;
  color: [number, number, number, number];
  intensity: number;
  radius: number;
  enabled: boolean;
  castsShadows: boolean;
  attenuationRadius: number | null;
  innerConeAngle: number | null;
  outerConeAngle: number | null;
}

export interface SelectedSceneNode {
  id: string;
  transform: SceneTransform;
  material: SceneMaterial | null;
  light: SceneLight | null;
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
  property: SceneCommandProperty;
  applied: boolean;
  error: string | null;
}

export type SceneMaterialProperty = "baseColor" | "metallic" | "roughness";
export type SceneLightProperty =
  | "lightColor"
  | "lightIntensity"
  | "lightDirection"
  | "lightEnabled"
  | "lightCastsShadows";
export type SceneCommandProperty = SceneMaterialProperty | SceneLightProperty | "visibility";

export type SceneCommand =
  | { type: "setBaseColor"; nodeId: string; color: [number, number, number, number] }
  | { type: "setMetallic"; nodeId: string; value: number }
  | { type: "setRoughness"; nodeId: string; value: number }
  | { type: "setLightColor"; nodeId: string; color: [number, number, number, number] }
  | { type: "setLightIntensity"; nodeId: string; value: number }
  | { type: "setLightDirection"; nodeId: string; direction: [number, number, number] }
  | { type: "setLightEnabled"; nodeId: string; enabled: boolean }
  | { type: "setLightCastsShadows"; nodeId: string; castsShadows: boolean }
  | { type: "setVisibility"; nodeId: string; visible: boolean };

export interface SceneCommandEnvelope {
  sequence: number;
  command: SceneCommand;
}
