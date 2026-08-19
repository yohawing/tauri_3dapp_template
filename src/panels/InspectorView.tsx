import type { ReactNode } from "react";
import type { SceneNodeSummary } from "../scene/core/projection";
import "./Inspector.css";

export interface InspectorViewProps {
  /** Node list row for the selection (id/label/kind); null when nothing is selected. */
  summary: SceneNodeSummary | undefined;
  /**
   * Editing controls for the current selection (transform / material / light
   * bindings, etc). The host decides what control surface to render here —
   * this component only owns the panel chrome (tab header, selection label,
   * empty state) around it.
   */
  children?: ReactNode;
}

/**
 * Presentational panel chrome for the Inspector: tab header, selected-node
 * label, and an empty state when nothing is selected. No data source, no
 * Tauri IPC — the host supplies the selection summary and renders whatever
 * editing controls it wants as `children`.
 */
export function InspectorView({ summary, children }: InspectorViewProps) {
  return (
    <div className="inspector-panel">
      <div className="inspector-panel__header">
        <span className="inspector-panel__tab inspector-panel__tab--active">Inspector</span>
      </div>
      {!summary ? null : (
        <div className="inspector-selection">
          <span className="inspector-selection__label">{summary.label}</span>
          <span className="inspector-selection__kind">{summary.kind}</span>
        </div>
      )}
      <div className="inspector-panel__content">
        {!summary ? <div className="inspector-empty">No scene node selected</div> : children}
      </div>
    </div>
  );
}
