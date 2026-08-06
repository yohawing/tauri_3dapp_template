interface ToolbarProps {
  inspectorVisible: boolean;
  onToggleInspector: () => void;
}

export function Toolbar({ inspectorVisible, onToggleInspector }: ToolbarProps) {
  return (
    <div className="toolbar">
      <span className="toolbar__title">Tauri3D</span>
      <div className="toolbar__spacer" />
      <button
        type="button"
        className="toolbar__button"
        onClick={onToggleInspector}
      >
        {inspectorVisible ? "Hide Inspector" : "Show Inspector"}
      </button>
    </div>
  );
}
