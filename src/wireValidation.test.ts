import { describe, expect, it } from "vitest";
import {
  isBoundedUtf8String,
  isFiniteF32,
  isSafeNonNegativeInteger,
  isWireRecord,
  truncateUtf8Prefix,
} from "./wireValidation";

describe("wire validation primitives", () => {
  it("distinguishes records from null and array wire values", () => {
    expect(isWireRecord({ value: 1 })).toBe(true);
    expect(isWireRecord(Object.create(null))).toBe(true);
    expect(isWireRecord(null)).toBe(false);
    expect(isWireRecord(["value"])).toBe(false);
  });

  it("accepts only safe non-negative integer sequence values", () => {
    expect(isSafeNonNegativeInteger(0)).toBe(true);
    expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isSafeNonNegativeInteger(1.5)).toBe(false);
    expect(isSafeNonNegativeInteger(-1)).toBe(false);
    expect(isSafeNonNegativeInteger(Number.NaN)).toBe(false);
  });

  it("keeps finite values within Rust f32 range", () => {
    expect(isFiniteF32(3.25)).toBe(true);
    expect(isFiniteF32(Number.MAX_VALUE)).toBe(false);
    expect(isFiniteF32(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("enforces UTF-8 byte limits without splitting a multibyte value", () => {
    const exact = "あ".repeat(1_365) + "a";
    expect(new TextEncoder().encode(exact).byteLength).toBe(4_096);
    expect(isBoundedUtf8String(exact, 4_096)).toBe(true);
    expect(isBoundedUtf8String(`${exact}あ`, 4_096)).toBe(false);
    expect(isBoundedUtf8String("   ", 4_096)).toBe(false);
    expect(isBoundedUtf8String("   ", 4_096, true)).toBe(true);
  });

  it("truncates a UTF-8 prefix without leaving a surrogate", () => {
    const bounded = truncateUtf8Prefix(`${"a".repeat(4_093)}😀`, 4_096);
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(4_096);
    const last = bounded.charCodeAt(bounded.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });

  it("handles tiny caps, combining marks, and lone low surrogates", () => {
    expect(truncateUtf8Prefix("😀", 0)).toBe("");
    expect(truncateUtf8Prefix("😀", 1)).toBe("");
    expect(truncateUtf8Prefix("😀", 2)).toBe("");
    expect(truncateUtf8Prefix("😀", 3)).toBe("");
    expect(truncateUtf8Prefix("e\u0301x", 1)).toBe("e");
    expect(truncateUtf8Prefix("a😀b", 5)).toBe("a😀");
    expect(truncateUtf8Prefix("\udc00", 3)).toBe("");
  });
});
