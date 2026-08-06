import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewIDisposable,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";
import { Toolbar } from "./panels/Toolbar";
import { Outliner } from "./panels/Outliner";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import { ViewportHost, requestViewportRemeasure, type ViewportMode } from "./viewport/ViewportHost";
import { buildDefaultLayout } from "./shell/layout";

let backendSelfTestHasRun = false;
let dockSelfTestHasRun = false;

// Panel content, keyed by the `component` name used in shell/layout.ts. Each
// entry wraps the (self-contained, opaque) panel component or ViewportHost in
// our own marker div: dockview-react gives every panel's content the same
// `.dv-react-part` wrapper (no per-panel class), so the transparent-vs-opaque
// distinction has to be painted one level in, by us. Defined at module scope
// so the object reference is stable — DockviewReact re-registers all panel
// components whenever this prop's identity changes.
const DOCK_COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  outliner: () => (
    <div className="dock-panel-content">
      <Outliner />
    </div>
  ),
  inspector: () => (
    <div className="dock-panel-content">
      <Inspector />
    </div>
  ),
  timeline: () => (
    <div className="dock-panel-content">
      <Timeline />
    </div>
  ),
  viewport: (props) => (
    <div className="dock-panel-content dock-panel-content--viewport">
      <ViewportHost mode={(props.params.mode as ViewportMode) ?? "native"} />
    </div>
  ),
};

