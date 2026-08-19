import { describe, expect, it } from "vitest";
import {
  clampTimelineTime,
  formatCompactTimelineReadout,
  formatTimelineReadout,
  resolveTimelineSeekTime,
  snapTimelineTimeToFrame,
} from "./display";

describe("Timeline display policies", () => {
  it("keeps a 1.02s canonical value while formatting frames", () => {
    const canonical = 1.02;
    expect(formatTimelineReadout(canonical, 3, "frames")).toBe("0024 / 0072");
    expect(formatCompactTimelineReadout(canonical, 3, "frames")).toBe("0024 f");
    expect(canonical).toBe(1.02);
    expect(clampTimelineTime(canonical, 3)).toBe(1.02);
  });

  it("makes display toggles formatter-only and idempotent", () => {
    const canonical = 1.02;
    const frames = formatTimelineReadout(canonical, 3, "frames");
    const seconds = formatTimelineReadout(canonical, 3, "seconds");
    expect(formatTimelineReadout(canonical, 3, "frames")).toBe(frames);
    expect(formatTimelineReadout(canonical, 3, "seconds")).toBe(seconds);
    expect(canonical).toBe(1.02);
  });

  it("snaps only when an explicit frame-snap policy is requested", () => {
    expect(snapTimelineTimeToFrame(1.02, 24)).toBe(1);
    expect(resolveTimelineSeekTime(1.02, 3, "unsnapped")).toBe(1.02);
    expect(resolveTimelineSeekTime(1.02, 3, "frame-snap")).toBe(1);
  });

  it("clamps finite and non-finite values to a deterministic range", () => {
    expect(clampTimelineTime(-1, 3)).toBe(0);
    expect(clampTimelineTime(5, 3)).toBe(3);
    expect(clampTimelineTime(Number.NaN, 3)).toBe(0);
    expect(clampTimelineTime(Number.POSITIVE_INFINITY, 3)).toBe(3);
    expect(clampTimelineTime(Number.NEGATIVE_INFINITY, 3)).toBe(0);
    expect(clampTimelineTime(1, Number.NaN)).toBe(0);
    expect(clampTimelineTime(1, -1)).toBe(0);
  });

  it("preserves exact 24fps frame-step deltas before clamping", () => {
    const current = 1.02;
    const next = resolveTimelineSeekTime(current + 1 / 24, 3, "unsnapped");
    expect(next - current).toBeCloseTo(1 / 24);
    expect(resolveTimelineSeekTime(3 + 1 / 24, 3, "unsnapped")).toBe(3);
  });
});
