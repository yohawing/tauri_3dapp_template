import { useCallback, useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { attachViewportInput, maybeRunViewportInputSelfTest } from "./input";
import type { CameraState, CanvasViewportSettings } from "./canvasBackend";
import { BackendTransitionController } from "./backendTransition";
import type { ViewportEnvironmentSettings, ViewportLightingSettings, ViewportTonemap } from "../settings/model";
import { isFiniteF32 } from "../wireValidation";

/**
 * Fixed IPC contract shared with the Rust side. Do not change field names or
 * shape without coordinating — src-tauri is coding against exactly this.
 */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

/** Drop malformed details before internal viewport diagnostics format values. */
export function normalizeViewportRect(value: unknown): ViewportRect | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { x, y, width, height, scaleFactor } = record;
  if (
    !isFiniteF32(x) ||
    !isFiniteF32(y) ||
    !isFiniteF32(width) ||
    width < 0 ||
    !isFiniteF32(height) ||
    height < 0 ||
    !isFiniteF32(scaleFactor) ||
    scaleFactor <= 0
  ) {
    return null;
  }
  return { x, y, width, height, scaleFactor };
}

export function areViewportRectsEqual(
  left: ViewportRect | null,
  right: ViewportRect,
): boolean {
  return left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.scaleFactor === right.scaleFactor;
}

export type ViewportMode = "native" | "canvas";
export type ManipulatorMode = "translate" | "rotate" | "scale";
export type ManipulatorOrientation = "world" | "local";
export type ViewportDisplayMode = "lit" | "wireframe";
export type CameraProjection = "perspective" | "orthographic";
export type CameraViewPreset = "front" | "right" | "top" | "perspective";
export type CameraFov = 30 | 45 | 60 | 90;

type ViewportToolbarIconName =
  | "translate"
  | "rotate"
  | "scale"
  | "world"
  | "local"
  | "snap"
  | "lit"
  | "wireframe"
  | "camera"
  | "lighting"
  | "environment"
  | "show";

function ViewportToolbarIcon({ name }: { name: ViewportToolbarIconName }) {
  const common = {
    className: "viewport-host__tool-icon",
    viewBox: "0 0 24 24",
    "aria-hidden": true,
  } as const;

  switch (name) {
    case "translate":
      return <svg {...common}><path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M21 12l-3-3m3 3-3 3" /></svg>;
    case "rotate":
      return <svg {...common}><path d="M18.8 8A8 8 0 1 0 20 12" /><path d="M18.8 3.8V8h-4.2" /></svg>;
    case "scale":
      return <svg {...common}><path d="M5 19 19 5M13 5h6v6M5 13v6h6" /></svg>;
    case "world":
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.2 2.2 3.3 4.9 3.3 8S14.2 17.8 12 20c-2.2-2.2-3.3-4.9-3.3-8S9.8 6.2 12 4" /></svg>;
    case "local":
      return <svg {...common}><path d="m6 16 6 3.5 6-3.5V9l-6-3.5L6 9v7Z" /><path d="m6 9 6 3.5L18 9M12 12.5v7" /></svg>;
    case "snap":
      return <svg {...common}><path d="M5 4v9a7 7 0 0 0 14 0V4h-4v9a3 3 0 0 1-6 0V4H5Z" /><path d="M5 8h4m6 0h4" /></svg>;
    case "lit":
      return <svg {...common}><circle cx="12" cy="12" r="5" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></svg>;
    case "wireframe":
      return <svg {...common}><path d="m5 8 7-4 7 4v8l-7 4-7-4V8Z" /><path d="m5 8 7 4 7-4M12 12v8" /></svg>;
    case "camera":
      return <svg {...common}><path d="M4 7h4l1.5-2h5L16 7h4v11H4V7Z" /><circle cx="12" cy="12.5" r="3.5" /></svg>;
    case "lighting":
      return <svg {...common}><path d="M8.5 15.5c-1.3-1-2-2.5-2-4.1a5.5 5.5 0 1 1 11 0c0 1.6-.7 3.1-2 4.1-.8.7-1.1 1.2-1.1 2H9.6c0-.8-.3-1.3-1.1-2Z" /><path d="M9.5 20h5" /></svg>;
    case "environment":
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M4.6 15h14.8M7 15l3-4 2 2 2.5-3 3 5" /></svg>;
    case "show":
      return <svg {...common}><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
  }
}

function ViewportToolbarChevron() {
  return <svg className="viewport-host__tool-chevron" viewBox="0 0 8 8" aria-hidden="true"><path d="m1.5 2.5 2.5 3 2.5-3" /></svg>;
}

