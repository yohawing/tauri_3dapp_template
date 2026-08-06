import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pane } from "tweakpane";
import type { CameraState } from "../viewport/canvasBackend";
import "./Inspector.css";

// Mirrors OrbitCamera::default() in src-tauri/src/camera.rs, used only as a
// fallback when get_camera can't be reached (e.g. plain `vite dev`).
const DEFAULT_CAMERA: CameraState = {
  target: [0, 0, 0],
  yaw: -0.6,
  pitch: 0.35,
  distance: 4.0,
};

const POLL_INTERVAL_MS = 100;

// Outside a real Tauri runtime (e.g. plain `vite dev` in a browser tab)
// `invoke` rejects for every call. Log once instead of spamming the console
// on every 100ms poll tick (same pattern as viewport/ViewportHost.tsx).
let hasWarnedAboutMissingTauri = false;

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    if (!hasWarnedAboutMissingTauri) {
      hasWarnedAboutMissingTauri = true;
      console.warn(
        `[Inspector] ${cmd} invoke failed once (expected when running outside the Tauri shell, e.g. plain \`vite dev\`):`,
        err,
      );
    }
    return undefined;
  }
}

// Flattened binding target — tweakpane reads these fields directly to render
// each readout; `distance`/`yaw`/`pitch` map 1:1 onto CameraState.
interface CamFields {
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
  distance: number;
  yawDeg: number;
  pitchDeg: number;
}

function toFields(camera: CameraState): CamFields {
  return {
    tx: camera.target[0],
    ty: camera.target[1],
    tz: camera.target[2],
    yaw: camera.yaw,
    pitch: camera.pitch,
    distance: camera.distance,
    yawDeg: (camera.yaw * 180) / Math.PI,
    pitchDeg: (camera.pitch * 180) / Math.PI,
  };
}

// Readonly ("monitor") number bindings in @tweakpane/core ignore `step`
// entirely — decimal precision is controlled by `format` instead, which
// defaults to 2 places (see NumberMonitorPlugin in
// @tweakpane/core/dist/monitor-binding/number/plugin.js). Spelling the
// formatter out explicitly avoids silently losing yaw/pitch's former
// 3-decimal-step precision now that editing (and its `step` options) is gone.
const format2 = (value: number) => value.toFixed(2);
const format3 = (value: number) => value.toFixed(3);

/**
 * Read-only live readout of the native orbit camera (see src-tauri/src/
 * camera.rs and the get_camera Tauri command): a 100ms poll fetches the
 * current camera state and refreshes every field below it. There is no
 * write-back path — this panel is display-only.
 *
 * It's read-only by design, not just for simplicity: the viewport's orbit
 * controls and this panel observe the very same single Rust camera object,
 * so a writable Inspector would fight live orbiting (whichever of the two
 * wrote last would win, at 100ms granularity). Revisit once scene objects
 * get their own transforms distinct from the view camera — editing a
 * genuinely separate target then becomes meaningful again.
 */
export function Inspector() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;

    const pane = new Pane({ container });
    const state = toFields(DEFAULT_CAMERA);
    // Every binding here is a number field, so a plain structural type (just
    // the one method this file actually calls) is enough to hold all of them
    // in one array without fighting BindingApi's In/Ex generics.
    const bindings: { refresh(): void }[] = [];

    const targetFolder = pane.addFolder({ title: "Target" });
    bindings.push(
      targetFolder.addBinding(state, "tx", { readonly: true, label: "X", format: format2 }),
      targetFolder.addBinding(state, "ty", { readonly: true, label: "Y", format: format2 }),
      targetFolder.addBinding(state, "tz", { readonly: true, label: "Z", format: format2 }),
    );
    bindings.push(
      pane.addBinding(state, "yaw", { readonly: true, format: format3 }),
      pane.addBinding(state, "pitch", { readonly: true, format: format3 }),
      pane.addBinding(state, "distance", { readonly: true, format: format2 }),
      pane.addBinding(state, "yawDeg", { readonly: true, label: "Yaw (deg)" }),
      pane.addBinding(state, "pitchDeg", { readonly: true, label: "Pitch (deg)" }),
    );

    function refreshAll() {
      bindings.forEach((b) => b.refresh());
    }

    async function poll() {
      if (disposed) {
        return;
      }
      const camera = await safeInvoke<CameraState>("get_camera");
      if (disposed || !camera) {
        return;
      }
      Object.assign(state, toFields(camera));
      refreshAll();
    }

    void poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(intervalId);
      pane.dispose();
    };
  }, []);

  return (
    <div className="inspector-panel">
      <div className="inspector-panel__header">Inspector</div>
      <div className="inspector-panel__pane" ref={containerRef} />
    </div>
  );
}
