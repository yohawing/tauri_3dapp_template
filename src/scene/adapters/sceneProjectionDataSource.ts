import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { waitForViewportInputIdle } from "../../viewport/input";
import { boundedDiagnosticText, safeDiagnosticText } from "../../console/contracts";
import { installSceneProjectionSelfTests } from "./sceneProjectionSelfTests";
import {
  isBoundedUtf8String,
  isFiniteF32,
  isSafeNonNegativeInteger,
  isWireRecord,
} from "../../wireValidation";
import type {
  SceneCommand,
  SceneCommandEnvelope,
  SceneCommandResult,
  SceneLight,
  SceneMaterial,
  SceneCommandProperty,
  SceneNodeSummary,
  SceneProjection,
  SceneTransform,
} from "../core/projection";

// Generated bone IDs append `::bone::<index>` to a valid Scene instance ID,
// so runtime node IDs use a wider wire cap than persisted IDs/labels.
const MAX_RUNTIME_ID_BYTES = 2048;
const MAX_RUNTIME_LABEL_BYTES = 1024;
const MAX_DIAGNOSTIC_TEXT_BYTES = 4096;
const MAX_SCENE_NODES = 262_144;
const MAX_NODE_DEPTH = 512;
const MAX_COMMAND_RESULTS = 32;
/** Must match SceneCommand::SetLightIntensity's native 0..=1000 f32 bound. */
const MAX_LIGHT_INTENSITY = 1_000;
/** Must match renderer's pre-load runtime projection text budget. */
export const MAX_RUNTIME_PROJECTION_TEXT_BYTES = 64 * 1024 * 1024;
const F32_EPSILON = 1.1920929e-7;
const projectionTextEncoder = new TextEncoder();
const projectionTextScratch = new Uint8Array(MAX_RUNTIME_ID_BYTES);

function projectionTextByteLength(value: string): number {
  const encoded = projectionTextEncoder.encodeInto(value, projectionTextScratch);
  // Each caller is already bounded to MAX_RUNTIME_ID_BYTES or less.
  return encoded.read === value.length ? encoded.written : projectionTextEncoder.encode(value).byteLength;
}

function isRuntimeString(value: unknown, allowEmpty = false): value is string {
  return isBoundedUtf8String(value, MAX_RUNTIME_ID_BYTES, allowEmpty);
}

function isRuntimeLabel(value: unknown, allowEmpty = false): value is string {
  return isBoundedUtf8String(value, MAX_RUNTIME_LABEL_BYTES, allowEmpty);
}

function isDiagnosticText(value: unknown): value is string {
  return isBoundedUtf8String(value, MAX_DIAGNOSTIC_TEXT_BYTES, true);
}

function numberTuple(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  return value.every(isFiniteF32)
    ? value as number[]
    : null;
}

function normalizeTransform(value: unknown): SceneTransform | null {
  if (!isWireRecord(value)) return null;
  const translation = numberTuple(value.translation, 3);
  const rotation = numberTuple(value.rotation, 4);
  const scale = numberTuple(value.scale, 3);
  if (!translation || !rotation || !scale) return null;
  const rotationLengthSquared = rotation.reduce(
    (sum, item) => Math.fround(sum + Math.fround(item * item)),
    0,
  );
  if (!Number.isFinite(rotationLengthSquared) || rotationLengthSquared <= F32_EPSILON) return null;
  if (scale.some((item) => item <= 0)) return null;
  return {
    translation: translation as SceneTransform["translation"],
    rotation: rotation as SceneTransform["rotation"],
    scale: scale as SceneTransform["scale"],
  };
}

function normalizedColor(value: unknown): [number, number, number, number] | null {
  const color = numberTuple(value, 4);
  return color && color.every((item) => item >= 0 && item <= 1)
    ? color as [number, number, number, number]
    : null;
}

function nonNegativeFinite(value: unknown): number | null {
  return isFiniteF32(value) && value >= 0 ? value : null;
}

