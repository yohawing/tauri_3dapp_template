import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
import {
  createConsoleStore,
  normalizeConsoleDiagnostic,
  safeDiagnosticText,
  type ConsoleEntry,
  type ConsoleStore,
} from "./console";
import { SettingsModal } from "./settings/SettingsModal";
import {
  loadSettings,
  normalizeViewportEnvironmentSettings,
  saveSettings,
  type Settings,
  type UiScale,
  type ViewportEnvironmentSettings,
  type ViewportLightingSettings,
} from "./settings/model";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import {
  ViewportHost,
  createLatestCommandInvoker,
  normalizeViewportRect,
  requestViewportRemeasure,
  type CameraFov,
  type CameraProjection,
  type CameraViewPreset,
  type ViewportMode,
} from "./viewport/ViewportHost";
import {
  AVAILABLE_RENDERER_STATUS,
  getRendererStatus,
  onRendererStatusChanged,
  type RendererStatus,
} from "./viewport/rendererStatus";
import { buildDefaultLayout } from "./shell/layout";
import { useSceneFileController } from "./scene/useSceneFileController";
import { createSelfTestTimerBag, type SelfTestTimerBag } from "./selfTestTimers";
import { focusLazyPanelHost, LazyPanelBoundary } from "./components/LazyPanelBoundary";
import { redoSceneTransform, undoSceneTransform } from "./scene/adapters/sceneProjectionDataSource";

let backendSelfTestHasRun = false;
let dockSelfTestHasRun = false;
let shortcutSelfTestHasRun = false;
let shellSelfTestHasRun = false;
let viewportDisplaySelfTestHasRun = false;
let viewportCameraSelfTestHasRun = false;
let viewportEnvironmentSelfTestHasRun = false;
let viewportLightingSelfTestHasRun = false;

function createLazyConsoleDrawer() {
  return lazy(() =>
    import("./console/ConsoleDrawer").then(({ ConsoleDrawer }) => ({ default: ConsoleDrawer })),
  );
}

function createLazyOutliner() {
  return lazy(() =>
    import("./panels/Outliner").then(({ Outliner }) => ({ default: Outliner })),
  );
}

const UiScaleContext = createContext<UiScale>(1);

function LazyOutlinerPanel() {
  const uiScale = useContext(UiScaleContext);
  const [generation, setGeneration] = useState(0);
  const [Outliner, setOutliner] = useState(createLazyOutliner);
  const retry = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    focusLazyPanelHost(event.currentTarget);
    setGeneration((current) => current + 1);
    setOutliner(() => createLazyOutliner());
  }, []);
  return (
    <LazyPanelBoundary
      key={generation}
      source="outliner"
      diagnosticMessage={(error) => `Outliner unavailable: ${safeDiagnosticText(error)}`}
      onError={(error, info) => console.error("[Outliner] failed to load", error, info.componentStack)}
      fallback={(
        <div role="alert">
          <span>Outliner unavailable</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
    >
      <Suspense fallback={<div role="status">Loading outliner…</div>}>
        <Outliner uiScale={uiScale} />
      </Suspense>
    </LazyPanelBoundary>
  );
}

export function recoverModeAfterBackendError(
  current: ViewportMode,
  nativeAvailable: boolean,
): ViewportMode {
  return nativeAvailable ? "native" : current === "canvas" ? current : "canvas";
}

export type RendererStatusSource = "initial" | "event";

/** Stable semantic identity for renderer lifecycle snapshots. */
export function rendererStatusSemanticKey(status: RendererStatus): string {
  return JSON.stringify([
    status.nativeAvailable,
    status.nativeActive,
    status.fallbackReason,
    status.recoveryHint,
  ]);
}

/** Ignore an initial status response that was overtaken by a lifecycle event. */
export function shouldAcceptRendererStatus(
  source: RendererStatusSource,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return source === "event" || requestGeneration === currentGeneration;
}

/** Read the small window-event payload without letting a hostile getter throw. */
export function readConsoleToggleOpen(value: unknown): boolean | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const open = (value as Record<string, unknown>).open;
    return typeof open === "boolean" ? open : undefined;
  } catch {
    return undefined;
  }
}

/** Keep an untrusted viewport event from aborting the window event loop. */
export function readViewportRectDetail(value: unknown): ReturnType<typeof normalizeViewportRect> {
  try {
    return normalizeViewportRect(value);
  } catch {
    return null;
  }
}

/**
 * Tauri's UnlistenFn is typed as void, but the runtime implementation returns
 * a Promise while it unregisters the native listener. Normalize both forms so
 * a late cleanup failure cannot become an unhandled rejection.
 */
