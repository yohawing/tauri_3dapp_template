import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  SceneCommand,
  SceneCommandEnvelope,
  SceneCommandResult,
  SceneMaterial,
  SceneCommandProperty,
  SceneProjection,
} from "../core/projection";

const FIXTURE_PROJECTION: SceneProjection = {
  revision: 1,
  selectedNodeId: "cube",
  nodes: [
    { id: "scene", parent: null, label: "Scene", kind: "scene", visible: true },
    { id: "key-light", parent: "scene", label: "Key Light", kind: "light", visible: true },
    { id: "cube", parent: "scene", label: "Cube", kind: "mesh", visible: true },
  ],
  selected: {
    id: "cube",
    transform: {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: { color: [1, 0.45, 0.1, 1], metallic: 0, roughness: 0.5 },
  },
  lastProcessedSequence: 0,
  commandResults: [],
};

const POLL_INTERVAL_MS = 100;

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Listener = () => void;

export class SceneProjectionDataSource {
  private snapshot: SceneProjection = FIXTURE_PROJECTION;
  private readonly listeners = new Set<Listener>();
  private pollId: number | undefined;
  private pollInFlight: Promise<void> | undefined;
  private nativeSnapshotAccepted = false;
  // Keep sequences monotonic across ordinary WebView reloads as well as
  // within one module instance. Date.now() leaves ample integer headroom.
  private nextSequence = Date.now() * 1000;
  private readonly pendingCommands = new Map<string, SceneCommandEnvelope>();
  private readonly commandFlights = new Map<string, { active: boolean; queued?: SceneCommandEnvelope }>();
  private warned = false;

  constructor() {
    if (hasTauriRuntime()) {
      if (import.meta.env.VITE_SCENE_SELF_TEST) {
        window.setTimeout(() => {
          console.log("[scene-self-test] select=key-light");
          void this.select("key-light");
        }, 2500);
      }
      if (import.meta.env.VITE_MATERIAL_SELF_TEST) {
        window.setTimeout(() => {
          console.log("[material-self-test] color=#2dc8ff metallic=0.8 roughness=0.2");
          void this.dispatch({ type: "setBaseColor", nodeId: "cube", color: [0.176, 0.784, 1, 1] });
          void this.dispatch({ type: "setMetallic", nodeId: "cube", value: 0.8 });
          void this.dispatch({ type: "setRoughness", nodeId: "cube", value: 0.2 });
        }, 2500);
      }
      if (import.meta.env.VITE_VISIBILITY_SELF_TEST) {
        this.scheduleVisibilitySelfTest();
      }
    }
  }

  private scheduleVisibilitySelfTest(): void {
    window.setTimeout(() => {
      console.log("[visibility-self-test] step=hide cube");
      void this.dispatch({ type: "setVisibility", nodeId: "cube", visible: false });
    }, 2500);
    window.setTimeout(() => {
      this.logVisibilitySelfTestResult("hide");
      console.log("[visibility-self-test] step=show cube");
      void this.dispatch({ type: "setVisibility", nodeId: "cube", visible: true });
    }, 4000);
    window.setTimeout(() => this.logVisibilitySelfTestResult("show"), 5500);
  }

  private logVisibilitySelfTestResult(step: string): void {
    const result = [...this.snapshot.commandResults]
      .reverse()
      .find((candidate) => candidate.nodeId === "cube" && candidate.property === "visibility");
    const visible = this.snapshot.nodes.find((node) => node.id === "cube")?.visible;
    const message =
      `[visibility-self-test] step=${step} sequence=${result?.sequence ?? "pending"} ` +
      `applied=${result?.applied ?? "pending"} visible=${visible ?? "missing"}`;
    console.log(message);
    window.dispatchEvent(
      new CustomEvent("tauri3d:diagnostic", {
        detail: { level: "info", source: "scene", message },
      }),
    );
    window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: true } }));
  }

  getSnapshot = (): SceneProjection => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && hasTauriRuntime()) {
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
    if (this.pollId !== undefined) {
      window.clearInterval(this.pollId);
      this.pollId = undefined;
    }
  }

  async select(nodeId: string): Promise<void> {
    if (!hasTauriRuntime()) {
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

    try {
      await invoke("select_scene_node", { nodeId });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[SceneProjection] select_scene_node invoke failed:", error);
      }
    }
  }

  async dispatch(command: SceneCommand): Promise<void> {
    const envelope: SceneCommandEnvelope = { sequence: ++this.nextSequence, command };
    if (!hasTauriRuntime()) {
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
    this.pendingCommands.set(key, envelope);
    this.applyOptimistic(envelope);

    const flight = this.commandFlights.get(key);
    if (flight?.active) {
      flight.queued = envelope;
      return;
    }
    this.commandFlights.set(key, { active: true });
    await this.sendCommand(key, envelope);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    const request = (async () => {
      try {
        const projection = await invoke<SceneProjection>("get_scene_projection");
        // The first native snapshot is authoritative even when its revision is
        // lower than the browser fixture.  Later rollbacks are rejected.
        if (shouldAcceptSceneProjection(this.nativeSnapshotAccepted, this.snapshot.revision, projection.revision)) {
          this.nativeSnapshotAccepted = true;
          this.applyProjection(projection);
        }
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          console.warn("[SceneProjection] get_scene_projection invoke failed; using fixture:", error);
        }
      }
    })();
    this.pollInFlight = request;
    try {
      await request;
    } finally {
      if (this.pollInFlight === request) this.pollInFlight = undefined;
    }
  }

  private async sendCommand(key: string, envelope: SceneCommandEnvelope): Promise<void> {
    try {
      await invoke("dispatch_scene_command", { command: envelope });
    } catch (error) {
      if (this.pendingCommands.get(key)?.sequence === envelope.sequence) {
        this.pendingCommands.delete(key);
        this.recordCommandResult(resultFor(envelope, false, String(error)));
      }
      if (!this.warned) {
        this.warned = true;
        console.warn("[SceneProjection] dispatch_scene_command invoke failed:", error);
      }
    } finally {
      const flight = this.commandFlights.get(key);
      if (flight?.queued) {
        const next = flight.queued;
        flight.queued = undefined;
        await this.sendCommand(key, next);
      } else {
        this.commandFlights.delete(key);
      }
    }
  }

  private applyProjection(projection: SceneProjection): void {
    const reconciled = reconcileSceneProjection(projection, this.pendingCommands);
    this.pendingCommands.clear();
    reconciled.pending.forEach((envelope, key) => this.pendingCommands.set(key, envelope));
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

  private recordCommandResult(result: SceneCommandResult): void {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      lastProcessedSequence: Math.max(this.snapshot.lastProcessedSequence, result.sequence),
      commandResults: [...this.snapshot.commandResults, result].slice(-32),
    };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export function shouldAcceptSceneProjection(
  nativeSnapshotAccepted: boolean,
  currentRevision: number,
  nextRevision: number,
): boolean {
  return !nativeSnapshotAccepted || nextRevision > currentRevision;
}

function commandKey(command: SceneCommand): string {
  return `${command.nodeId}/${commandProperty(command)}`;
}

function commandProperty(command: SceneCommand): SceneCommandProperty {
  switch (command.type) {
    case "setBaseColor":
      return "baseColor";
    case "setMetallic":
      return "metallic";
    case "setRoughness":
      return "roughness";
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
  for (const result of projection.commandResults) {
    const key = `${result.nodeId}/${result.property}`;
    if (pending.get(key)?.sequence === result.sequence) pending.delete(key);
  }
  let next = projection;
  for (const envelope of pending.values()) next = applyOptimisticToProjection(next, envelope);
  return { projection: next, pending };
}

function applyFixtureCommand(material: SceneMaterial, command: SceneCommand): SceneMaterial {
  switch (command.type) {
    case "setBaseColor":
      return { ...material, color: command.color };
    case "setMetallic":
      return { ...material, metallic: command.value };
    case "setRoughness":
      return { ...material, roughness: command.value };
    case "setVisibility":
      return material;
  }
}

function fixtureDetails(nodeId: string): SceneProjection["selected"] {
  if (nodeId === "cube") return FIXTURE_PROJECTION.selected;
  return {
    id: nodeId,
    transform: {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: null,
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