function normalizeMaterial(value: unknown): SceneMaterial | null {
  if (!isWireRecord(value)) return null;
  const color = normalizedColor(value.color);
  const metallic = value.metallic;
  const roughness = value.roughness;
  if (
    !color || !isFiniteF32(metallic) || metallic < 0 || metallic > 1 ||
    !isFiniteF32(roughness) || roughness < 0 || roughness > 1
  ) return null;
  return { color, metallic, roughness };
}

function normalizeLight(value: unknown): SceneLight | null {
  if (!isWireRecord(value)) return null;
  const lightType = value.lightType;
  if (lightType !== "point" && lightType !== "directional" && lightType !== "spot") return null;
  const direction = value.direction === null ? null : numberTuple(value.direction, 3);
  if (value.direction !== null && !direction) return null;
  if ((lightType === "directional") !== (direction !== null)) return null;
  const directionLengthSquared = direction?.reduce(
    (sum, item) => Math.fround(sum + Math.fround(item * item)),
    0,
  );
  if (direction &&
    (directionLengthSquared === undefined ||
      !Number.isFinite(directionLengthSquared) || directionLengthSquared <= F32_EPSILON)
  ) return null;
  const color = normalizedColor(value.color);
  const intensity = nonNegativeFinite(value.intensity);
  const radius = nonNegativeFinite(value.radius);
  const attenuationRadius = value.attenuationRadius === null ? null : nonNegativeFinite(value.attenuationRadius);
  const innerConeAngle = value.innerConeAngle === null ? null : nonNegativeFinite(value.innerConeAngle);
  const outerConeAngle = value.outerConeAngle === null ? null : nonNegativeFinite(value.outerConeAngle);
  if (
    !color || intensity === null || radius === null ||
    intensity > MAX_LIGHT_INTENSITY ||
    (value.attenuationRadius !== null && attenuationRadius === null) ||
    (value.innerConeAngle !== null && innerConeAngle === null) ||
    (value.outerConeAngle !== null && outerConeAngle === null) ||
    typeof value.enabled !== "boolean" || typeof value.castsShadows !== "boolean"
  ) return null;
  return {
    lightType,
    direction: direction as SceneLight["direction"],
    color,
    intensity,
    radius,
    enabled: value.enabled,
    castsShadows: value.castsShadows,
    attenuationRadius,
    innerConeAngle,
    outerConeAngle,
  };
}

function normalizeSelected(value: unknown): SceneProjection["selected"] | null {
  if (!isWireRecord(value)) return null;
  const id = value.id;
  const transform = normalizeTransform(value.transform);
  const material = value.material === null ? null : normalizeMaterial(value.material);
  const light = value.light === null ? null : normalizeLight(value.light);
  if (!isRuntimeString(id) || !transform || (value.material !== null && !material) || (value.light !== null && !light)) {
    return null;
  }
  if (typeof value.transformEditable !== "boolean") return null;
  return { id, transform, transformEditable: value.transformEditable, material, light };
}

function validCommandProperty(value: unknown): value is SceneCommandProperty {
  return value === "baseColor" || value === "metallic" || value === "roughness" || value === "lightColor" ||
    value === "lightIntensity" || value === "lightDirection" || value === "lightEnabled" ||
    value === "lightCastsShadows" || value === "transform" || value === "visibility";
}

function normalizeCommandResult(value: unknown): SceneCommandResult | null {
  if (!isWireRecord(value)) return null;
  if (
    !isSafeNonNegativeInteger(value.sequence) || value.sequence < 1 || !isRuntimeString(value.nodeId) ||
    !validCommandProperty(value.property) || typeof value.applied !== "boolean" ||
    (value.error !== null && !isDiagnosticText(value.error))
  ) return null;
  return {
    sequence: value.sequence,
    nodeId: value.nodeId,
    property: value.property,
    applied: value.applied,
    error: value.error,
  };
}

