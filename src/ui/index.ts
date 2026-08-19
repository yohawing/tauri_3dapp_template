/**
 * Public presentational surface for external hosts (e.g. yw-retarget-web)
 * that want to reuse this template's panel/shell UI without pulling in its
 * Tauri IPC or native scene data layer.
 *
 * Everything re-exported here is either:
 *   - already Tauri-free (MenuBar, buildDefaultLayout), or
 *   - a *View component that takes data + callbacks as props instead of
 *     reading a concrete data source (OutlinerView, InspectorView), or
 *   - already designed for dependency injection (Timeline's `dataSource`
 *     prop, TweakpaneInspector's `onCommand` prop).
 *
 * The app's own panels (`src/panels/Outliner.tsx`, `src/panels/Inspector.tsx`,
 * `src/App.tsx`) are thin containers that wire the live Tauri-backed data
 * source to these same components — see those files for the wiring pattern
 * an external host should mirror with its own data source.
 *
 * ViewportHost and shell/layout.ts are exported too: both already guard every
 * Tauri call behind an `"__TAURI_INTERNALS__" in window` (or
 * `hasTauriRuntime()`) check, so they degrade to their non-native behavior
 * (canvas/three.js viewport, plain dockview layout) outside a Tauri shell
 * without any changes. They still import `@tauri-apps/api/core` at the
 * module level (a plain npm dependency, safe to resolve in any bundler) —
 * making that import itself injectable is a natural follow-up, not done here
 * to avoid destabilizing their effect-heavy lifecycle code in this pass.
 */

// Menu / command bar — pure props, no Tauri dependency at all.
export { MenuBar } from "../panels/MenuBar";
export type { EditorAction, EditorActionId, ShortcutSpec } from "../actions/editorActions";

// Outliner — presentational tree view. Feed it a `SceneNodeSummary[]` and
// two callbacks; it has no opinion on where the data comes from.
export { OutlinerView } from "../panels/OutlinerView";
export type { OutlinerViewProps } from "../panels/OutlinerView";

// Inspector — presentational panel chrome (tab header / selection label /
// empty state). Render your own editing controls as `children`.
export { InspectorView } from "../panels/InspectorView";
export type { InspectorViewProps } from "../panels/InspectorView";

// Tweakpane-based transform/material/light editor used by the app's own
// Inspector container. Takes `onCommand` instead of importing a concrete
// dispatcher, so it can be driven by any `SceneCommand` sink.
export { TweakpaneInspector } from "../panels/TweakpaneInspector";
export type { SceneCommandDispatch } from "../panels/TweakpaneInspector";

// Timeline — already accepts an injectable `dataSource` (see
// src/timeline/core/contracts.ts) and a `playbackController`; defaults to
// the app's runtime (Tauri-backed) data source when used un-wrapped.
export { Timeline } from "../panels/Timeline";
export type { TimelineProps } from "../panels/Timeline";
export type { TimelineDataSource } from "../timeline/core/contracts";

// Viewport host (native transparent hole / canvas three.js backend) and the
// dockview default-layout builder. See the module doc comment above for the
// current Tauri-coupling caveat on these two.
export { ViewportHost } from "../viewport/ViewportHost";
export type {
  CameraFov,
  CameraProjection,
  CameraViewPreset,
  ViewportDisplayMode,
  ViewportMode,
} from "../viewport/ViewportHost";
export { buildDefaultLayout } from "../shell/layout";

// Three.js scene graph -> SceneNodeSummary[] adapter. Not Tauri, not a
// concrete data source — a host that owns a live THREE.Object3D tree (this
// template's own Canvas fallback, or an external three.js-based viewport
// like yw-retarget-web's) uses this to feed OutlinerView/InspectorView from
// that tree instead of the Tauri-polled SceneProjection. See that module's
// doc comment for the full rationale.
export {
  createThreeSceneGraphController,
  defaultThreeNodeKind,
  snapshotThreeScene,
  threeObjectTransform,
} from "../scene/adapters/threeSceneAdapter";
export type {
  ThreeNodeKindClassifier,
  ThreeSceneAdapterOptions,
  ThreeSceneGraphController,
  ThreeSceneGraphListener,
  ThreeSceneSnapshot,
} from "../scene/adapters/threeSceneAdapter";

// Read-only scene projection DTOs shared by Outliner/Inspector. Pure types —
// no Tauri, no adapters — the contract an external data source needs to
// satisfy to drive OutlinerView / InspectorView / TweakpaneInspector.
export type {
  SceneCommand,
  SceneCommandProperty,
  SceneCommandResult,
  SceneLight,
  SceneLightType,
  SceneMaterial,
  SceneNodeKind,
  SceneNodeSummary,
  SceneProjection,
  SceneTransform,
  SelectedSceneNode,
} from "../scene/core/projection";
