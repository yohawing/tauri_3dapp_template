import { describe, expect, it } from "vitest";
import { normalizeRendererStatus } from "./rendererStatus";

describe("renderer status wire contract", () => {
  it("accepts the native serialized status shape", () => {
    expect(normalizeRendererStatus({
      nativeAvailable: false,
      nativeActive: false,
      fallbackReason: "Native GPU out of memory",
      recoveryHint: "Restart the application",
    })).toEqual({
      nativeAvailable: false,
      nativeActive: false,
      fallbackReason: "Native GPU out of memory",
      recoveryHint: "Restart the application",
    });
  });

  it.each([
    null,
    { nativeAvailable: "false", nativeActive: false, fallbackReason: null, recoveryHint: null },
    { nativeAvailable: false, nativeActive: true, fallbackReason: "invalid", recoveryHint: null },
    { nativeAvailable: false, nativeActive: false, fallbackReason: 1, recoveryHint: null },
    { nativeAvailable: false, nativeActive: false, fallbackReason: null, recoveryHint: {} },
  ])("rejects malformed payload %#", (payload) => {
    expect(normalizeRendererStatus(payload)).toBeNull();
  });

  it("bounds optional Native status text before storing it", () => {
    expect(normalizeRendererStatus({
      nativeAvailable: false,
      nativeActive: false,
      fallbackReason: "x".repeat(4_097),
      recoveryHint: null,
    })).toBeNull();
    expect(normalizeRendererStatus({
      nativeAvailable: false,
      nativeActive: false,
      fallbackReason: null,
      recoveryHint: "hint",
    })?.recoveryHint).toBe("hint");
  });
});