function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutSubRef = useRef<DockviewIDisposable | null>(null);
  const addGroupSubRef = useRef<DockviewIDisposable | null>(null);
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

  // Disposes the onDidLayoutChange subscription (created in onReady, below)
  // when App unmounts. DockviewReact owns creating/disposing the DockviewApi
  // itself; this only tears down our own subscription onto it.
  useEffect(() => {
    return () => {
      layoutSubRef.current?.dispose();
      addGroupSubRef.current?.dispose();
    };
  }, []);

  // Called once by DockviewReact after it builds the DockviewApi. Wires
  // onDidAddGroup *before* building the layout so it also catches the initial
  // groups (see the comment above the subscription), then builds the default
  // layout, does the initial viewport remeasure, and wires layout changes
  // (including a panel moving without resizing, which a ResizeObserver alone
  // would miss) to remeasure again — the same subscription also keeps the
  // Toolbar's inspector-visible label in sync even if the user closes the
  // Inspector tab directly instead of via the button.
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    // We render our own header inside every panel (Outliner/Inspector/
    // Timeline), so dockview's own tab bar would be a duplicate title and
    // dead chrome once dnd is off (see the `disableDnd` prop below). Setting
    // `group.header.hidden = true` is the supported API for this (see
    // dockview-core's dockviewGroupPanelModel.d.ts `IHeader` /
    // TabsContainer's `hidden` setter, which toggles `display: none` on the
    // tab strip element itself — no CSS hack, and no leftover height since
    // the element is fully removed from layout). `hideHeader` in `GroupOptions`
    // only applies at group-creation time and can't be threaded through
    // `addPanel`'s implicit group creation, so `onDidAddGroup` is the one hook
    // that covers every group — the four from `buildDefaultLayout` below, the
    // Inspector's re-added group from `onToggleInspector`, and any future one.
    addGroupSubRef.current = api.onDidAddGroup((group) => {
      group.header.hidden = true;
    });
    buildDefaultLayout(api, viewportMode);
    requestViewportRemeasure();
    layoutSubRef.current = api.onDidLayoutChange(() => {
      requestViewportRemeasure();
      setInspectorVisible(api.getPanel("inspector") != null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once on mount; viewportMode changes are pushed via the effect below instead.
  }, []);

  // Keeps the mounted viewport panel's mode in sync with Toolbar toggles.
  useEffect(() => {
    apiRef.current?.getPanel("viewport")?.update({ params: { mode: viewportMode } });
  }, [viewportMode]);

  const onToggleInspector = useCallback(() => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const panel = api.getPanel("inspector");
    if (panel) {
      api.removePanel(panel);
    } else {
      api.addPanel({
        id: "inspector",
        component: "inspector",
        title: "Inspector",
        position: { direction: "right", referencePanel: "viewport" },
        initialWidth: 280,
      });
    }
  }, []);

  const onResetLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    buildDefaultLayout(api, viewportMode);
    requestViewportRemeasure();
  }, [viewportMode]);

  // Dev-only self-test, gated behind VITE_DOCK_SELF_TEST: proves the viewport
  // rect stays correct across dock layout changes, including the one case a
  // ResizeObserver alone can't catch — a panel move that changes the
  // viewport's position without changing its size. Runs at most once per
  // page load, same pattern as VITE_INPUT_SELF_TEST / VITE_BACKEND_SELF_TEST.
  useEffect(() => {
    if (dockSelfTestHasRun || !import.meta.env.VITE_DOCK_SELF_TEST) {
      return;
    }
    dockSelfTestHasRun = true;

    setTimeout(() => {
      console.log("[dock-self-test] step=move-outliner-right");
      const api = apiRef.current;
      const outlinerPanel = api?.getPanel("outliner");
      const viewportPanel = api?.getPanel("viewport");
      if (outlinerPanel && viewportPanel) {
        // panel.api.moveTo({ group, position }) is the exact call a real tab
        // drag resolves to internally (dockview-core's
        // DockviewPanelApiImpl.moveTo -> accessor.moveGroupOrPanel), so this
        // drives the genuine move machinery rather than faking a pointer
        // event. Moving outliner from the left of the viewport's group to
        // its right is the move-without-resize case: the viewport is
        // expected to keep its width while its x shifts, which a
        // ResizeObserver on the viewport element alone would never notice —
        // only the onDidLayoutChange -> requestViewportRemeasure() wiring in
        // onReady, above, can catch it.
        outlinerPanel.api.moveTo({ group: viewportPanel.group, position: "right" });
      }
    }, 3000);

    setTimeout(() => {
      console.log("[dock-self-test] step=remove-inspector");
      // Same code path the Toolbar's "Hide Inspector" button calls. Removing
      // the inspector widens the viewport group — the resize case, which a
      // plain ResizeObserver on the viewport element already handles, used
      // here as a control/contrast to the move-only step above.
      onToggleInspector();
    }, 6000);

    setTimeout(() => {
      console.log("[dock-self-test] step=reset-layout");
      // Same code path the Toolbar's "Reset Layout" button calls.
      onResetLayout();
    }, 9000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires at most once per page load; intentionally not re-arming on onToggleInspector/onResetLayout identity changes.
  }, []);

  return (
    <div className="app-shell">
      <Toolbar
        inspectorVisible={inspectorVisible}
        onToggleInspector={onToggleInspector}
        viewportMode={viewportMode}
        onToggleViewportMode={toggleViewportMode}
        onResetLayout={onResetLayout}
      />
      <div className="dockview-shell">
        {/* themeAbyss is kept deliberately even though App.css nulls out its
            headline feature (`--dv-group-view-background-color`, painted on
            .dv-dockview/.dv-groupview/.dv-resize-container) to preserve the
            viewport hole. It still supplies every other themed value dockview
            reads — sash/splitter color, context menu, watermark — so the dock
            chrome that remains (now just sashes, since the tab bar is hidden
            and dnd is off, below) stays readable and matches the rest of the
            (dark) app UI. Swapping to a plainer base theme would only save
            deleting one CSS custom property we already override; it wouldn't
            remove any risk, so themeAbyss stays. */}
        <DockviewReact
          theme={themeAbyss}
          components={DOCK_COMPONENTS}
          onReady={onReady}
          // No tab bar means no drag handle, but stray drop-target overlays /
          // edge drop zones would still be reachable (e.g. dragging a panel's
          // own content) and would be confusing dead weight now that
          // rearranging is out of scope for this simplified layout (see
          // onDidAddGroup above). `disableDnd` is dockview-core's top-level
          // kill switch — it zeroes out both the html5 and pointer DnD
          // backends (dockview-core's dndCapabilities.ts) so no drag source
          // is ever wired, not just a preview suppression. It does not affect
          // `panel.api.moveTo(...)`, which the VITE_DOCK_SELF_TEST hook uses:
          // that call goes straight through `DockviewComponent.moveGroupOrPanel`
          // (dockviewComponent.js), the same programmatic path a resolved drag
          // would land on, entirely separate from the DnD source/overlay code
          // `disableDnd` turns off.
          disableDnd
        />
      </div>
    </div>
  );
}

export default App;
