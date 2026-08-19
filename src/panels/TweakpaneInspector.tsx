import { useEffect, useRef } from "react";
import { Pane } from "tweakpane";
import type { BindingApi } from "@tweakpane/core";
import { dispatchSceneCommand } from "../scene/adapters/sceneProjectionDataSource";
import type { SceneTransform, SelectedSceneNode } from "../scene/core/projection";

type Refreshable = { refresh(): void };
type ColorValue = [number, number, number, number];
type Point3Value = { x: number; y: number; z: number };
type Point4Value = { x: number; y: number; z: number; w: number };

interface PaneModel {
  transform: {
    position: Point3Value;
    rotation: Point4Value;
    scale: Point3Value;
  };
  material?: {
    color: string;
    metallic: number;
    roughness: number;
  };
  light?: {
    type: string;
    color: string;
    intensity: number;
    direction: Point3Value;
    enabled: boolean;
    castsShadows: boolean;
  };
}

interface PaneSession {
  pane: Pane;
  nodeId: string;
  model: PaneModel;
  bindings: Refreshable[];
}

function componentToHex(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function colorToHex(color: readonly number[]): string {
  return `#${componentToHex(color[0] ?? 0)}${componentToHex(color[1] ?? 0)}${componentToHex(color[2] ?? 0)}`;
}

function hexToColor(value: string, alpha: number): ColorValue {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
    alpha,
  ];
}

function point3(values: readonly number[]): Point3Value {
  return {
    x: values[0] ?? 0,
    y: values[1] ?? 0,
    z: values[2] ?? 0,
  };
}

function point4(values: readonly number[]): Point4Value {
  return {
    x: values[0] ?? 0,
    y: values[1] ?? 0,
    z: values[2] ?? 0,
    w: values[3] ?? 1,
  };
}

function point3ToTuple(value: Point3Value): [number, number, number] | null {
  const result: [number, number, number] = [value.x, value.y, value.z];
  if (!result.every(Number.isFinite) || result.every((component) => component === 0)) {
    return null;
  }
  return result;
}

function createPaneModel(selected: SelectedSceneNode): PaneModel {
  const { translation, rotation, scale } = selected.transform;
  return {
    transform: {
      position: point3(translation),
      rotation: point4(rotation),
      scale: point3(scale),
    },
    material: selected.material
      ? {
          color: colorToHex(selected.material.color),
          metallic: selected.material.metallic,
          roughness: selected.material.roughness,
        }
      : undefined,
    light: selected.light
      ? {
          type: selected.light.lightType,
          color: colorToHex(selected.light.color),
          intensity: selected.light.intensity,
          direction: point3(selected.light.direction ?? [0, -1, 0]),
          enabled: selected.light.enabled,
          castsShadows: selected.light.castsShadows,
        }
      : undefined,
  };
}

function track<T>(bindings: Refreshable[], binding: BindingApi<unknown, T>): BindingApi<unknown, T> {
  bindings.push(binding);
  return binding;
}

function listen<T>(binding: BindingApi<unknown, T>, handler: (value: T) => void): void {
  binding.on("change", (event) => handler(event.value));
}

function editableTransform(model: PaneModel): SceneTransform | null {
  const { position, rotation, scale } = model.transform;
  const translation: [number, number, number] = [position.x, position.y, position.z];
  const quaternion: [number, number, number, number] = [rotation.x, rotation.y, rotation.z, rotation.w];
  const scaling: [number, number, number] = [scale.x, scale.y, scale.z];
  if (![...translation, ...quaternion, ...scaling].every(Number.isFinite)) return null;
  if (quaternion.every((component) => component === 0)) return null;
  if (scaling.some((component) => component <= 0)) return null;
  return { translation, rotation: quaternion, scale: scaling };
}

function addTransformFolder(
  pane: Pane,
  model: PaneModel,
  selected: SelectedSceneNode,
  bindings: Refreshable[],
): void {
  const folder = pane.addFolder({ title: "Transform", expanded: true });
  const position = track(
    bindings,
    folder.addBinding(model.transform, "position", {
      label: "Position",
      disabled: !selected.transformEditable,
      x: { step: 0.001 },
      y: { step: 0.001 },
      z: { step: 0.001 },
    }),
  );
  listen(position, () => {
    const transform = editableTransform(model);
    if (transform) dispatchSceneCommand({ type: "setTransform", nodeId: selected.id, transform });
  });
  const rotation = track(
    bindings,
    folder.addBinding(model.transform, "rotation", {
      label: "Rotation",
      disabled: !selected.transformEditable,
      x: { step: 0.001 },
      y: { step: 0.001 },
      z: { step: 0.001 },
      w: { step: 0.001 },
    }),
  );
  listen(rotation, () => {
    const transform = editableTransform(model);
    if (transform) dispatchSceneCommand({ type: "setTransform", nodeId: selected.id, transform });
  });
  const scale = track(
    bindings,
    folder.addBinding(model.transform, "scale", {
      label: "Scale",
      disabled: !selected.transformEditable,
      x: { step: 0.001 },
      y: { step: 0.001 },
      z: { step: 0.001 },
    }),
  );
  listen(scale, () => {
    const transform = editableTransform(model);
    if (transform) dispatchSceneCommand({ type: "setTransform", nodeId: selected.id, transform });
  });
}

