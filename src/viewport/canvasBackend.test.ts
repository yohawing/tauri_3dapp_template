import { describe, expect, it, vi } from "vitest";
import {
  applyCanvasOrbitBounds,
  CAMERA_MAX_DISTANCE,
  CAMERA_MAX_POLAR_ANGLE,
  CAMERA_MIN_DISTANCE,
  CAMERA_MIN_POLAR_ANGLE,
  createCanvasRenderScheduler,
  reportCanvasPerformanceSummary,
} from "./canvasBackend";
import { CanvasPerformanceSampler } from "./performanceSampler";

interface PendingFrame {
  id: number;
  callback: FrameRequestCallback;
}

function createRafHarness() {
  let nextId = 1;
  const pending: PendingFrame[] = [];
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    pending.push({ id, callback });
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    const index = pending.findIndex((frame) => frame.id === id);
    if (index >= 0) pending.splice(index, 1);
  });
  return {
    pending,
    requestFrame,
    cancelFrame,
    runNext(timestamp: number) {
      const frame = pending.shift();
      expect(frame).toBeDefined();
      frame?.callback(timestamp);
    },
  };
}

describe("createCanvasRenderScheduler", () => {
  it("renders explicit invalidations without starting an idle RAF loop", () => {
    const raf = createRafHarness();
    const render = vi.fn();
    const scheduler = createCanvasRenderScheduler({
      render,
      continuous: false,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
    });

    scheduler.start();
    scheduler.invalidate();
    scheduler.invalidate();

    expect(render).toHaveBeenCalledTimes(2);
    expect(raf.requestFrame).not.toHaveBeenCalled();
  });

  it("keeps sampling mode on a continuous RAF loop", () => {
    const raf = createRafHarness();
    const render = vi.fn();
    const scheduler = createCanvasRenderScheduler({
      render,
      continuous: true,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
    });

    scheduler.start();
    expect(raf.requestFrame).toHaveBeenCalledTimes(1);
    raf.runNext(12.5);
    expect(render).toHaveBeenLastCalledWith(12.5);
    expect(raf.requestFrame).toHaveBeenCalledTimes(2);
    raf.runNext(29.25);
    expect(render).toHaveBeenLastCalledWith(29.25);
    expect(raf.requestFrame).toHaveBeenCalledTimes(3);
  });

  it("cancels sampling and ignores queued callbacks after dispose", () => {
    const raf = createRafHarness();
    const render = vi.fn();
    const scheduler = createCanvasRenderScheduler({
      render,
      continuous: true,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
    });

    scheduler.start();
    const queued = raf.pending[0];
    scheduler.dispose();
    expect(raf.cancelFrame).toHaveBeenCalledWith(queued?.id);
    expect(raf.pending).toHaveLength(0);

    // A browser may already have copied the callback before cancellation.
    queued?.callback(42);
    scheduler.invalidate();
    expect(render).not.toHaveBeenCalled();
  });
});

describe("Canvas performance reporting", () => {
  function summary() {
    const sampler = new CanvasPerformanceSampler(1920, 1080, 1, 0);
    sampler.observe(0, 1);
    return sampler.observe(10, 1);
  }

  it("contains synchronous report failures", () => {
    const error = new Error("report unavailable");
    const errors: unknown[] = [];
    expect(() => reportCanvasPerformanceSummary(summary()!, () => { throw error; }, (value) => errors.push(value))).not.toThrow();
    expect(errors).toEqual([error]);
  });

  it("contains asynchronous report failures", async () => {
    const error = new Error("report rejected");
    const errors: unknown[] = [];
    reportCanvasPerformanceSummary(summary()!, () => Promise.reject(error), (value) => errors.push(value));
    await Promise.resolve();
    expect(errors).toEqual([error]);
  });
});

describe("Canvas camera handoff bounds", () => {
  it("matches the Native camera validator range", () => {
    const controls = {
      minDistance: 0,
      maxDistance: Number.POSITIVE_INFINITY,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
    };

    applyCanvasOrbitBounds(controls);

    expect(controls).toEqual({
      minDistance: CAMERA_MIN_DISTANCE,
      maxDistance: CAMERA_MAX_DISTANCE,
      minPolarAngle: CAMERA_MIN_POLAR_ANGLE,
      maxPolarAngle: CAMERA_MAX_POLAR_ANGLE,
    });
  });
});
