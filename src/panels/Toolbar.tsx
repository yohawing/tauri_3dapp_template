import type { ViewportMode } from "../viewport/ViewportHost";

interface ToolbarProps {
  inspectorVisible: boolean;
  onToggleInspector: () => void;
  viewportMode: ViewportMode;
  onToggleViewportMode: () => void;
  onResetLayout: () => void;
}

export function Toolbar({
  inspectorVisible,
  onToggleInspector,
  viewportMode,
  onToggleViewportMode,
  onResetLayout,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <span className="toolbar__title">Tauri3D</span>
      <div className="toolbar__spacer" />
      <button
        type="button"
        className="toolbar__button"
        onClick={onToggleViewportMode}
      >
        {viewportMode === "native" ? "Switch to Canvas" : "Switch to Native"}
      </button>
      <button
        type="button"
        className="toolbar__button"
        onClick={onToggleInspector}
      >
        {inspectorVisible ? "Hide Inspector" : "Show Inspector"}
      </button>
      <button
        type="button"
        className="toolbar__button"
        onClick={onResetLayout}
      >
        Reset Layout
      </button>
    </div>
  );
}
