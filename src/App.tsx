import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import {
  actionById,
  findShortcutAction,
  isEditableTarget,
  isMacPlatform,
  type EditorAction,
} from "./actions/editorActions";
import { MenuBar } from "./panels/MenuBar";
import { ConsoleDrawer, createConsoleStore, type ConsoleEntry, type ConsoleStore } from "./console";
import { SettingsModal } from "./settings/SettingsModal";
import { loadSettings, saveSettings, type Settings } from "./settings/model";
import { Outliner } from "./panels/Outliner";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import { ViewportHost, requestViewportRemeasure, type ViewportMode } from "./viewport/ViewportHost";
import {
  AVAILABLE_RENDERER_STATUS,
  getRendererStatus,
  onRendererStatusChanged,
  type RendererStatus,
} from "./viewport/rendererStatus";
import { buildDefaultLayout } from "./shell/layout";
import { useSceneFileController } from "./scene/useSceneFileController";

let backendSelfTestHasRun = false;
let dockSelfTestHasRun = false;
let shortcutSelfTestHasRun = false;
let shellSelfTestHasRun = false;

// Panel content, keyed by the `component` name used in shell/layout.ts. Each
// entry wraps the (self-contained, opaque) panel component or ViewportHost in
// our own marker div: dockview-react gives every panel's content the same
// `.dv-react-part` wrapper (no per-panel class), so the transparent-vs-opaque
// distinction has to be painted one level in, by us. Defined at module scope
// so the object reference is stable — DockviewReact re-registers all panel
// components whenever this prop's identity changes.
const ConsoleStoreContext = createContext<ConsoleStore | null>(null);

function BottomPanel(props: IDockviewPanelProps) {
  const consoleStore = useContext(ConsoleStoreContext);
  if (props.params.view === "console" && consoleStore) {
    return <ConsoleDrawer store={consoleStore} className="console-drawer--embedded" />;
  }
  return <Timeline />;
}

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
  timeline: (props) => (
    <div className="dock-panel-content">
      <BottomPanel {...props} />
    </div>
  ),
  viewport: (props) => (
    <div className="dock-panel-content dock-panel-content--viewport">
      <ViewportHost
        mode={(props.params.mode as ViewportMode) ?? "native"}
        showDebugOverlay={(props.params.showDebugOverlay as boolean | undefined) ?? true}
        fallbackReason={(props.params.fallbackReason as string | null | undefined) ?? null}
        recoveryHint={(props.params.recoveryHint as string | null | undefined) ?? null}
      />
    </div>
  ),
};