function initialManipulatorMode(): ManipulatorMode {
  const selfTest = import.meta.env.VITE_MANIPULATOR_SELF_TEST;
  return selfTest === "rotate" || selfTest === "scale" ? selfTest : "translate";
}

export function nextManipulatorMode(mode: ManipulatorMode): ManipulatorMode {
  if (mode === "translate") return "rotate";
  if (mode === "rotate") return "scale";
  return "translate";
}

export function nextViewportDisplayMode(mode: ViewportDisplayMode): ViewportDisplayMode {
  return mode === "lit" ? "wireframe" : "lit";
}

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

const DEFAULT_ENVIRONMENT: ViewportEnvironmentSettings = {
  enabled: false,
  path: "",
  rotationDegrees: 0,
  intensity: 1,
};

const DEFAULT_LIGHTING: ViewportLightingSettings = {
  exposure: 1,
  tonemap: "none",
  ambientIntensity: 0.2,
  ambientColor: "#ffffff",
  shadowsEnabled: true,
  shadowResolution: 2048,
  shadowSoftness: 1,
  backgroundMode: "transparent",
  backgroundColor: "#000000",
};

// Keep this wire guard aligned with `validate_camera_state` in camera.rs.
// These limits are intentionally local so the transparent Native host does
// not eagerly pull the Three.js Canvas backend into the initial chunk.
const CAMERA_PITCH_LIMIT = 1.55;
const CAMERA_MIN_DISTANCE = 0.5;
const CAMERA_MAX_DISTANCE = 100;
const CAMERA_BASIS_EPSILON_SQ = 1.1920929e-7; // f32::EPSILON
/** Validate a CameraState returned by the Native IPC boundary. */
export function normalizeCameraState(value: unknown): CameraState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const target = record.target;
  const yaw = record.yaw;
  const pitch = record.pitch;
  const distance = record.distance;
  if (
    !Array.isArray(target) ||
    target.length !== 3 ||
    !target.every(isFiniteF32) ||
    !isFiniteF32(yaw) ||
    !isFiniteF32(pitch) ||
    Math.abs(pitch) > CAMERA_PITCH_LIMIT ||
    !isFiniteF32(distance) ||
    distance < CAMERA_MIN_DISTANCE ||
    distance > CAMERA_MAX_DISTANCE
  ) {
    return null;
  }

  const [targetX, targetY, targetZ] = target as [number, number, number];
  const [sinYaw, cosYaw] = [Math.sin(yaw), Math.cos(yaw)];
  const [sinPitch, cosPitch] = [Math.sin(pitch), Math.cos(pitch)];
  const offset = [
    distance * cosPitch * cosYaw,
    distance * sinPitch,
    distance * cosPitch * sinYaw,
  ];
  const eye = [targetX + offset[0], targetY + offset[1], targetZ + offset[2]];
  const separation = [eye[0] - targetX, eye[1] - targetY, eye[2] - targetZ];
  const separationSquared = separation.reduce((sum, component) => sum + component * component, 0);
  if (
    eye.some((component) => !Number.isFinite(component)) ||
    !Number.isFinite(separationSquared) ||
    separationSquared <= CAMERA_BASIS_EPSILON_SQ
  ) {
    return null;
  }
  return { target: [targetX, targetY, targetZ], yaw, pitch, distance };
}

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

type InvokeDependency = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Maximum ordered commands retained, including the in-flight command. */
export const MAX_SERIAL_INVOKES = 256;

/** Serialize ordered IPC and reject commands after the bounded queue is full. */
export function createSerialInvoker(dependency: InvokeDependency) {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  return function serialInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (queued >= MAX_SERIAL_INVOKES) {
      return Promise.reject(new Error("serial invoke queue is full; command was rejected"));
    }
    queued += 1;
    let result!: T;
    const current = tail.then(async () => {
      result = await dependency<T>(cmd, args);
    });
    tail = current.then(
      () => {
        queued -= 1;
      },
      () => {
        queued -= 1;
      },
    );
    return current.then(() => result);
  };
}

