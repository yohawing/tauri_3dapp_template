import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CanvasPerformanceSampler,
  parsePerformanceSampleFrames,
  parsePerformanceTarget,
  type PerformanceSummary,
} from "./performanceSampler";

/**
 * Fixed IPC shape shared with the Rust side (see src-tauri/src/protocol.rs
 * `CameraState`). Do not change field names without coordinating.
 */
export interface CameraState {
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
}

// Keep Canvas OrbitControls inside the Rust camera validator's handoff range.
// CameraState is a shared wire contract; changing these values requires
// coordinating src-tauri/src/camera.rs as well.
export const CAMERA_PITCH_LIMIT = 1.55;
export const CAMERA_MIN_DISTANCE = 0.5;
export const CAMERA_MAX_DISTANCE = 100;
export const CAMERA_MIN_POLAR_ANGLE = Math.PI / 2 - CAMERA_PITCH_LIMIT;
export const CAMERA_MAX_POLAR_ANGLE = Math.PI / 2 + CAMERA_PITCH_LIMIT;

interface OrbitControlBounds {
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
}

export function applyCanvasOrbitBounds(controls: OrbitControlBounds): void {
  controls.minDistance = CAMERA_MIN_DISTANCE;
  controls.maxDistance = CAMERA_MAX_DISTANCE;
  controls.minPolarAngle = CAMERA_MIN_POLAR_ANGLE;
  controls.maxPolarAngle = CAMERA_MAX_POLAR_ANGLE;
}

// Mirrors OrbitCamera::eye() in src-tauri/src/camera.rs exactly:
//   eye = target + distance * (cos(pitch)*cos(yaw), sin(pitch), cos(pitch)*sin(yaw))
// three.js is right-handed / Y-up like glam here, so the formula carries over
// unchanged.
function eyeFromCamera(camera: CameraState): THREE.Vector3 {
  const { yaw, pitch, distance } = camera;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return new THREE.Vector3(
    camera.target[0] + distance * cp * cy,
    camera.target[1] + distance * sp,
    camera.target[2] + distance * cp * sy,
  );
}

// Inverse of eyeFromCamera: recovers {yaw, pitch, distance} from a
// position/target pair (e.g. after OrbitControls has moved the three.js
// camera around), so switching back to native can hand Rust an equivalent
// OrbitCamera state.
function cameraFromEye(eye: THREE.Vector3, target: THREE.Vector3): CameraState {
  const d = new THREE.Vector3().subVectors(eye, target);
  const distance = d.length();
  const pitch = distance > 1e-6 ? Math.asin(THREE.MathUtils.clamp(d.y / distance, -1, 1)) : 0;
  const yaw = Math.atan2(d.z, d.x);
  return {
    target: [target.x, target.y, target.z],
    yaw,
    pitch,
    distance,
  };
}

// Same clear color as the native wgpu renderer (renderer.rs render()).
const CLEAR_COLOR = new THREE.Color(0.07, 0.07, 0.09);

// Face colors lifted directly from the VERTICES table in renderer.rs, in
// BoxGeometry face-material order: [+X, -X, +Y, -Y, +Z, -Z].
const FACE_COLORS: [number, number, number][] = [
  [1.0, 0.2, 0.2], // +X red
  [0.2, 1.0, 1.0], // -X cyan
  [0.2, 1.0, 0.2], // +Y green
  [1.0, 0.2, 1.0], // -Y magenta
  [0.3, 0.4, 1.0], // +Z blue
  [1.0, 1.0, 0.2], // -Z yellow
];

export interface CanvasBackendHandle {
  /** Disposes the renderer/scene and returns the final camera state, for
   * handing continuity back to the native side. */
  dispose: () => CameraState;
}

export interface CanvasRenderScheduler {
  /** Render one frame for an explicit invalidation (or a control/resize event). */
  invalidate: () => void;
  /** Starts the continuous RAF loop used by the performance sampler. */
  start: () => void;
  /** Stops future frames, including callbacks already queued by the browser. */
  dispose: () => void;
}

/** Keep optional performance reporting from escaping the render/RAF callback. */
export function reportCanvasPerformanceSummary(
  summary: PerformanceSummary,
  report: (summary: PerformanceSummary) => unknown = (value) =>
    invoke("report_performance_summary", { summary: value }),
  onError: (error: unknown) => void = (error) =>
    console.warn("[perf] failed to report Canvas performance summary:", error),
): void {
  const reportError = (error: unknown) => {
    try {
      onError(error);
    } catch {
      // Diagnostics must not create a second unhandled rejection.
    }
  };
  try {
    void Promise.resolve(report(summary)).catch(reportError);
  } catch (error) {
    reportError(error);
  }
}