function addMaterialFolder(
  pane: Pane,
  model: PaneModel,
  selected: SelectedSceneNode,
  bindings: Refreshable[],
): void {
  if (!selected.material || !model.material) return;

  const nodeId = selected.id;
  const alpha = selected.material.color[3];
  const folder = pane.addFolder({ title: "Base Material", expanded: true });
  const color = track(
    bindings,
    folder.addBinding(model.material, "color", {
      label: "Color",
      color: { alpha: false },
    }),
  );
  listen(color, (value) => {
    if (typeof value !== "string") return;
    dispatchSceneCommand({
      type: "setBaseColor",
      nodeId,
      color: hexToColor(value, alpha),
    });
  });

  const metallic = track(
    bindings,
    folder.addBinding(model.material, "metallic", {
      label: "Metallic",
      min: 0,
      max: 1,
      step: 0.01,
    }),
  );
  listen(metallic, (value) => {
    dispatchSceneCommand({ type: "setMetallic", nodeId, value });
  });

  const roughness = track(
    bindings,
    folder.addBinding(model.material, "roughness", {
      label: "Roughness",
      min: 0,
      max: 1,
      step: 0.01,
    }),
  );
  listen(roughness, (value) => {
    dispatchSceneCommand({ type: "setRoughness", nodeId, value });
  });
}

function addLightFolder(
  pane: Pane,
  model: PaneModel,
  selected: SelectedSceneNode,
  bindings: Refreshable[],
): void {
  if (!selected.light || !model.light) return;

  const nodeId = selected.id;
  const light = selected.light;
  const folder = pane.addFolder({ title: "Light", expanded: true });
  track(bindings, folder.addBinding(model.light, "type", { label: "Type", readonly: true }));

  const color = track(
    bindings,
    folder.addBinding(model.light, "color", {
      label: "Color",
      color: { alpha: false },
    }),
  );
  listen(color, (value) => {
    if (typeof value !== "string") return;
    dispatchSceneCommand({
      type: "setLightColor",
      nodeId,
      color: hexToColor(value, light.color[3]),
    });
  });

  const intensity = track(
    bindings,
    folder.addBinding(model.light, "intensity", {
      label: "Intensity",
      min: 0,
      max: 20,
      step: 0.1,
    }),
  );
  listen(intensity, (value) => {
    dispatchSceneCommand({ type: "setLightIntensity", nodeId, value });
  });

  if (light.direction) {
    const direction = track(
      bindings,
      folder.addBinding(model.light, "direction", {
        label: "Direction",
        x: { step: 0.01 },
        y: { step: 0.01 },
        z: { step: 0.01 },
      }),
    );
    listen(direction, (value) => {
      const next = point3ToTuple(value);
      if (next) dispatchSceneCommand({ type: "setLightDirection", nodeId, direction: next });
    });
  }

  const enabled = track(bindings, folder.addBinding(model.light, "enabled", { label: "Enabled" }));
  listen(enabled, (value) => {
    dispatchSceneCommand({ type: "setLightEnabled", nodeId, enabled: value });
  });

  const castsShadows = track(
    bindings,
    folder.addBinding(model.light, "castsShadows", { label: "Cast shadows" }),
  );
  listen(castsShadows, (value) => {
    dispatchSceneCommand({ type: "setLightCastsShadows", nodeId, castsShadows: value });
  });
}

export function TweakpaneInspector({
  selected,
  materialError,
}: {
  selected: SelectedSceneNode;
  materialError?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<PaneSession | null>(null);
  // Binding options such as `disabled` are fixed when Pane controls are
  // created. Rebuild if Native changes editability, otherwise a node can stay
  // locked (or editable) after a projection update even though its value is
  // refreshed below.
  const paneSignature = `${selected.id}:${selected.transformEditable ? "editable" : "readonly"}:${selected.material ? "material" : ""}:${selected.light?.lightType ?? ""}:${selected.light?.direction ? "direction" : ""}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pane = new Pane({ container });
    const model = createPaneModel(selected);
    const bindings: Refreshable[] = [];

    addTransformFolder(pane, model, selected, bindings);
    addLightFolder(pane, model, selected, bindings);
    addMaterialFolder(pane, model, selected, bindings);

    const session: PaneSession = { pane, nodeId: selected.id, model, bindings };
    sessionRef.current = session;
    return () => {
      if (sessionRef.current?.pane === pane) sessionRef.current = null;
      pane.dispose();
    };
  }, [paneSignature]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || session.nodeId !== selected.id) return;

    const transform = session.model.transform;
    transform.position = point3(selected.transform.translation);
    transform.rotation = point4(selected.transform.rotation);
    transform.scale = point3(selected.transform.scale);

    if (selected.material && session.model.material) {
      session.model.material.color = colorToHex(selected.material.color);
      session.model.material.metallic = selected.material.metallic;
      session.model.material.roughness = selected.material.roughness;
    }
    if (selected.light && session.model.light) {
      session.model.light.type = selected.light.lightType;
      session.model.light.color = colorToHex(selected.light.color);
      session.model.light.intensity = selected.light.intensity;
      session.model.light.direction = point3(selected.light.direction ?? [0, -1, 0]);
      session.model.light.enabled = selected.light.enabled;
      session.model.light.castsShadows = selected.light.castsShadows;
    }

    session.bindings.forEach((binding) => binding.refresh());
  }, [selected]);

  return (
    <div className="inspector-pane-host">
      <div ref={containerRef} className="inspector-pane" />
      {materialError && <div className="inspector-material-error">{materialError}</div>}
    </div>
  );
}
