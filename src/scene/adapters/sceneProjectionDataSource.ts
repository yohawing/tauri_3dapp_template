import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SceneCommand, SceneMaterial, SceneProjection } from "../core/projection";

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
};

const POLL_INTERVAL_MS = 100;

// Tauri's invoke implementation is unavailable in a plain Vite browser. Do
// not start a rejected promise loop there; the deterministic fixture remains
// a useful standalone preview of both panels.
function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Listener = () => void;

class SceneProjectionDataSource {
  private snapshot: SceneProjection = FIXTURE_PROJECTION;
  private readonly listeners = new Set<Listener>();
  private pollId: number | undefined;
  private warned = false;

  constructor() {
    if (hasTauriRuntime()) {
      void this.poll();
      this.pollId = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
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
    }
  }

  getSnapshot = (): SceneProjection => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      if (selected === null) {
        return;
      }
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
    if (!hasTauriRuntime()) {
      const selected = this.snapshot.selected;
      const material = selected?.material;
      if (!selected || !material || selected.id !== command.nodeId) {
        return;
      }
      const nextMaterial = applyFixtureCommand(material, command);
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        selected: { ...selected, material: nextMaterial },
      };
      this.emit();
      return;
    }

    try {
      await invoke("dispatch_scene_command", { command });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[SceneProjection] dispatch_scene_command invoke failed:", error);
      }
    }
  }

  private async poll(): Promise<void> {
    try {
      const projection = await invoke<SceneProjection>("get_scene_projection");
      if (projection.revision !== this.snapshot.revision || projection.selectedNodeId !== this.snapshot.selectedNodeId) {
        this.snapshot = projection;
        this.emit();
      }
    } catch (error) {
      // A runtime can briefly be unavailable while the WebView is starting.
      // Keep the fixture visible and warn once instead of flooding the console.
      if (!this.warned) {
        this.warned = true;
        console.warn("[SceneProjection] get_scene_projection invoke failed; using fixture:", error);
      }
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

function applyFixtureCommand(material: SceneMaterial, command: SceneCommand): SceneMaterial {
  switch (command.type) {
    case "setBaseColor":
      return { ...material, color: command.color };
    case "setMetallic":
      return { ...material, metallic: command.value };
    case "setRoughness":
      return { ...material, roughness: command.value };
  }
}

function fixtureDetails(nodeId: string): SceneProjection["selected"] {
  if (nodeId === "cube") {
    return FIXTURE_PROJECTION.selected;
  }
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
