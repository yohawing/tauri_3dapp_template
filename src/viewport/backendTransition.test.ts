import { describe, expect, it, vi } from "vitest";
import { BackendTransitionController, type BackendTransitionDependencies } from "./backendTransition";
import type { CameraState, CanvasBackendHandle } from "./canvasBackend";

const CAMERA: CameraState = {
  target: [1, 2, 3],
  yaw: 0.25,
  pitch: -0.1,
  distance: 5,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function makeDependencies(overrides: Partial<BackendTransitionDependencies> = {}) {
  const calls = {
    deactivate: 0,
    activate: 0,
    read: 0,
    writes: [] as CameraState[],
    mounts: 0,
    disposes: 0,
    errors: [] as unknown[],
  };
  const handle: CanvasBackendHandle = {
    dispose: vi.fn(() => {
      calls.disposes += 1;
      return CAMERA;
    }),
  };
  const dependencies: BackendTransitionDependencies = {
    deactivateNative: vi.fn(async () => {
      calls.deactivate += 1;
    }),
    activateNative: vi.fn(async () => {
      calls.activate += 1;
    }),
    readCamera: vi.fn(async () => {
      calls.read += 1;
      return CAMERA;
    }),
    writeCamera: vi.fn(async (camera: CameraState) => {
      calls.writes.push(camera);
    }),
    mountCanvas: vi.fn(() => {
      calls.mounts += 1;
      return handle;
    }),
    reportError: vi.fn((error: unknown) => {
      calls.errors.push(error);
    }),
    ...overrides,
  };
  return { calls, dependencies, handle };
}

describe("BackendTransitionController", () => {
  it("completes Native -> Canvas -> Native with one dispose and camera handoff", async () => {
    const { calls, dependencies } = makeDependencies();
    const controller = new BackendTransitionController(dependencies);

    controller.transition("canvas");
    await settle();
    controller.transition("native");
    await settle();

    expect(calls.deactivate).toBe(1);
    expect(calls.mounts).toBe(1);
    expect(calls.disposes).toBe(1);
    expect(calls.writes).toEqual([CAMERA]);
    expect(calls.activate).toBe(1);
    expect(calls.errors).toEqual([]);
  });

  it("restores Native when cancelled after deactivation but before camera read", async () => {
    const read = deferred<CameraState>();
    const { calls, dependencies } = makeDependencies({
      readCamera: vi.fn(() => {
        calls.read += 1;
        return read.promise;
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    const cleanup = controller.transition("canvas");
    await settle();
    expect(calls.deactivate).toBe(1);
    expect(calls.read).toBe(1);

    cleanup();
    read.resolve(CAMERA);
    await settle();

    expect(calls.mounts).toBe(0);
    expect(calls.activate).toBe(1);
    expect(calls.writes).toEqual([]);
  });

  it("restores Native when cancellation wins before deactivation resolves", async () => {
    const deactivate = deferred<void>();
    const { calls, dependencies } = makeDependencies({
      deactivateNative: vi.fn(() => {
        calls.deactivate += 1;
        return deactivate.promise;
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    const cleanup = controller.transition("canvas");
    await settle();
    cleanup();

    deactivate.resolve();
    await settle();

    expect(calls.mounts).toBe(0);
    expect(calls.read).toBe(0);
    expect(calls.activate).toBe(1);
  });

  it("does not mount when cancelled after camera read but before mount", async () => {
    const read = deferred<CameraState>();
    const { calls, dependencies } = makeDependencies({
      readCamera: vi.fn(() => {
        calls.read += 1;
        return read.promise;
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    const cleanup = controller.transition("canvas");
    await settle();
    read.resolve(CAMERA);
    cleanup();
    await settle();

    expect(calls.mounts).toBe(0);
    expect(calls.activate).toBe(1);
  });

  it("does not mount Canvas when Native deactivation rejects", async () => {
    const error = new Error("deactivation failed");
    const { calls, dependencies } = makeDependencies({
      deactivateNative: vi.fn(async () => {
        calls.deactivate += 1;
        throw error;
      }),
    });
    const controller = new BackendTransitionController(dependencies);

    controller.transition("canvas");
    await settle();

    expect(calls.mounts).toBe(0);
    expect(calls.activate).toBe(0);
    expect(calls.errors).toEqual([error]);
  });

  it("reactivates the current generation when Canvas mounting throws", async () => {
    const error = new Error("mount failed");
    const { calls, dependencies } = makeDependencies({
      mountCanvas: vi.fn(() => {
        calls.mounts += 1;
        throw error;
      }),
    });
    const controller = new BackendTransitionController(dependencies);

    controller.transition("canvas");
    await settle();

    expect(calls.deactivate).toBe(1);
    expect(calls.activate).toBe(1);
    expect(calls.errors).toEqual([error]);
  });

  it("cannot let a stale generation cleanup reactivate Native", async () => {
    const { calls, dependencies } = makeDependencies();
    const controller = new BackendTransitionController(dependencies);
    const staleCleanup = controller.transition("canvas");
    await settle();

    controller.transition("native");
    staleCleanup();
    await settle();

    expect(calls.disposes).toBe(1);
    expect(calls.writes).toEqual([CAMERA]);
    expect(calls.activate).toBe(1);
  });

  it("does not reactivate from a delayed stale deactivation during a newer Canvas generation", async () => {
    const firstDeactivate = deferred<void>();
    const secondDeactivate = deferred<void>();
    let deactivationCount = 0;
    const { calls, dependencies } = makeDependencies({
      deactivateNative: vi.fn(() => {
        calls.deactivate += 1;
        deactivationCount += 1;
        return (deactivationCount === 1 ? firstDeactivate : secondDeactivate).promise;
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    const staleCleanup = controller.transition("canvas");
    await settle();
    staleCleanup();
    controller.transition("canvas");

    firstDeactivate.resolve();
    await settle();
    expect(calls.activate).toBe(0);
    expect(calls.mounts).toBe(0);

    secondDeactivate.resolve();
    await settle();
    expect(calls.activate).toBe(0);
    expect(calls.mounts).toBe(1);
  });

  it("compensates a late Canvas deactivation after Native has become current", async () => {
    const deactivate = deferred<void>();
    const { calls, dependencies } = makeDependencies({
      deactivateNative: vi.fn(() => {
        calls.deactivate += 1;
        return deactivate.promise;
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    controller.transition("canvas");
    await settle();

    controller.transition("native");
    await settle();
    expect(calls.activate).toBe(1);

    deactivate.resolve();
    await settle();
    expect(calls.activate).toBe(2);
    expect(calls.mounts).toBe(0);
  });

  it("makes a newer Canvas generation wait for late Native compensation", async () => {
    const firstDeactivate = deferred<void>();
    const compensationActivate = deferred<void>();
    let deactivateCount = 0;
    let activateCount = 0;
    const { calls, dependencies } = makeDependencies({
      deactivateNative: vi.fn(() => {
        calls.deactivate += 1;
        deactivateCount += 1;
        if (deactivateCount === 1) {
          return firstDeactivate.promise;
        }
        return Promise.resolve();
      }),
      activateNative: vi.fn(() => {
        calls.activate += 1;
        activateCount += 1;
        return activateCount === 2 ? compensationActivate.promise : Promise.resolve();
      }),
    });
    const controller = new BackendTransitionController(dependencies);
    controller.transition("canvas");
    await settle();
    controller.transition("native");
    await settle();

    firstDeactivate.resolve();
    await settle();
    expect(calls.activate).toBe(2);

    controller.transition("canvas");
    await settle();
    expect(calls.deactivate).toBe(1);
    expect(calls.mounts).toBe(0);

    compensationActivate.resolve();
    await settle();
    expect(calls.deactivate).toBe(2);
    expect(calls.mounts).toBe(1);
  });

  it("makes disposal idempotent and disposes an existing Canvas exactly once", async () => {
    const { calls, dependencies } = makeDependencies();
    const controller = new BackendTransitionController(dependencies);
    controller.transition("canvas");
    await settle();

    controller.dispose();
    controller.dispose();
    await settle();

    expect(calls.disposes).toBe(1);
    expect(calls.writes).toEqual([CAMERA]);
    expect(calls.activate).toBe(1);
  });
});
