import { describe, expect, it } from "vitest";
import {
  disposeRendererStatusListener,
  readConsoleToggleOpen,
  readViewportRectDetail,
  rendererStatusSemanticKey,
  recoverModeAfterBackendError,
  shouldAcceptRendererStatus,
} from "./App";

describe("recoverModeAfterBackendError", () => {
  it("returns Native when the renderer is still available", () => {
    expect(recoverModeAfterBackendError("canvas", true)).toBe("native");
  });

  it("keeps Canvas fallback when Native is unavailable", () => {
    expect(recoverModeAfterBackendError("canvas", false)).toBe("canvas");
    expect(recoverModeAfterBackendError("native", false)).toBe("canvas");
  });

  it("reports and swallows async listener cleanup failures", async () => {
    const error = new Error("listener cleanup failed");
    const errors: unknown[] = [];

    disposeRendererStatusListener(() => Promise.reject(error), (nextError) => errors.push(nextError));
    await Promise.resolve();

    expect(errors).toEqual([error]);
  });

  it("swallows synchronous listener cleanup failures", () => {
    const error = new Error("listener cleanup threw");
    const errors: unknown[] = [];

    disposeRendererStatusListener(() => {
      throw error;
    }, (nextError) => errors.push(nextError));

    expect(errors).toEqual([error]);
  });

});

describe("renderer status source ordering", () => {
  it("accepts an initial response only when no event overtook it", () => {
    expect(shouldAcceptRendererStatus("initial", 0, 0)).toBe(true);
    expect(shouldAcceptRendererStatus("initial", 0, 1)).toBe(false);
  });

  it("accepts lifecycle events, including later availability recovery", () => {
    expect(shouldAcceptRendererStatus("event", 0, 1)).toBe(true);
  });
});

describe("console toggle event payload", () => {
  it("fails closed for a payload with a throwing getter", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile toggle getter");
      },
    });

    expect(() => readConsoleToggleOpen(hostile)).not.toThrow();
    expect(readConsoleToggleOpen(hostile)).toBeUndefined();
    expect(readConsoleToggleOpen({ open: true })).toBe(true);
  });
});

describe("viewport rect event payload", () => {
  it("fails closed for a payload with a throwing getter", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile rect getter");
      },
    });

    expect(() => readViewportRectDetail(hostile)).not.toThrow();
    expect(readViewportRectDetail(hostile)).toBeNull();
  });
});

describe("renderer status semantic dedupe", () => {
  const unavailable = {
    nativeAvailable: false,
    nativeActive: false,
    fallbackReason: "wgpu device lost",
    recoveryHint: "Restart the application to retry Native wgpu",
  };

  it("treats identical snapshots as duplicates but accepts recovery and reason changes", () => {
    expect(rendererStatusSemanticKey(unavailable)).toBe(rendererStatusSemanticKey({ ...unavailable }));
    expect(
      rendererStatusSemanticKey(unavailable),
    ).not.toBe(rendererStatusSemanticKey({ ...unavailable, fallbackReason: "Native surface unavailable: Lost" }));
    expect(
      rendererStatusSemanticKey(unavailable),
    ).not.toBe(
      rendererStatusSemanticKey({
        nativeAvailable: true,
        nativeActive: true,
        fallbackReason: null,
        recoveryHint: null,
      }),
    );
  });
});
