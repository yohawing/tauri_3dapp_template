import { describe, expect, it } from "vitest";
import {
  areViewportRectsEqual,
  clampFinite,
  createLatestCommandInvoker,
  createLatestSerialSender,
  createSerialInvoker,
  MAX_SERIAL_INVOKES,
  normalizeCameraState,
  normalizeViewportRect,
} from "./ViewportHost";

async function settleEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("ViewportHost rect equality", () => {
  const rect = { x: 1, y: 2, width: 320, height: 180, scaleFactor: 1.5 };

  it("drops malformed internal event details before formatting diagnostics", () => {
    expect(normalizeViewportRect(rect)).toEqual(rect);
    expect(normalizeViewportRect({ ...rect, width: -1 })).toBeNull();
    expect(normalizeViewportRect({ ...rect, scaleFactor: 0 })).toBeNull();
    expect(normalizeViewportRect({ ...rect, x: Number.NaN })).toBeNull();
    expect(normalizeViewportRect({ ...rect, x: Number.MAX_VALUE })).toBeNull();
    expect(normalizeViewportRect({ width: 1, height: 1 })).toBeNull();
  });

  it("compares every geometry and DPR field", () => {
    expect(areViewportRectsEqual(rect, { ...rect })).toBe(true);
    expect(areViewportRectsEqual(rect, { ...rect, x: 2 })).toBe(false);
    expect(areViewportRectsEqual(rect, { ...rect, y: 3 })).toBe(false);
    expect(areViewportRectsEqual(rect, { ...rect, width: 321 })).toBe(false);
    expect(areViewportRectsEqual(rect, { ...rect, height: 181 })).toBe(false);
    expect(areViewportRectsEqual(rect, { ...rect, scaleFactor: 2 })).toBe(false);
    expect(areViewportRectsEqual(null, rect)).toBe(false);
  });
});