interface CanvasRenderSchedulerOptions {
  render: (rafTimestamp?: number) => void;
  continuous: boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * Keeps the normal Canvas fallback invalidation-driven while retaining the
 * continuous RAF required by the opt-in performance sampler. The injected RAF
 * functions make the lifecycle deterministic without constructing WebGL in
 * unit tests.
 */
export function createCanvasRenderScheduler({
  render,
  continuous,
  requestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame = window.cancelAnimationFrame.bind(window),
}: CanvasRenderSchedulerOptions): CanvasRenderScheduler {
  let disposed = false;
  let started = false;
  let rafId: number | null = null;

  const schedule = () => {
    if (disposed || !continuous || rafId !== null) return;
    rafId = requestFrame((timestamp) => {
      rafId = null;
      if (disposed) return;
      render(timestamp);
      schedule();
    });
  };

  return {
    invalidate: () => {
      if (!disposed) render();
    },
    start: () => {
      if (disposed || started) return;
      started = true;
      schedule();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) {
        cancelFrame(rafId);
        rafId = null;
      }
    },
  };
}

/**
 * Mounts a three.js canvas filling `host`, rendering the same colored cube as
 * the native wgpu renderer, seeded from `initialCamera`. OrbitControls owns
 * all input directly (no IPC) while this backend is active.
 */
export function mountCanvasBackend(
  host: HTMLElement,
  initialCamera: CameraState,
): CanvasBackendHandle {
  const scene = new THREE.Scene();
  scene.background = CLEAR_COLOR;

  const width = Math.max(host.clientWidth, 1);
  const height = Math.max(host.clientHeight, 1);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  const target = new THREE.Vector3(...initialCamera.target);
  camera.position.copy(eyeFromCamera(initialCamera));
  camera.lookAt(target);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // The wgpu surface picks a non-sRGB format specifically to avoid an extra
  // gamma pass (see renderer.rs), so the 0..1 clear/vertex colors land on
  // screen unmodified. three.js defaults to sRGB output encoding, which would
  // otherwise make identical RGB triples look visibly different here — turn
  // it off so the "same numbers" are actually the same pixels.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const performanceTarget = parsePerformanceTarget(import.meta.env.VITE_PERF_TARGET);
  if (performanceTarget) {
    camera.aspect = performanceTarget[0] / performanceTarget[1];
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(1);
    renderer.setSize(performanceTarget[0], performanceTarget[1], false);
  } else {
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
  }
  // Absolutely positioned to fill the host, and behind the (already-mounted)
  // overlay div, which relies on host's `position: relative` + DOM order for
  // its own stacking today. Pin z-index explicitly so appending the canvas
  // after the overlay never covers it.
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  renderer.domElement.style.zIndex = "0";
  renderer.domElement.setAttribute("aria-label", "Canvas viewport preview");
  host.appendChild(renderer.domElement);

  const materials = FACE_COLORS.map(
    ([r, g, b]) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) }),
  );
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  const grid = new THREE.GridHelper(20, 20, 0x474f5e, 0x292e38);
  const axes = new THREE.AxesHelper(2.5);
  scene.add(grid, axes, cube);

  const controls = new OrbitControls(camera, renderer.domElement);
  applyCanvasOrbitBounds(controls);
  controls.target.copy(target);
  controls.update();

  let disposed = false;
  const performanceSampleFrames = parsePerformanceSampleFrames(import.meta.env.VITE_PERF_SAMPLE_FRAMES);
  const performanceSampler =
    performanceTarget && performanceSampleFrames !== null
      ? new CanvasPerformanceSampler(
          performanceTarget[0],
          performanceTarget[1],
          performanceSampleFrames,
      )
      : null;
  const canReportPerformance = "__TAURI_INTERNALS__" in window;

  function render(rafTimestamp?: number) {
    if (disposed) return;
    const startedAt = performance.now();
    renderer.render(scene, camera);
    const summary = performanceSampler?.observe(startedAt, performance.now() - startedAt, rafTimestamp);
    if (summary) {
      console.info(`[perf] ${JSON.stringify(summary)}`);
      if (canReportPerformance) reportCanvasPerformanceSummary(summary);
    }
  }
  const scheduler = createCanvasRenderScheduler({
    render,
    continuous: performanceSampler !== null,
  });
  const renderOnControlChange = () => scheduler.invalidate();
  controls.addEventListener("change", renderOnControlChange);
  scheduler.start();

  const resizeObserver = new ResizeObserver(() => {
    const w = Math.max(host.clientWidth, 1);
    const h = Math.max(host.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!performanceTarget) renderer.setSize(w, h);
    scheduler.invalidate();
  });
  resizeObserver.observe(host);

  scheduler.invalidate();

  function dispose(): CameraState {
    const final = cameraFromEye(camera.position, controls.target);
    disposed = true;
    scheduler.dispose();
    resizeObserver.disconnect();
    controls.removeEventListener("change", renderOnControlChange);
    controls.dispose();
    materials.forEach((m) => m.dispose());
    cube.geometry.dispose();
    grid.geometry.dispose();
    if (Array.isArray(grid.material)) {
      grid.material.forEach((material) => material.dispose());
    } else {
      grid.material.dispose();
    }
    axes.geometry.dispose();
    if (Array.isArray(axes.material)) {
      axes.material.forEach((material) => material.dispose());
    } else {
      axes.material.dispose();
    }
    renderer.dispose();
    if (renderer.domElement.parentNode === host) {
      host.removeChild(renderer.domElement);
    }
    return final;
  }

  return { dispose };
}
