/**
 * Generic three.js `Object3D` -> Tweakpane-binding-descriptor reflector.
 *
 * `threeSceneAdapter.ts` (this directory) turns a live three.js tree into the
 * read-only `SceneNodeSummary[]` the Outliner walks. This module is its
 * Inspector-side counterpart for hosts that select a *real* `THREE.Object3D`
 * directly (no Rust/Tauri IPC round-trip, no `SelectedSceneNode` DTO) — e.g.
 * this template's own Canvas fallback, or an external three.js viewport like
 * yw-retarget-web's. Rather than hand-writing a fixed set of Tweakpane
 * folders per object type (what `TweakpaneInspector.tsx` does for the
 * Native/Tauri `SelectedSceneNode` shape), `reflectThreeObject` inspects the
 * object's actual type/properties at call time and returns a data-only list
 * of bindings a renderer (`ThreeObjectInspector.tsx`) turns into Tweakpane
 * controls. Kept framework-free (no Tweakpane import, no React) so the
 * reflection logic itself can be unit-tested without a DOM or a Pane.
 *
 * Every binding writes straight back to the live three.js object — there is
 * no `SceneCommand`/dispatch round-trip here, unlike the Native path. Pass an
 * `onChange` callback (e.g. `ThreeSceneGraphController.publish`) to be
 * notified after a write so a subscribed Outliner/Inspector can refresh.
 */
import * as THREE from "three";

export type ReflectedFieldKind = "string" | "boolean" | "number" | "color" | "vector3";

export interface ReflectedNumberOptions {
  min?: number;
  max?: number;
  step?: number;
}

export interface ReflectedField {
  key: string;
  label: string;
  kind: ReflectedFieldKind;
  readonly?: boolean;
  /** Only meaningful when `kind === "number"`. */
  options?: ReflectedNumberOptions;
  get: () => unknown;
  set: (value: unknown) => void;
}

export interface ReflectedGroup {
  title: string;
  fields: ReflectedField[];
}

export interface ThreeObjectReflection {
  /** `object.uuid` — stable identity for a renderer to key a Pane session on. */
  objectId: string;
  groups: ReflectedGroup[];
}

