/**
 * Generic three.js scene graph -> `SceneNodeSummary[]` projection.
 *
 * Native (Tauri) hosts drive the Outliner/Inspector from Rust's own scene via
 * `sceneProjectionDataSource.ts` (an IPC-polled `SceneProjection`). Any host
 * that instead owns a real `THREE.Object3D` tree directly — this template's
 * own Canvas fallback (`viewport/canvasBackend.ts`), or an external consumer
 * like yw-retarget-web's three.js viewport — has no such IPC layer to poll,
 * but still wants to feed the same presentational `OutlinerView`/
 * `InspectorView`/`TweakpaneInspector` components. This module is that
 * bridge: walk a live three.js tree into the same read-only DTOs, without
 * ever putting a three.js object into React state itself (only the
 * serializable snapshot goes through React; the objects stay in a plain
 * `Map` a caller can look up by id when it needs to actually touch three.js,
 * e.g. to read a bone's live transform for the Inspector).
 *
 * `three` is already a normal (non-dev) dependency of this template
 * (`package.json` — used by `viewport/canvasBackend.ts`), so importing it
 * here does not add a new dependency for any consumer already using this
 * template.
 */
import * as THREE from "three";
import type { SceneNodeKind, SceneNodeSummary, SceneTransform } from "../core/projection";

/** Classifies one three.js object into a `SceneNodeKind`. The default
 * (`defaultThreeNodeKind`) covers every object type three.js's own loaders
 * produce; pass a custom `kindOf` only to override specific objects (e.g. an
 * app-specific marker object that should read as something other than its
 * three.js type would suggest). */
export type ThreeNodeKindClassifier = (object: THREE.Object3D) => SceneNodeKind;

export function defaultThreeNodeKind(object: THREE.Object3D): SceneNodeKind {
  if ((object as THREE.Light).isLight) return "light";
  if ((object as THREE.Bone).isBone) return "bone";
  if ((object as THREE.Mesh | THREE.SkinnedMesh).isMesh) return "mesh";
  return "scene";
}

export interface ThreeSceneAdapterOptions {
  /** Overrides the default three.js-type-based `SceneNodeKind` classifier. */
  kindOf?: ThreeNodeKindClassifier;
  /** Returning `false` excludes `object` *and its whole subtree* from the
   * snapshot (e.g. a helper layer a host wants to keep out of the Outliner
   * entirely). Defaults to including everything. */
  include?: (object: THREE.Object3D) => boolean;
  /** Row label for `object`. Defaults to `object.name || object.type` (three
   * objects with no authored `name` — most `Group`/`Object3D` wrappers a
   * loader inserts — still get a readable label this way, e.g. "Group"
   * instead of an empty string). */
  labelOf?: (object: THREE.Object3D) => string;
}

export interface ThreeSceneSnapshot {
  nodes: SceneNodeSummary[];
  /** `SceneNodeSummary.id` (== the three.js object's own `uuid`) -> the live
   * `THREE.Object3D`. Kept out of the `nodes` array/React state on purpose —
   * see this module's doc comment — so callers needing the real object
   * (visibility toggle, live transform read for the Inspector) look it up
   * through this map instead of stashing a three.js reference in state. */
  registry: ReadonlyMap<string, THREE.Object3D>;
}

const defaultInclude = () => true;
const defaultLabelOf = (object: THREE.Object3D) => object.name || object.type;

/**
 * Walks `root` and every descendant into a flat `SceneNodeSummary[]` (`root`
 * itself becomes the tree's one parentless row, `id` is `parent`less), using
 * each object's own `uuid` as the row id and `visible` as authored on the
 * object. Pure/synchronous — call again (e.g. from a `requestAnimationFrame`
 * loop, on scene rebuild, or after a visibility toggle) to get a fresh
 * snapshot reflecting whatever changed since the last call.
 */
