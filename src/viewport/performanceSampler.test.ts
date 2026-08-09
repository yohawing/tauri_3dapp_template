import { describe, expect, it } from "vitest";
import { CanvasPerformanceSampler, parsePerformanceTarget } from "./performanceSampler";

describe("parsePerformanceTarget", () => {
  it("accepts bounded physical dimensions", () => {
    expect(parsePerformanceTarget("1920x1080")).toEqual([1920, 1080]);
  });

  it("rejects malformed and unsafe dimensions", () => {
    expect(parsePerformanceTarget("1920*1080")).toBeNull();
    expect(parsePerformanceTarget("0x1080")).toBeNull();
    expect(parsePerformanceTarget("20000x1080")).toBeNull();
  });
});

it("reports once after warm-up with nearest-rank percentiles", () => {
  const sampler = new CanvasPerformanceSampler(1920, 1080, 4, 2);
  expect(sampler.observe(0, 1)).toBeNull();
  expect(sampler.observe(10, 2)).toBeNull();
  expect(sampler.observe(20, 3)).toBeNull();
  expect(sampler.observe(30, 4)).toBeNull();
  expect(sampler.observe(50, 5)).toBeNull();
  const summary = sampler.observe(90, 6);
  expect(summary).toMatchObject({
    samples: 4,
    averageFps: 50,
    frameWallP50Ms: 10,
    frameWallP95Ms: 40,
    cpuRenderP50Ms: 4,
    cpuRenderP95Ms: 6,
  });
  expect(sampler.observe(100, 7)).toBeNull();
});

it("reports RAF callback delay separately from scheduled RAF intervals", () => {
  const sampler = new CanvasPerformanceSampler(1920, 1080, 2, 1);
  expect(sampler.observe(0, 1, 0)).toBeNull();
  expect(sampler.observe(10, 1, 10)).toBeNull();
  const summary = sampler.observe(30, 1, 30);
  expect(summary).toMatchObject({
    samples: 2,
    rafCallbackDelayP50Ms: 0,
    rafCallbackDelayP95Ms: 0,
    rafTimestampP50Ms: 10,
    rafTimestampP95Ms: 20,
  });
});