export function validNodeTree(nodes: SceneNodeSummary[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set(byId.keys());
  if (ids.size !== nodes.length || nodes.length > MAX_SCENE_NODES) return false;
  if (nodes.some((node) => node.parent !== null && !ids.has(node.parent))) return false;
  const states = new Map<string, 1 | 2>();
  const depths = new Map<string, number>();
  for (const node of nodes) {
    if (states.get(node.id) === 2) continue;
    const path: string[] = [];
    let currentId = node.id;
    while (true) {
      const state = states.get(currentId);
      if (state === 1) return false;
      if (state === 2) {
        let depth = depths.get(currentId);
        if (depth === undefined) return false;
        for (let index = path.length - 1; index >= 0; index -= 1) {
          depth += 1;
          if (depth > MAX_NODE_DEPTH) return false;
          depths.set(path[index], depth);
          states.set(path[index], 2);
        }
        break;
      }
      const current = byId.get(currentId);
      if (!current) return false;
      states.set(currentId, 1);
      path.push(currentId);
      if (current.parent === null) {
        let depth = 0;
        for (let index = path.length - 1; index >= 0; index -= 1) {
          if (depth > MAX_NODE_DEPTH) return false;
          depths.set(path[index], depth);
          states.set(path[index], 2);
          depth += 1;
        }
        break;
      }
      currentId = current.parent;
    }
  }
  return true;
}

/** Reject malformed Native scene snapshots before they affect UI state. */
export function normalizeSceneProjection(value: unknown): SceneProjection | null {
  if (!isWireRecord(value)) return null;
  const epoch = value.epoch;
  const revision = value.revision;
  const selectedNodeId = value.selectedNodeId;
  const rawNodes = value.nodes;
  const selected = value.selected;
  const lastProcessedSequence = value.lastProcessedSequence;
  const rawResults = value.commandResults;
  if (
    !isSafeNonNegativeInteger(epoch) || epoch < 1 || !isSafeNonNegativeInteger(revision) ||
    (selectedNodeId !== null && !isRuntimeString(selectedNodeId)) || !Array.isArray(rawNodes) ||
    rawNodes.length > MAX_SCENE_NODES || (selected !== null && !isWireRecord(selected)) ||
    !isSafeNonNegativeInteger(lastProcessedSequence) || !Array.isArray(rawResults) ||
    rawResults.length > MAX_COMMAND_RESULTS
  ) return null;
  const nodes: SceneNodeSummary[] = [];
  let projectionTextBytes = 0;
  const addProjectionText = (value: string): boolean => {
    projectionTextBytes += projectionTextByteLength(value);
    return projectionTextBytes <= MAX_RUNTIME_PROJECTION_TEXT_BYTES;
  };
  for (const value of rawNodes) {
    if (!isWireRecord(value) || !isRuntimeString(value.id) ||
      (value.parent !== null && !isRuntimeString(value.parent)) || !isRuntimeLabel(value.label, true) ||
      (value.kind !== "scene" && value.kind !== "light" && value.kind !== "mesh" && value.kind !== "bone") ||
      typeof value.visible !== "boolean") return null;
    if (!addProjectionText(value.id) ||
      (value.parent !== null && !addProjectionText(value.parent)) ||
      !addProjectionText(value.label) || !addProjectionText(value.kind)) return null;
    nodes.push({ id: value.id, parent: value.parent, label: value.label, kind: value.kind, visible: value.visible });
  }
  if (!validNodeTree(nodes)) return null;
  const normalizedSelected = selected === null ? null : normalizeSelected(selected);
  if ((selectedNodeId === null) !== (normalizedSelected === null) ||
    (selectedNodeId !== null && normalizedSelected?.id !== selectedNodeId) ||
    (selectedNodeId !== null && !nodes.some((node) => node.id === selectedNodeId))) return null;
  const commandResults: SceneCommandResult[] = [];
  for (const result of rawResults) {
    const normalized = normalizeCommandResult(result);
    if (!normalized) return null;
    commandResults.push(normalized);
  }
  return {
    epoch,
    revision,
    selectedNodeId,
    nodes,
    selected: normalizedSelected,
    lastProcessedSequence,
    commandResults,
  };
}

const FIXTURE_PROJECTION: SceneProjection = {
  epoch: 1,
  revision: 1,
  selectedNodeId: "cube",
  nodes: [
    { id: "scene", parent: null, label: "Scene", kind: "scene", visible: true },
    { id: "key-light", parent: "scene", label: "Key Light", kind: "light", visible: true },
    { id: "cube", parent: "scene", label: "Cube", kind: "mesh", visible: true },
  ],
  selected: {
    id: "cube",
    transformEditable: true,
    transform: {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: { color: [1, 0.45, 0.1, 1], metallic: 0, roughness: 0.5 },
    light: null,
  },
  lastProcessedSequence: 0,
  commandResults: [],
};

const EMPTY_RUNTIME_PROJECTION: SceneProjection = {
  epoch: 1,
  revision: 0,
  selectedNodeId: null,
  nodes: [],
  selected: null,
  lastProcessedSequence: 0,
  commandResults: [],
};

const POLL_INTERVAL_MS = 100;
/** Keep frontend optimistic state bounded to the Native queue capacity. */
export const MAX_PENDING_SCENE_COMMANDS = 256;

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function reportSceneError(context: string, error: unknown): void {
  const message = `[SceneProjection] ${context}: ${safeDiagnosticText(error)}`;
  console.warn(message);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("tauri3d:diagnostic", {
      detail: { level: "error", source: "scene", message },
    }),
  );
  window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
}

type Listener = () => void;
type WarningKey = "poll" | "select" | "dispatch";

interface SceneCommandFlight {
  active: boolean;
  queued?: SceneCommandEnvelope;
  detach?: () => void;
}

export class SceneProjectionDataSource {
  private snapshot: SceneProjection;
  private canonicalSnapshot: SceneProjection;
  private readonly listeners = new Set<Listener>();
  private pollId: number | undefined;
  private pollInFlight: Promise<void> | undefined;
  private pollGeneration = 0;
  private commandGeneration = 0;
  private disposed = false;
  private nativeSnapshotAccepted = false;
  // Keep sequences monotonic across ordinary WebView reloads as well as
  // within one module instance. Date.now() leaves ample integer headroom.
  private nextSequence = Date.now() * 1000;
  private readonly pendingCommands = new Map<string, SceneCommandEnvelope>();
  private readonly commandFlights = new Map<string, SceneCommandFlight>();
  private readonly commandKeys = new Set<string>();
  private selfTestCleanup: (() => void) | undefined;
  private readonly warned: Record<WarningKey, boolean> = {
    poll: false,
    select: false,
    dispatch: false,
  };

  constructor(private readonly runtime = hasTauriRuntime()) {
    const initial = runtime ? EMPTY_RUNTIME_PROJECTION : FIXTURE_PROJECTION;
    this.snapshot = initial;
    this.canonicalSnapshot = initial;
    if (runtime && import.meta.env.DEV) {
      this.selfTestCleanup = installSceneProjectionSelfTests(this, {
        scene: import.meta.env.VITE_SCENE_SELF_TEST,
        material: import.meta.env.VITE_MATERIAL_SELF_TEST,
        visibility: import.meta.env.VITE_VISIBILITY_SELF_TEST,
      });
    }
  }

  getSnapshot = (): SceneProjection => this.snapshot;

  private warnOnce(key: WarningKey, report: () => void): void {
    if (this.warned[key]) return;
    this.warned[key] = true;
    report();
  }

  private resetWarning(key: WarningKey): void {
    this.warned[key] = false;
  }

  subscribe = (listener: Listener): (() => void) => {
    if (this.listeners.size === 0) this.disposed = false;
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.runtime) {
      void this.poll();
      this.pollId = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.dispose();
      }
    };
  };

  dispose(): void {
    this.selfTestCleanup?.();
    this.selfTestCleanup = undefined;
    this.disposed = true;
    this.pollGeneration += 1;
    this.commandGeneration += 1;
    this.pollInFlight = undefined;
    for (const flight of this.commandFlights.values()) flight.detach?.();
    this.pendingCommands.clear();
    this.commandFlights.clear();
    this.commandKeys.clear();
    this.listeners.clear();
    if (this.pollId !== undefined) {
      window.clearInterval(this.pollId);
      this.pollId = undefined;
    }
  }

  async select(nodeId: string): Promise<void> {
    if (this.disposed) return;
    if (!this.runtime) {
      const selected = this.snapshot.nodes.some((node) => node.id === nodeId) ? nodeId : null;
      if (selected === null) return;
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        selectedNodeId: selected,
        selected: fixtureDetails(selected),
      };
      this.emit();
      return;
    }

    const generation = this.commandGeneration;
    try {
      await invoke("select_scene_node", { nodeId });
      if (this.disposed || generation !== this.commandGeneration) return;
      this.resetWarning("select");
    } catch (error) {
      if (this.disposed || generation !== this.commandGeneration) return;
      this.warnOnce("select", () => {
        reportSceneError("select_scene_node invoke failed", error);
      });
    }
  }

  async dispatch(command: SceneCommand): Promise<void> {
    if (this.disposed) return;
    const envelope: SceneCommandEnvelope = {
      epoch: this.snapshot.epoch,
      sequence: ++this.nextSequence,
      command,
    };
    if (!this.runtime) {
      if (command.type === "setVisibility") {
        const node = this.snapshot.nodes.find((candidate) => candidate.id === command.nodeId);
        if (!node) return;
        this.snapshot = {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          nodes: this.snapshot.nodes.map((candidate) =>
            candidate.id === command.nodeId ? { ...candidate, visible: command.visible } : candidate,
          ),
          lastProcessedSequence: envelope.sequence,
          commandResults: [...this.snapshot.commandResults, resultFor(envelope, true)].slice(-32),
        };
        this.emit();
        return;
      }
      const selected = this.snapshot.selected;
      if (command.type === "setTransform") {
        if (!selected || selected.id !== command.nodeId || !selected.transformEditable) return;
        this.snapshot = {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          selected: { ...selected, transform: command.transform },
          lastProcessedSequence: envelope.sequence,
          commandResults: [...this.snapshot.commandResults, resultFor(envelope, true)].slice(-32),
        };
        this.emit();
        return;
      }
      if (isLightCommand(command) && (!selected?.light || selected.id !== command.nodeId)) return;
      const light = selected?.light;
      if (selected && light && selected.id === command.nodeId && isLightCommand(command)) {
        this.snapshot = {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          selected: { ...selected, light: applyFixtureLightCommand(light, command) },
          lastProcessedSequence: envelope.sequence,
          commandResults: [...this.snapshot.commandResults, resultFor(envelope, true)].slice(-32),
        };
        this.emit();
        return;
      }
      const material = selected?.material;
      if (!selected || !material || selected.id !== command.nodeId) return;
      const nextMaterial = applyFixtureCommand(material, command);
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        selected: { ...selected, material: nextMaterial },
        lastProcessedSequence: envelope.sequence,
        commandResults: [...this.snapshot.commandResults, resultFor(envelope, true)].slice(-32),
      };
      this.emit();
      return;
    }

    const key = commandKey(command);
    if (!this.commandKeys.has(key) && this.commandKeys.size >= MAX_PENDING_SCENE_COMMANDS) {
      this.warnOnce("dispatch", () => {
        console.warn(
          `[SceneProjection] scene command capacity is full (${MAX_PENDING_SCENE_COMMANDS}); command was dropped`,
        );
      });
      return;
    }
    this.commandKeys.add(key);
    this.pendingCommands.set(key, envelope);
    this.applyOptimistic(envelope);

    const activeFlight = this.commandFlights.get(key);
    if (activeFlight?.active) {
      activeFlight.queued = envelope;
      return;
    }
    const flight: SceneCommandFlight = { active: true };
    this.commandFlights.set(key, flight);
    this.commandKeys.add(key);
    await this.sendCommand(key, envelope, flight, this.commandGeneration);
  }

  async undoTransform(): Promise<void> {
    if (!this.runtime) return;
    try {
      await waitForViewportInputIdle();
      await invoke("undo_transform");
    } catch (error) {
      this.warnOnce("dispatch", () => reportSceneError("undo_transform invoke failed", error));
    }
  }

  async redoTransform(): Promise<void> {
    if (!this.runtime) return;
    try {
      await waitForViewportInputIdle();
      await invoke("redo_transform");
    } catch (error) {
      this.warnOnce("dispatch", () => reportSceneError("redo_transform invoke failed", error));
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.listeners.size === 0) return;
    if (this.pollInFlight) return this.pollInFlight;
    const generation = this.pollGeneration;
    const request = (async () => {
      try {
        const rawProjection = await invoke<unknown>("get_scene_projection");
        if (this.disposed || generation !== this.pollGeneration) return;
        const projection = normalizeSceneProjection(rawProjection);
        if (!projection) {
          this.warnOnce("poll", () => {
            reportSceneError("get_scene_projection returned an invalid projection payload", "malformed payload");
          });
          return;
        }
        this.resetWarning("poll");
        // The first native snapshot is authoritative even when its revision is
        // lower than the browser fixture.  Later rollbacks are rejected.
        if (
          shouldAcceptSceneProjection(
            this.nativeSnapshotAccepted,
            this.canonicalSnapshot.revision,
            projection.revision,
            this.canonicalSnapshot.epoch,
            projection.epoch,
          )
        ) {
          this.nativeSnapshotAccepted = true;
          this.applyProjection(projection);
        }
      } catch (error) {
        if (this.disposed || generation !== this.pollGeneration) return;
        this.warnOnce("poll", () => {
          reportSceneError("get_scene_projection invoke failed; runtime projection unavailable", error);
        });
      }
    })();
    this.pollInFlight = request;
    try {
      await request;
    } finally {
      if (this.pollInFlight === request) this.pollInFlight = undefined;
    }
  }

  private async sendCommand(
    key: string,
    envelope: SceneCommandEnvelope,
    flight: SceneCommandFlight,
    generation: number,
  ): Promise<void> {
    let resolveDetached!: () => void;
    let detached = false;
    const detachedCompletion = new Promise<void>((resolve) => {
      resolveDetached = () => {
        if (detached) return;
        detached = true;
        resolve();
      };
    });
    flight.detach = resolveDetached;

    const invokeTask = (async () => {
      try {
        await invoke("dispatch_scene_command", { command: envelope });
        if (
          !this.disposed &&
          generation === this.commandGeneration &&
          this.commandFlights.get(key) === flight &&
          envelope.epoch === this.snapshot.epoch
        ) {
          this.resetWarning("dispatch");
        }
      } catch (error) {
        const current =
          !this.disposed &&
          generation === this.commandGeneration &&
          this.commandFlights.get(key) === flight &&
          envelope.epoch === this.snapshot.epoch;
        if (current && this.pendingCommands.get(key)?.sequence === envelope.sequence) {
          const rollback = rollbackRejectedCommand(this.canonicalSnapshot, this.pendingCommands, envelope);
          this.pendingCommands.clear();
          rollback.pending.forEach((next, nextKey) => this.pendingCommands.set(nextKey, next));
          this.pruneCommandKeys();
          this.snapshot = {
            ...rollback.projection,
            revision: Math.max(this.snapshot.revision, this.canonicalSnapshot.revision) + 1,
            lastProcessedSequence: Math.max(this.snapshot.lastProcessedSequence, envelope.sequence),
            commandResults: [...this.snapshot.commandResults, resultFor(envelope, false, boundedDiagnosticText(error))].slice(-32),
          };
          this.emit();
        }
        if (current) {
          this.warnOnce("dispatch", () => {
            console.warn("[SceneProjection] dispatch_scene_command invoke failed:", error);
          });
        }
      } finally {
        flight.detach = undefined;
        // A Scene replacement clears old flights.  Do not let an old invoke's
        // finally block observe a newly-created flight for the same key.
        if (generation !== this.commandGeneration || this.commandFlights.get(key) !== flight) return;
        if (flight.queued) {
          const next = flight.queued;
          flight.queued = undefined;
          await this.sendCommand(key, next, flight, generation);
        } else {
          this.commandFlights.delete(key);
          this.pruneCommandKeys();
        }
      }
    })();
    await Promise.race([invokeTask, detachedCompletion]);
  }

  private applyProjection(projection: SceneProjection): void {
    if (projection.epoch !== this.snapshot.epoch) {
      // Pending values and queued invokes belong to the previous Scene.  The
      // active invoke cannot be canceled, but its completion is fenced by the
      // flight identity check in sendCommand.  Release local callers now so a
      // stalled old transport cannot retain the replaced Scene.
      this.commandGeneration += 1;
      for (const flight of this.commandFlights.values()) flight.detach?.();
      this.pendingCommands.clear();
      this.commandFlights.clear();
      this.commandKeys.clear();
    }
    this.canonicalSnapshot = projection;
    const reconciled = reconcileSceneProjection(projection, this.pendingCommands);
    this.pendingCommands.clear();
    reconciled.pending.forEach((envelope, key) => this.pendingCommands.set(key, envelope));
    this.pruneCommandKeys();
    const next = reconciled.projection;
    if (next !== this.snapshot || next.revision !== this.snapshot.revision) {
      this.snapshot = next;
      this.emit();
    }
  }

  private applyOptimistic(envelope: SceneCommandEnvelope): void {
    const next = applyOptimisticToProjection(this.snapshot, envelope);
    if (next !== this.snapshot) {
      this.snapshot = next;
      this.emit();
    }
  }

  private pruneCommandKeys(): void {
    for (const key of this.commandKeys) {
      if (!this.pendingCommands.has(key) && !this.commandFlights.has(key)) {
        this.commandKeys.delete(key);
      }
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        // One consumer must not abort the remaining subscription fanout or
        // turn an otherwise successful poll into a transport failure.
        try {
          console.error("[SceneProjection] subscriber failed:", error);
        } catch {
          // Console implementations can be replaced by embedding hosts.
        }
      }
    });
  }
}