export function snapshotThreeScene(root: THREE.Object3D, options: ThreeSceneAdapterOptions = {}): ThreeSceneSnapshot {
  const kindOf = options.kindOf ?? defaultThreeNodeKind;
  const include = options.include ?? defaultInclude;
  const labelOf = options.labelOf ?? defaultLabelOf;

  const nodes: SceneNodeSummary[] = [];
  const registry = new Map<string, THREE.Object3D>();

  const visit = (object: THREE.Object3D, parentId: string | null) => {
    if (!include(object)) return;
    const id = object.uuid;
    nodes.push({ id, parent: parentId, label: labelOf(object), kind: kindOf(object), visible: object.visible });
    registry.set(id, object);
    for (const child of object.children) visit(child, id);
  };
  visit(root, null);

  return { nodes, registry };
}

/** `SceneTransform` for one three.js object's *local* transform (parent-
 * relative, matching `TweakpaneInspector`'s expectation for a scene-graph
 * node — the same convention `SelectedSceneNode.transform` already uses for
 * the native/Tauri scene). */
export function threeObjectTransform(object: THREE.Object3D): SceneTransform {
  return {
    translation: [object.position.x, object.position.y, object.position.z],
    rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

export type ThreeSceneGraphListener = () => void;

/**
 * A tiny external-store around `snapshotThreeScene`: owns the latest
 * `ThreeSceneSnapshot`, notifies subscribers when it changes, and exposes a
 * `toggleVisibility` that mutates the live three.js object *and* republishes
 * an updated snapshot in one step (so a subscriber re-rendering off
 * `getSnapshot()` sees the flipped `visible` immediately, without needing to
 * re-walk the whole tree). Shaped to drop straight into React's
 * `useSyncExternalStore(controller.subscribe, controller.getSnapshot)` — the
 * same pattern `sceneProjectionDataSource.ts` uses for the native/Tauri
 * scene — so a host's Outliner/Inspector containers can treat a three.js
 * scene and a Tauri scene identically from React's point of view.
 */
export interface ThreeSceneGraphController {
  getSnapshot: () => ThreeSceneSnapshot;
  subscribe: (listener: ThreeSceneGraphListener) => () => void;
  /** Re-walks `root` (same `options` every call unless a new one is passed)
   * and notifies subscribers. Call this whenever the underlying three.js
   * tree structurally changed (a mesh bound/unbound, a scene rebuilt) — a
   * mere per-frame pose update does *not* need this (positions/rotations are
   * read live off the registry's objects, not cached in the snapshot). */
  publish: (root: THREE.Object3D, options?: ThreeSceneAdapterOptions) => ThreeSceneSnapshot;
  /** Flips `object.visible` for the registry entry at `nodeId` (a no-op, not
   * an error, if `nodeId` is unknown — e.g. a stale row from a snapshot the
   * scene has since moved past) and republishes. Returns whether it found a
   * matching object. */
  toggleVisibility: (nodeId: string) => boolean;
}

const EMPTY_SNAPSHOT: ThreeSceneSnapshot = { nodes: [], registry: new Map() };

export function createThreeSceneGraphController(): ThreeSceneGraphController {
  let snapshot = EMPTY_SNAPSHOT;
  let lastRoot: THREE.Object3D | null = null;
  let lastOptions: ThreeSceneAdapterOptions | undefined;
  const listeners = new Set<ThreeSceneGraphListener>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (root, options) => {
      lastRoot = root;
      lastOptions = options ?? lastOptions;
      snapshot = snapshotThreeScene(root, lastOptions);
      notify();
      return snapshot;
    },
    toggleVisibility: (nodeId) => {
      const object = snapshot.registry.get(nodeId);
      if (!object) return false;
      object.visible = !object.visible;
      // Rebuild just the changed row rather than re-walking the whole tree —
      // cheap, and correct as long as toggling visibility doesn't itself
      // change any other row's classification/label (it doesn't).
      snapshot = {
        nodes: snapshot.nodes.map((node) => (node.id === nodeId ? { ...node, visible: object.visible } : node)),
        registry: snapshot.registry,
      };
      notify();
      // `lastRoot` is intentionally unused by toggleVisibility itself (no
      // re-walk needed) but kept so a future full `publish()` call after a
      // toggle still has the right root/options to fall back to.
      void lastRoot;
      return true;
    },
  };
}