interface LatestCommandState {
  inFlight: boolean;
  pending?: {
    args?: Record<string, unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
}

/**
 * Keeps one in-flight and one latest pending snapshot for each command.
 * Superseded or disposed pending calls resolve with `undefined` without
 * reaching the transport, so callers should treat this as best-effort state
 * synchronization rather than a delivery acknowledgement.
 */
export function createLatestCommandInvoker(dependency: InvokeDependency) {
  const states = new Map<string, LatestCommandState>();

  const drain = async <T,>(cmd: string, state: LatestCommandState): Promise<void> => {
    if (state.inFlight || !state.pending) return;
    const next = state.pending;
    state.pending = undefined;
    state.inFlight = true;
    try {
      next.resolve(await dependency<T>(cmd, next.args));
    } catch (error) {
      next.reject(error);
    } finally {
      state.inFlight = false;
      if (state.pending) {
        void drain<T>(cmd, state);
      } else if (states.get(cmd) === state) {
        states.delete(cmd);
      }
    }
  };

  const latestInvoke = function latestInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const state = states.get(cmd) ?? { inFlight: false };
    states.set(cmd, state);
    return new Promise<T>((resolve, reject) => {
      if (state.pending) {
        state.pending.resolve(undefined);
      }
      state.pending = { args, resolve: resolve as (value: unknown) => void, reject };
      void drain<T>(cmd, state);
    });
  };
  latestInvoke.dispose = () => {
    for (const state of states.values()) {
      state.pending?.resolve(undefined);
      state.pending = undefined;
    }
    states.clear();
  };
  return latestInvoke;
}

export interface LatestSerialSender<T> {
  /** Resolves on transport completion, superseding, or disposal. */
  send(value: T): Promise<void>;
  dispose(): void;
}

/** Serializes rect updates while retaining only the latest pending value. */
export function createLatestSerialSender<T>(
  dependency: (value: T) => Promise<void>,
): LatestSerialSender<T> {
  let inFlight = false;
  let pending: { value: T; waiter: { resolve: () => void; reject: (error: unknown) => void } } | null = null;
  let disposed = false;

  const drain = async () => {
    if (inFlight || disposed || !pending) return;
    const next = pending;
    pending = null;
    inFlight = true;
    try {
      await dependency(next.value);
      next.waiter.resolve();
    } catch (error) {
      next.waiter.reject(error);
    } finally {
      inFlight = false;
      if (!disposed) void drain();
    }
  };

  return {
    send: (value) => {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        if (pending) {
          // The previous value will not reach the transport. Its caller only
          // needs to know that it was superseded, so resolve it now instead
          // of retaining an unbounded waiter list during a stalled invoke.
          pending.waiter.resolve();
          pending.value = value;
          pending.waiter = { resolve, reject };
        } else {
          pending = { value, waiter: { resolve, reject } };
        }
        void drain();
      });
    },
    dispose: () => {
      disposed = true;
      pending?.waiter.resolve();
      pending = null;
    },
  };
}

/** Clamp numeric viewport controls to the same finite ranges as Rust. */
export function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const latestCommandInvoke = createLatestCommandInvoker(invoke);

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await latestCommandInvoke<T>(cmd, args);
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
  displayMode?: ViewportDisplayMode;
  showGrid?: boolean;
  showBones?: boolean;
  projection?: CameraProjection;
  fov?: CameraFov;
  viewPreset?: CameraViewPreset;
  environment?: ViewportEnvironmentSettings;
  lighting?: ViewportLightingSettings;
  onDisplaySettingsChange?: (patch: {
    displayMode?: ViewportDisplayMode;
    showGrid?: boolean;
    showBones?: boolean;
  }) => void;
  onCameraSettingsChange?: (patch: {
    projection?: CameraProjection;
    fov?: CameraFov;
  }) => void;
  onCameraViewChange?: (preset: CameraViewPreset) => void;
  onEnvironmentSettingsChange?: (patch: Partial<ViewportEnvironmentSettings>) => void;
  onEnvironmentBrowse?: () => void;
  onEnvironmentClear?: () => void;
  onLightingSettingsChange?: (patch: Partial<ViewportLightingSettings>) => void;
}