export function shouldAcceptSceneProjection(
  nativeSnapshotAccepted: boolean,
  currentRevision: number,
  nextRevision: number,
  currentEpoch = 1,
  nextEpoch = currentEpoch,
): boolean {
  return !nativeSnapshotAccepted || nextEpoch > currentEpoch || (nextEpoch === currentEpoch && nextRevision > currentRevision);
}

function commandKey(command: SceneCommand): string {
  return `${command.nodeId}/${commandProperty(command)}`;
}

function commandProperty(command: SceneCommand): SceneCommandProperty {
  switch (command.type) {
    case "setTransform":
      return "transform";
    case "setBaseColor":
      return "baseColor";
    case "setMetallic":
      return "metallic";
    case "setRoughness":
      return "roughness";
    case "setLightColor":
      return "lightColor";
    case "setLightIntensity":
      return "lightIntensity";
    case "setLightDirection":
      return "lightDirection";
    case "setLightEnabled":
      return "lightEnabled";
    case "setLightCastsShadows":
      return "lightCastsShadows";
    case "setVisibility":
      return "visibility";
  }
}

function resultFor(envelope: SceneCommandEnvelope, applied: boolean, error: string | null = null): SceneCommandResult {
  return {
    sequence: envelope.sequence,
    nodeId: envelope.command.nodeId,
    property: commandProperty(envelope.command),
    applied,
    error,
  };
}

