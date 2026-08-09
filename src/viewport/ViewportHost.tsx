import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { attachViewportInput, maybeRunViewportInputSelfTest } from "./input";
import { mountCanvasBackend, type CameraState, type CanvasBackendHandle } from "./canvasBackend";

/**
 * Fixed IPC contract shared with the Rust side. Do not change field names or
 * shape without coordinating — src-tauri is coding against exactly this.
 */
interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export type ViewportMode = "native" | "canvas";
export type CameraProjection = "perspective" | "orthographic";
export type CameraViewPreset = "front" | "right" | "top" | "perspective";
export type CameraFov = 30 | 45 | 60 | 90;

// Escape hatch for the dock shell: dockview's onDidLayoutChange fires when a
// panel is moved without being resized (e.g. swapping left/right groups),
// which a ResizeObserver alone would miss even though the viewport's on-screen
// position changed. The mounted instance registers/unregisters itself below.
let remeasure: (() => void) | null = null;
export function requestViewportRemeasure(): void {
  remeasure?.();
}

// Mirrors OrbitCamera::default() in src-tauri/src/camera.rs, used only as a
// fallback when get_camera can't be reached (e.g. plain `vite dev`).
const DEFAULT_CAMERA: CameraState = {
  target: [0, 0, 0],
  yaw: -0.6,
  pitch: 0.35,
  distance: 4.0,
};

// Outside a real Tauri runtime (e.g. plain `vite dev` in a browser tab)
// `invoke` rejects for every call. Log once instead of spamming the console
// on every resize frame.
let hasWarnedAboutMissingTauri = false;