function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutSubRef = useRef<DockviewIDisposable | null>(null);
  const addGroupSubRef = useRef<DockviewIDisposable | null>(null);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [viewportMode, setViewportMode] = useState<ViewportMode>("native");
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>(AVAILABLE_RENDERER_STATUS);
  const [consoleVisible, setConsoleVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [consoleStore] = useState(() =>
    createConsoleStore({
      capacity: 500,
      levelFilter: settings.console.minimumLevel,
      autoScroll: settings.console.autoScroll,
    }),
  );
  const consoleState = useSyncExternalStore(
    consoleStore.subscribe,
    consoleStore.getState,
    consoleStore.getState,
  );
  const consoleErrorCount = consoleState.entries.filter((entry) => entry.level === "error").length;
  const isMac = useMemo(() => isMacPlatform(navigator.platform), []);

  const appendDiagnostic = useCallback(
    (level: ConsoleEntry["level"], source: ConsoleEntry["source"], message: string) => {
      consoleStore.append({ timestamp: new Date().toISOString(), level, source, message });
    },
    [consoleStore],
  );

  const selectNativeRenderer = useCallback(() => {
    if (!rendererStatus.nativeAvailable) {
      appendDiagnostic(
        "error",
        "renderer",
        rendererStatus.fallbackReason ?? "Native renderer is unavailable",
      );
      setConsoleVisible(true);
      return;
    }
    setViewportMode("native");
    appendDiagnostic("info", "renderer", "Backend selected: Native wgpu");
  }, [appendDiagnostic, rendererStatus]);
  const selectCanvasRenderer = useCallback(() => {
    setViewportMode("canvas");
    appendDiagnostic("info", "renderer", "Backend selected: Canvas (three.js)");
  }, [appendDiagnostic]);
  const activateNativeForScene = useCallback(() => {
    if (rendererStatus.nativeAvailable) setViewportMode("native");
  }, [rendererStatus.nativeAvailable]);
  const revealConsole = useCallback(() => setConsoleVisible(true), []);
  const {
    status: sceneFileStatus,
    busy: sceneFileBusy,
    newScene: onNewScene,
    openScene: onOpenScene,
    saveScene: onSaveScene,
    saveSceneAs: onSaveSceneAs,
  } = useSceneFileController({
    appendDiagnostic,
    activateNativeRenderer: activateNativeForScene,
    revealConsole,
  });
  const viewportPanelParams = useMemo(
    () => ({
      mode: viewportMode,
      showDebugOverlay: settings.viewport.debugOverlay,
      fallbackReason: rendererStatus.fallbackReason,
      recoveryHint: rendererStatus.recoveryHint,
    }),
    [rendererStatus.fallbackReason, rendererStatus.recoveryHint, settings.viewport.debugOverlay, viewportMode],
  );

  // Disposes the onDidLayoutChange subscription (created in onReady, below)
  // when App unmounts. DockviewReact owns creating/disposing the DockviewApi
  // itself; this only tears down our own subscription onto it.
  useEffect(() => {
    return () => {
      layoutSubRef.current?.dispose();
      addGroupSubRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    appendDiagnostic("info", "frontend", "Application shell ready");
    appendDiagnostic("info", "scene", "Scene projection connected");

    const onViewportRect = (event: Event) => {
      const rect = (event as CustomEvent<{ x: number; y: number; width: number; height: number }>).detail;
      appendDiagnostic(
        "info",
        "viewport",
        `rect x=${rect.x.toFixed(1)} y=${rect.y.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)}`,
      );
    };
    const onDiagnostic = (event: Event) => {
      const detail = (event as CustomEvent<{
        level: ConsoleEntry["level"];
        source: ConsoleEntry["source"];
        message: string;
      }>).detail;
      appendDiagnostic(detail.level, detail.source, detail.message);
    };
    const onConsoleToggle = (event: Event) => {
      const open = (event as CustomEvent<{ open?: boolean }>).detail?.open;
      if (typeof open === "boolean") setConsoleVisible(open);
    };
    window.addEventListener("tauri3d:viewport-rect", onViewportRect);
    window.addEventListener("tauri3d:diagnostic", onDiagnostic);
    window.addEventListener("tauri3d:console-toggle", onConsoleToggle);
    return () => {
      window.removeEventListener("tauri3d:viewport-rect", onViewportRect);
      window.removeEventListener("tauri3d:diagnostic", onDiagnostic);
      window.removeEventListener("tauri3d:console-toggle", onConsoleToggle);
    };
  }, [appendDiagnostic]);

  useEffect(() => {
    let cancelled = false;
    const acceptStatus = (status: RendererStatus) => {
      if (cancelled) return;
      setRendererStatus(status);
      if (!status.nativeAvailable) {
        setViewportMode("canvas");
        setConsoleVisible(true);
        appendDiagnostic(
          "error",
          "renderer",
          `Automatic Canvas fallback: ${status.fallbackReason ?? "Native renderer is unavailable"}`,
        );
      }
    };
    const unlisten = onRendererStatusChanged(acceptStatus);
    void getRendererStatus()
      .then(acceptStatus)
      .catch((error) => {
        if (!cancelled) {
          appendDiagnostic("warn", "renderer", `Renderer status unavailable: ${String(error)}`);
        }
      });
    return () => {
      cancelled = true;
      void unlisten.then((dispose) => dispose());
    };
  }, [appendDiagnostic]);

  useEffect(() => {
    consoleStore.setFilter(settings.console.minimumLevel);
    consoleStore.setAutoScroll(settings.console.autoScroll);
    apiRef.current?.getPanel("viewport")?.update({
      params: viewportPanelParams,
    });
  }, [consoleStore, settings, viewportPanelParams]);

  const onSettingsChange = useCallback(
    (next: Settings) => {
      setSettings(next);
      if (!saveSettings(next)) {
        appendDiagnostic("warn", "frontend", "Settings changed for this session but could not be persisted");
      }
    },
    [appendDiagnostic],
  );

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
    api.getPanel("viewport")?.update({
      params: viewportPanelParams,
    });
    requestViewportRemeasure();
    layoutSubRef.current = api.onDidLayoutChange(() => {
      requestViewportRemeasure();
      setInspectorVisible(api.getPanel("inspector") != null);
    });
  }, [viewportMode, viewportPanelParams]);

  // Keeps the mounted viewport panel's mode in sync with renderer actions.
  useEffect(() => {
    apiRef.current?.getPanel("viewport")?.update({
      params: viewportPanelParams,
    });
  }, [viewportPanelParams]);

  useEffect(() => {
    apiRef.current?.getPanel("timeline")?.update({
      params: { view: consoleVisible ? "console" : "timeline" },
    });
    requestViewportRemeasure();
  }, [consoleVisible]);

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
    api.getPanel("timeline")?.update({
      params: { view: consoleVisible ? "console" : "timeline" },
    });
    api.getPanel("viewport")?.update({
      params: viewportPanelParams,
    });
    requestViewportRemeasure();
  }, [consoleVisible, viewportMode, viewportPanelParams]);

  const actions = useMemo<readonly EditorAction[]>(
    () => [
      {
        id: "file.new",
        label: "New",
        shortcut: { code: "KeyN", primary: true },
        enabled: !sceneFileBusy,
        run: onNewScene,
      },
      {
        id: "file.open",
        label: "Open…",
        shortcut: { code: "KeyO", primary: true },
        enabled: !sceneFileBusy,
        run: onOpenScene,
      },
      {
        id: "file.save",
        label: "Save",
        shortcut: { code: "KeyS", primary: true },
        enabled: !sceneFileBusy && sceneFileStatus.canSave,
        run: onSaveScene,
      },
      {
        id: "file.saveAs",
        label: "Save As…",
        shortcut: { code: "KeyS", primary: true, shift: true },
        enabled: !sceneFileBusy && sceneFileStatus.hasDocument,
        run: onSaveSceneAs,
      },
      {
        id: "renderer.native",
        label: "Native",
        shortcut: { code: "Digit1", primary: true },
        enabled: rendererStatus.nativeAvailable,
        checked: viewportMode === "native",
        run: selectNativeRenderer,
      },
      {
        id: "renderer.canvas",
        label: "Canvas",
        shortcut: { code: "Digit2", primary: true },
        enabled: true,
        checked: viewportMode === "canvas",
        run: selectCanvasRenderer,
      },
      {
        id: "view.inspector.toggle",
        label: inspectorVisible ? "Hide Inspector" : "Show Inspector",
        shortcut: { code: "KeyI", primary: true },
        enabled: true,
        checked: inspectorVisible,
        run: onToggleInspector,
      },
      {
        id: "view.console.toggle",
        label: `${consoleVisible ? "Hide" : "Show"} Console${consoleErrorCount > 0 ? ` • ${consoleErrorCount}` : ""}`,
        enabled: true,
        checked: consoleVisible,
        run: () => setConsoleVisible((visible) => !visible),
      },
      {
        id: "view.settings.open",
        label: "Settings…",
        enabled: true,
        run: () => setSettingsOpen(true),
      },
      {
        id: "view.layout.reset",
        label: "Reset Layout",
        shortcut: { code: "Digit0", primary: true, shift: true },
        enabled: true,
        run: onResetLayout,
      },
    ],
    [
      inspectorVisible,
      consoleVisible,
      consoleErrorCount,
      onNewScene,
      onOpenScene,
      onResetLayout,
      onSaveScene,
      onSaveSceneAs,
      onToggleInspector,
      sceneFileBusy,
      sceneFileStatus,
      rendererStatus,
      selectCanvasRenderer,
      selectNativeRenderer,
      viewportMode,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const action = findShortcutAction(actions, event, isMac);
      if (!action) return;
      event.preventDefault();
      action.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, isMac]);

  // Dev-only shortcut integration gate. Synthetic keydown events exercise
  // the same window listener as physical keyboard input without bypassing
  // shortcut matching, editable-target filtering, or Action dispatch.
  useEffect(() => {
    if (shortcutSelfTestHasRun || !import.meta.env.VITE_SHORTCUT_SELF_TEST) return;
    shortcutSelfTestHasRun = true;
    const press = (code: string, shiftKey = false) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code,
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    setTimeout(() => press("Digit2"), 2000);
    setTimeout(() => press("KeyI"), 4000);
    setTimeout(() => press("Digit0", true), 6000);
    setTimeout(() => press("Digit1"), 8000);
  }, [isMac]);

  // Dev-only self-test, gated behind VITE_BACKEND_SELF_TEST. It uses the same
  // finite actions as the Menu Bar and shortcuts.
  useEffect(() => {
    if (backendSelfTestHasRun || !import.meta.env.VITE_BACKEND_SELF_TEST) return;
    backendSelfTestHasRun = true;
    setTimeout(() => actionById(actions, "renderer.canvas").run(), 3000);
    setTimeout(() => actionById(actions, "renderer.native").run(), 6000);
  }, [actions]);

  // Reproducible GUI gate for the Console drawer and Settings modal. Both
  // steps use the exact finite actions exposed by the View menu.
  useEffect(() => {
    if (shellSelfTestHasRun || !import.meta.env.VITE_SHELL_SELF_TEST) return;
    shellSelfTestHasRun = true;
    setTimeout(() => actionById(actions, "view.console.toggle").run(), 2000);
    setTimeout(() => actionById(actions, "view.settings.open").run(), 5000);
    setTimeout(() => setSettingsOpen(false), 8000);
  }, [actions]);

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
      console.log("[dock-self-test] step=resize-viewport-group");
      const viewportPanel = apiRef.current?.getPanel("viewport");
      // Dockview's group size API drives the same grid allocation that a sash
      // drag commits, without depending on OS pointer injection or DPI-aware
      // cursor coordinates in the repeatable self-test.
      viewportPanel?.group.api.setSize({ width: 620 });
    }, 1500);

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
      // Same action path the View menu and Ctrl+I call. Removing
      // the inspector widens the viewport group — the resize case, which a
      // plain ResizeObserver on the viewport element already handles, used
      // here as a control/contrast to the move-only step above.
      actionById(actions, "view.inspector.toggle").run();
    }, 6000);

    setTimeout(() => {
      console.log("[dock-self-test] step=reset-layout");
      // Same action path the View menu and Ctrl+Shift+0 call.
      actionById(actions, "view.layout.reset").run();
    }, 9000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires at most once per page load; intentionally not re-arming on onToggleInspector/onResetLayout identity changes.
  }, [actions]);

  return (
    <div className="app-shell">
      <MenuBar
        actions={actions}
        backendLabel={
          viewportMode === "native"
            ? "Native wgpu"
            : rendererStatus.nativeAvailable
              ? "Canvas (three.js)"
              : "Canvas fallback"
        }
        documentLabel={sceneFileStatus.displayName}
        isMac={isMac}
      />
      <ConsoleStoreContext.Provider value={consoleStore}>
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
      </ConsoleStoreContext.Provider>
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={onSettingsChange}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export default App;