export function applyOptimisticToProjection(projection: SceneProjection, envelope: SceneCommandEnvelope): SceneProjection {
  if (envelope.epoch !== projection.epoch) return projection;
  if (envelope.command.type === "setVisibility") {
    const visibility = envelope.command;
    const node = projection.nodes.find((candidate) => candidate.id === visibility.nodeId);
    if (!node) return projection;
    return {
      ...projection,
      nodes: projection.nodes.map((candidate) =>
        candidate.id === visibility.nodeId
          ? { ...candidate, visible: visibility.visible }
          : candidate,
      ),
    };
  }
  const selected = projection.selected;
  if (envelope.command.type === "setTransform") {
    if (!selected || selected.id !== envelope.command.nodeId || !selected.transformEditable) return projection;
    return {
      ...projection,
      selected: { ...selected, transform: envelope.command.transform },
    };
  }
  if (isLightCommand(envelope.command)) {
    if (!selected || selected.id !== envelope.command.nodeId || !selected.light) return projection;
    return {
      ...projection,
      selected: {
        ...selected,
        light: applyFixtureLightCommand(selected.light, envelope.command),
      },
    };
  }
  if (!selected || selected.id !== envelope.command.nodeId || !selected.material) return projection;
  return {
    ...projection,
    selected: {
      ...selected,
      material: applyFixtureCommand(selected.material, envelope.command),
    },
  };
}

