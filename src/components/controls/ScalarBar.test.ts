import { describe, expect, it } from "vitest";
import { isActiveRangePointer } from "./RangeViewport";
import { scalarBarPercent } from "./ScalarBar";

describe("ScalarBar progress", () => {
  it("fails closed for non-finite values and invalid ranges", () => {
    expect(scalarBarPercent(Number.NaN, 0, 1)).toBe(0);
    expect(scalarBarPercent(0.5, Number.POSITIVE_INFINITY, 1)).toBe(0);
    expect(scalarBarPercent(0.5, 1, 1)).toBe(0);
  });

  it("clamps valid values to the range", () => {
    expect(scalarBarPercent(-1, 0, 1)).toBe(0);
    expect(scalarBarPercent(0.5, 0, 1)).toBe(50);
    expect(scalarBarPercent(2, 0, 1)).toBe(100);
  });
});

describe("RangeViewport pointer ownership", () => {
  it("ignores terminal events from a different pointer", () => {
    expect(isActiveRangePointer(7, 7)).toBe(true);
    expect(isActiveRangePointer(7, 8)).toBe(false);
    expect(isActiveRangePointer(null, 7)).toBe(false);
  });
});