describe("ViewportHost settings helpers", () => {
  it("rejects malformed or out-of-range Native camera responses", () => {
    const camera = { target: [1, 2, 3], yaw: -0.6, pitch: 0.35, distance: 4 };
    expect(normalizeCameraState(camera)).toEqual(camera);
    expect(normalizeCameraState({ ...camera, target: [1, 2] })).toBeNull();
    expect(normalizeCameraState({ ...camera, yaw: Number.NaN })).toBeNull();
    expect(normalizeCameraState({ ...camera, pitch: 1.56 })).toBeNull();
    expect(normalizeCameraState({ ...camera, distance: 0.49 })).toBeNull();
    expect(normalizeCameraState({ ...camera, distance: 101 })).toBeNull();
    expect(normalizeCameraState({ ...camera, target: [Number.MAX_VALUE, 0, 0] })).toBeNull();
  });

  it("clamps finite values and falls back for non-finite values", () => {
    expect(clampFinite(2, 0, 4, 1)).toBe(2);
    expect(clampFinite(-1, 0, 4, 1)).toBe(0);
    expect(clampFinite(8, 0, 4, 1)).toBe(4);
    expect(clampFinite(Number.NaN, 0, 4, 1)).toBe(1);
    expect(clampFinite(Number.POSITIVE_INFINITY, 0, 4, 1)).toBe(1);
    expect(clampFinite(-200, -180, 180, 0)).toBe(-180);
    expect(clampFinite(200, -180, 180, 0)).toBe(180);
    expect(clampFinite(Number.NaN, 0, 8, 1)).toBe(1);
  });

  it("serializes requests, preserves issue order, and continues after rejection", async () => {
    const calls: string[] = [];
    const deferred: Array<{
      resolve: (value: string) => void;
      reject: (error: unknown) => void;
    }> = [];
    const dependency = <T>(cmd: string): Promise<T> => {
      calls.push(cmd);
      return new Promise<T>((resolve, reject) =>
        deferred.push({ resolve: resolve as (value: string) => void, reject }),
      );
    };
    const invoke = createSerialInvoker(dependency);
    const first = invoke<string>("A");
    const second = invoke<string>("B");
    await settleEventLoop();
    expect(calls).toEqual(["A"]);

    deferred.shift()?.resolve("accepted A");
    await expect(first).resolves.toBe("accepted A");
    await settleEventLoop();
    expect(calls).toEqual(["A", "B"]);

    deferred.shift()?.reject(new Error("rejected B"));
    await expect(second).rejects.toThrow("rejected B");

    const third = invoke<string>("C");
    await settleEventLoop();
    expect(calls).toEqual(["A", "B", "C"]);
    deferred.shift()?.resolve("accepted C");
    await expect(third).resolves.toBe("accepted C");
  });

  it("rejects ordered requests at the cap and continues after the stall drains", async () => {
    let resolveFirst!: () => void;
    const calls: string[] = [];
    const invoke = createSerialInvoker(async <T>(cmd: string): Promise<T> => {
      calls.push(cmd);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return undefined as T;
    });

    const active = invoke("active");
    await Promise.resolve();
    const queued = Array.from({ length: MAX_SERIAL_INVOKES - 1 }, (_, index) => invoke(`queued-${index}`));
    await expect(invoke("overflow")).rejects.toThrow("serial invoke queue is full");

    resolveFirst();
    await expect(Promise.all([active, ...queued])).resolves.toHaveLength(MAX_SERIAL_INVOKES);
    await expect(invoke("after")).resolves.toBeUndefined();
    expect(calls).toHaveLength(MAX_SERIAL_INVOKES + 1);
  });

  it("coalesces settings snapshots per command while allowing other families through", async () => {
    let resolveFirst!: () => void;
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = createLatestCommandInvoker(async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ cmd, args });
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return undefined as T;
    });

    const active = invoke("set_camera_settings", { value: 1 });
    await Promise.resolve();
    let superseded = false;
    const old = invoke("set_camera_settings", { value: 2 }).then(() => {
      superseded = true;
    });
    const latest = invoke("set_camera_settings", { value: 3 });
    const other = invoke("set_viewport_lighting", { value: 4 });
    await Promise.resolve();

    expect(superseded).toBe(true);
    expect(calls).toEqual([
      { cmd: "set_camera_settings", args: { value: 1 } },
      { cmd: "set_viewport_lighting", args: { value: 4 } },
    ]);
    resolveFirst();
    await expect(Promise.all([active, old, latest, other])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(calls).toEqual([
      { cmd: "set_camera_settings", args: { value: 1 } },
      { cmd: "set_viewport_lighting", args: { value: 4 } },
      { cmd: "set_camera_settings", args: { value: 3 } },
    ]);
  });

  it("releases pending settings on disposal without deleting a remounted command state", async () => {
    let resolveFirst!: () => void;
    const calls: number[] = [];
    const invoke = createLatestCommandInvoker(async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push(args?.value as number);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return undefined as T;
    });
    const active = invoke("set_camera_settings", { value: 1 });
    await Promise.resolve();
    const queued = invoke("set_camera_settings", { value: 2 });
    invoke.dispose();
    await expect(queued).resolves.toBeUndefined();
    const remounted = invoke("set_camera_settings", { value: 3 });
    resolveFirst();
    await expect(Promise.all([active, remounted])).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual([1, 3]);
  });

  it("drops a stale queued camera preset when the App unmounts", async () => {
    let resolveFirst!: () => void;
    const calls: Array<Record<string, unknown> | undefined> = [];
    const invoke = createLatestCommandInvoker(async <T>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push(args);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return undefined as T;
    });

    const active = invoke("set_camera_view", { preset: "front" });
    await Promise.resolve();
    const stale = invoke("set_camera_view", { preset: "right" });
    invoke.dispose();
    await expect(stale).resolves.toBeUndefined();
    resolveFirst();
    await expect(active).resolves.toBeUndefined();
    expect(calls).toEqual([{ preset: "front" }]);
  });
});

describe("ViewportHost rect sender", () => {
  it("serializes rects and keeps only the latest pending value", async () => {
    const calls: string[] = [];
    const deferred: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    const sender = createLatestSerialSender(async (value: string) => {
      calls.push(value);
      await new Promise<void>((resolve, reject) => deferred.push({ resolve, reject }));
    });

    const first = sender.send("A");
    const second = sender.send("B");
    const third = sender.send("C");
    await Promise.resolve();
    expect(calls).toEqual(["A"]);

    deferred.shift()?.resolve();
    await settleEventLoop();
    expect(calls).toEqual(["A", "C"]);
    deferred.shift()?.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("settles superseded pending rect sends without retaining waiters", async () => {
    let resolveFirst!: () => void;
    const calls: string[] = [];
    const sender = createLatestSerialSender(async (value: string) => {
      calls.push(value);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const first = sender.send("A");
    await Promise.resolve();
    let superseded = false;
    const second = sender.send("B").then(() => {
      superseded = true;
    });
    const latest = sender.send("C");
    await Promise.resolve();

    expect(superseded).toBe(true);
    expect(calls).toEqual(["A"]);
    resolveFirst();
    await expect(Promise.all([first, second, latest])).resolves.toEqual([undefined, undefined, undefined]);
    expect(calls).toEqual(["A", "C"]);
  });

  it("drops pending rects after dispose and ignores late drain", async () => {
    let resolveFirst!: () => void;
    const calls: string[] = [];
    const sender = createLatestSerialSender(async (value: string) => {
      calls.push(value);
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    const first = sender.send("A");
    const pending = sender.send("B");
    sender.dispose();
    resolveFirst();
    await expect(Promise.all([first, pending])).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual(["A"]);
  });
});