/** Apply command acknowledgements and retain only still-pending optimistic values. */
export function reconcileSceneProjection(
  projection: SceneProjection,
  pendingCommands: ReadonlyMap<string, SceneCommandEnvelope>,
): { projection: SceneProjection; pending: Map<string, SceneCommandEnvelope> } {
  const pending = new Map(pendingCommands);
  for (const [key, envelope] of pending) {
    if (envelope.epoch !== projection.epoch) pending.delete(key);
  }
  for (const result of projection.commandResults) {
    const key = `${result.nodeId}/${result.property}`;
    if (pending.get(key)?.sequence === result.sequence) pending.delete(key);
  }
  let next = projection;
  for (const envelope of pending.values()) next = applyOptimisticToProjection(next, envelope);
  return { projection: next, pending };
}

/** Rebuilds the optimistic view after a transport-level command rejection. */
export function rollbackRejectedCommand(
  canonical: SceneProjection,
  pendingCommands: ReadonlyMap<string, SceneCommandEnvelope>,
  rejected: SceneCommandEnvelope,
): { projection: SceneProjection; pending: Map<string, SceneCommandEnvelope> } {
  const pending = new Map(pendingCommands);
  const key = commandKey(rejected.command);
  if (pending.get(key)?.sequence === rejected.sequence) pending.delete(key);
  return reconcileSceneProjection(canonical, pending);
}