function componentToHex(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function colorToHex(color: THREE.Color): string {
  return `#${componentToHex(color.r)}${componentToHex(color.g)}${componentToHex(color.b)}`;
}

function isValidHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function colorField(key: string, label: string, color: THREE.Color, onChange?: () => void): ReflectedField {
  return {
    key,
    label,
    kind: "color",
    get: () => colorToHex(color),
    set: (value) => {
      if (!isValidHex(value)) return;
      color.set(value);
      onChange?.();
    },
  };
}

function vector3Field(
  key: string,
  label: string,
  vector: THREE.Vector3 | THREE.Euler,
  onChange?: () => void,
  options?: ReflectedNumberOptions,
): ReflectedField {
  return {
    key,
    label,
    kind: "vector3",
    options,
    get: () => ({ x: vector.x, y: vector.y, z: vector.z }),
    set: (value) => {
      if (typeof value !== "object" || value === null) return;
      const { x, y, z } = value as { x?: unknown; y?: unknown; z?: unknown };
      if (![x, y, z].every((component) => typeof component === "number" && Number.isFinite(component))) return;
      vector.set(x as number, y as number, z as number);
      onChange?.();
    },
  };
}

function numberField(
  key: string,
  label: string,
  get: () => number,
  set: (value: number) => void,
  options?: ReflectedNumberOptions,
): ReflectedField {
  return {
    key,
    label,
    kind: "number",
    options,
    get,
    set: (value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      set(value);
    },
  };
}

function booleanField(key: string, label: string, get: () => boolean, set: (value: boolean) => void): ReflectedField {
  return {
    key,
    label,
    kind: "boolean",
    get,
    set: (value) => {
      if (typeof value !== "boolean") return;
      set(value);
    },
  };
}

function commonGroup(object: THREE.Object3D, onChange?: () => void): ReflectedGroup {
  return {
    title: "Object",
    fields: [
      {
        key: "name",
        label: "Name",
        kind: "string",
        readonly: true,
        get: () => object.name || object.type,
        set: () => {
          // Read-only: three.js `name` is authoring metadata, not something
          // this generic reflector should let an Inspector rename blind.
        },
      },
      booleanField(
        "visible",
        "Visible",
        () => object.visible,
        (value) => {
          object.visible = value;
          onChange?.();
        },
      ),
    ],
  };
}

function transformGroup(object: THREE.Object3D, onChange?: () => void): ReflectedGroup {
  return {
    title: "Transform",
    fields: [
      vector3Field("position", "Position", object.position, onChange, { step: 0.001 }),
      // three.js's own unit for `Object3D.rotation` (a `THREE.Euler`) is
      // radians; kept as-is here rather than converting to degrees so a
      // write-back round-trips exactly through `object.rotation.set(...)`.
      vector3Field("rotation", "Rotation (rad)", object.rotation, onChange, { step: 0.01 }),
      vector3Field("scale", "Scale", object.scale, onChange, { step: 0.001 }),
    ],
  };
}

/** `true` if `key` is a genuine own/inherited data property on `target` —
 * i.e. safe to reflect generically rather than needing a type-specific case.
 * Using `in` (not `hasOwnProperty`) on purpose: three.js light/material
 * subclass fields (`distance`, `decay`, `groundColor`, `metalness`, …) are
 * plain instance properties set in each subclass's constructor, so `in`
 * finds them on the instance without needing to walk the prototype chain by
 * class name. */
function has<T extends object>(target: T, key: string): boolean {
  return key in target;
}

function lightGroup(light: THREE.Light, onChange?: () => void): ReflectedGroup {
  const fields: ReflectedField[] = [
    colorField("color", "Color", light.color, onChange),
    numberField(
      "intensity",
      "Intensity",
      () => light.intensity,
      (value) => {
        light.intensity = value;
        onChange?.();
      },
      { min: 0, step: 0.01 },
    ),
  ];

  if (has(light, "distance")) {
    const withDistance = light as unknown as { distance: number };
    fields.push(
      numberField(
        "distance",
        "Distance",
        () => withDistance.distance,
        (value) => {
          withDistance.distance = value;
          onChange?.();
        },
        { min: 0, step: 0.01 },
      ),
    );
  }

  if (has(light, "decay")) {
    const withDecay = light as unknown as { decay: number };
    fields.push(
      numberField(
        "decay",
        "Decay",
        () => withDecay.decay,
        (value) => {
          withDecay.decay = value;
          onChange?.();
        },
        { min: 0, step: 0.01 },
      ),
    );
  }

  if (has(light, "groundColor")) {
    const withGroundColor = light as unknown as { groundColor: THREE.Color };
    fields.push(colorField("groundColor", "Ground color", withGroundColor.groundColor, onChange));
  }

  return { title: "Light", fields };
}

const MATERIAL_COLOR_PROPERTIES = ["color", "opacity", "wireframe", "metalness", "roughness"] as const;

function materialGroup(material: THREE.Material, onChange?: () => void): ReflectedGroup | null {
  const fields: ReflectedField[] = [];
  const anyMaterial = material as unknown as Record<(typeof MATERIAL_COLOR_PROPERTIES)[number], unknown>;

  if (has(material, "color") && anyMaterial.color instanceof THREE.Color) {
    fields.push(colorField("color", "Color", anyMaterial.color, onChange));
  }
  if (has(material, "opacity") && typeof anyMaterial.opacity === "number") {
    fields.push(
      numberField(
        "opacity",
        "Opacity",
        () => material.opacity,
        (value) => {
          material.opacity = value;
          onChange?.();
        },
        { min: 0, max: 1, step: 0.01 },
      ),
    );
  }
  if (has(material, "wireframe") && typeof anyMaterial.wireframe === "boolean") {
    const withWireframe = material as unknown as { wireframe: boolean };
    fields.push(
      booleanField(
        "wireframe",
        "Wireframe",
        () => withWireframe.wireframe,
        (value) => {
          withWireframe.wireframe = value;
          onChange?.();
        },
      ),
    );
  }
  if (has(material, "metalness") && typeof anyMaterial.metalness === "number") {
    const withMetalness = material as unknown as { metalness: number };
    fields.push(
      numberField(
        "metalness",
        "Metalness",
        () => withMetalness.metalness,
        (value) => {
          withMetalness.metalness = value;
          onChange?.();
        },
        { min: 0, max: 1, step: 0.01 },
      ),
    );
  }
  if (has(material, "roughness") && typeof anyMaterial.roughness === "number") {
    const withRoughness = material as unknown as { roughness: number };
    fields.push(
      numberField(
        "roughness",
        "Roughness",
        () => withRoughness.roughness,
        (value) => {
          withRoughness.roughness = value;
          onChange?.();
        },
        { min: 0, max: 1, step: 0.01 },
      ),
    );
  }

  return fields.length > 0 ? { title: "Material", fields } : null;
}

/**
 * Builds the Tweakpane binding descriptors for `object`: always includes the
 * common `Object`/`Transform` groups, plus a `Light` group when `object` is a
 * `THREE.Light` and a `Material` group when it's a `THREE.Mesh`/
 * `THREE.SkinnedMesh` with a (non-array, non-shader) material exposing any of
 * the recognized properties. Unknown object types — a plain `Object3D`,
 * `Group`, `Bone`, `Camera`, etc. — get only the common groups.
 *
 * `onChange` (optional) is called after every successful write, so a caller
 * can republish a scene snapshot (see `ThreeSceneGraphController.publish`) —
 * this module never touches React state or a snapshot cache itself.
 */
export function reflectThreeObject(object: THREE.Object3D, onChange?: () => void): ThreeObjectReflection {
  const groups: ReflectedGroup[] = [commonGroup(object, onChange), transformGroup(object, onChange)];

  if ((object as THREE.Light).isLight) {
    groups.push(lightGroup(object as THREE.Light, onChange));
  }

  const mesh = object as THREE.Mesh;
  if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
    const group = materialGroup(mesh.material, onChange);
    if (group) groups.push(group);
  }

  return { objectId: object.uuid, groups };
}
