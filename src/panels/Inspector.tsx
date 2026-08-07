import { useEffect, useState } from "react";
import {
  dispatchSceneCommand,
  useSceneProjection,
} from "../scene/adapters/sceneProjectionDataSource";
import type { SceneMaterial, SceneTransform } from "../scene/core/projection";
import "./Inspector.css";

const format = (value: number) => value.toFixed(3);

function VectorField({ label, values, names }: { label: string; values: readonly number[]; names: readonly string[] }) {
  return (
    <div className="inspector-field">
      <span className="inspector-field__label">{label}</span>
      <div className="inspector-field__values">
        {values.map((value, index) => (
          <span className="inspector-value" key={`${label}-${names[index]}`}>
            <span className="inspector-value__axis">{names[index]}</span>
            {format(value)}
          </span>
        ))}
      </div>
    </div>
  );
}
function TransformSection({ transform }: { transform: SceneTransform }) {
  return (
    <section className="inspector-section">
      <div className="inspector-section__title">Local Transform</div>
      <VectorField label="Translation" values={transform.translation} names={["X", "Y", "Z"]} />
      <VectorField label="Rotation" values={transform.rotation} names={["X", "Y", "Z", "W"]} />
      <VectorField label="Scale" values={transform.scale} names={["X", "Y", "Z"]} />
    </section>
  );
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const componentToHex = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");
const colorToHex = (color: SceneMaterial["color"]) =>
  `#${componentToHex(color[0])}${componentToHex(color[1])}${componentToHex(color[2])}`;

function hexToColor(hex: string, alpha: number): SceneMaterial["color"] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
    alpha,
  ];
}

function MaterialSection({ nodeId, material }: { nodeId: string; material: SceneMaterial }) {
  const [draft, setDraft] = useState(material);

  useEffect(() => setDraft(material), [nodeId, material]);

  const setColor = (hex: string) => {
    const color = hexToColor(hex, draft.color[3]);
    setDraft((current) => ({ ...current, color }));
    dispatchSceneCommand({ type: "setBaseColor", nodeId, color });
  };

  const setScalar = (kind: "metallic" | "roughness", value: number) => {
    const clamped = clamp01(value);
    setDraft((current) => ({ ...current, [kind]: clamped }));
    dispatchSceneCommand({
      type: kind === "metallic" ? "setMetallic" : "setRoughness",
      nodeId,
      value: clamped,
    });
  };

  return (
    <section className="inspector-section">
      <div className="inspector-section__title">Base Material</div>
      <label className="inspector-field">
        <span className="inspector-field__label">Color</span>
        <span className="inspector-color-editor">
          <input
            aria-label="Base color"
            className="inspector-color-input"
            type="color"
            value={colorToHex(draft.color)}
            onChange={(event) => setColor(event.currentTarget.value)}
          />
          <span>{colorToHex(draft.color).toUpperCase()}</span>
        </span>
      </label>
      <MaterialSlider
        label="Metallic"
        value={draft.metallic}
        onChange={(value) => setScalar("metallic", value)}
      />
      <MaterialSlider
        label="Roughness"
        value={draft.roughness}
        onChange={(value) => setScalar("roughness", value)}
      />
    </section>
  );
}

function MaterialSlider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="inspector-field">
      <span className="inspector-field__label">{label}</span>
      <span className="inspector-slider-editor">
        <input
          aria-label={label}
          className="inspector-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={value}
          onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        />
        <span className="inspector-number">{value.toFixed(2)}</span>
      </span>
    </label>
  );
}

export function Inspector() {
  const projection = useSceneProjection();
  const selected = projection.selected;
  const summary = projection.nodes.find((node) => node.id === projection.selectedNodeId);

  return (
    <div className="inspector-panel">
      <div className="inspector-panel__header">Inspector</div>
      <div className="inspector-panel__content">
        {!selected || !summary ? (
          <div className="inspector-empty">No scene node selected</div>
        ) : (
          <>
            <div className="inspector-selection">
              <span className="inspector-selection__label">{summary.label}</span>
              <span className="inspector-selection__kind">{summary.kind}</span>
            </div>
            <TransformSection transform={selected.transform} />
            {selected.material && <MaterialSection nodeId={selected.id} material={selected.material} />}
          </>
        )}
      </div>
    </div>
  );
}