export function disposeRendererStatusListener(
  dispose: (() => void) | null | undefined,
  onError?: (error: unknown) => void,
): void {
  if (!dispose) return;
  const reportError = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // Diagnostics must never create a second unhandled rejection.
    }
  };
  try {
    void Promise.resolve(dispose()).catch(reportError);
  } catch (error) {
    reportError(error);
  }
}

// Panel content, keyed by the `component` name used in shell/layout.ts. Each
// entry wraps the (self-contained, opaque) panel component or ViewportHost in
// our own marker div: dockview-react gives every panel's content the same
// `.dv-react-part` wrapper (no per-panel class), so the transparent-vs-opaque
// distinction has to be painted one level in, by us. Defined at module scope
// so the object reference is stable — DockviewReact re-registers all panel
// components whenever this prop's identity changes.
const ConsoleStoreContext = createContext<ConsoleStore | null>(null);

function LazyConsolePanel({ store }: { store: ConsoleStore }) {
  const [generation, setGeneration] = useState(0);
  const [ConsoleDrawer, setConsoleDrawer] = useState(createLazyConsoleDrawer);
  const retry = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    focusLazyPanelHost(event.currentTarget);
    setGeneration((current) => current + 1);
    setConsoleDrawer(() => createLazyConsoleDrawer());
  }, []);
  return (
    <LazyPanelBoundary
      key={generation}
      source="frontend"
      diagnosticMessage={(error) => `Console unavailable: ${safeDiagnosticText(error)}`}
      onError={(error, info) => console.error("[Console] failed to load", error, info.componentStack)}
      fallback={(
        <div role="alert">
          <span>Console unavailable</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
    >
      <Suspense fallback={<div role="status">Loading console…</div>}>
        <ConsoleDrawer store={store} className="console-drawer--embedded" />
      </Suspense>
    </LazyPanelBoundary>
  );
}

function BottomPanel(props: IDockviewPanelProps) {
  const consoleStore = useContext(ConsoleStoreContext);
  if (props.params.view === "console" && consoleStore) {
    return <LazyConsolePanel store={consoleStore} />;
  }
  return <Timeline />;
}

const DOCK_COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  outliner: () => (
    <div className="dock-panel-content" data-lazy-panel-host tabIndex={-1}>
      <LazyOutlinerPanel />
    </div>
  ),
  inspector: () => (
    <div className="dock-panel-content" data-lazy-panel-host tabIndex={-1}>
      <Inspector />
    </div>
  ),
  timeline: (props) => (
    <div className="dock-panel-content" data-lazy-panel-host tabIndex={-1}>
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
        displayMode={(props.params.displayMode as "lit" | "wireframe" | undefined) ?? "lit"}
        showGrid={(props.params.showGrid as boolean | undefined) ?? true}
        showBones={(props.params.showBones as boolean | undefined) ?? false}
        projection={(props.params.projection as CameraProjection | undefined) ?? "perspective"}
        fov={(props.params.fov as CameraFov | undefined) ?? 45}
        viewPreset={(props.params.viewPreset as CameraViewPreset | undefined) ?? "perspective"}
        environment={props.params.environment as ViewportEnvironmentSettings | undefined}
        lighting={props.params.lighting as ViewportLightingSettings | undefined}
        onDisplaySettingsChange={props.params.onDisplaySettingsChange as
          | ((patch: {
              displayMode?: "lit" | "wireframe";
              showGrid?: boolean;
              showBones?: boolean;
            }) => void)
          | undefined}
        onCameraSettingsChange={props.params.onCameraSettingsChange as
          | ((patch: { projection?: CameraProjection; fov?: CameraFov }) => void)
          | undefined}
        onCameraViewChange={props.params.onCameraViewChange as
          | ((preset: CameraViewPreset) => void)
          | undefined}
        onEnvironmentSettingsChange={props.params.onEnvironmentSettingsChange as
          | ((patch: Partial<ViewportEnvironmentSettings>) => void)
          | undefined}
        onEnvironmentBrowse={props.params.onEnvironmentBrowse as (() => void) | undefined}
        onEnvironmentClear={props.params.onEnvironmentClear as (() => void) | undefined}
        onLightingSettingsChange={props.params.onLightingSettingsChange as
          | ((patch: Partial<ViewportLightingSettings>) => void)
          | undefined}
      />
    </div>
  ),
};

