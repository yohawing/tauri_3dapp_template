import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { Toolbar } from "./panels/Toolbar";
import { Outliner } from "./panels/Outliner";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import { ViewportHost, type ViewportMode } from "./viewport/ViewportHost";

let backendSelfTestHasRun = false;

function App() {
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [viewportMode, setViewportMode] = useState<ViewportMode>("native");

  const toggleViewportMode = useCallback(() => {
    setViewportMode((mode) => (mode === "native" ? "canvas" : "native"));
  }, []);

  // Dev-only self-test, gated behind VITE_BACKEND_SELF_TEST: drives the same
  // toggle code path as the Toolbar button to auto-switch to canvas at +3s
  // and back to native at +6s. Runs at most once per page load, same pattern
  // as VITE_INPUT_SELF_TEST in viewport/input.ts.
  useEffect(() => {
    if (backendSelfTestHasRun || !import.meta.env.VITE_BACKEND_SELF_TEST) {
      return;
    }
    backendSelfTestHasRun = true;
    setTimeout(toggleViewportMode, 3000);
    setTimeout(toggleViewportMode, 6000);
  }, [toggleViewportMode]);

  return (
    <div
      className={
        inspectorVisible ? "app-shell" : "app-shell app-shell--no-inspector"
      }
    >
      <Toolbar
        inspectorVisible={inspectorVisible}
        onToggleInspector={() => setInspectorVisible((visible) => !visible)}
        viewportMode={viewportMode}
        onToggleViewportMode={toggleViewportMode}
      />
      <Outliner />
      <ViewportHost mode={viewportMode} />
      {inspectorVisible && <Inspector />}
      <Timeline />
    </div>
  );
}

export default App;