function reportBackendTransitionError(error: unknown): void {
  console.error("[ViewportHost] backend transition failed:", error);
  window.dispatchEvent(
    new CustomEvent("tauri3d:backend-transition-error", {
      detail: error,
    }),
  );
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
  environment = DEFAULT_ENVIRONMENT,
  lighting = DEFAULT_LIGHTING,
  onDisplaySettingsChange,
  onCameraSettingsChange,
  onCameraViewChange,
  onEnvironmentSettingsChange,
  onEnvironmentBrowse,
  onEnvironmentClear,
  onLightingSettingsChange,
}: ViewportHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const viewportRectSenderRef = useRef<LatestSerialSender<ViewportRect> | null>(null);
  const inputIdleRef = useRef<Promise<void>>(Promise.resolve());
  const lifecycleEpochRef = useRef(0);
  const canvasSettingsRef = useRef<CanvasViewportSettings>({
    displayMode,
    showGrid,
    showBones,
    projection,
    fov,
    manipulatorMode: initialManipulatorMode(),
    manipulatorOrientation: "world",
    snapEnabled: false,
  });
  const transitionControllerRef = useRef<BackendTransitionController | null>(null);
  if (transitionControllerRef.current === null) {
    const tauriAvailable = "__TAURI_INTERNALS__" in window;
    transitionControllerRef.current = new BackendTransitionController({
      deactivateNative: async () => {
        if (tauriAvailable) {
          await invoke("set_renderer_active", { active: false });
        }
      },
      waitForViewportInputIdle: () => inputIdleRef.current,
      activateNative: async () => {
        if (tauriAvailable) {
          await invoke("set_renderer_active", { active: true });
        }
      },
      readCamera: async () => {
        if (!tauriAvailable) {
          return DEFAULT_CAMERA;
        }
        const camera = normalizeCameraState(await invoke<unknown>("get_camera"));
        if (!camera) {
          throw new Error("get_camera returned malformed camera state");
        }
        return camera;
      },
      writeCamera: async (camera) => {
        if (tauriAvailable) {
          await invoke("set_camera", { camera });
        }
      },
      prepareCanvas: async () => {
        const { mountCanvasBackend } = await import("./canvasBackend");
        return (camera: CameraState) => {
          const host = hostRef.current;
          if (!host) {
            throw new Error("ViewportHost is not mounted");
          }
          return mountCanvasBackend(host, camera, canvasSettingsRef.current);
        };
      },
      reportError: reportBackendTransitionError,
    });
  }
  const transitionController = transitionControllerRef.current!;
  const [lastRect, setLastRect] = useState<ViewportRect | null>(null);
  const lastRectRef = useRef<ViewportRect | null>(null);
  const [manipulatorMode, setManipulatorMode] = useState<ManipulatorMode>(initialManipulatorMode);
  const [manipulatorOrientation, setManipulatorOrientation] = useState<ManipulatorOrientation>("world");
  const [snapEnabled, setSnapEnabled] = useState(false);
  canvasSettingsRef.current = {
    displayMode,
    showGrid,
    showBones,
    projection,
    fov,
    manipulatorMode,
    manipulatorOrientation,
    snapEnabled,
  };
  const [showMenu, setShowMenu] = useState(false);
  const [showCameraMenu, setShowCameraMenu] = useState(
    () => Boolean(import.meta.env.VITE_VIEWPORT_CAMERA_MENU_SELF_TEST),
  );
  const [showEnvironmentMenu, setShowEnvironmentMenu] = useState(
    () => Boolean(import.meta.env.VITE_VIEWPORT_ENVIRONMENT_MENU_SELF_TEST),
  );
  const [showLightingMenu, setShowLightingMenu] = useState(
    () => Boolean(import.meta.env.VITE_VIEWPORT_LIGHTING_MENU_SELF_TEST),
  );
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);

  const restorePopoverFocus = useCallback(() => {
    const trigger = popoverTriggerRef.current;
    popoverTriggerRef.current = null;
    if (!trigger?.isConnected) return;
    queueMicrotask(() => trigger.focus());
  }, []);

  const closeViewportSettings = useCallback((restoreFocus = false) => {
    setShowMenu(false);
    setShowCameraMenu(false);
    setShowEnvironmentMenu(false);
    setShowLightingMenu(false);
    if (restoreFocus) restorePopoverFocus();
    else popoverTriggerRef.current = null;
  }, [restorePopoverFocus]);

  const toggleViewportPopover = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    setOpen: Dispatch<SetStateAction<boolean>>,
    isOpen: boolean,
  ) => {
    const trigger = event.currentTarget;
    if (isOpen) {
      setOpen(false);
      popoverTriggerRef.current = null;
      if (trigger.isConnected) queueMicrotask(() => trigger.focus());
      return;
    }
    closeViewportSettings();
    popoverTriggerRef.current = trigger;
    setOpen(true);
  }, [closeViewportSettings]);

  useEffect(() => {
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    void safeInvoke("set_manipulator_mode", { mode: manipulatorMode });
  }, [manipulatorMode, mode]);

  useEffect(() => {
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    void safeInvoke("set_manipulator_orientation", { orientation: manipulatorOrientation });
  }, [manipulatorOrientation, mode]);

  useEffect(() => {
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    void safeInvoke("set_manipulator_snap", {
      settings: {
        enabled: snapEnabled,
        translateIncrement: 1,
        rotateDegrees: 15,
        scaleIncrement: 0.1,
      },
    });
  }, [mode, snapEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      const next = ({ w: "translate", e: "rotate", r: "scale" } as const)[event.key.toLowerCase() as "w" | "e" | "r"];
      if (next) setManipulatorMode(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
    if (mode !== "native" || !("__TAURI_INTERNALS__" in window)) return;
    const color = (value: string): [number, number, number] => {
      const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value.slice(1) : "000000";
      return [0, 1, 2].map((index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) / 255) as [number, number, number];
    };
    void safeInvoke("set_viewport_lighting", {
      settings: {
        exposure: lighting.exposure,
        tonemap: lighting.tonemap,
        ambientIntensity: lighting.ambientIntensity,
        ambientColor: color(lighting.ambientColor),
        shadowsEnabled: lighting.shadowsEnabled,
        shadowResolution: lighting.shadowResolution,
        shadowSoftness: lighting.shadowSoftness,
        backgroundMode: lighting.backgroundMode,
        backgroundColor: color(lighting.backgroundColor),
      },
    });
  }, [lighting, mode]);

  useEffect(() => {
    if (mode !== "canvas") return;
    transitionController.updateCanvas((handle) => handle.updateSettings(canvasSettingsRef.current));
  }, [
    displayMode,
    fov,
    manipulatorMode,
    manipulatorOrientation,
    mode,
    projection,
    showBones,
    showGrid,
    snapEnabled,
    transitionController,
  ]);

  useEffect(() => {
    if (!showMenu && !showCameraMenu && !showEnvironmentMenu && !showLightingMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeViewportSettings(true);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [closeViewportSettings, showCameraMenu, showEnvironmentMenu, showLightingMenu, showMenu]);

  useEffect(() => {
    const blurViewportControlOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const isViewportUi = target instanceof Element && target.closest("[data-viewport-ui]") !== null;
      if (isViewportUi) return;

      closeViewportSettings();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && hostRef.current?.contains(activeElement)) {
        activeElement.blur();
      }
    };

    // Capture outside clicks before the viewport toolbar's stopPropagation so
    // a click on another panel or the viewport itself always clears focus.
    document.addEventListener("pointerdown", blurViewportControlOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", blurViewportControlOnOutsidePointer, true);
  }, [closeViewportSettings]);

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
      if (areViewportRectsEqual(lastRectRef.current, rect)) return;
      lastRectRef.current = rect;
      setLastRect(rect);
      window.dispatchEvent(
        new CustomEvent("tauri3d:viewport-rect", {
          detail: rect,
        }),
      );
      const sender =
        viewportRectSenderRef.current ??
        (viewportRectSenderRef.current = createLatestSerialSender(sendViewportRect));
      void sender.send(rect);
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
      viewportRectSenderRef.current?.dispose();
      viewportRectSenderRef.current = null;
      lastRectRef.current = null;
    };
  }, [scheduleMeasure]);

  // Forward pointer/wheel input on the same host element to Rust so the
  // native orbit camera can be driven. Only wired up in native mode — in
  // canvas mode OrbitControls handles input itself, directly on its canvas.
  useEffect(() => {
    let attachment: ReturnType<typeof attachViewportInput> | null = null;
    let inputSelfTest: ReturnType<typeof maybeRunViewportInputSelfTest> | null = null;
    if (mode === "native") {
      const el = hostRef.current;
      if (el) {
        attachment = attachViewportInput(el);
        inputSelfTest = maybeRunViewportInputSelfTest(el);
      }
    }
    const transitionCleanup = transitionController.transition(mode);

    // Keep input teardown and backend transition in one effect so React's
    // cleanup order is explicit: detach + capture the IPC tail, then cancel
    // the previous transition. Canvas deactivation waits on that tail.
    return () => {
      inputSelfTest?.cancel();
      if (attachment) {
        attachment.detach();
        inputIdleRef.current = Promise.all([
          attachment.idle(),
          inputSelfTest?.idle() ?? Promise.resolve(),
        ]).then(() => undefined);
      } else {
        inputIdleRef.current = inputSelfTest?.idle() ?? Promise.resolve();
      }
      transitionCleanup();
    };
  }, [mode, transitionController]);

  useEffect(() => () => {
    latestCommandInvoke.dispose();
  }, []);

  // StrictMode intentionally runs effect setup/cleanup twice in development.
  // Defer disposal by one microtask so that probe cleanup does not permanently
  // dispose the controller before the real effect setup runs.
  useEffect(() => {
    const epoch = ++lifecycleEpochRef.current;
    return () => {
      queueMicrotask(() => {
        if (lifecycleEpochRef.current === epoch) {
          transitionController.dispose();
        }
      });
    };
  }, [transitionController]);

  const browserNativePreview = mode === "native" && !("__TAURI_INTERNALS__" in window);
  const cameraLabel = `${viewPreset[0].toUpperCase()}${viewPreset.slice(1)} · ${
    projection === "perspective" ? "Perspective" : "Orthographic"
  } · ${fov}°`;
  const environmentName = environment.path.split(/[\\/]/).pop() || "Off";
  const lightingLabel = `${lighting.exposure}× · ${lighting.tonemap.toUpperCase()} · ${lighting.shadowsEnabled ? "Shadows" : "No shadows"}`;

  const chooseCameraView = (preset: CameraViewPreset) => {
    closeViewportSettings(true);
    if (mode === "canvas") {
      transitionController.updateCanvas((handle) => handle.setViewPreset(preset));
    }
    onCameraViewChange?.(preset);
  };

  return (
    <div ref={hostRef} className={`viewport-host${browserNativePreview ? " viewport-host--browser-preview" : ""}`}>
      <div
        className="viewport-host__toolbar"
        data-viewport-ui="true"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
      >
        <div className="viewport-host__mode-group" role="group" aria-label="Transform manipulator">
          <button
            type="button"
            className="viewport-host__tool-button viewport-host__tool-button--icon is-active"
            aria-label={`${manipulatorMode} manipulator. Toggle to ${nextManipulatorMode(manipulatorMode)}`}
            title={`${manipulatorMode[0].toUpperCase()}${manipulatorMode.slice(1)} (W/E/R shortcuts; click to cycle)`}
            onClick={() => setManipulatorMode((value) => nextManipulatorMode(value))}
          >
            <ViewportToolbarIcon name={manipulatorMode} />
          </button>
        </div>
        <div className="viewport-host__mode-group" role="group" aria-label="Manipulator orientation and snapping">
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon${manipulatorOrientation === "local" ? " is-active" : ""}`}
            aria-label={`Manipulator orientation: ${manipulatorOrientation}. Toggle to ${manipulatorOrientation === "world" ? "local" : "world"}`}
            aria-pressed={manipulatorOrientation === "local"}
            title={`Orientation: ${manipulatorOrientation === "world" ? "World" : "Local"} (click to toggle)`}
            onClick={() => setManipulatorOrientation((value) => value === "world" ? "local" : "world")}
          >
            <ViewportToolbarIcon name={manipulatorOrientation} />
          </button>
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon${snapEnabled ? " is-active" : ""}`}
            aria-label="Toggle transform snapping"
            aria-pressed={snapEnabled}
            title="Transform snapping"
            onClick={() => setSnapEnabled((value) => !value)}
          >
            <ViewportToolbarIcon name="snap" />
          </button>
        </div>
        <div className="viewport-host__mode-group" role="group" aria-label="Viewport display mode">
          <button
            type="button"
            className="viewport-host__tool-button viewport-host__tool-button--icon is-active"
            aria-label={`${displayMode} display mode. Toggle to ${nextViewportDisplayMode(displayMode)}`}
            aria-pressed={displayMode === "wireframe"}
            title={`${displayMode === "lit" ? "Lit" : "Wireframe"} display (click to toggle)`}
            onClick={() => onDisplaySettingsChange?.({ displayMode: nextViewportDisplayMode(displayMode) })}
          >
            <ViewportToolbarIcon name={displayMode} />
          </button>
        </div>
        <div className="viewport-host__camera-menu">
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon viewport-host__tool-button--menu${showCameraMenu ? " is-active" : ""}`}
            aria-label={`Camera settings: ${cameraLabel}`}
            aria-expanded={showCameraMenu}
            aria-haspopup="dialog"
            title={cameraLabel}
            onClick={(event) => toggleViewportPopover(event, setShowCameraMenu, showCameraMenu)}
          >
            <ViewportToolbarIcon name="camera" />
            <ViewportToolbarChevron />
          </button>
          {showCameraMenu && (
            <div className="viewport-host__camera-popover" role="dialog" aria-label="Camera settings">
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">Projection</span>
                <div className="viewport-host__camera-options" role="group" aria-label="Projection">
                  {(["perspective", "orthographic"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${projection === option ? " is-active" : ""}`}
                      aria-pressed={projection === option}
                      onClick={() => onCameraSettingsChange?.({ projection: option })}
                    >
                      {option[0].toUpperCase() + option.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">FOV</span>
                <div className="viewport-host__camera-options" role="group" aria-label="FOV">
                  {([30, 45, 60, 90] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${fov === option ? " is-active" : ""}`}
                      aria-pressed={fov === option}
                      onClick={() => onCameraSettingsChange?.({ fov: option })}
                    >
                      {option}°
                    </button>
                  ))}
                </div>
              </div>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">View</span>
                <div className="viewport-host__camera-options viewport-host__camera-options--views" role="group" aria-label="View preset">
                  {(["front", "right", "top", "perspective"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${viewPreset === option ? " is-active" : ""}`}
                      aria-pressed={viewPreset === option}
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
        <div className="viewport-host__lighting-menu">
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon viewport-host__tool-button--menu${showLightingMenu ? " is-active" : ""}`}
            aria-label={`Lighting settings: ${lightingLabel}`}
            aria-expanded={showLightingMenu}
            aria-haspopup="dialog"
            title={lightingLabel}
            disabled={mode !== "native"}
            onClick={(event) => toggleViewportPopover(event, setShowLightingMenu, showLightingMenu)}
          >
            <ViewportToolbarIcon name="lighting" />
            <ViewportToolbarChevron />
          </button>
          {showLightingMenu && (
            <div className="viewport-host__lighting-popover" role="dialog" aria-label="Lighting settings">
              <label className="viewport-host__environment-field">
                <span>Exposure</span>
                <input
                  type="number"
                  min={0}
                  max={16}
                  step={0.1}
                  value={lighting.exposure}
                  disabled={mode !== "native"}
                  onChange={(event) => onLightingSettingsChange?.({
                    exposure: clampFinite(Number(event.currentTarget.value), 0, 16, lighting.exposure),
                  })}
                />
              </label>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">Tonemap</span>
                <div className="viewport-host__camera-options" role="group" aria-label="Tonemap">
                  {(["none", "reinhard", "aces"] as const).map((option: ViewportTonemap) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${lighting.tonemap === option ? " is-active" : ""}`}
                      aria-pressed={lighting.tonemap === option}
                      disabled={mode !== "native"}
                      onClick={() => onLightingSettingsChange?.({ tonemap: option })}
                    >
                      {option === "aces" ? "ACES" : option[0].toUpperCase() + option.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="viewport-host__environment-field">
                <span>Ambient</span>
                <input
                  type="number"
                  min={0}
                  max={4}
                  step={0.1}
                  value={lighting.ambientIntensity}
                  disabled={mode !== "native"}
                  onChange={(event) => onLightingSettingsChange?.({
                    ambientIntensity: clampFinite(Number(event.currentTarget.value), 0, 4, lighting.ambientIntensity),
                  })}
                />
                <input
                  type="color"
                  aria-label="Ambient color"
                  value={lighting.ambientColor}
                  disabled={mode !== "native"}
                  onChange={(event) => onLightingSettingsChange?.({ ambientColor: event.currentTarget.value })}
                />
              </label>
              <label className={`viewport-host__show-item${mode !== "native" ? " is-disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={lighting.shadowsEnabled}
                  disabled={mode !== "native"}
                  onChange={(event) => onLightingSettingsChange?.({ shadowsEnabled: event.currentTarget.checked })}
                />
                <span>Shadows</span>
              </label>
              <label className="viewport-host__environment-field">
                <span>Resolution</span>
                <select
                  value={lighting.shadowResolution}
                  disabled={mode !== "native" || !lighting.shadowsEnabled}
                  onChange={(event) => onLightingSettingsChange?.({ shadowResolution: Number(event.currentTarget.value) as 512 | 1024 | 2048 })}
                >
                  {[512, 1024, 2048].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="viewport-host__environment-field">
                <span>Softness</span>
                <input
                  type="number"
                  min={0}
                  max={8}
                  step={0.1}
                  value={lighting.shadowSoftness}
                  disabled={mode !== "native" || !lighting.shadowsEnabled}
                  onChange={(event) => onLightingSettingsChange?.({
                    shadowSoftness: clampFinite(Number(event.currentTarget.value), 0, 8, lighting.shadowSoftness),
                  })}
                />
              </label>
              <div className="viewport-host__camera-section">
                <span className="viewport-host__camera-heading">Background</span>
                <div className="viewport-host__camera-options" role="group" aria-label="Background mode">
                  {(["transparent", "solid"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`viewport-host__camera-option${lighting.backgroundMode === option ? " is-active" : ""}`}
                      aria-pressed={lighting.backgroundMode === option}
                      disabled={mode !== "native"}
                      onClick={() => onLightingSettingsChange?.({ backgroundMode: option })}
                    >
                      {option[0].toUpperCase() + option.slice(1)}
                    </button>
                  ))}
                </div>
                <input
                  type="color"
                  aria-label="Background color"
                  value={lighting.backgroundColor}
                  disabled={mode !== "native" || lighting.backgroundMode !== "solid"}
                  onChange={(event) => onLightingSettingsChange?.({ backgroundColor: event.currentTarget.value })}
                />
              </div>
              {environment.enabled && (
                <div className="viewport-host__environment-note">HDRI background takes precedence while Environment is enabled.</div>
              )}
            </div>
          )}
        </div>
        <div className="viewport-host__environment-menu">
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon viewport-host__tool-button--menu${showEnvironmentMenu ? " is-active" : ""}`}
            aria-label={`Environment settings: ${environment.enabled ? environmentName : "Off"}`}
            aria-expanded={showEnvironmentMenu}
            aria-haspopup="dialog"
            disabled={mode !== "native"}
            title={environment.path || "No environment selected"}
            onClick={(event) => toggleViewportPopover(event, setShowEnvironmentMenu, showEnvironmentMenu)}
          >
            <ViewportToolbarIcon name="environment" />
            <ViewportToolbarChevron />
          </button>
          {showEnvironmentMenu && (
            <div className="viewport-host__environment-popover" role="dialog" aria-label="Environment settings">
              <div className="viewport-host__environment-actions">
                <button
                  type="button"
                  className="viewport-host__camera-option"
                  disabled={mode !== "native"}
                  onClick={onEnvironmentBrowse}
                >
                  Browse…
                </button>
                <button
                  type="button"
                  className="viewport-host__camera-option"
                  disabled={mode !== "native" || environment.path.length === 0}
                  onClick={onEnvironmentClear}
                >
                  Clear
                </button>
              </div>
              <div className="viewport-host__environment-path" title={environment.path}>
                {environment.path || "No environment selected"}
              </div>
              <label className="viewport-host__show-item">
                <input
                  type="checkbox"
                  checked={environment.enabled}
                  disabled={mode !== "native" || environment.path.length === 0}
                  onChange={(event) => onEnvironmentSettingsChange?.({ enabled: event.currentTarget.checked })}
                />
                <span>Enabled</span>
              </label>
              <label className="viewport-host__environment-field">
                <span>Y Rotation</span>
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step={15}
                  value={environment.rotationDegrees}
                  disabled={mode !== "native" || !environment.enabled}
                  onChange={(event) => onEnvironmentSettingsChange?.({
                    rotationDegrees: clampFinite(Number(event.currentTarget.value), -180, 180, environment.rotationDegrees),
                  })}
                />
                <small>deg</small>
              </label>
              <label className="viewport-host__environment-field">
                <span>Intensity</span>
                <input
                  type="number"
                  min={0}
                  max={8}
                  step={0.1}
                  value={environment.intensity}
                  disabled={mode !== "native" || !environment.enabled}
                  onChange={(event) => onEnvironmentSettingsChange?.({
                    intensity: clampFinite(Number(event.currentTarget.value), 0, 8, environment.intensity),
                  })}
                />
              </label>
            </div>
          )}
        </div>
        <div className="viewport-host__show-menu">
          <button
            type="button"
            className={`viewport-host__tool-button viewport-host__tool-button--icon viewport-host__tool-button--menu${showMenu ? " is-active" : ""}`}
            aria-label="Display options"
            aria-expanded={showMenu}
            aria-haspopup="dialog"
            title="Display options"
            onClick={(event) => toggleViewportPopover(event, setShowMenu, showMenu)}
          >
            <ViewportToolbarIcon name="show" />
            <ViewportToolbarChevron />
          </button>
          {showMenu && (
            <div className="viewport-host__show-popover" role="dialog" aria-label="Display options">
              <label className="viewport-host__show-item">
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(event) => onDisplaySettingsChange?.({ showGrid: event.currentTarget.checked })}
                />
                <span>Grid</span>
              </label>
              <label className="viewport-host__show-item">
                <input
                  type="checkbox"
                  checked={showBones}
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
