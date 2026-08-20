import { useEffect, useRef } from "react";
import { Pane } from "tweakpane";
import type * as THREE from "three";
import { reflectThreeObject, type ReflectedField } from "../scene/adapters/threeObjectReflector";
// Reuses TweakpaneInspector's own stylesheet — both components render into
// the same `.inspector-pane-host`/`.inspector-pane` shell, so the dark-theme
// Tweakpane variables it defines apply here unchanged.
import "./Inspector.css";

/**
 * Tweakpane control surface driven by `reflectThreeObject`'s generic
 * binding descriptors, for a host that selected a real `THREE.Object3D`
 * directly (no Native/Tauri `SelectedSceneNode` DTO available) — e.g. this
 * template's own Canvas fallback, or an external three.js viewport. Every
 * edit here writes straight back to `object` (see `threeObjectReflector.ts`);
 * there is no `SceneCommand` dispatch. `TweakpaneInspector.tsx` (the Native
 * path) is unrelated and unchanged — this is an additive alternative for
 * hosts with a live three.js object instead of a DTO.
 */
export function ThreeObjectInspector({
  object,
  onChange,
}: {
  object: THREE.Object3D;
  /** Called after any field writes back to `object` (e.g. to republish a
   * `ThreeSceneGraphController` snapshot so the Outliner picks up a changed
   * name/visibility). */
  onChange?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The set of groups/fields present (Light vs. Material vs. neither) only
  // depends on the selected object's identity, so the Pane is rebuilt when
  // that changes and never on a field's own value change (those write
  // straight into the three.js object below instead of round-tripping
  // through React state).
  const objectId = object.uuid;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pane = new Pane({ container });
    const notify = () => onChangeRef.current?.();
    const reflection = reflectThreeObject(object, notify);

    const addField = (folder: ReturnType<Pane["addFolder"]>, field: ReflectedField) => {
      const model = { value: field.get() };
      const binding = folder.addBinding(model, "value", {
        label: field.label,
        readonly: field.readonly,
        ...(field.kind === "color" ? { color: { alpha: false } } : {}),
        ...(field.kind === "vector3"
          ? {
              x: { step: field.options?.step },
              y: { step: field.options?.step },
              z: { step: field.options?.step },
            }
          : {}),
        ...(field.kind === "number"
          ? { min: field.options?.min, max: field.options?.max, step: field.options?.step }
          : {}),
      });
      binding.on("change", (event: { value: unknown }) => {
        field.set(event.value);
        // The reflector may reject an edit (non-finite number, malformed
        // hex, …) without throwing — re-read the authoritative value so a
        // rejected edit visibly snaps back instead of leaving the pane
        // showing a value the three.js object never actually took.
        model.value = field.get();
        binding.refresh();
      });
    };

    for (const group of reflection.groups) {
      const folder = pane.addFolder({ title: group.title, expanded: true });
      for (const field of group.fields) addField(folder, field);
    }

    return () => pane.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild keyed on object identity only, see comment above.
  }, [objectId]);

  return (
    <div className="inspector-pane-host">
      <div ref={containerRef} className="inspector-pane" />
    </div>
  );
}
