import { useState } from "react";
import "./App.css";
import { Toolbar } from "./panels/Toolbar";
import { Outliner } from "./panels/Outliner";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import { ViewportHost } from "./viewport/ViewportHost";

function App() {
  const [inspectorVisible, setInspectorVisible] = useState(true);

  return (
    <div
      className={
        inspectorVisible ? "app-shell" : "app-shell app-shell--no-inspector"
      }
    >
      <Toolbar
        inspectorVisible={inspectorVisible}
        onToggleInspector={() => setInspectorVisible((visible) => !visible)}
      />
      <Outliner />
      <ViewportHost />
      {inspectorVisible && <Inspector />}
      <Timeline />
    </div>
  );
}

export default App;