function applyFixtureCommand(material: SceneMaterial, command: SceneCommand): SceneMaterial {
  switch (command.type) {
    case "setTransform":
      return material;
    case "setBaseColor":
      return { ...material, color: command.color };
    case "setMetallic":
      return { ...material, metallic: command.value };
    case "setRoughness":
      return { ...material, roughness: command.value };
    case "setLightColor":
    case "setLightIntensity":
    case "setLightDirection":
    case "setLightEnabled":
    case "setLightCastsShadows":
    case "setVisibility":
      return material;
  }
}

function isLightCommand(command: SceneCommand): command is Extract<SceneCommand, { type: `setLight${string}` }> {
  return command.type.startsWith("setLight");
}

function applyFixtureLightCommand(light: SceneLight, command: SceneCommand): SceneLight {
  switch (command.type) {
    case "setLightColor":
      return { ...light, color: command.color };
    case "setLightIntensity":
      return { ...light, intensity: command.value };
    case "setLightDirection":
      return { ...light, direction: command.direction };
    case "setLightEnabled":
      return { ...light, enabled: command.enabled };
    case "setLightCastsShadows":
      return { ...light, castsShadows: command.castsShadows };
    default:
      return light;
  }
}

function fixtureDetails(nodeId: string): SceneProjection["selected"] {
  if (nodeId === "cube") return FIXTURE_PROJECTION.selected;
  if (nodeId === "key-light") {
    return {
      id: nodeId,
      transformEditable: false,
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      material: null,
      light: {
        lightType: "directional",
        direction: [-0.45, -1, -0.35],
        color: [1, 1, 1, 1],
        intensity: 3,
        radius: 0,
        enabled: true,
        castsShadows: true,
        attenuationRadius: null,
        innerConeAngle: null,
        outerConeAngle: null,
      },
    };
  }
  return {
    id: nodeId,
    transformEditable: false,
    transform: {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: null,
    light: null,
  };
}

export const sceneProjectionDataSource = new SceneProjectionDataSource();

// Vite HMR can recreate React modules without unloading the page.  Stop the
// timer owned by the old singleton so duplicate polling loops do not survive.
if (import.meta.hot) {
  import.meta.hot.dispose(() => sceneProjectionDataSource.dispose());
}

export function useSceneProjection(): SceneProjection {
  return useSyncExternalStore(
    sceneProjectionDataSource.subscribe,
    sceneProjectionDataSource.getSnapshot,
    sceneProjectionDataSource.getSnapshot,
  );
}

export function selectSceneNode(nodeId: string): void {
  void sceneProjectionDataSource.select(nodeId);
}

export function dispatchSceneCommand(command: SceneCommand): void {
  void sceneProjectionDataSource.dispatch(command);
}

export function undoSceneTransform(): void {
  void sceneProjectionDataSource.undoTransform();
}

export function redoSceneTransform(): void {
  void sceneProjectionDataSource.redoTransform();
}
