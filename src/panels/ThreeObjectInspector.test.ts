import { describe, expect, it } from "vitest";
import { fieldValuesEqual } from "./ThreeObjectInspector";

// Regression coverage for the recursion bug this helper exists to prevent:
// `binding.on("change", ...)` used to call `model.value = field.get();
// binding.refresh()` unconditionally on every edit. Tweakpane v4.0.5 does not
// de-duplicate a `rawValue` write by structural equality — a freshly built
// `{x,y,z}` vector3 object (or even a plain number that round-trips exactly)
// reads as "changed" by reference/representation, so an unconditional
// `refresh()` re-fired the same "change" handler synchronously, which called
// `refresh()` again, forever — RangeError: Maximum call stack size exceeded
// on the very first accepted edit to any field. `fieldValuesEqual` is what
// the handler now checks first, so `refresh()` (and the resulting recursion)
// only happens when the reflector actually rejected/clamped an edit.
describe("fieldValuesEqual", () => {
  it("treats identical primitives as equal", () => {
    expect(fieldValuesEqual(4.2, 4.2)).toBe(true);
    expect(fieldValuesEqual("#ff0000", "#ff0000")).toBe(true);
    expect(fieldValuesEqual(true, true)).toBe(true);
  });

  it("treats different primitives as unequal", () => {
    expect(fieldValuesEqual(4.2, 4.3)).toBe(false);
    expect(fieldValuesEqual("#ff0000", "#00ff00")).toBe(false);
    expect(fieldValuesEqual(true, false)).toBe(false);
  });

  it("compares vector3-shaped objects structurally, not by reference", () => {
    expect(fieldValuesEqual({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(fieldValuesEqual({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3.001 })).toBe(false);
  });

  it("treats mismatched shapes/types as unequal rather than throwing", () => {
    expect(fieldValuesEqual({ x: 1, y: 2, z: 3 }, 4.2)).toBe(false);
    expect(fieldValuesEqual(null, { x: 1, y: 2, z: 3 })).toBe(false);
    expect(fieldValuesEqual(undefined, undefined)).toBe(true);
  });
});
