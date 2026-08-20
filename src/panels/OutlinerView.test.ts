import { describe, expect, it } from "vitest";
import { toggleOutlinerNode, type OutlinerOpenState } from "./OutlinerView";

describe("toggleOutlinerNode", () => {
  it("opens a node that isn't in the map yet when defaultOpen is false", () => {
    const next = toggleOutlinerNode({}, "a", false);
    expect(next).toEqual({ a: true });
  });

  it("closes a node that isn't in the map yet when defaultOpen is true", () => {
    const next = toggleOutlinerNode({}, "a", true);
    expect(next).toEqual({ a: false });
  });

  it("flips an explicit entry regardless of defaultOpen", () => {
    const state: OutlinerOpenState = { a: true };
    expect(toggleOutlinerNode(state, "a", false)).toEqual({ a: false });
    expect(toggleOutlinerNode(state, "a", true)).toEqual({ a: false });
  });

  it("does not mutate the input map and leaves other entries untouched", () => {
    const state: OutlinerOpenState = { a: true, b: false };
    const next = toggleOutlinerNode(state, "b", false);
    expect(state).toEqual({ a: true, b: false });
    expect(next).toEqual({ a: true, b: true });
  });

  it("round-trips: toggling twice from the same default returns to the original value", () => {
    let state: OutlinerOpenState = {};
    state = toggleOutlinerNode(state, "a", false);
    state = toggleOutlinerNode(state, "a", false);
    expect(state).toEqual({ a: false });
  });
});
