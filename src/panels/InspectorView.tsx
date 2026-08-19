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
  /**
   * Whether to draw this component's own `inspector-panel__header` "Inspector"
   * tab row. Defaults to `true` (this template's own `App.tsx` hides every
   * dockview group's native tab strip, so that own-drawn header is this
   * panel's only tab affordance there — see `App.css`'s doc comment on
   * `.dockview-shell .dv-dockview`). Pass `false` for a host that instead
   * shows dockview's *native* tab strip for this panel's group (the tab
   * already reads "Inspector" there — see yw-retarget-web's `shell/layout.ts`
   * doc comment), where this own header would otherwise stack as a second,
   * redundant "Inspector" label directly beneath the real dockview tab.
   */
  showHeader?: boolean;
}

/**
 * Presentational panel chrome for the Inspector: tab header, selected-node
 * label, and an empty state when nothing is selected. No data source, no
 * Tauri IPC — the host supplies the selection summary and renders whatever
 * editing controls it wants as `children`.
 */
export function InspectorView({ summary, children, showHeader = true }: InspectorViewProps) {
  return (
    <div className="inspector-panel">
      {!showHeader ? null : (
        <div className="inspector-panel__header">
          <span className="inspector-panel__tab inspector-panel__tab--active">Inspector</span>
        </div>
      )}
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