async function sendViewportRect(rect: ViewportRect): Promise<void> {
  try {
    await invoke("set_viewport_rect", { rect });
  } catch (err) {
    if (!hasWarnedAboutMissingTauri) {
      hasWarnedAboutMissingTauri = true;
      console.warn(
        "[ViewportHost] set_viewport_rect invoke failed once (expected when " +
          "running outside the Tauri shell, e.g. plain `vite dev`):",
        err,
      );
    }
  }
}

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[ViewportHost] ${cmd} invoke failed (expected outside the Tauri shell):`, err);
    return undefined;
  }
}

interface ViewportHostProps {
  mode: ViewportMode;
  showDebugOverlay?: boolean;
  fallbackReason?: string | null;
  recoveryHint?: string | null;
  displayMode?: "lit" | "wireframe";
  showGrid?: boolean;
  showBones?: boolean;
  projection?: CameraProjection;
  fov?: CameraFov;
  viewPreset?: CameraViewPreset;
  onDisplaySettingsChange?: (patch: {
    displayMode?: "lit" | "wireframe";
    showGrid?: boolean;
    showBones?: boolean;
  }) => void;
  onCameraSettingsChange?: (patch: {
    projection?: CameraProjection;
    fov?: CameraFov;
  }) => void;
  onCameraViewChange?: (preset: CameraViewPreset) => void;
}

/**
 * Central transparent hole in the DOM. In "native" mode the native wgpu
 * renderer draws behind the WebView here and this component's only jobs are
 * to (a) stay visually transparent and (b) keep Rust informed of its
 * on-screen rectangle. In "canvas" mode a three.js canvas is mounted in its
 * place instead (see canvasBackend.ts), driven by its own OrbitControls.
 */
export function ViewportHost({
  mode,
  showDebugOverlay = true,
  fallbackReason = null,
  recoveryHint = null,
  displayMode = "lit",
  showGrid = true,
  showBones = false,
  projection = "perspective",
  fov = 45,
  viewPreset = "perspective",
  onDisplaySettingsChange,
  onCameraSettingsChange,
  onCameraViewChange,
}: ViewportHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const [lastRect, setLastRect] = useState<ViewportRect | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showCameraMenu, setShowCameraMenu] = useState(
    () => Boolean(import.meta.env.VITE_VIEWPORT_CAMERA_MENU_SELF_TEST),
  );

  useEffect(() => {
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    void safeInvoke("set_viewport_display", {
      mode: displayMode,
      showGrid,
      showBones,
    });
  }, [displayMode, mode, showBones, showGrid]);

  useEffect(() => {
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    void safeInvoke("set_camera_settings", {
      settings: { projection, fovDegrees: fov },
    });
  }, [fov, mode, projection]);

  useEffect(() => {
    if (!showMenu && !showCameraMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowMenu(false);
        setShowCameraMenu(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [showCameraMenu, showMenu]);

  // Coalesces any number of triggers (ResizeObserver, window resize, DPI
  // change) into at most one measurement + invoke per animation frame.
  const scheduleMeasure = useCallback(() => {
    if (rafIdRef.current !== null) {
      return;
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = hostRef.current;
      if (!el) {
        return;
      }
      const domRect = el.getBoundingClientRect();
      const rect: ViewportRect = {
        x: domRect.x,
        y: domRect.y,
        width: domRect.width,
        height: domRect.height,
        scaleFactor: window.devicePixelRatio,
      };
      setLastRect(rect);
      window.dispatchEvent(
        new CustomEvent("tauri3d:viewport-rect", {
          detail: rect,
        }),
      );
      void sendViewportRect(rect);
    });
  }, []);

  // Rect reporting runs regardless of mode: harmless in canvas mode, and
  // keeps native in sync for when we switch back to it.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) {
      return;
    }

    remeasure = scheduleMeasure;
    scheduleMeasure();

    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure();
    });
    resizeObserver.observe(el);

    window.addEventListener("resize", scheduleMeasure);

    // There's no direct "devicePixelRatio changed" event, so we re-arm a
    // matchMedia query tuned to the current DPR each time it fires. This
    // catches the window being dragged to a monitor with a different scale
    // factor, or the OS display scale being changed.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      scheduleMeasure();
      armDprWatcher();
    };
    function armDprWatcher() {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    }
    armDprWatcher();

    return () => {
      if (remeasure === scheduleMeasure) {
        remeasure = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      dprQuery?.removeEventListener("change", onDprChange);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scheduleMeasure]);

  // Forward pointer/wheel input on the same host element to Rust so the
  // native orbit camera can be driven. Only wired up in native mode — in
  // canvas mode OrbitControls handles input itself, directly on its canvas.
  useEffect(() => {
    if (mode !== "native") {
      return;
    }
    const el = hostRef.current;
    if (!el) {
      return;
    }
    const detach = attachViewportInput(el);
    maybeRunViewportInputSelfTest(el);
    return detach;
  }, [mode]);

  // Mounts/tears down the three.js backend on mode transitions, handing
  // camera state across the switch in both directions:
  //   native -> canvas: pause the native renderer, read its camera, seed
  //     the three.js OrbitControls with it.
  //   canvas -> native: read back the (possibly user-manipulated) three.js
  //     camera, push it into the native OrbitCamera, resume the native
  //     renderer.
  useEffect(() => {
    if (mode !== "canvas") {
      return;
    }
    let cancelled = false;
    let handle: CanvasBackendHandle | null = null;

    void (async () => {
      await safeInvoke("set_renderer_active", { active: false });
      const camera = (await safeInvoke<CameraState>("get_camera")) ?? DEFAULT_CAMERA;
      if (cancelled) {
        return;
      }
      const el = hostRef.current;
      if (!el) {
        return;
      }
      handle = mountCanvasBackend(el, camera);
    })();

    return () => {
      cancelled = true;
      if (handle) {
        const finalCamera = handle.dispose();
        void safeInvoke("set_camera", { camera: finalCamera });
        void safeInvoke("set_renderer_active", { active: true });
      }
    };
  }, [mode]);

  const browserNativePreview = mode === "native" && !("__TAURI_INTERNALS__" in window);
  const cameraLabel = `${viewPreset[0].toUpperCase()}${viewPreset.slice(1)} · ${
    projection === "perspective" ? "Perspective" : "Orthographic"
  } · ${fov}°`;

  const chooseCameraView = (preset: CameraViewPreset) => {
    setShowCameraMenu(false);
    onCameraViewChange?.(preset);
  };

  return (
    <div ref={hostRef} className={`viewport-host${browserNativePreview ? " viewport-host--browser-preview" : ""}`}>
      <div
        className="viewport-host__toolbar"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
      >
        <div className="viewport-host__mode-group" role="group" aria-label="Viewport display mode">
          <button
            type="button"
            className={`viewport-host__tool-button${displayMode === "lit" ? " is-active" : ""}`}
            aria-pressed={displayMode === "lit"}
            disabled={mode !== "native"}
            onClick={() => onDisplaySettingsChange?.({ displayMode: "lit" })}
          >
            Lit
          </button>
          <button
            type="button"
            className={`viewport-host__tool-button${displayMode === "wireframe" ? " is-active" : ""}`}
            aria-pressed={displayMode === "wireframe"}
            disabled={mode !== "native"}
            onClick={() => onDisplaySettingsChange?.({ displayMode: "wireframe" })}
          >
            Wireframe
          </button>
        </div>
        <div className="viewport-host__camera-menu">
          <button
            type="button"
            className={`viewport-host__tool-button${showCameraMenu ? " is-active" : ""}`}
            aria-expanded={showCameraMenu}
            aria-haspopup="menu"
            disabled={mode !== "native"}
            onClick={() => setShowCameraMenu((open) => !open)}
          >
            Camera: {cameraLabel} ▾
          </button>
          {showCameraMenu && (
            <div className="viewport-host__camera-popover" role="menu" aria-label="Camera settings">
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">Projection</span>
                <div className="viewport-host__camera-options">
                  {(["perspective", "orthographic"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${projection === option ? " is-active" : ""}`}
                      disabled={mode !== "native"}
                      onClick={() => onCameraSettingsChange?.({ projection: option })}
                    >
                      {option[0].toUpperCase() + option.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">FOV</span>
                <div className="viewport-host__camera-options">
                  {([30, 45, 60, 90] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${fov === option ? " is-active" : ""}`}
                      disabled={mode !== "native"}
                      onClick={() => onCameraSettingsChange?.({ fov: option })}
                    >
                      {option}°
                    </button>
                  ))}
                </div>
              </div>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">View</span>
                <div className="viewport-host__camera-options viewport-host__camera-options--views">
                  {(["front", "right", "top", "perspective"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${viewPreset === option ? " is-active" : ""}`}
                      disabled={mode !== "native"}
                      onClick={() => chooseCameraView(option)}
                    >
                      {option[0].toUpperCase() + option.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="viewport-host__show-menu">
          <button
            type="button"
            className={`viewport-host__tool-button${showMenu ? " is-active" : ""}`}
            aria-expanded={showMenu}
            aria-haspopup="menu"
            onClick={() => setShowMenu((open) => !open)}
          >
            Show ▾
          </button>
          {showMenu && (
            <div className="viewport-host__show-popover" role="menu">
              <label className={`viewport-host__show-item${mode !== "native" ? " is-disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={showGrid}
                  disabled={mode !== "native"}
                  onChange={(event) => onDisplaySettingsChange?.({ showGrid: event.currentTarget.checked })}
                />
                <span>Grid</span>
              </label>
              <label className={`viewport-host__show-item${mode !== "native" ? " is-disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={showBones}
                  disabled={mode !== "native"}
                  onChange={(event) => onDisplaySettingsChange?.({ showBones: event.currentTarget.checked })}
                />
                <span>Bones</span>
              </label>
            </div>
          )}
        </div>
      </div>
      {browserNativePreview && <span className="viewport-host__preview-label">native wgpu surface (transparent DOM hole)</span>}
      {mode === "canvas" && fallbackReason && (
        <div className="viewport-host__fallback" role="status">
          <strong>Canvas fallback</strong>
          <span>{fallbackReason}</span>
          {recoveryHint && <small>{recoveryHint}</small>}
        </div>
      )}
      {showDebugOverlay && <div className="viewport-host__overlay">
        <div className="viewport-host__label">
          {mode === "native" ? "Backend: native wgpu" : "Backend: canvas (three.js)"}
        </div>
        {lastRect && (
          <div className="viewport-host__rect">
            x: {lastRect.x.toFixed(1)} y: {lastRect.y.toFixed(1)} w:{" "}
            {lastRect.width.toFixed(1)} h: {lastRect.height.toFixed(1)} dpr:{" "}
            {lastRect.scaleFactor.toFixed(2)}
          </div>
        )}
        <div className="viewport-host__hint">
          {mode === "native"
            ? "Drag: orbit · Shift+Drag: pan · Wheel: zoom"
            : "Drag: orbit · Right-drag: pan · Wheel: zoom"}
        </div>
      </div>}
    </div>
  );
}
