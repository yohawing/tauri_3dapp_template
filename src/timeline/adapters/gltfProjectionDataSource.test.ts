import { describe, expect, it, vi } from "vitest";
import {
  createGltfTimelineDataSource,
  createRuntimeTimelineDataSource,
  createTimelineDataSource,
  normalizeGltfTimelineProjection,
  type GltfTimelineProjection,
  type TimelineRuntimeDependencies,
} from "./gltfProjectionDataSource";
import { fixtureTimelineDataSource } from "./fixtureDataSource";

const projection: GltfTimelineProjection = {
  revision: 7,
  clips: [
    {
      instanceId: "brainstem",
      clipIndex: 0,
      label: "Animation 1",
      duration: 2,
      channels: [
        {
          id: "c0",
          nodeIndex: 1,
          nodeLabel: "Node 2",
          property: "translation",
          interpolation: "linear",
          keyTimes: [0, 0.01, 0.02, 1, 2],
        },
      ],
    },
  ],
};

describe("glTF Timeline projection adapter", () => {
  it("validates the Native timeline budget and channel wire shape", () => {
    expect(normalizeGltfTimelineProjection(projection)).toEqual(projection);
    expect(normalizeGltfTimelineProjection({ ...projection, revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], duration: Number.NaN }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], duration: Number.MAX_VALUE }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], duration: 86_400 }],
    })).not.toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], duration: 86_400.001 }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{
        ...projection.clips[0],
        label: "x".repeat(4096),
        channels: [{ ...projection.clips[0].channels[0], nodeLabel: "x".repeat(4096), id: "x".repeat(4096) }],
      }],
    })).not.toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], label: "x".repeat(4097) }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{ ...projection.clips[0], instanceId: "x".repeat(1025) }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{
        ...projection.clips[0],
        channels: [{ ...projection.clips[0].channels[0], keyTimes: [0.5, 0.25] }],
      }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{
        ...projection.clips[0],
        channels: [{ ...projection.clips[0].channels[0], keyTimes: [0, Number.MAX_VALUE] }],
      }],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{
        ...projection.clips[0],
        channels: [{ ...projection.clips[0].channels[0], property: "unknown" }],
      }],
    })).toBeNull();
  });

  it("rejects duplicate clip/channel ids and conflicting node labels", () => {
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [projection.clips[0], projection.clips[0]],
    })).toBeNull();
    expect(normalizeGltfTimelineProjection({
      ...projection,
      clips: [{
        ...projection.clips[0],
        channels: [
          projection.clips[0].channels[0],
          { ...projection.clips[0].channels[0], id: "c1", nodeLabel: "Other" },
        ],
      }],
    })).toBeNull();
  });

  it("keeps compact key arrays and groups same-pixel keys", () => {
    const source = createGltfTimelineDataSource(projection);
    const rows = source.getRows({ start: 0, count: 100 });
    const channelRow = rows.find((row) => row.kind === "channel")!;
    const columns = source.getKeyColumns!(
      { rowIds: [channelRow.id], range: { start: 0, end: 2 } },
      10,
    );
    expect(columns.map((column) => [column.time, column.count])).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(source.getKeys({ rowIds: [channelRow.id], range: { start: 0, end: 2 } })).toEqual([]);
  });

  it("uses half-open visible ranges and exposes the clip duration", () => {
    const source = createGltfTimelineDataSource(projection);
    const channelRow = source.getRows({ start: 0, count: 100 }).find((row) => row.kind === "channel")!;
    expect(source.getRange()).toEqual({ start: 0, end: 2 });
    expect(
      source.getKeyColumns!({ rowIds: [channelRow.id], range: { start: 1, end: 2 } }, 100),
    ).toHaveLength(1);
  });

  it("resolves one playback target for clip, node, and channel rows", () => {
    const source = createGltfTimelineDataSource(projection);
    const rows = source.getRows({ start: 0, count: 100 });
    const target = { instanceId: "brainstem", clipIndex: 0 };

    expect(source.getPlaybackTarget?.(rows[0].id)).toEqual(target);
    expect(source.getPlaybackTarget?.(rows.find((row) => row.kind === "group" && row.depth === 0)!.id)).toEqual(target);
    expect(source.getPlaybackTarget?.(rows.find((row) => row.kind === "channel")!.id)).toEqual(target);
    expect(source.getPlaybackTarget?.("missing-row" as typeof rows[number]["id"])).toBeNull();
  });

  it("keeps playback targets distinct across instances and clips", () => {
    const source = createGltfTimelineDataSource({
      revision: 9,
      clips: [
        projection.clips[0],
        {
          ...projection.clips[0],
          instanceId: "second-instance",
          clipIndex: 4,
          channels: projection.clips[0].channels.map((channel) => ({
            ...channel,
            id: "second-channel",
          })),
        },
      ],
    });
    const secondClipRow = source
      .getRows({ start: 0, count: 100 })
      .find((row) => row.id === "clip-row:second-instance:4");

    expect(secondClipRow).toBeDefined();
    expect(source.getPlaybackTarget?.(secondClipRow!.id)).toEqual({
      instanceId: "second-instance",
      clipIndex: 4,
    });
  });

  it("retrieves rows beyond the old 10k viewport materialization limit", () => {
    const largeProjection: GltfTimelineProjection = {
      revision: 8,
      clips: [{
        ...projection.clips[0],
        channels: Array.from({ length: 5_001 }, (_, index) => ({
          id: `large-${index}`,
          nodeIndex: index,
          nodeLabel: `Node ${index}`,
          property: "translation" as const,
          interpolation: "linear" as const,
          keyTimes: [],
        })),
      }],
    };
    const source = createGltfTimelineDataSource(largeProjection);

    expect(source.getRowCount()).toBeGreaterThan(10_000);
    expect(source.getRows({ start: 10_000, count: 1 })).toHaveLength(1);
  });

  it("keeps the browser fixture but starts a Tauri source empty", async () => {
    const invoke = vi.fn(async () => ({ revision: 1, clips: [] }));
    const dependencies = runtimeDependencies(invoke);

    expect(createTimelineDataSource({ hasTauriRuntime: () => false })).toBe(fixtureTimelineDataSource);
    const source = createTimelineDataSource(dependencies);
    await settle();

    expect(invoke).toHaveBeenCalledWith("get_timeline_projection");
    expect(source.getGroups()).toEqual([]);
    expect(source.getRows({ start: 0, count: 100 })).toEqual([]);
  });

  it("labels default runtime diagnostics as timeline events", async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const windowTarget = new EventTarget() as unknown as Window;
    const diagnostics: unknown[] = [];
    windowTarget.addEventListener("tauri3d:diagnostic", (event) => {
      diagnostics.push((event as CustomEvent<unknown>).detail);
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });

    try {
      const source = createTimelineDataSource({
        hasTauriRuntime: () => true,
        invoke: async () => { throw new Error("timeline unavailable"); },
      });
      await settle();
      if ("dispose" in source && typeof source.dispose === "function") source.dispose();

      expect(diagnostics).toEqual([
        {
          level: "warn",
          source: "timeline",
          message: "Runtime timeline projection unavailable: Error: timeline unavailable",
        },
      ]);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, "window", previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("continues notifying subscribers when one subscriber throws", async () => {
    const invoke = vi.fn(async () => ({ revision: 1, clips: [clipProjection()] }));
    const source = createRuntimeTimelineDataSourceForTest(runtimeDependencies(invoke));
    const first = vi.fn(() => { throw new Error("subscriber failed"); });
    const second = vi.fn();
    const stopFirst = source.subscribe(first);
    const stopSecond = source.subscribe(second);
    await settle();
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    stopFirst();
    stopSecond();
    source.dispose();
  });

  it("does not report a success diagnostic after a subscriber disposes the source", async () => {
    const diagnostics: Array<{ level: string; message: string }> = [];
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(vi.fn(async () => ({ revision: 1, clips: [clipProjection()] }))),
      reportDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    source.subscribe(() => source.dispose());

    await settle();

    expect(source.getGroups()).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it("keeps the Tauri source empty after IPC failure and reports once", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("projection unavailable");
    });
    const warnings: unknown[] = [];
    const diagnostics: Array<{ level: string; message: string }> = [];
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke),
      warn: (error) => warnings.push(error),
      reportDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    await settle();
    source.dispose();

    expect(source.getGroups()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(diagnostics).toEqual([
      { level: "warn", message: "Runtime timeline projection unavailable: Error: projection unavailable" },
    ]);
  });

  it("reports a later failure after a successful reload", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockResolvedValueOnce({ revision: 2, clips: [clipProjection()] })
      .mockRejectedValueOnce(new Error("reload failure"));
    const warnings: unknown[] = [];
    const diagnostics: Array<{ level: string; message: string }> = [];
    let sceneChanged: (() => void) | undefined;
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke),
      onSceneFileChanged: (listener) => {
        sceneChanged = listener;
        return () => undefined;
      },
      warn: (error) => warnings.push(error),
      reportDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });

    await settle();
    expect(warnings).toHaveLength(1);
    sceneChanged?.();
    await settle();
    expect(source.getGroups()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    sceneChanged?.();
    await settle();
    expect(warnings).toHaveLength(2);
    expect(diagnostics.at(-1)).toEqual({
      level: "warn",
      message: "Runtime timeline projection unavailable: Error: reload failure",
    });
    source.dispose();
  });

  it("keeps the previous runtime projection after malformed IPC payload", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ revision: 1, clips: [clipProjection()] })
      .mockResolvedValueOnce({ revision: 2, clips: [{ duration: Number.POSITIVE_INFINITY }] });
    const warnings: unknown[] = [];
    const diagnostics: Array<{ level: string; message: string }> = [];
    let sceneChanged: (() => void) | undefined;
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke),
      onSceneFileChanged: (listener) => {
        sceneChanged = listener;
        return () => undefined;
      },
      warn: (error) => warnings.push(error),
      reportDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    await settle();
    const before = source.getGroups();
    expect(before).toHaveLength(1);
    sceneChanged?.();
    await settle();
    expect(source.getGroups()).toEqual(before);
    expect(warnings).toHaveLength(1);
    expect(diagnostics.at(-1)).toEqual({
      level: "warn",
      message: "Runtime timeline projection unavailable: Error: malformed timeline projection payload",
    });
    source.dispose();
  });

  it("accepts an empty projection after Scene replacement", async () => {
    let projection = { revision: 2, clips: [clipProjection()] };
    let sceneChanged: (() => void) | undefined;
    const invoke = vi.fn(async () => projection);
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke),
      onSceneFileChanged: (listener) => {
        sceneChanged = listener;
        return () => undefined;
      },
    });
    await settle();
    expect(source.getGroups().length).toBeGreaterThan(0);

    projection = { revision: 3, clips: [] };
    sceneChanged?.();
    await settle();
    expect(source.getGroups()).toEqual([]);
    expect(source.getRows({ start: 0, count: 100 })).toEqual([]);
  });

  it("coalesces rapid Scene replacement reloads behind one in-flight request", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const invoke = vi.fn(() => new Promise<unknown>((resolve) => pending.push(resolve)));
    let sceneChanged: (() => void) | undefined;
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke as unknown as (command: string) => Promise<GltfTimelineProjection>),
      onSceneFileChanged: (listener) => {
        sceneChanged = listener;
        return () => undefined;
      },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    sceneChanged?.();
    sceneChanged?.();
    expect(invoke).toHaveBeenCalledTimes(1);

    pending.shift()?.({ revision: 2, clips: [clipProjection()] });
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);

    pending.shift()?.({ revision: 3, clips: [] });
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(source.getGroups()).toEqual([]);
    source.dispose();
  });

  it("retries one coalesced reload after the active request rejects", async () => {
    const pending: Array<{
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }> = [];
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    let sceneChanged: (() => void) | undefined;
    const source = createRuntimeTimelineDataSourceForTest({
      ...runtimeDependencies(invoke as unknown as (command: string) => Promise<GltfTimelineProjection>),
      onSceneFileChanged: (listener) => {
        sceneChanged = listener;
        return () => undefined;
      },
    });

    sceneChanged?.();
    pending[0]?.reject(new Error("stale projection request"));
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);

    pending[1]?.resolve({ revision: 2, clips: [clipProjection()] });
    await settle();
    expect(source.getGroups()).toHaveLength(1);
    source.dispose();
  });
});

function runtimeDependencies(invoke: (command: string) => Promise<GltfTimelineProjection>): TimelineRuntimeDependencies {
  return {
    hasTauriRuntime: () => true,
    invoke: invoke as TimelineRuntimeDependencies["invoke"],
    onSceneFileChanged: () => () => undefined,
    reportDiagnostic: () => undefined,
    warn: () => undefined,
  };
}

function createRuntimeTimelineDataSourceForTest(dependencies: TimelineRuntimeDependencies) {
  return createRuntimeTimelineDataSource(dependencies);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function clipProjection(): GltfTimelineProjection["clips"][number] {
  return {
    instanceId: "brainstem",
    clipIndex: 0,
    label: "Animation 1",
    duration: 1,
    channels: [],
  };
}
