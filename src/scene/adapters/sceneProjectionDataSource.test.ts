import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { SceneCommandEnvelope, SceneNodeSummary, SceneProjection } from "../core/projection";
import {
  MAX_PENDING_SCENE_COMMANDS,
  MAX_RUNTIME_PROJECTION_TEXT_BYTES,
  SceneProjectionDataSource,
  applyOptimisticToProjection,
  normalizeSceneProjection,
  reconcileSceneProjection,
  rollbackRejectedCommand,
  shouldAcceptSceneProjection,
  validNodeTree,
} from "./sceneProjectionDataSource";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

function projection(): SceneProjection {
  return {
    epoch: 1,
    revision: 4,
    selectedNodeId: "cube",
    nodes: [{ id: "cube", parent: null, label: "Cube", kind: "mesh", visible: true }],
    selected: {
      id: "cube",
      transformEditable: true,
      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      material: { color: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
      light: null,
    },
    lastProcessedSequence: 0,
    commandResults: [],
  };
}

function lightProjection(): SceneProjection {
  return {
    epoch: 1,
    revision: 4,
    selectedNodeId: "key-light",
    nodes: [{ id: "key-light", parent: null, label: "Key Light", kind: "light", visible: true }],
    selected: {
      id: "key-light",
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
    },
    lastProcessedSequence: 0,
    commandResults: [],
  };
}

describe("scene projection synchronization", () => {
  it("validates leaf-first and shared-parent trees without rescanning parent chains", () => {
    const chain = Array.from({ length: 513 }, (_, index): SceneNodeSummary => ({
      id: `chain-${index}`,
      parent: index === 0 ? null : `chain-${index - 1}`,
      label: `Chain ${index}`,
      kind: "mesh",
      visible: true,
    })).reverse();
    expect(validNodeTree(chain)).toBe(true);

    const shared: SceneNodeSummary[] = [
      { id: "root", parent: null, label: "Root", kind: "scene", visible: true },
      { id: "shared", parent: "root", label: "Shared", kind: "scene", visible: true },
      { id: "branch-a", parent: "shared", label: "A", kind: "mesh", visible: true },
      { id: "branch-b", parent: "shared", label: "B", kind: "mesh", visible: true },
    ];
    expect(validNodeTree(shared)).toBe(true);
  });

  it("accepts the native projection shape and rejects unsafe nested values", () => {
    expect(normalizeSceneProjection(projection())).toEqual(projection());
    expect(normalizeSceneProjection(lightProjection())).toEqual(lightProjection());
    expect(normalizeSceneProjection({
      ...lightProjection(),
      selected: {
        ...lightProjection().selected!,
        light: { ...lightProjection().selected!.light!, direction: [0, 0, 0] },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...lightProjection(),
      selected: {
        ...lightProjection().selected!,
        light: { ...lightProjection().selected!.light!, intensity: 1_000 },
      },
    })).not.toBeNull();
    expect(normalizeSceneProjection({
      ...lightProjection(),
      selected: {
        ...lightProjection().selected!,
        light: { ...lightProjection().selected!.light!, intensity: 1_000.01 },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({ ...projection(), epoch: 0, revision: 99 })).toBeNull();
    expect(normalizeSceneProjection({ ...projection(), epoch: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      selectedNodeId: " \t",
      nodes: [{ ...projection().nodes[0], id: " \t" }],
      selected: { ...projection().selected!, id: " \t" },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      selected: {
        ...projection().selected!,
        transform: { ...projection().selected!.transform, scale: [1, Number.NaN, 1] },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      selected: {
        ...projection().selected!,
        transform: { ...projection().selected!.transform, rotation: [1e-10, 0, 0, 0] },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      selected: {
        ...projection().selected!,
        transform: { ...projection().selected!.transform, translation: [Number.MAX_VALUE, 0, 0] },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      selected: {
        ...projection().selected!,
        material: { ...projection().selected!.material!, metallic: Number.POSITIVE_INFINITY },
      },
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      commandResults: [{
        sequence: 1,
        nodeId: "cube",
        property: "metallic",
        applied: false,
        error: "rejected",
      }],
    })).toMatchObject({ commandResults: [{ sequence: 1, applied: false }] });
    expect(normalizeSceneProjection({
      ...projection(),
      commandResults: [
        { sequence: 2, nodeId: "cube", property: "metallic", applied: true, error: null },
        { sequence: 1, nodeId: "cube", property: "metallic", applied: false, error: "stale" },
      ],
    })).toMatchObject({ commandResults: [{ sequence: 2 }, { sequence: 1 }] });
    expect(normalizeSceneProjection({
      ...projection(),
      commandResults: [{ sequence: Number.NaN, nodeId: "cube", property: "metallic", applied: true, error: null }],
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      commandResults: [{ sequence: 1, nodeId: "cube", property: "metallic", applied: false, error: "x".repeat(4_096) }],
    })).not.toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      commandResults: [{ sequence: 1, nodeId: "cube", property: "metallic", applied: false, error: "x".repeat(4_097) }],
    })).toBeNull();
  });

  it("accepts generated runtime bone IDs beyond the persisted ID cap", () => {
    const generatedBoneId = "i".repeat(2_048);
    const generatedBoneProjection = {
      ...projection(),
      selectedNodeId: null,
      selected: null,
      nodes: [
        { id: "scene", parent: null, label: "Scene", kind: "scene" as const, visible: true },
        { id: generatedBoneId, parent: "scene", label: "Bone", kind: "bone" as const, visible: true },
      ],
    };
    expect(normalizeSceneProjection(generatedBoneProjection)).not.toBeNull();
    expect(normalizeSceneProjection({
      ...generatedBoneProjection,
      nodes: [{ ...generatedBoneProjection.nodes[1], id: `${generatedBoneId}x` }, generatedBoneProjection.nodes[0]],
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...generatedBoneProjection,
      nodes: [{ ...generatedBoneProjection.nodes[1], label: "b".repeat(1_025) }, generatedBoneProjection.nodes[0]],
    })).toBeNull();
  });

  it("fails closed when aggregate projection text exceeds the runtime budget", () => {
    const nodeCount = 33_000;
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${index}-${"x".repeat(2_038)}`,
      parent: null,
      label: "Node",
      kind: "mesh" as const,
      visible: true,
    }));
    expect(nodes.length).toBeLessThan(262_144);
    expect(nodeCount * 2_048).toBeGreaterThan(MAX_RUNTIME_PROJECTION_TEXT_BYTES);
    expect(normalizeSceneProjection({
      ...projection(),
      selectedNodeId: null,
      selected: null,
      nodes,
    })).toBeNull();
  });

  it("rejects malformed scene trees and selected payloads", () => {
    expect(normalizeSceneProjection({ ...projection(), nodes: [{ ...projection().nodes[0], parent: "missing" }] })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      nodes: [
        { id: "a", parent: "b", label: "A", kind: "mesh", visible: true },
        { id: "b", parent: "a", label: "B", kind: "mesh", visible: true },
      ],
      selectedNodeId: null,
      selected: null,
    })).toBeNull();
    const deepNodes = Array.from({ length: 514 }, (_, index) => ({
      id: `node-${index}`,
      parent: index === 0 ? null : `node-${index - 1}`,
      label: `Node ${index}`,
      kind: "mesh" as const,
      visible: true,
    }));
    expect(normalizeSceneProjection({
      ...projection(),
      nodes: deepNodes,
      selectedNodeId: null,
      selected: null,
    })).toBeNull();
    expect(normalizeSceneProjection({
      ...projection(),
      nodes: deepNodes.slice(0, 513),
      selectedNodeId: null,
      selected: null,
    })).not.toBeNull();
    expect(normalizeSceneProjection({ ...projection(), selectedNodeId: null })).toBeNull();
    expect(normalizeSceneProjection({ ...projection(), selected: null })).toBeNull();
  });

  it("keeps the previous snapshot when Native returns a malformed payload", async () => {
    const eventTarget = new EventTarget();
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    const diagnostics: CustomEvent[] = [];
    const onDiagnostic = (event: Event) => diagnostics.push(event as CustomEvent);
    windowStub.addEventListener("tauri3d:diagnostic", onDiagnostic);
    invokeMock.mockResolvedValueOnce({ invalid: true } as never);

    try {
      const source = new SceneProjectionDataSource(true);
      const before = source.getSnapshot();
      const unsubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(source.getSnapshot()).toBe(before);
      expect(diagnostics[0]?.detail).toMatchObject({
        level: "error",
        source: "scene",
        message: expect.stringContaining("invalid projection payload"),
      });
      unsubscribe();
    } finally {
      windowStub.removeEventListener("tauri3d:diagnostic", onDiagnostic);
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("keeps the browser fixture when Tauri is unavailable", () => {
    const source = new SceneProjectionDataSource(false);

    expect(source.getSnapshot().nodes.map((node) => node.id)).toEqual(["scene", "key-light", "cube"]);
    expect(source.getSnapshot().selected?.id).toBe("cube");
  });

  it("continues notifying subscribers when one subscriber throws", async () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setInterval: vi.fn(() => 1), clearInterval: vi.fn() },
    });
    const source = new SceneProjectionDataSource(true);
    invokeMock.mockResolvedValueOnce({ ...projection(), revision: 2 } as never);
    const first = vi.fn(() => { throw new Error("subscriber failed"); });
    const second = vi.fn();
    try {
      const stopFirst = source.subscribe(first);
      const stopSecond = source.subscribe(second);
      await Promise.resolve();
      await Promise.resolve();
      expect(first).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      stopFirst();
      stopSecond();
    } finally {
      source.dispose();
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("starts Tauri runtime with an empty projection instead of the browser fixture", () => {
    const source = new SceneProjectionDataSource(true);

    expect(source.getSnapshot()).toMatchObject({
      epoch: 1,
      revision: 0,
      selectedNodeId: null,
      nodes: [],
      selected: null,
    });
  });

  it("cancels runtime self-test timers when the data source is disposed", () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SCENE_SELF_TEST", "1");
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });

    try {
      const source = new SceneProjectionDataSource(true);
      expect(vi.getTimerCount()).toBe(1);
      source.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(3000);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("keeps the runtime empty and emits a console diagnostic when the initial poll fails", async () => {
    const error = new Error("native unavailable");
    invokeMock.mockRejectedValueOnce(error);
    const eventTarget = new EventTarget();
    const interval = vi.fn(() => 1);
    const clearInterval = vi.fn();
    const windowStub = Object.assign(eventTarget, { setInterval: interval, clearInterval }) as unknown as Window;
    const hadWindow = "window" in globalThis;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    const diagnostics: CustomEvent[] = [];
    const onDiagnostic = (event: Event) => diagnostics.push(event as CustomEvent);
    windowStub.addEventListener("tauri3d:diagnostic", onDiagnostic);

    try {
      const source = new SceneProjectionDataSource(true);
      const unsubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();

      expect(source.getSnapshot().nodes).toEqual([]);
      expect(source.getSnapshot().selected).toBeNull();
      expect(diagnostics[0]?.detail).toMatchObject({
        level: "error",
        source: "scene",
        message: expect.stringContaining("runtime projection unavailable"),
      });
      expect(interval).toHaveBeenCalledTimes(1);
      unsubscribe();
      source.dispose();
    } finally {
      windowStub.removeEventListener("tauri3d:diagnostic", onDiagnostic);
      if (hadWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("fences a disposed poll and starts a fresh request after resubscribe", async () => {
    let resolveFirst!: (value: SceneProjection) => void;
    const first = new Promise<SceneProjection>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    invokeMock.mockImplementation((command) => {
      if (command !== "get_scene_projection") return Promise.resolve(undefined) as never;
      calls += 1;
      return (calls === 1 ? first : Promise.resolve(projection())) as never;
    });
    const eventTarget = new EventTarget();
    const interval = vi.fn(() => 1);
    const clearInterval = vi.fn();
    const windowStub = Object.assign(eventTarget, { setInterval: interval, clearInterval }) as unknown as Window;
    const hadWindow = "window" in globalThis;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });

    try {
      const source = new SceneProjectionDataSource(true);
      const listener = vi.fn();
      const unsubscribe = source.subscribe(listener);
      await Promise.resolve();
      unsubscribe();
      resolveFirst(projection());
      await Promise.resolve();
      await Promise.resolve();

      expect(listener).not.toHaveBeenCalled();

      const resubscribe = source.subscribe(listener);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(listener).toHaveBeenCalledTimes(1);
      resubscribe();
    } finally {
      if (hadWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("drops a disposed command before a late rejection can overlay a fresh projection", async () => {
    let rejectCommand!: (error: Error) => void;
    let projectionCalls = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "get_scene_projection") {
        projectionCalls += 1;
        return Promise.resolve({ ...projection(), revision: projectionCalls === 1 ? 4 : 5 }) as never;
      }
      if (command === "dispatch_scene_command") {
        return new Promise<never>((_resolve, reject) => {
          rejectCommand = reject;
        }) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    const eventTarget = new EventTarget();
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });

    try {
      const source = new SceneProjectionDataSource(true);
      const unsubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      const command = source.dispatch({ type: "setVisibility", nodeId: "cube", visible: false });
      await Promise.resolve();
      expect(source.getSnapshot().nodes.find((node) => node.id === "cube")?.visible).toBe(false);

      unsubscribe();
      await command;
      const resubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(source.getSnapshot().nodes.find((node) => node.id === "cube")?.visible).toBe(true);

      rejectCommand(new Error("late command rejection"));
      await Promise.resolve();
      expect(source.getSnapshot().nodes.find((node) => node.id === "cube")?.visible).toBe(true);
      resubscribe();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("does not let a select failure suppress the first poll diagnostic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const eventTarget = new EventTarget();
    let pollTick: (() => void) | undefined;
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn((callback: () => void) => {
        pollTick = callback;
        return 1;
      }),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    invokeMock
      .mockRejectedValueOnce(new Error("select unavailable"))
      .mockRejectedValueOnce(new Error("poll unavailable"));

    try {
      const source = new SceneProjectionDataSource(true);
      await source.select("cube");
      const unsubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(pollTick).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(2);
      unsubscribe();
    } finally {
      warn.mockRestore();
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("surfaces a rejected selection once and suppresses duplicate diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const eventTarget = new EventTarget();
    const diagnostics: CustomEvent[] = [];
    const toggles: CustomEvent[] = [];
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const onDiagnostic = (event: Event) => diagnostics.push(event as CustomEvent);
    const onToggle = (event: Event) => toggles.push(event as CustomEvent);
    windowStub.addEventListener("tauri3d:diagnostic", onDiagnostic);
    windowStub.addEventListener("tauri3d:console-toggle", onToggle);
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    invokeMock.mockRejectedValue(new Error("selection unavailable"));
    let source: SceneProjectionDataSource | undefined;

    try {
      source = new SceneProjectionDataSource(true);
      await source.select("cube");
      await source.select("cube");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.detail).toMatchObject({
        level: "error",
        source: "scene",
      });
      expect(diagnostics[0]?.detail.message).toContain("selection unavailable");
      expect(toggles).toHaveLength(1);
      expect(toggles[0]?.detail).toEqual({ open: true });
    } finally {
      source?.dispose();
      windowStub.removeEventListener("tauri3d:diagnostic", onDiagnostic);
      windowStub.removeEventListener("tauri3d:console-toggle", onToggle);
      warn.mockRestore();
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("suppresses a late selection rejection after disposal", async () => {
    let rejectSelection!: (error: Error) => void;
    invokeMock.mockImplementation((command) => {
      if (command === "select_scene_node") {
        return new Promise<never>((_resolve, reject) => {
          rejectSelection = reject;
        }) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    const eventTarget = new EventTarget();
    const diagnostics: CustomEvent[] = [];
    const toggles: CustomEvent[] = [];
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const onDiagnostic = (event: Event) => diagnostics.push(event as CustomEvent);
    const onToggle = (event: Event) => toggles.push(event as CustomEvent);
    windowStub.addEventListener("tauri3d:diagnostic", onDiagnostic);
    windowStub.addEventListener("tauri3d:console-toggle", onToggle);
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    const source = new SceneProjectionDataSource(true);
    try {
      const selection = source.select("cube");
      await Promise.resolve();
      source.dispose();
      rejectSelection(new Error("late selection rejection"));
      await selection;
      expect(diagnostics).toHaveLength(0);
      expect(toggles).toHaveLength(0);
    } finally {
      windowStub.removeEventListener("tauri3d:diagnostic", onDiagnostic);
      windowStub.removeEventListener("tauri3d:console-toggle", onToggle);
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("re-enables dispatch diagnostics after a successful command", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock
      .mockRejectedValueOnce(new Error("first dispatch unavailable"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second dispatch unavailable"));

    try {
      const source = new SceneProjectionDataSource(true);
      const command = { type: "setVisibility" as const, nodeId: "cube", visible: false };
      await source.dispatch(command);
      await source.dispatch(command);
      await source.dispatch(command);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds distinct optimistic command keys to the Native queue capacity", async () => {
    invokeMock.mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const source = new SceneProjectionDataSource(true);
      await Promise.all(
        Array.from({ length: MAX_PENDING_SCENE_COMMANDS + 1 }, (_, index) =>
          source.dispatch({ type: "setVisibility", nodeId: `node-${index}`, visible: false }),
        ),
      );

      expect(invokeMock).toHaveBeenCalledTimes(MAX_PENDING_SCENE_COMMANDS);
      expect(warn).toHaveBeenCalledWith(
        `[SceneProjection] scene command capacity is full (${MAX_PENDING_SCENE_COMMANDS}); command was dropped`,
      );
      source.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("allows a coalesced update for a tracked key at capacity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    invokeMock.mockImplementation(() => gate as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const source = new SceneProjectionDataSource(true);
      const active = Array.from({ length: MAX_PENDING_SCENE_COMMANDS }, (_, index) =>
        source.dispatch({ type: "setVisibility", nodeId: `node-${index}`, visible: false }),
      );
      await Promise.resolve();
      expect(invokeMock).toHaveBeenCalledTimes(MAX_PENDING_SCENE_COMMANDS);

      await source.dispatch({ type: "setVisibility", nodeId: "node-0", visible: true });
      expect(warn).not.toHaveBeenCalledWith(
        `[SceneProjection] scene command capacity is full (${MAX_PENDING_SCENE_COMMANDS}); command was dropped`,
      );
      release();
      await Promise.all(active);
      source.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("releases a command key after a Native poll acknowledgement", async () => {
    let dispatchedSequence = 0;
    invokeMock.mockImplementation((command, args) => {
      if (command === "dispatch_scene_command") {
        dispatchedSequence = (args as { command: SceneCommandEnvelope }).command.sequence;
        return Promise.resolve(undefined) as never;
      }
      if (command === "get_scene_projection") {
        return Promise.resolve({
          ...projection(),
          revision: 5,
          lastProcessedSequence: dispatchedSequence,
          commandResults: dispatchedSequence
            ? [{ sequence: dispatchedSequence, nodeId: "cube", property: "visibility", applied: true, error: null }]
            : [],
        }) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    const eventTarget = new EventTarget();
    const windowStub = Object.assign(eventTarget, {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    }) as unknown as Window;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    try {
      const source = new SceneProjectionDataSource(true);
      await source.dispatch({ type: "setVisibility", nodeId: "cube", visible: false });
      const unsubscribe = source.subscribe(() => undefined);
      await Promise.resolve();
      await Promise.resolve();

      const before = invokeMock.mock.calls.filter(([command]) => command === "dispatch_scene_command").length;
      await Promise.all(
        Array.from({ length: MAX_PENDING_SCENE_COMMANDS }, (_, index) =>
          source.dispatch({ type: "setVisibility", nodeId: `node-${index}`, visible: false }),
        ),
      );
      const after = invokeMock.mock.calls.filter(([command]) => command === "dispatch_scene_command").length;
      expect(before).toBe(1);
      expect(after - before).toBe(MAX_PENDING_SCENE_COMMANDS);
      unsubscribe();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("accepts the first native snapshot but rejects later revision rollback", () => {
    expect(shouldAcceptSceneProjection(false, 10, 0)).toBe(true);
    expect(shouldAcceptSceneProjection(true, 10, 9)).toBe(false);
    expect(shouldAcceptSceneProjection(true, 10, 10)).toBe(false);
    expect(shouldAcceptSceneProjection(true, 10, 11)).toBe(true);
    expect(shouldAcceptSceneProjection(true, 10, 0, 1, 2)).toBe(true);
    expect(shouldAcceptSceneProjection(true, 10, 99, 2, 1)).toBe(false);
  });

  it("drops pending optimistic values from a replaced Scene even when node ids repeat", () => {
    const oldCommand: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 21,
      command: {
        type: "setTransform",
        nodeId: "cube",
        transform: {
          translation: [9, 8, 7],
          rotation: [0, 0, 0, 1],
          scale: [2, 2, 2],
        },
      },
    };
    const replacement = { ...projection(), epoch: 2 };
    const reconciled = reconcileSceneProjection(
      replacement,
      new Map([["cube/transform", oldCommand]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.selected?.transform.translation).toEqual([0, 0, 0]);
  });

  it("keeps optimistic values until ack and rolls back rejected commands", () => {
    const command: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 7,
      command: { type: "setMetallic", nodeId: "cube", value: 0.9 },
    };
    const optimistic = applyOptimisticToProjection(projection(), command);
    expect(optimistic.selected?.material?.metallic).toBe(0.9);

    const rejected = projection();
    rejected.commandResults = [
      {
        sequence: 7,
        nodeId: "cube",
        property: "metallic",
        applied: false,
        error: "unsupported scene node",
      },
    ];
    const reconciled = reconcileSceneProjection(
      rejected,
      new Map([["cube/metallic", command]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.selected?.material?.metallic).toBe(0);
  });

  it("rolls a rejected command back to canonical while retaining other pending edits", () => {
    const rejected: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 17,
      command: { type: "setMetallic", nodeId: "cube", value: 0.9 },
    };
    const pendingTransform: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 18,
      command: {
        type: "setTransform",
        nodeId: "cube",
        transform: {
          translation: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [2, 2, 2],
        },
      },
    };
    const rollback = rollbackRejectedCommand(
      projection(),
      new Map([
        ["cube/metallic", rejected],
        ["cube/transform", pendingTransform],
      ]),
      rejected,
    );

    expect(rollback.projection.selected?.material?.metallic).toBe(0);
    expect(rollback.projection.selected?.transform.translation).toEqual([1, 2, 3]);
    expect(rollback.pending.has("cube/metallic")).toBe(false);
    expect(rollback.pending.has("cube/transform")).toBe(true);
  });

  it("retains a newer optimistic value when an older result arrives", () => {
    const older: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 7,
      command: { type: "setRoughness", nodeId: "cube", value: 0.1 },
    };
    const newer: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 8,
      command: { type: "setRoughness", nodeId: "cube", value: 0.8 },
    };
    const next = projection();
    next.commandResults = [
      { sequence: 7, nodeId: "cube", property: "roughness", applied: true, error: null },
    ];
    const reconciled = reconcileSceneProjection(next, new Map([["cube/roughness", newer]]));
    expect(reconciled.pending.size).toBe(1);
    expect(reconciled.projection.selected?.material?.roughness).toBe(0.8);
    expect(older.sequence).toBeLessThan(newer.sequence);
  });

  it("does not roll back a newer optimistic value on an older rejection", () => {
    const newer: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 8,
      command: { type: "setRoughness", nodeId: "cube", value: 0.8 },
    };
    const next = projection();
    next.commandResults = [
      { sequence: 7, nodeId: "cube", property: "roughness", applied: false, error: "old rejection" },
    ];
    const reconciled = reconcileSceneProjection(next, new Map([["cube/roughness", newer]]));
    expect(reconciled.pending.get("cube/roughness")?.sequence).toBe(8);
    expect(reconciled.projection.selected?.material?.roughness).toBe(0.8);
  });

  it("optimistically toggles canonical node visibility and rolls back on reject", () => {
    const command: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 11,
      command: { type: "setVisibility", nodeId: "cube", visible: false },
    };
    const optimistic = applyOptimisticToProjection(projection(), command);
    expect(optimistic.nodes.find((node) => node.id === "cube")?.visible).toBe(false);

    const rejected = projection();
    rejected.commandResults = [
      {
        sequence: 11,
        nodeId: "cube",
        property: "visibility",
        applied: false,
        error: "unsupported scene node",
      },
    ];
    const reconciled = reconcileSceneProjection(
      rejected,
      new Map([["cube/visibility", command]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.nodes.find((node) => node.id === "cube")?.visible).toBe(true);
  });

  it("optimistically edits a selected object transform and rolls back on reject", () => {
    const command: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 13,
      command: {
        type: "setTransform",
        nodeId: "cube",
        transform: {
          translation: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [2, 2, 2],
        },
      },
    };
    const optimistic = applyOptimisticToProjection(projection(), command);
    expect(optimistic.selected?.transform.translation).toEqual([1, 2, 3]);

    const rejected = projection();
    rejected.commandResults = [
      { sequence: 13, nodeId: "cube", property: "transform", applied: false, error: "rejected" },
    ];
    const reconciled = reconcileSceneProjection(
      rejected,
      new Map([["cube/transform", command]]),
    );
    expect(reconciled.pending.size).toBe(0);
    expect(reconciled.projection.selected?.transform.translation).toEqual([0, 0, 0]);
  });

  it("optimistically edits the directional KeyLight payload", () => {
    const command: SceneCommandEnvelope = {
      epoch: 1,
      sequence: 12,
      command: { type: "setLightIntensity", nodeId: "key-light", value: 6.5 },
    };
    const next = applyOptimisticToProjection(lightProjection(), command);
    expect(next.selected?.light?.intensity).toBe(6.5);
  });
});