function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutSubRef = useRef<DockviewIDisposable | null>(null);
  const addGroupSubRef = useRef<DockviewIDisposable | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [viewportMode, setViewportMode] = useState<ViewportMode>(() =>
    import.meta.env.VITE_PERF_BACKEND === "canvas" ? "canvas" : "native",
  );
  const viewportModeRef = useRef(viewportMode);
  viewportModeRef.current = viewportMode;
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>(AVAILABLE_RENDERER_STATUS);
  const rendererStatusRef = useRef(rendererStatus);
  rendererStatusRef.current = rendererStatus;
  const [consoleVisible, setConsoleVisible] = useState(false);
  const consoleVisibleRef = useRef(consoleVisible);
  consoleVisibleRef.current = consoleVisible;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useLayoutEffect(() => {
    document.documentElement.style.fontSize = `${settings.ui.scale * 16}px`;
    requestViewportRemeasure();
  }, [settings.ui.scale]);
  // Seed from wall time so a frontend reload in the same native process does
  // not restart its request ordering below the Rust-side latest sequence.
  const environmentRequestSequenceRef = useRef(Date.now());
  const [cameraViewPreset, setCameraViewPreset] = useState<CameraViewPreset>("perspective");
  const cameraPresetInvoke = useMemo(() => createLatestCommandInvoker(invoke), []);
  useEffect(() => () => cameraPresetInvoke.dispose(), [cameraPresetInvoke]);
  const [consoleStore] = useState(() =>
    createConsoleStore({
      capacity: 500,
      levelFilter: settings.console.minimumLevel,
      autoScroll: settings.console.autoScroll,
    }),
  );
  const getConsoleErrorCount = useCallback(
    () => consoleStore.getState().entries.reduce(
      (count, entry) => count + (entry.level === "error" ? 1 : 0),
      0,
    ),
    [consoleStore],
  );
  const consoleErrorCount = useSyncExternalStore(
    consoleStore.subscribe,
    getConsoleErrorCount,
    getConsoleErrorCount,
  );
  const isMac = useMemo(() => isMacPlatform(navigator.platform), []);

  const appendDiagnostic = useCallback(
    (level: ConsoleEntry["level"], source: ConsoleEntry["source"], message: string) => {
      const normalized = normalizeConsoleDiagnostic({ level, source, message });
      if (!normalized) {
        // `level`/`source` are typed known values, but keep this boundary
        // fail-closed without recursively routing a fallback through here.
        consoleStore.append({
          timestamp: new Date().toISOString(),
          level: "warn",
          source: "frontend",
          message: "Ignored malformed diagnostic",
        });
        return;
      }
      consoleStore.append({ timestamp: new Date().toISOString(), ...normalized });
    },
    [consoleStore],
  );

  // Persist the committed React snapshot instead of writing independently
  // from async HDRI and lighting callbacks. React's state queue then defines a
  // single order, so either control family cannot save a stale copy of the other.
  useEffect(() => {
    settingsRef.current = settings;
    if (!saveSettings(settings)) {
      appendDiagnostic("warn", "frontend", "Editor settings changed for this session but could not be persisted");
    }
  }, [appendDiagnostic, settings]);

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
    importAsset: onImportAsset,
    saveScene: onSaveScene,
    saveSceneAs: onSaveSceneAs,
  } = useSceneFileController({
    appendDiagnostic,
    activateNativeRenderer: activateNativeForScene,
    revealConsole,
  });
  const onViewportDisplaySettingsChange = useCallback(
    (patch: {
      displayMode?: "lit" | "wireframe";
      showGrid?: boolean;
      showBones?: boolean;
    }) => {
      setSettings((current) => {
        return {
          ...current,
          viewport: { ...current.viewport, ...patch },
        };
      });
    },
    [],
  );
  const onViewportCameraSettingsChange = useCallback(
    (patch: { projection?: CameraProjection; fov?: CameraFov }) => {
      setSettings((current) => {
        return {
          ...current,
          viewport: { ...current.viewport, ...patch },
        };
      });
    },
    [],
  );
  const onViewportCameraViewChange = useCallback(
    (preset: CameraViewPreset) => {
      setCameraViewPreset(preset);
      if (viewportMode !== "native") return;
      void cameraPresetInvoke("set_camera_view", { preset }).catch((error) => {
        appendDiagnostic("warn", "viewport", `Camera view preset unavailable: ${safeDiagnosticText(error)}`);
      });
    },
    [appendDiagnostic, viewportMode],
  );
  const onViewportLightingSettingsChange = useCallback(
    (patch: Partial<ViewportLightingSettings>) => {
      if (viewportMode !== "native") return;
      setSettings((current) => {
        const next = {
          ...current,
          viewport: {
            ...current.viewport,
            lighting: { ...current.viewport.lighting, ...patch },
          },
        };
        settingsRef.current = next;
        return next;
      });
    },
    [viewportMode],
  );
  const applyViewportEnvironment = useCallback(
    async (next: ViewportEnvironmentSettings, action: string, isCancelled?: () => boolean) => {
      if (!mountedRef.current || isCancelled?.()) return;
      const sequence = environmentRequestSequenceRef.current + 1;
      environmentRequestSequenceRef.current = sequence;
      try {
        const acceptedWire = await invoke<unknown>("set_viewport_environment", {
          settings: next,
          sequence,
        });
        const accepted = normalizeViewportEnvironmentSettings(acceptedWire);
        if (!accepted) throw new Error("malformed environment settings response");
        if (!mountedRef.current || sequence !== environmentRequestSequenceRef.current || isCancelled?.()) return;
        setSettings((current) => {
          const updated = {
            ...current,
            viewport: { ...current.viewport, environment: accepted },
          };
          settingsRef.current = updated;
          return updated;
        });
        appendDiagnostic(
          "info",
          "viewport",
          `${action}: ${accepted.enabled ? accepted.path : "environment off"}`,
        );
      } catch (error) {
        if (!mountedRef.current || sequence !== environmentRequestSequenceRef.current || isCancelled?.()) return;
        appendDiagnostic("error", "viewport", `${action} failed: ${safeDiagnosticText(error)}`);
      }
    },
    [appendDiagnostic],
  );
  const onViewportEnvironmentSettingsChange = useCallback(
    (patch: Partial<ViewportEnvironmentSettings>) => {
      void applyViewportEnvironment(
        { ...settingsRef.current.viewport.environment, ...patch },
        "Viewport environment updated",
      );
    },
    [applyViewportEnvironment],
  );
  const onViewportEnvironmentBrowse = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      if (!("__TAURI_INTERNALS__" in window)) {
        appendDiagnostic("warn", "viewport", "HDRI picker is unavailable outside the Tauri shell");
        setConsoleVisible(true);
        return;
      }
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Environment Image", extensions: ["hdr", "exr", "png", "jpg", "jpeg", "webp"] }],
      });
      if (!mountedRef.current || typeof path !== "string") return;
      await applyViewportEnvironment(
        { ...settingsRef.current.viewport.environment, enabled: true, path },
        "HDRI loaded",
      );
    } catch (error) {
      if (!mountedRef.current) return;
      appendDiagnostic("error", "viewport", `HDRI picker failed: ${safeDiagnosticText(error)}`);
      setConsoleVisible(true);
    }
  }, [appendDiagnostic, applyViewportEnvironment]);
  const onViewportEnvironmentClear = useCallback(() => {
    void applyViewportEnvironment(
      { ...settingsRef.current.viewport.environment, enabled: false, path: "" },
      "HDRI cleared",
    );
  }, [applyViewportEnvironment]);
  const initialEnvironmentAppliedRef = useRef(false);
  useEffect(() => {
    if (initialEnvironmentAppliedRef.current || !("__TAURI_INTERNALS__" in window)) return;
    initialEnvironmentAppliedRef.current = true;
    const requestSequence = environmentRequestSequenceRef.current;
    void invoke<ViewportEnvironmentSettings>("set_viewport_environment", {
      settings: settings.viewport.environment,
      sequence: requestSequence,
    }).catch((error) => {
      if (!mountedRef.current || requestSequence !== environmentRequestSequenceRef.current) return;
      appendDiagnostic("error", "viewport", `Persisted HDRI could not be restored: ${safeDiagnosticText(error)}`);
    });
  }, [appendDiagnostic, settings.viewport.environment]);
  const viewportPanelParams = useMemo(
    () => ({
      mode: viewportMode,
      showDebugOverlay: settings.viewport.debugOverlay,
      fallbackReason: rendererStatus.fallbackReason,
      recoveryHint: rendererStatus.recoveryHint,
      displayMode: settings.viewport.displayMode,
      showGrid: settings.viewport.showGrid,
      showBones: settings.viewport.showBones,
      projection: settings.viewport.projection,
      fov: settings.viewport.fov,
      viewPreset: cameraViewPreset,
      environment: settings.viewport.environment,
      lighting: settings.viewport.lighting,
      onDisplaySettingsChange: onViewportDisplaySettingsChange,
      onCameraSettingsChange: onViewportCameraSettingsChange,
      onCameraViewChange: onViewportCameraViewChange,
      onEnvironmentSettingsChange: onViewportEnvironmentSettingsChange,
      onEnvironmentBrowse: onViewportEnvironmentBrowse,
      onEnvironmentClear: onViewportEnvironmentClear,
      onLightingSettingsChange: onViewportLightingSettingsChange,
    }),
    [
      onViewportDisplaySettingsChange,
      rendererStatus.fallbackReason,
      rendererStatus.recoveryHint,
      settings.viewport.debugOverlay,
      settings.viewport.displayMode,
      settings.viewport.showBones,
      settings.viewport.showGrid,
      settings.viewport.projection,
      settings.viewport.fov,
      cameraViewPreset,
      settings.viewport.environment,
      settings.viewport.lighting,
      onViewportCameraSettingsChange,
      onViewportCameraViewChange,
      onViewportEnvironmentSettingsChange,
      onViewportEnvironmentBrowse,
      onViewportEnvironmentClear,
      onViewportLightingSettingsChange,
      viewportMode,
    ],
  );
  const viewportPanelParamsRef = useRef(viewportPanelParams);
  viewportPanelParamsRef.current = viewportPanelParams;

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
      const rect = readViewportRectDetail((event as CustomEvent<unknown>).detail);
      if (!rect) return;
      appendDiagnostic(
        "info",
        "viewport",
        `rect x=${rect.x.toFixed(1)} y=${rect.y.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)}`,
      );
    };
    const onDiagnostic = (event: Event) => {
      const detail = normalizeConsoleDiagnostic((event as CustomEvent<unknown>).detail);
      if (!detail) {
        appendDiagnostic("warn", "frontend", "Ignored malformed diagnostic event");
        return;
      }
      appendDiagnostic(detail.level, detail.source, detail.message);
    };
    const onConsoleToggle = (event: Event) => {
      const open = readConsoleToggleOpen((event as CustomEvent<unknown>).detail);
      if (open !== undefined) setConsoleVisible(open);
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
    const onBackendTransitionError = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const message = safeDiagnosticText(detail);
      appendDiagnostic("error", "renderer", `Viewport backend transition failed: ${message}`);
      setConsoleVisible(true);
      setViewportMode((current) => recoverModeAfterBackendError(current, rendererStatusRef.current.nativeAvailable));
    };
    window.addEventListener("tauri3d:backend-transition-error", onBackendTransitionError);
    return () => window.removeEventListener("tauri3d:backend-transition-error", onBackendTransitionError);
  }, [appendDiagnostic]);

  useEffect(() => {
    let cancelled = false;
    let statusGeneration = 0;
    let disposeListener: (() => void) | null = null;
    let statusUnavailableReported = false;
    let lastAcceptedStatusKey: string | null = null;
    const reportStatusUnavailable = (message: string) => {
      if (cancelled || statusUnavailableReported) return;
      statusUnavailableReported = true;
      appendDiagnostic("warn", "renderer", message);
    };
    const acceptStatus = (status: RendererStatus, source: RendererStatusSource) => {
      if (cancelled) return;
      if (source === "event") statusGeneration += 1;
      const statusKey = rendererStatusSemanticKey(status);
      if (statusKey === lastAcceptedStatusKey) return;
      lastAcceptedStatusKey = statusKey;
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
    const initialGeneration = statusGeneration;
    if ("__TAURI_INTERNALS__" in window) {
      void Promise.resolve()
        .then(() => onRendererStatusChanged((status) => acceptStatus(status, "event")))
        .then((dispose) => {
          if (cancelled) {
            disposeRendererStatusListener(dispose);
          } else {
            disposeListener = dispose;
          }
        })
        .catch((error) => {
          reportStatusUnavailable(`Renderer status listener unavailable: ${safeDiagnosticText(error)}`);
        });
    }
    void getRendererStatus()
      .then((status) => {
        if (!shouldAcceptRendererStatus("initial", initialGeneration, statusGeneration)) return;
        acceptStatus(status, "initial");
      })
      .catch((error) => {
          reportStatusUnavailable(`Renderer status unavailable: ${safeDiagnosticText(error)}`);
      });
    return () => {
      cancelled = true;
      disposeRendererStatusListener(disposeListener);
    };
  }, [appendDiagnostic]);

  useEffect(() => {
    consoleStore.setFilter(settings.console.minimumLevel);
    consoleStore.setAutoScroll(settings.console.autoScroll);
  }, [consoleStore, settings.console.autoScroll, settings.console.minimumLevel]);

  const onSettingsChange = useCallback(
    (next: Settings) => {
      setSettings(next);
    },
    [],
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
    buildDefaultLayout(api, viewportModeRef.current);
    api.getPanel("timeline")?.update({
      params: { view: consoleVisibleRef.current ? "console" : "timeline" },
    });
    api.getPanel("viewport")?.update({
      params: viewportPanelParamsRef.current,
    });
    requestViewportRemeasure();
    layoutSubRef.current = api.onDidLayoutChange(() => {
      requestViewportRemeasure();
      setInspectorVisible(api.getPanel("inspector") != null);
    });
  }, []);

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
        id: "file.import",
        label: "Import Asset…",
        enabled: !sceneFileBusy,
        run: onImportAsset,
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
        id: "edit.undoTransform",
        label: "Undo Transform",
        shortcut: { code: "KeyZ", primary: true },
        enabled: viewportMode === "native",
        run: undoSceneTransform,
      },
      {
        id: "edit.redoTransform",
        label: "Redo Transform",
        shortcut: { code: "KeyY", primary: true },
        enabled: viewportMode === "native",
        run: redoSceneTransform,
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
      onImportAsset,
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
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const cameraSettingsSelfTestRef = useRef(onViewportCameraSettingsChange);
  cameraSettingsSelfTestRef.current = onViewportCameraSettingsChange;
  const cameraViewSelfTestRef = useRef(onViewportCameraViewChange);
  cameraViewSelfTestRef.current = onViewportCameraViewChange;
  const lightingSelfTestRef = useRef(onViewportLightingSettingsChange);
  lightingSelfTestRef.current = onViewportLightingSettingsChange;
  const lightingSelfTestTimersRef = useRef<SelfTestTimerBag | null>(null);
  const lightingSelfTestCompletedRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (primary && event.code === "KeyZ" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        redoSceneTransform();
        return;
      }
      // Actions change when settings/status/scene state changes. Read the
      // latest snapshot through the existing ref so the global listener does
      // not churn on every panel update.
      const action = findShortcutAction(actionsRef.current, event, isMac);
      if (!action) return;
      event.preventDefault();
      action.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac]);

  // Dev-only shortcut integration gate. Synthetic keydown events exercise
  // the same window listener as physical keyboard input without bypassing
  // shortcut matching, editable-target filtering, or Action dispatch.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (shortcutSelfTestHasRun || !import.meta.env.VITE_SHORTCUT_SELF_TEST) return;
    shortcutSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
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
    timers.schedule(() => press("Digit2"), 2000);
    timers.schedule(() => press("KeyI"), 4000);
    timers.schedule(() => press("Digit0", true), 6000);
    timers.schedule(() => {
      completed = true;
      press("Digit1");
    }, 8000);
    return () => {
      timers.cancel();
      if (!completed) shortcutSelfTestHasRun = false;
    };
  }, [isMac]);

  // Dev-only self-test, gated behind VITE_BACKEND_SELF_TEST. It uses the same
  // finite actions as the Menu Bar and shortcuts.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (backendSelfTestHasRun || !import.meta.env.VITE_BACKEND_SELF_TEST) return;
    backendSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    timers.schedule(() => actionById(actionsRef.current, "renderer.canvas").run(), 3000);
    timers.schedule(() => {
      completed = true;
      actionById(actionsRef.current, "renderer.native").run();
    }, 6000);
    return () => {
      timers.cancel();
      if (!completed) backendSelfTestHasRun = false;
    };
  }, []);

  // Dev-only display-settings gate. It follows the same callback used by the
  // viewport toolbar, so persistence and Native IPC wiring are exercised
  // together rather than bypassed through a test-only state mutation.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const requestedMode = import.meta.env.VITE_VIEWPORT_DISPLAY_SELF_TEST;
    if (viewportDisplaySelfTestHasRun || !requestedMode) return;
    viewportDisplaySelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    timers.schedule(() => {
      const display = requestedMode === "lit"
        ? { displayMode: "lit" as const, showGrid: true, showBones: false }
        : { displayMode: "wireframe" as const, showGrid: false, showBones: true };
      onViewportDisplaySettingsChange(display);
      appendDiagnostic(
        "info",
        "viewport",
        `Viewport display self-test applied: mode=${display.displayMode} grid=${display.showGrid ? "on" : "off"} bones=${display.showBones ? "on" : "off"}`,
      );
      completed = true;
    }, 2000);
    return () => {
      timers.cancel();
      if (!completed) viewportDisplaySelfTestHasRun = false;
    };
  }, [appendDiagnostic, onViewportDisplaySettingsChange]);

  // Dev-only camera gate. Each step uses the same callbacks/actions as the
  // toolbar so projection/FOV persistence, Native view presets, and backend
  // camera handoff are exercised without a test-only IPC path.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const requestedTest = import.meta.env.VITE_VIEWPORT_CAMERA_SELF_TEST;
    if (viewportCameraSelfTestHasRun || !requestedTest) return;
    viewportCameraSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    if (["front", "right", "top", "perspective"].includes(requestedTest)) {
      const preset = requestedTest as CameraViewPreset;
      timers.schedule(() => {
        cameraSettingsSelfTestRef.current({
          projection: preset === "perspective" ? "perspective" : "orthographic",
          fov: preset === "perspective" ? 45 : 60,
        });
        cameraViewSelfTestRef.current(preset);
        appendDiagnostic("info", "viewport", `Viewport camera hold self-test applied: ${preset}`);
        completed = true;
      }, 6000);
      return () => {
        timers.cancel();
        if (!completed) viewportCameraSelfTestHasRun = false;
      };
    }
    timers.schedule(() => {
      cameraSettingsSelfTestRef.current({ projection: "perspective", fov: 30 });
      cameraViewSelfTestRef.current("front");
    }, 2000);
    timers.schedule(() => {
      cameraSettingsSelfTestRef.current({ projection: "orthographic", fov: 60 });
      cameraViewSelfTestRef.current("right");
    }, 4000);
    timers.schedule(() => cameraViewSelfTestRef.current("top"), 6000);
    timers.schedule(() => actionById(actionsRef.current, "renderer.canvas").run(), 8000);
    timers.schedule(() => actionById(actionsRef.current, "renderer.native").run(), 10000);
    timers.schedule(() => {
      appendDiagnostic("info", "viewport", "Viewport camera self-test completed");
      completed = true;
    }, 12000);
    return () => {
      timers.cancel();
      if (!completed) viewportCameraSelfTestHasRun = false;
    };
  }, [appendDiagnostic]);

  // Dev-only lighting gate. It follows the production callback so settings
  // persistence and Native IPC are exercised together; Canvas remains an
  // explicitly unsupported (disabled) control surface.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const requestedTest = import.meta.env.VITE_VIEWPORT_LIGHTING_SELF_TEST;
    if (
      viewportLightingSelfTestHasRun ||
      lightingSelfTestTimersRef.current ||
      !requestedTest ||
      viewportMode !== "native"
    ) return;
    viewportLightingSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    lightingSelfTestTimersRef.current = timers;
    lightingSelfTestCompletedRef.current = false;
    timers.schedule(() => {
      lightingSelfTestRef.current({ exposure: 2, tonemap: "reinhard", ambientIntensity: 0.35 });
      appendDiagnostic("info", "viewport", "Viewport lighting self-test: exposure/tonemap/ambient applied");
    }, 2000);
    timers.schedule(() => {
      lightingSelfTestRef.current({ shadowsEnabled: true, shadowResolution: 512, shadowSoftness: 2 });
    }, 4000);
    timers.schedule(() => {
      lightingSelfTestRef.current({ shadowResolution: 1024, backgroundMode: "solid", backgroundColor: "#172033" });
    }, 6000);
    timers.schedule(() => {
      const finalShadowResolution = requestedTest === "shadow-512"
        ? 512
        : requestedTest === "shadow-1024"
          ? 1024
          : 2048;
      lightingSelfTestRef.current({
        shadowResolution: finalShadowResolution,
        backgroundMode: requestedTest === "solid" ? "solid" : "transparent",
        backgroundColor: "#172033",
        tonemap: "aces",
      });
      appendDiagnostic("info", "viewport", "Viewport lighting self-test completed");
      lightingSelfTestCompletedRef.current = true;
      lightingSelfTestTimersRef.current = null;
    }, 8000);
  }, [appendDiagnostic, viewportMode]);

  useEffect(() => () => {
    lightingSelfTestTimersRef.current?.cancel();
    lightingSelfTestTimersRef.current = null;
    if (!lightingSelfTestCompletedRef.current) viewportLightingSelfTestHasRun = false;
  }, []);

  // Dev-only real-file HDRI gate. Uses the production validation/persistence
  // path so load, orientation, failure retention, and clear can be captured
  // without automating the native file picker.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const path = import.meta.env.VITE_VIEWPORT_ENVIRONMENT_SELF_TEST;
    if (viewportEnvironmentSelfTestHasRun || !path) return;
    viewportEnvironmentSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    const base = { enabled: true, path, rotationDegrees: 0, intensity: 1 };
    timers.schedule(() => {
      void (async () => {
        if (timers.isCancelled()) return;
        await applyViewportEnvironment(base, "HDRI self-test loaded", timers.isCancelled);
        if (timers.isCancelled()) return;
        if (import.meta.env.VITE_VIEWPORT_ENVIRONMENT_ROTATE_SELF_TEST) {
          await applyViewportEnvironment(
            { ...base, rotationDegrees: 90, intensity: 2 },
            "HDRI self-test rotated",
            timers.isCancelled,
          );
        }
        if (timers.isCancelled()) return;
        if (import.meta.env.VITE_VIEWPORT_ENVIRONMENT_INVALID_SELF_TEST) {
          await applyViewportEnvironment(
            { ...base, path: `${path}.missing` },
            "HDRI invalid self-test",
            timers.isCancelled,
          );
        }
        if (timers.isCancelled()) return;
        if (import.meta.env.VITE_VIEWPORT_ENVIRONMENT_CLEAR_SELF_TEST) {
          await applyViewportEnvironment(
            { ...base, enabled: false, path: "" },
            "HDRI self-test cleared",
            timers.isCancelled,
          );
        }
        completed = true;
      })().catch((error) => {
        if (!timers.isCancelled()) {
          appendDiagnostic("error", "viewport", `HDRI self-test failed: ${safeDiagnosticText(error)}`);
        }
      });
    }, 5000);
    return () => {
      timers.cancel();
      if (!completed) viewportEnvironmentSelfTestHasRun = false;
    };
  }, [appendDiagnostic, applyViewportEnvironment]);

  // Reproducible GUI gate for the Console drawer and Settings modal. Both
  // steps use the exact finite actions exposed by the View menu.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (shellSelfTestHasRun || !import.meta.env.VITE_SHELL_SELF_TEST) return;
    shellSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;
    timers.schedule(() => actionById(actionsRef.current, "view.console.toggle").run(), 2000);
    timers.schedule(() => actionById(actionsRef.current, "view.settings.open").run(), 5000);
    timers.schedule(() => {
      completed = true;
      setSettingsOpen(false);
    }, 8000);
    return () => {
      timers.cancel();
      if (!completed) shellSelfTestHasRun = false;
    };
  }, []);

  // Dev-only self-test, gated behind VITE_DOCK_SELF_TEST: proves the viewport
  // rect stays correct across dock layout changes, including the one case a
  // ResizeObserver alone can't catch — a panel move that changes the
  // viewport's position without changing its size. Runs at most once per
  // page load, same pattern as VITE_INPUT_SELF_TEST / VITE_BACKEND_SELF_TEST.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (dockSelfTestHasRun || !import.meta.env.VITE_DOCK_SELF_TEST) {
      return;
    }
    dockSelfTestHasRun = true;
    const timers = createSelfTestTimerBag();
    let completed = false;

    timers.schedule(() => {
      console.log("[dock-self-test] step=resize-viewport-group");
      const viewportPanel = apiRef.current?.getPanel("viewport");
      // Dockview's group size API drives the same grid allocation that a sash
      // drag commits, without depending on OS pointer injection or DPI-aware
      // cursor coordinates in the repeatable self-test.
      viewportPanel?.group.api.setSize({ width: 620 });
    }, 1500);

    timers.schedule(() => {
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

    timers.schedule(() => {
      console.log("[dock-self-test] step=remove-inspector");
      // Same action path the View menu and Ctrl+I call. Removing
      // the inspector widens the viewport group — the resize case, which a
      // plain ResizeObserver on the viewport element already handles, used
      // here as a control/contrast to the move-only step above.
      actionById(actionsRef.current, "view.inspector.toggle").run();
    }, 6000);

    timers.schedule(() => {
      console.log("[dock-self-test] step=reset-layout");
      // Same action path the View menu and Ctrl+Shift+0 call.
      actionById(actionsRef.current, "view.layout.reset").run();
      completed = true;
    }, 9000);
    return () => {
      timers.cancel();
      if (!completed) dockSelfTestHasRun = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires at most once per page load; intentionally not re-arming on onToggleInspector/onResetLayout identity changes.
  }, []);

  return (
    <UiScaleContext.Provider value={settings.ui.scale}>
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
    </UiScaleContext.Provider>
  );
}

export default App;
